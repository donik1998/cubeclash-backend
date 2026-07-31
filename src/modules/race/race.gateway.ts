import { Logger, OnModuleDestroy } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { DefaultEventsMap, Server, Socket } from 'socket.io';

import { Env } from '../../config/env';
import {
  ClientEvent,
  CountdownPayload,
  RaceErrorPayload,
  RaceResultPayload,
  RaceStatePayload,
  ReadyUpdatePayload,
  ScramblePayload,
  ServerEvent,
  SolveStopPayload,
  StatePlayer,
  WireStatus,
} from './race.events';
import { Adjudicated, ForcedLoss, adjudicate } from './adjudicate';
import { checkPlausibility } from './plausibility';
import { RaceRoomStore, RoomPhase } from './race-room.store';
import { DISCONNECT_GRACE_MS, RACE_CAPACITY, RaceService } from './race.service';
import { RaceWithCompetitors } from './race.types';

/** What we hang off each authenticated socket. `userId` is set at connect; `raceId` at create/join. */
interface SocketData {
  userId: string;
  raceId?: string;
}

/**
 * A socket that has been through `handleConnection` carries its principal.
 *
 * Typed through Socket.IO's `SocketData` type parameter (not an intersection) so
 * `socket.data.userId` is a *typed* read rather than an `any` access — the
 * transport's own generic slot is exactly for this per-connection state.
 */
type RaceSocket = Socket<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>;

/**
 * How often the server relays a still-solving player's running clock to their
 * opponent (spec §10). Short events at 10 Hz feel live; long events at 4 Hz stay
 * smooth at a third of the traffic, because a 5×5 bar barely moves per frame.
 */
const PROGRESS_HZ_SHORT = 10;
const PROGRESS_HZ_LONG = 4;

/**
 * The events that get the 4 Hz cadence — the long-form puzzles where a race runs
 * for a minute or more. Everything else (2×2, 3×3, OH, and the small puzzles) is
 * over in seconds and gets 10 Hz. Read off the same size split the client uses in
 * `fake_race_gateway.dart`'s `_runOpponent`.
 */
const LONG_FORM_EVENTS = new Set(['4x4', '5x5', '6x6', '7x7', 'megaminx', 'square-1']);

/**
 * The real-time half of a race — spec §1–§5, §10.
 *
 * ## What this class is, and what it is not
 *
 * It is a **transport**. It owns sockets, timers, and fan-out; it owns *no*
 * rules. Every rule — who may ready, what counts as a legal finish, who won, what
 * Elo moves — is `RaceService`'s, which the REST controller drives too, so the
 * two transports can never disagree about whether a room is joinable or settled
 * (the reason the service is exported). The one thing that is genuinely the
 * gateway's and nobody else's is **the clock**: the countdown, the
 * scramble-reveal stamp, and the anti-cheat check that measures a reported time
 * against it (spec §5). REST cannot do that — it never sees `client_time_ms`.
 *
 * ## The two payloads that are NOT broadcasts
 *
 * `race:state` carries `is_me` (per viewer) and a private `code` (only to a
 * participant); `race:result` carries `your_time`/`opp_time`/`elo_delta` (per
 * recipient). Both are emitted **per socket**, never `server.to(room).emit(...)`.
 * A one-client test would pass either way — that is the trap — so this is
 * deliberate and the e2e drives two real clients to prove the personalisation.
 *
 * ## Ephemeral vs durable
 *
 * The DB `race_status` enum has no `ready-check`; the wire protocol does. So
 * `ready-check` is a phase in Redis ({@link RaceRoomStore}), emitted in
 * `race:state`, and **never** passed to `advanceStatus`. Only `countdown`,
 * `racing`, `settled` are persisted.
 */
@WebSocketGateway({ namespace: '/race' })
export class RaceGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy {
  private readonly logger = new Logger(RaceGateway.name);
  private readonly accessSecret: string;

  @WebSocketServer()
  private server!: Server<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>;

  /**
   * Server-driven progress relays, one interval per in-flight race. Process-local
   * because the interval only fans out through `this.server` (which the Redis
   * adapter makes cluster-wide) — the *timer* need not be shared, only its emits.
   */
  private readonly progressTimers = new Map<string, NodeJS.Timeout>();
  /** Flipped by [onModuleDestroy]; a tick that wakes after shutdown must do nothing. */
  private destroyed = false;
  /**
   * Every fire-and-forget `setTimeout` the countdown schedules. They were
   * previously dropped on the floor: each one keeps the Node event loop alive
   * until it fires, and the reveal sits three seconds out, so a suite that
   * finished mid-countdown could not exit.
   */
  private readonly pendingTimers = new Set<NodeJS.Timeout>();
  /**
   * One promise chain per participant, so their `solve:stop` frames are handled
   * in arrival order.
   *
   * Socket.IO delivers a socket's frames in order, but `@SubscribeMessage`
   * handlers are `async` and Nest does not wait for one before invoking the
   * next — so five frames sent in a tick all enter the handler, `await` their
   * way through `getRace`/`getRevealAt`, and reach the write in whatever order
   * those resolve. The Redis latch below makes exactly one of them win; it
   * cannot make the *first* one win. Chaining does.
   */
  private readonly submitChains = new Map<string, Promise<void>>();

  /**
   * Pending disconnect-grace timers, keyed `raceId:userId`. If the player
   * reconnects before it fires, we cancel it; if it fires, they are DNF'd and the
   * opponent wins (spec §10).
   */
  private readonly graceTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly races: RaceService,
    private readonly rooms: RaceRoomStore,
    private readonly jwt: JwtService,
    config: ConfigService<Env, true>,
  ) {
    this.accessSecret = config.get('JWT_ACCESS_SECRET', { infer: true });
  }

  // ----------------------------------------------------------- connection auth

  /**
   * Authenticate the socket, or refuse it — spec §1. The token is read from
   * `handshake.auth.token` (the documented path all three clients use) with the
   * `Authorization: Bearer` header as a fallback. A missing or invalid token is a
   * hard disconnect: **anonymous sockets are never accepted.**
   *
   * On a *re*-connection (same JWT, so same user) we look up the user's active
   * race and, if the grace window has not yet expired, seat them back into the
   * Socket.IO room and cancel the pending DNF — the rejoin path of spec §10.
   */
  async handleConnection(socket: RaceSocket): Promise<void> {
    const token = this.extractToken(socket);
    if (!token) {
      this.refuse(socket, 'No authentication token');
      return;
    }

    let userId: string;
    try {
      const payload = await this.jwt.verifyAsync<{ sub?: string }>(token, {
        secret: this.accessSecret,
      });
      if (!payload?.sub) throw new Error('token has no subject');
      userId = payload.sub;
    } catch {
      this.refuse(socket, 'Invalid authentication token');
      return;
    }

    socket.data.userId = userId;
    // A per-user room every one of this user's sockets joins, so a per-recipient
    // fan-out (`race:result`) or a per-recipient *exclusion* (`opponent_progress`
    // to everyone but the solver) can address a user regardless of socket id, and
    // regardless of which instance holds the socket — the Redis adapter routes it.
    await socket.join(this.userRoom(userId));

    // Reconnect: if this user has a live race, re-seat them and cancel any
    // pending grace-window DNF. A fresh connection with no active race just
    // waits for a race:create / race:join.
    await this.tryResumeActiveRace(socket, userId);
  }

  /**
   * A socket dropped. If it was in an in-flight race, start the grace window:
   * the player has {@link DISCONNECT_GRACE_MS} to reconnect (spec §10) before
   * they are DNF'd and the opponent wins. A settled/absent race needs nothing.
   */
  async handleDisconnect(socket: RaceSocket): Promise<void> {
    const { userId, raceId } = socket.data;
    if (!userId || !raceId) return;

    const phase = await this.rooms.getPhase(raceId);
    // Nothing to grace once the room is over (or never started its live state).
    if (!phase || phase === 'settled') return;

    const key = this.graceKey(raceId, userId);
    if (this.graceTimers.has(key)) return; // already counting down

    this.logger.log(`User ${userId} dropped from race ${raceId}; ${DISCONNECT_GRACE_MS}ms grace`);
    const timer = setTimeout(() => {
      this.graceTimers.delete(key);
      void this.settleOnWalkout(raceId, userId).catch((err) =>
        this.logger.error(`grace-window settle failed for ${raceId}`, err as Error),
      );
    }, DISCONNECT_GRACE_MS);
    this.graceTimers.set(key, timer);
  }

  // ------------------------------------------------------- client → server

  /**
   * `race:create` — open a room (spec §2). Quick enqueues; private mints a code.
   * The socket joins the Socket.IO room and gets `race:state` so it learns its
   * own `race_id` (which is how every client discovers it).
   */
  @SubscribeMessage(ClientEvent.CREATE)
  async onCreate(
    socket: RaceSocket,
    body: { mode?: 'quick' | 'private'; event?: string },
  ): Promise<void> {
    const userId = socket.data.userId;
    const mode = body?.mode === 'private' ? 'private' : 'quick';
    const event = typeof body?.event === 'string' ? body.event : '3x3';

    try {
      const { race } = await this.races.createRoom(userId, { mode, event });
      socket.data.raceId = race.id;
      await socket.join(race.id);
      await this.rooms.setPhase(race.id, 'waiting');
      await this.emitStateToRoom(race.id, 'waiting');
    } catch (err) {
      this.emitError(socket, err);
    }
  }

  /**
   * `race:join` — join a private room by code (spec §2). When the second player
   * lands, the room advances to the ephemeral `ready-check` phase and both
   * players get fresh `race:state`.
   */
  @SubscribeMessage(ClientEvent.JOIN)
  async onJoin(socket: RaceSocket, body: { code?: string }): Promise<void> {
    const userId = socket.data.userId;
    const code = typeof body?.code === 'string' ? body.code.trim().toUpperCase() : '';

    try {
      const race = await this.races.joinByCode(userId, code);
      socket.data.raceId = race.id;
      await socket.join(race.id);

      // Two players present → ready-check. This is a gateway phase, not a DB
      // status: `ready-check` is not in the enum, so it never reaches the DB.
      const phase: RoomPhase = race.competitors.length >= RACE_CAPACITY ? 'ready-check' : 'waiting';
      await this.rooms.setPhase(race.id, phase);
      await this.emitStateToRoom(race.id, phase);
    } catch (err) {
      this.emitError(socket, err);
    }
  }

  /**
   * `race:ready` — flip this player's ready flag (spec §2/§4). Broadcasts
   * `race:ready_update` (viewer-agnostic) and re-sends per-viewer `race:state`.
   * When both are ready, the countdown begins.
   */
  @SubscribeMessage(ClientEvent.READY)
  async onReady(socket: RaceSocket): Promise<void> {
    const { userId, raceId } = socket.data;
    if (!raceId) return;

    try {
      const { race, allReady } = await this.races.markReady(raceId, userId, true);

      const update: ReadyUpdatePayload = { user_id: userId, ready: true };
      this.server.to(raceId).emit(ServerEvent.READY_UPDATE, update);

      const phase: RoomPhase = allReady ? 'countdown' : 'ready-check';
      await this.rooms.setPhase(raceId, phase);
      await this.emitStateToRoom(raceId, phase, race);

      if (allReady) await this.runCountdown(raceId, race.event);
    } catch (err) {
      this.emitError(socket, err);
    }
  }

  /**
   * `solve:start` — the client began solving (spec §2). The server records
   * nothing durable here: its authoritative clock is the scramble-reveal stamp it
   * already wrote at countdown, and *that* is what a finish is measured against,
   * not a client-announced start. Present so the wire contract is complete and so
   * a future per-start audit has a hook.
   */
  @SubscribeMessage(ClientEvent.SOLVE_START)
  onSolveStart(_socket: RaceSocket): void {
    // Intentionally inert — see the doc comment. The reveal stamp is the baseline.
  }

  /**
   * `solve:stop {client_time_ms}` — a finish (spec §2/§5). The gateway is the
   * **only** layer that can validate it, because it owns the reveal stamp and the
   * receipt time. The flow:
   *
   *  1. record the server receipt time regardless (spec §5);
   *  2. reject a time that finished before the reveal, is faster than any human,
   *     or exceeds the wall-clock elapsed — a doctored `client_time_ms`;
   *  3. persist the *validated* time via `submitTime`, which is idempotent: a
   *     duplicate `solve:stop` after a participant has submitted writes nothing;
   *  4. once both have finished (or DNF'd), settle.
   */
  @SubscribeMessage(ClientEvent.SOLVE_STOP)
  async onSolveStop(socket: RaceSocket, body: SolveStopPayload): Promise<void> {
    const { userId, raceId } = socket.data;
    if (!raceId) return;

    // Stamp receipt now, in arrival order, before queueing — the time a frame
    // reached the server must not depend on how long it waited behind another.
    const receivedAtMs = Date.now();
    const key = `${raceId}:${userId}`;
    const previous = this.submitChains.get(key) ?? Promise.resolve();
    const current = previous.then(() => this.handleSolveStop(socket, body, receivedAtMs));
    // Swallow here so one rejection cannot poison every later frame in the chain;
    // handleSolveStop already reports failures to the client.
    this.submitChains.set(
      key,
      current.catch(() => undefined),
    );
    await current;
  }

  private async handleSolveStop(
    socket: RaceSocket,
    body: SolveStopPayload,
    receivedAtMs: number,
  ): Promise<void> {
    const { userId, raceId } = socket.data;
    // Re-checked rather than passed in: the socket may have left the room while
    // this frame waited its turn in the chain.
    if (!raceId) return;
    const clientTimeMs = Number(body?.client_time_ms);

    try {
      const race = await this.races.getRace(raceId);
      const revealAtMs = await this.rooms.getRevealAt(raceId);
      // No reveal stamp means the race is not racing — a stop before GO.
      if (revealAtMs === null) {
        this.emitError(socket, {
          code: 'not_racing',
          message: 'The scramble has not been revealed yet',
        });
        return;
      }

      const verdict = checkPlausibility({
        event: race.event,
        clientTimeMs,
        revealAtMs,
        receivedAtMs,
      });
      if (!verdict.ok) {
        // Rejected: the server records its own receipt but refuses the time. The
        // client renders the refusal; it does not get to retry with a new number
        // (the idempotent submit below would ignore a retry anyway).
        this.logger.warn(
          `Rejected implausible time ${clientTimeMs}ms for ${userId} in ${raceId}: ${verdict.reason}`,
        );
        this.emitError(socket, {
          code: 'implausible_time',
          message: `Time rejected: ${verdict.reason}`,
        });
        return;
      }

      // Idempotent, and deterministically so. `recordFinish` guards on
      // `finished_at is null`, which stops a second *write* — but this handler
      // is async, so two frames emitted in the same tick interleave and both
      // arrive at that UPDATE while the column is still null. The DB then picks
      // whichever commits first, i.e. at random. Firing several `solve:stop`s
      // with different times and keeping the lucky one is a cheat, so the first
      // arrival is latched in Redis *before* anything touches Postgres.
      //
      // Claimed after plausibility, so a rejected time does not burn the
      // attempt. We still fall through to maybeSettle even when the claim
      // fails, in case the pair completed while this duplicate was in flight.
      if (await this.rooms.claimFinish(raceId, userId)) {
        await this.races.submitTime(raceId, userId, {
          timeMs: clientTimeMs,
          penalty: 'none',
          finishedAt: new Date(receivedAtMs),
        });
      }

      await this.maybeSettle(raceId);
    } catch (err) {
      this.emitError(socket, err);
    }
  }

  /**
   * `race:leave` — a deliberate walkout (spec §2/§10). Settled immediately as a
   * `left` for the leaver and a win for the opponent; no grace window, because
   * leaving is a choice, not a blip.
   */
  @SubscribeMessage(ClientEvent.LEAVE)
  async onLeave(socket: RaceSocket): Promise<void> {
    const { userId, raceId } = socket.data;
    if (!raceId) return;
    try {
      await this.settleOnWalkout(raceId, userId);
      await socket.leave(raceId);
      socket.data.raceId = undefined;
    } catch (err) {
      this.emitError(socket, err);
    }
  }

  // --------------------------------------------------------------- lifecycle

  /**
   * The countdown, server-driven: `race:countdown` 3 → 2 → 1 → 0 one per second,
   * then reveal the scramble to both at the same instant and **stamp the reveal
   * time** — the anti-cheat baseline (spec §4/§5). The DB status advances to
   * `racing`; the progress relay starts.
   */
  private async runCountdown(raceId: string, event: string): Promise<void> {
    await this.races.advanceStatus(raceId, 'countdown');

    for (let n = 3; n >= 0; n--) {
      this.later(
        () => {
          const payload: CountdownPayload = { n };
          try {
            this.server.to(raceId).emit(ServerEvent.COUNTDOWN, payload);
          } catch {
            // Adapter gone (shutting down) — the countdown is advisory.
          }
        },
        (3 - n) * 1000,
      );
    }

    // GO lands with n=0; the scramble reveal is one tick after, at t=3s.
    this.later(() => {
      void this.reveal(raceId, event).catch((err) =>
        this.logger.error(`reveal failed for ${raceId}`, err as Error),
      );
    }, 3000);
  }

  /** Reveal the scramble, stamp the baseline, go racing, start the progress relay. */
  private async reveal(raceId: string, event: string): Promise<void> {
    const race = await this.races.getRace(raceId);
    const revealAtMs = await this.rooms.stampReveal(raceId, Date.now());

    // `\n` is significant and never trimmed — the scramble is sent byte-for-byte
    // to both players, at the same instant, off the one stored value.
    const payload: ScramblePayload = { scramble: race.scramble };
    this.server.to(raceId).emit(ServerEvent.SCRAMBLE, payload);

    await this.races.advanceStatus(raceId, 'racing');
    await this.rooms.setPhase(raceId, 'racing');

    this.startProgressRelay(raceId, event, revealAtMs);
  }

  /**
   * Relay each still-solving player's running clock to their opponent (spec §10),
   * server-authoritative: the running time is `now - revealAt`, not a
   * client-reported number. Ticks at 10 Hz (short) or 4 Hz (long) until both have
   * finished, then stops.
   */
  private startProgressRelay(raceId: string, event: string, revealAtMs: number): void {
    const hz = LONG_FORM_EVENTS.has(event) ? PROGRESS_HZ_LONG : PROGRESS_HZ_SHORT;
    const intervalMs = Math.round(1000 / hz);

    const timer = setInterval(() => {
      if (this.destroyed) {
        this.stopProgressRelay(raceId);
        return;
      }
      void (async () => {
        const race = await this.races.getRace(raceId).catch(() => null);
        if (!race) {
          this.stopProgressRelay(raceId);
          return;
        }

        const unfinished = race.competitors.filter((c) => c.finishedAt === null);
        if (unfinished.length === 0) {
          this.stopProgressRelay(raceId);
          return;
        }

        const runningMs = Date.now() - revealAtMs;
        // Each still-solving player's clock is relayed to *the other* player: emit
        // to the room but exclude the solver's own per-user room, so a player only
        // ever sees their opponent's progress, never their own echoed back. With
        // one player still solving, only the finished player receives it.
        for (const solver of unfinished) {
          try {
            this.server
              .to(raceId)
              .except(this.userRoom(solver.userId))
              .emit(ServerEvent.OPPONENT_PROGRESS, { running_ms: runningMs });
          } catch {
            // The Redis adapter publishes synchronously, so once the connection
            // is gone this throws right here rather than rejecting a promise —
            // which is why wrapping the enclosing async block was not enough.
            // Progress is advisory (the client recomputes it from the reveal
            // stamp), so a dropped frame costs nothing; an escaping throw took
            // the whole e2e suite down with "Connection is closed".
            this.stopProgressRelay(raceId);
            return;
          }
        }
      })().catch(() => {
        // A tick that fires into a torn-down app throws "Connection is closed"
        // from the Redis adapter. Progress is advisory — the client recomputes
        // it from the reveal stamp — so a dropped frame costs nothing, whereas
        // an unhandled rejection here failed the whole e2e suite. Stop relaying
        // rather than retrying into a socket that is gone.
        this.stopProgressRelay(raceId);
      });
    }, intervalMs);

    this.progressTimers.set(raceId, timer);
  }

  /**
   * Shutdown must clear every relay. Each is a bare `setInterval`, which keeps
   * the Node event loop alive on its own — so without this the process never
   * exits: `test:e2e` printed "Jest did not exit one second after the test run
   * has completed" and CI, which has no `--forceExit`, would have hung until the
   * job timeout. Worse, a surviving tick fires into a closed Redis connection
   * and fails the suite outright.
   */
  onModuleDestroy(): void {
    this.destroyed = true;
    for (const timer of this.progressTimers.values()) clearInterval(timer);
    this.progressTimers.clear();
    // The grace timers are the long ones — DISCONNECT_GRACE_MS is 30s, and a
    // socket dropped at teardown schedules one. Leaving them pinned the event
    // loop open for half a minute after the tests had finished.
    for (const timer of this.graceTimers.values()) clearTimeout(timer);
    this.graceTimers.clear();
    for (const timer of this.pendingTimers) clearTimeout(timer);
    this.pendingTimers.clear();
    this.submitChains.clear();
  }

  /**
   * `setTimeout`, but tracked so shutdown can cancel it. Nothing in this gateway
   * may schedule an untracked timer: each is a live handle on the event loop,
   * and the process cannot exit while one is outstanding.
   */
  private later(fn: () => void, ms: number): void {
    const timer = setTimeout(() => {
      this.pendingTimers.delete(timer);
      if (this.destroyed) return;
      fn();
    }, ms);
    this.pendingTimers.add(timer);
  }

  private stopProgressRelay(raceId: string): void {
    const timer = this.progressTimers.get(raceId);
    if (timer) {
      clearInterval(timer);
      this.progressTimers.delete(raceId);
    }
  }

  /**
   * Settle once both players have a finish on record. Adjudicate win/loss/DNF
   * from the *validated* times (a null time_ms with a finish is a DNF), hand the
   * outcome to the service (which owns the Elo), and emit a per-recipient
   * `race:result`. Latched in Redis so two triggers cannot double-settle.
   */
  private async maybeSettle(raceId: string): Promise<void> {
    const race = await this.races.getRace(raceId);
    const bothFinished =
      race.competitors.length === RACE_CAPACITY &&
      race.competitors.every((c) => c.finishedAt !== null);
    if (!bothFinished) return;

    await this.settleAdjudicated(raceId, race, (c) =>
      c.penalty === 'dnf' || c.timeMs === null ? 'dnf' : null,
    );
  }

  /**
   * Settle a walkout/timeout: `leaver` gets `left`, the opponent wins outright.
   * Used by both `race:leave` and the grace-window expiry.
   */
  private async settleOnWalkout(raceId: string, leaverId: string): Promise<void> {
    const race = await this.races.getRace(raceId).catch(() => null);
    if (!race) return;
    if (race.status === 'settled') return;

    await this.settleAdjudicated(raceId, race, (c) => (c.userId === leaverId ? 'left' : null));
  }

  /**
   * The shared settlement path. `forced` lets a caller pin a specific loss reason
   * for a competitor (`dnf`/`left`); everyone else is ranked on time, faster
   * wins. Emits a personalised `race:result` to each player and tears down the
   * room's live state.
   *
   * Idempotent by the Redis latch *and* the service's own settle guard: a second
   * settlement claims neither and fans out nothing.
   */
  private async settleAdjudicated(
    raceId: string,
    race: RaceWithCompetitors,
    forced: ForcedLoss,
  ): Promise<void> {
    if (!(await this.rooms.claimSettlement(raceId))) return;

    this.stopProgressRelay(raceId);

    // Pure ranking (see `adjudicate.ts`): a forced reason (dnf/left) loses; among
    // the rest the strictly faster validated time wins. Only the already-validated
    // times reach here — the anti-cheat floor ran before persistence.
    const outcomes = adjudicate(
      race.competitors.map((c) => ({ userId: c.userId, timeMs: c.timeMs, penalty: c.penalty })),
      forced,
    );

    const { settled, eloByUser } = await this.races.settle(raceId, {
      results: outcomes.map((o) => ({
        userId: o.userId,
        result: o.result,
        timeMs: o.timeMs,
        penalty: o.penalty,
      })),
    });

    await this.rooms.setPhase(raceId, 'settled');

    // Lost the settle race to another worker: their result stands and was already
    // fanned out. Do not emit a second, conflicting set of results.
    if (!settled) {
      await this.rooms.clear(raceId);
      return;
    }

    for (const me of outcomes) {
      this.emitToUser(
        raceId,
        me.userId,
        ServerEvent.RESULT,
        this.resultFor(me, outcomes, eloByUser),
      );
    }

    await this.rooms.clear(raceId);
  }

  /**
   * The `race:result` as one recipient should see it (spec §3, per-recipient):
   * `result` from their perspective, `your_time`/`opp_time` swapped, and their
   * *own* signed `elo_delta`. A `dnf`/`left` result nulls that side's time.
   */
  private resultFor(
    me: Adjudicated,
    outcomes: Adjudicated[],
    eloByUser: Record<string, number>,
  ): RaceResultPayload {
    const opp = outcomes.find((o) => o.userId !== me.userId);
    const isNonResult = (o: Adjudicated | undefined): boolean =>
      !!o && (o.result === 'dnf' || o.result === 'left');

    return {
      result: me.result === 'win' ? 'win' : 'loss',
      your_time: isNonResult(me) ? null : me.timeMs,
      opp_time: opp && !isNonResult(opp) ? opp.timeMs : null,
      opponent_dnf: isNonResult(opp),
      elo_delta: eloByUser[me.userId] ?? 0,
    };
  }

  // --------------------------------------------------------- state fan-out

  /**
   * Send `race:state` to every socket in the room, **personalised per viewer**.
   *
   * `is_me` is true only in the copy sent to that player, and `code` is included
   * only for a private room and only to a participant — so this cannot be a
   * single `server.to(room).emit`. We resolve the sockets in the room and emit
   * one tailored payload each. Reuses `RaceService` for the race read; the
   * per-viewer shaping is the transport's job, so it lives here.
   */
  private async emitStateToRoom(
    raceId: string,
    status: WireStatus,
    prefetched?: RaceWithCompetitors,
  ): Promise<void> {
    const race = prefetched ?? (await this.races.getRace(raceId));
    const sockets = await this.server.in(raceId).fetchSockets();

    for (const socket of sockets) {
      const viewerId = socket.data.userId;
      socket.emit(ServerEvent.STATE, this.stateFor(race, status, viewerId));
    }
  }

  /** The `race:state` payload as one specific viewer should see it. */
  private stateFor(
    race: RaceWithCompetitors,
    status: WireStatus,
    viewerId: string,
  ): RaceStatePayload {
    const isParticipant = race.competitors.some((c) => c.userId === viewerId);

    const players: StatePlayer[] = race.competitors.map((c) => ({
      user_id: c.userId,
      display_name: c.displayName,
      country: c.country,
      ready: c.ready,
      is_me: c.userId === viewerId,
      // Presence is a live fact; a competitor with a socket in the room is
      // connected. During a grace window their socket is gone but the row
      // remains, so this reads false until they reconnect.
      connected: true,
    }));

    const payload: RaceStatePayload = {
      race_id: race.id,
      status,
      event: race.event,
      players,
    };
    // A private room's code is an invite; only a participant may read it back.
    if (race.code && race.mode === 'private' && isParticipant) {
      payload.code = race.code;
    }
    return payload;
  }

  // ------------------------------------------------------------- reconnect

  /** On reconnect, re-seat a user into their active race and cancel the DNF timer. */
  private async tryResumeActiveRace(socket: RaceSocket, userId: string): Promise<void> {
    const race = await this.races.findActiveRaceForUser(userId).catch(() => null);
    if (!race) return;

    socket.data.raceId = race.id;
    await socket.join(race.id);

    // They came back inside the window: cancel the pending DNF.
    const key = this.graceKey(race.id, userId);
    const timer = this.graceTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.graceTimers.delete(key);
      this.logger.log(`User ${userId} reconnected to race ${race.id}; grace cancelled`);
    }

    const phase = (await this.rooms.getPhase(race.id)) ?? this.phaseFromStatus(race.status);
    await this.emitStateToRoom(race.id, phase, race);
  }

  /** Map a persisted DB status to the wire phase (the DB has no `ready-check`). */
  private phaseFromStatus(status: RaceWithCompetitors['status']): WireStatus {
    return status;
  }

  // ---------------------------------------------------------------- helpers

  private graceKey(raceId: string, userId: string): string {
    return `${raceId}:${userId}`;
  }

  /**
   * The per-user Socket.IO room every one of a user's sockets joins at connect.
   * It is how the gateway addresses (`race:result`) or excludes
   * (`opponent_progress`) a *user* rather than a socket, across instances.
   */
  private userRoom(userId: string): string {
    return `user:${userId}`;
  }

  /** Emit one event to just one user's sockets — the per-recipient path. */
  private emitToUser(_raceId: string, userId: string, event: string, payload: unknown): void {
    this.server.to(this.userRoom(userId)).emit(event, payload);
  }

  private extractToken(socket: RaceSocket): string | null {
    const auth = socket.handshake.auth as { token?: unknown } | undefined;
    if (auth && typeof auth.token === 'string' && auth.token.length > 0) return auth.token;

    const header = socket.handshake.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7);
    return null;
  }

  private refuse(socket: RaceSocket, reason: string): void {
    this.logger.warn(`Refusing socket ${socket.id}: ${reason}`);
    const payload: RaceErrorPayload = { code: 'unauthorized', message: reason };
    socket.emit(ServerEvent.ERROR, payload);
    socket.disconnect(true);
  }

  private emitError(socket: RaceSocket, err: unknown): void {
    const payload: RaceErrorPayload = this.errorShape(err);
    socket.emit(ServerEvent.ERROR, payload);
  }

  private errorShape(err: unknown): { code: string; message: string } {
    if (err && typeof err === 'object') {
      const response = (err as { response?: unknown }).response;
      if (response && typeof response === 'object' && 'code' in response) {
        const r = response as { code?: string; message?: string };
        return { code: r.code ?? 'error', message: r.message ?? 'Request failed' };
      }
      if ('code' in err && 'message' in err) {
        const r = err as { code?: string; message?: string };
        return { code: r.code ?? 'error', message: r.message ?? 'Request failed' };
      }
    }
    return { code: 'error', message: 'Request failed' };
  }
}
