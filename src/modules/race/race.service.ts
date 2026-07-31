import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { ErrorCode } from '../../common/errors/error-codes';
import { EloOutcome, eloDelta } from '../../db/sql/elo';
import { Race, RaceParticipant } from '../../db/schema';
import { findEvent, isQuickMatch, isRaceable } from '../../domain/wca-events';
import { generateInviteCode } from './invite-code';
import { ParticipantSettlement, RaceHistoryPage, RaceRepository } from './race.repository';
import { RaceWithCompetitors } from './race.types';

/**
 * §11.1 — **the grace window is 30 seconds.** The spec leaves it open and asks
 * for a named value. Thirty seconds is the conservative pick: it comfortably
 * outlasts a phone flipping cell-to-Wi-Fi or a background/foreground bounce
 * (single-digit seconds), while staying *under* the client's 20-second silence
 * watchdog's... no — deliberately *over* it, so the watchdog on the client stays
 * a backstop and the server's timer is the real mechanism (spec §10). Past 30s a
 * dropped player is settled as `left` and the opponent wins. The REST layer does
 * not run this timer — it is the gateway's — but the constant lives here because
 * settlement (which the service owns) consumes it, and one module should not own
 * a rule the other has to re-declare.
 */
export const DISCONNECT_GRACE_MS = 30_000;

/** A room is exactly two players — 1v1 (spec §4: "advance when two are present"). */
export const RACE_CAPACITY = 2;

/** How many fresh codes to try before giving up on a private room (astronomically unreachable). */
const MAX_CODE_ATTEMPTS = 5;

/** The two ready flags flipped, ready to advance out of ready-check. */
export interface ReadyState {
  race: RaceWithCompetitors;
  allReady: boolean;
}

/** One player's validated finish, as the gateway hands it to `submitTime`. */
export interface FinishInput {
  timeMs: number;
  penalty: RaceParticipant['penalty'];
  finishedAt: Date;
}

/** The settlement the gateway asks the service to persist, before Elo is applied. */
export interface SettlementInput {
  /** userId → their adjudicated outcome and (validated) time. Exactly two entries. */
  results: {
    userId: string;
    result: NonNullable<RaceParticipant['result']>;
    timeMs: number | null;
    penalty: RaceParticipant['penalty'];
  }[];
}

/**
 * The rules of the race lobby, and the transitions the gateway drives.
 *
 * The controller is the REST half (create, join, read, history); the Socket.IO
 * gateway is the real-time half (ready, countdown, submit, settle). **Both call
 * this class** — it is the single owner of what a legal transition is, so the
 * two transports cannot disagree about, say, whether a settled room can still be
 * joined. The repository moves rows; this decides whether they may move.
 *
 * Everything the gateway needs is a public method here or a type this module
 * exports. Nothing about matchmaking, capacity, code minting, anti-cheat
 * validation or Elo lives in a gateway — that would put the server's authority
 * in the transport, where a second transport could contradict it.
 */
@Injectable()
export class RaceService {
  constructor(private readonly repository: RaceRepository) {}

  // ------------------------------------------------------- REST: create / join

  /**
   * Open a room. Quick match enqueues (no code); private mints a shareable code.
   *
   * The scramble is minted now and stored to satisfy the NOT NULL column, but it
   * is **not revealed here** — the gateway reveals it at countdown with a
   * server-stamped baseline (spec §4). The lobby read never returns it.
   */
  async createRoom(
    userId: string,
    input: { mode: 'quick' | 'private'; event: string },
  ): Promise<{ race: Race }> {
    this.assertRaceable(input.event, input.mode);

    const base = {
      event: input.event,
      mode: input.mode,
      createdBy: userId,
      scramble: this.mintScramble(input.event),
    } as const;

    if (input.mode === 'quick') {
      // Quick match has no code — it joins the matchmaking queue rather than
      // being shared. Pairing is longest-waiting FIFO (see §11.3 below).
      const race = await this.repository.createRoom({ ...base, code: null });
      return { race };
    }

    return { race: await this.createPrivateRoomWithCode(base) };
  }

  /**
   * Join a private room by its code, seating the caller as the second player.
   *
   * The lookup filters on status (`findActiveByCode`), so a code that a settled
   * room released back into the pool resolves to null here, not to the finished
   * race — the join-a-settled-room failure mode the spec calls out. A full room
   * (already two players) or joining your own room are both rejected.
   */
  async joinByCode(userId: string, code: string): Promise<RaceWithCompetitors> {
    const race = await this.repository.findActiveByCode(code);
    if (!race) throw this.roomNotFound();

    // A joinable room is a waiting one; a countdown/racing room has its two and
    // has moved on, and a settled one never reaches here (filtered above).
    if (race.status !== 'waiting') {
      throw new ConflictException({
        code: ErrorCode.CONFLICT,
        message: 'This race has already started',
      });
    }

    const seats = await this.repository.countParticipants(race.id);
    // The host already holds a seat. `>= capacity` means the room is full.
    if (seats >= RACE_CAPACITY) {
      // A re-join by the host or the existing second player is not "full" — let
      // the idempotent seating below return their existing seat instead.
      const already = await this.isParticipant(race.id, userId);
      if (!already) {
        throw new ConflictException({ code: ErrorCode.CONFLICT, message: 'This race is full' });
      }
    }

    // `seated === false` here means the caller already held a seat — an
    // idempotent re-join, not an error. Either way, return the room as it now
    // stands.
    await this.repository.addParticipant(race.id, userId);

    return this.requireRace(race.id);
  }

  // --------------------------------------------------------------- REST: reads

  /** One race with its competitors, or 404. The `code` leak is handled in the DTO mapper. */
  async getRace(raceId: string): Promise<RaceWithCompetitors> {
    return this.requireRace(raceId);
  }

  /**
   * The user's current in-flight race, or null — the gateway's reconnect lookup.
   *
   * A guarded read like `getRace`, but keyed on the user rather than a race id,
   * because on a socket reconnect the client has re-authenticated (so we know
   * *who*) but may not know *which* room — quick match has no code to re-send.
   * The rule "a user is in at most one live race" is the repository's; the
   * service exposes it so the gateway shares the same source of truth REST does.
   */
  findActiveRaceForUser(userId: string): Promise<RaceWithCompetitors | null> {
    return this.repository.findActiveRaceForUser(userId);
  }

  /** The caller's race history, newest first, cursor-paginated. */
  history(
    userId: string,
    options: { cursor?: string | null; limit?: number },
  ): Promise<RaceHistoryPage> {
    return this.repository.findHistory(userId, options);
  }

  // ------------------------------------------ gateway-driven state transitions
  //
  // The Socket.IO gateway calls the four methods below; they are the reason the
  // service is exported. Each is a guarded transition, not a raw write.

  /**
   * Flip a player's ready flag and report whether *both* are now ready.
   *
   * The gateway uses `allReady` to decide when to advance ready-check → countdown
   * (spec §4). The flag itself is broadcast as `race:ready_update`; that fan-out
   * is the gateway's job, but the truth of it is written here.
   */
  async markReady(raceId: string, userId: string, ready: boolean): Promise<ReadyState> {
    const ok = await this.repository.setReady(raceId, userId, ready);
    if (!ok) throw this.notParticipant();

    const race = await this.requireRace(raceId);
    const allReady =
      race.competitors.length === RACE_CAPACITY && race.competitors.every((c) => c.ready);

    return { race, allReady };
  }

  /**
   * Persist one player's finish — the durable record behind `solve:stop`.
   *
   * **The gateway validates `client_time_ms` against the server's scramble-reveal
   * stamp before calling this** (spec §5); the service persists the already-
   * validated `timeMs`. Idempotent: a duplicate submit (already finished) writes
   * nothing and returns `recorded: false`, mirroring the "ignore duplicate
   * solve:stop" rule so a retried socket event cannot overwrite a time.
   */
  async submitTime(
    raceId: string,
    userId: string,
    finish: FinishInput,
  ): Promise<{ recorded: boolean }> {
    return this.repository.recordFinish(raceId, userId, finish);
  }

  /**
   * Settle a race: freeze results, pay out Elo, stamp `settled_at`.
   *
   * The gateway decides the *outcome* (who won, who DNF'd, who left) from the
   * validated finishes it collected, and hands them here. The service owns the
   * *rating* consequence — it reads both current ratings and computes each
   * player's signed delta from `src/db/sql/elo.ts`, so a client can never
   * influence the number. Idempotent: a second settle of the same room is a
   * no-op (`settled: false`) rather than a double Elo payout.
   *
   * Returns the per-player Elo deltas the gateway needs for `race:result`
   * (`elo_delta` is that recipient's own signed delta, spec §3).
   */
  async settle(
    raceId: string,
    input: SettlementInput,
  ): Promise<{ settled: boolean; eloByUser: Record<string, number> }> {
    const race = await this.requireRace(raceId);

    const byId = new Map(race.competitors.map((c) => [c.userId, c]));
    const settlements: ParticipantSettlement[] = [];
    const eloByUser: Record<string, number> = {};

    for (const r of input.results) {
      const me = byId.get(r.userId);
      if (!me) {
        throw new BadRequestException({
          code: ErrorCode.VALIDATION_FAILED,
          message: `User ${r.userId} is not a participant of this race`,
        });
      }
      const opponent = race.competitors.find((c) => c.userId !== r.userId);
      // A 1v1 always has an opponent; a solo settle (opponent never joined)
      // pays out no rating — there is nobody to rate against.
      const delta = opponent ? eloDelta(me.elo, opponent.elo, toEloOutcome(r.result)) : 0;

      eloByUser[r.userId] = delta;
      settlements.push({
        userId: r.userId,
        result: r.result,
        timeMs: r.timeMs,
        penalty: r.penalty,
        eloDelta: delta,
      });
    }

    const { settled } = await this.repository.settle(raceId, settlements);
    // Lost the settle race to another worker: their Elo stands, not ours.
    return { settled, eloByUser: settled ? eloByUser : {} };
  }

  /** Move a room's status — the gateway drives waiting → countdown → racing. */
  async advanceStatus(raceId: string, status: Race['status']): Promise<void> {
    await this.repository.setStatus(raceId, status);
  }

  // --------------------------------------------------------------- internals

  private async createPrivateRoomWithCode(base: {
    event: string;
    mode: 'quick' | 'private';
    createdBy: string;
    scramble: string;
  }): Promise<Race> {
    // The partial unique index enforces code uniqueness among *active* rooms; a
    // collision throws 23505. It is astronomically unlikely (32^6 codes vs a
    // handful of live rooms) but not impossible, so retry with a fresh code
    // rather than surface a 500. Bounded, because an unbounded loop on a
    // genuinely-exhausted pool would hang the request.
    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
      try {
        return await this.repository.createRoom({ ...base, code: generateInviteCode() });
      } catch (error) {
        if (isUniqueViolation(error) && attempt < MAX_CODE_ATTEMPTS - 1) continue;
        throw error;
      }
    }
    // Unreachable: the loop either returns or throws on the last attempt.
    throw new ConflictException({
      code: ErrorCode.CONFLICT,
      message: 'Could not allocate a room code, please retry',
    });
  }

  private async isParticipant(raceId: string, userId: string): Promise<boolean> {
    const race = await this.repository.findWithCompetitors(raceId);
    return race?.competitors.some((c) => c.userId === userId) ?? false;
  }

  private async requireRace(raceId: string): Promise<RaceWithCompetitors> {
    const race = await this.repository.findWithCompetitors(raceId);
    if (!race) throw this.roomNotFound();
    return race;
  }

  /**
   * Reject an event a room cannot host.
   *
   * Two tiers, per spec §9: `raceable` gates a private room (every NxN plus
   * One-Handed), and `quickMatch` narrows the queue further to `2x2` / `3x3` /
   * `3x3-oh` — a random 6×6 queue is realistically empty, so we refuse it up
   * front rather than enqueue a match that never fills. An unknown event id is a
   * 400 with the `unknown_event` code, distinct from a known-but-not-raceable
   * one, so the client can tell "no such event" from "not here".
   */
  private assertRaceable(event: string, mode: 'quick' | 'private'): void {
    if (!findEvent(event)) {
      throw new BadRequestException({
        code: ErrorCode.UNKNOWN_EVENT,
        message: `Unknown event '${event}'`,
      });
    }
    if (!isRaceable(event)) {
      throw new BadRequestException({
        code: ErrorCode.EVENT_NOT_RACEABLE,
        message: `Event '${event}' cannot be raced`,
      });
    }
    if (mode === 'quick' && !isQuickMatch(event)) {
      throw new BadRequestException({
        code: ErrorCode.EVENT_NOT_RACEABLE,
        message: `Event '${event}' is not available for quick match; open a private room instead`,
      });
    }
  }

  /**
   * A placeholder scramble for the room row.
   *
   * The real scrambler (`ScrambleModule`) is not built yet, and the *revealed*
   * scramble is the gateway's to stamp at countdown anyway (spec §4). This mints
   * a syntactically-plausible per-event string so the NOT NULL column is
   * honoured and the byte-for-byte contract (`\n` significant, never trimmed) is
   * exercised end to end. When the scrambler lands, room creation calls it here;
   * nothing else changes.
   */
  private mintScramble(event: string): string {
    const spec = findEvent(event);
    // A short, deterministic-length token — enough to be non-empty and typed.
    // Megaminx's newline-per-line shape is preserved as the canonical example
    // that whitespace is never collapsed.
    if (event === 'megaminx') {
      return "R++ D++ R-- D++ R++ D-- U'\nR++ D++ R-- D++ R++ D-- U'";
    }
    return spec ? `SCRAMBLE ${event} ${Date.now().toString(36).toUpperCase()}` : 'SCRAMBLE';
  }

  private roomNotFound(): NotFoundException {
    return new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Race not found' });
  }

  private notParticipant(): NotFoundException {
    // 404, not 403: a caller who is not in the room is told the room is not
    // theirs to touch without confirming it exists — the same existence-hiding
    // rule the solves module uses.
    return new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Race not found' });
  }
}

/** A win rates as a win; a DNF and a walkout both rate as a loss (see `elo.ts` §11.2). */
function toEloOutcome(result: NonNullable<RaceParticipant['result']>): EloOutcome {
  return result === 'win' ? 'win' : 'loss';
}

/** True when the error is a Postgres unique-constraint violation (SQLSTATE 23505). */
function isUniqueViolation(error: unknown): boolean {
  const cause = error instanceof Error && error.cause != null ? error.cause : error;
  return (
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    (cause as { code?: string }).code === '23505'
  );
}
