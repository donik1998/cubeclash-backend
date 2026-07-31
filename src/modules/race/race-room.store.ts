import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';

import { REDIS } from '../../common/redis/redis.module';

/**
 * The in-flight room state a race needs but Postgres has no business holding.
 *
 * ## Why Redis, and what exactly lives here
 *
 * Postgres is the durable record — `races` + `race_participants`, who won, what
 * time, what Elo moved. But a race in progress has ephemeral facts that are only
 * meaningful for the ~30 seconds it is live and would be noise as columns:
 *
 *  - the **scramble-reveal stamp**, the anti-cheat baseline the gateway writes
 *    at countdown (spec §4/§5). It is server-owned, single-use, and gone once
 *    the room settles — a textbook piece of hot state.
 *  - the **ephemeral `ready-check` sub-status**. The DB `race_status` enum has no
 *    `ready-check` — it is `waiting | countdown | racing | settled`. The wire
 *    protocol *does* have it, and three clients parse it. So it lives here as a
 *    gateway-only overlay on `waiting`, emitted in `race:state` but never passed
 *    to `advanceStatus` (which would violate the enum).
 *  - a **settling latch**, so two instances expiring the same grace window (or a
 *    disconnect racing a final submit) cannot both drive settlement. The DB
 *    `settle` is already idempotent, but latching here avoids even attempting a
 *    double payout and the double `race:result` fan-out that would follow.
 *
 * Putting this in Redis rather than process memory is the whole reason the race
 * tier scales: any instance can serve any socket because the room's live state
 * is not pinned to the box that created it (spec §6).
 *
 * ## Key design
 *
 * One hash per room, `race:room:{raceId}`, with a TTL so a room that is
 * abandoned before it settles cannot leak state forever. Fields:
 *
 *  - `phase`            — the ephemeral gateway phase (see {@link RoomPhase}).
 *  - `revealAt`         — ms epoch the scramble was revealed; the anti-cheat baseline.
 *  - `settling`         — `"1"` once a settlement pass has been claimed (the latch).
 *
 * A hash (not one key per field) so the whole room reads/clears in a single round
 * trip, and so the TTL covers every field at once. `raceId` is in the key, never
 * a field, because it is the identity — a fact about *which* room, not a fact
 * *within* it (Rule 0: the key is the entity, fields are facts about it).
 */

/**
 * The gateway phase, which is a superset of the DB `race_status`: it adds the
 * ephemeral `ready-check` the enum deliberately omits. `waiting` here means "in
 * the room, not yet in ready-check"; `ready-check` means "both seated, flipping
 * ready flags". Everything from `countdown` on mirrors the DB status 1:1.
 */
export type RoomPhase = 'waiting' | 'ready-check' | 'countdown' | 'racing' | 'settled';

/** How long an in-flight room's Redis state survives with no activity. */
const ROOM_TTL_SECONDS = 10 * 60;

@Injectable()
export class RaceRoomStore {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  private key(raceId: string): string {
    return `race:room:${raceId}`;
  }

  /** Set (or overwrite) the ephemeral phase and refresh the room's TTL. */
  async setPhase(raceId: string, phase: RoomPhase): Promise<void> {
    await this.redis.hset(this.key(raceId), 'phase', phase);
    await this.redis.expire(this.key(raceId), ROOM_TTL_SECONDS);
  }

  /** The current ephemeral phase, or null if the room has no live state. */
  async getPhase(raceId: string): Promise<RoomPhase | null> {
    const phase = await this.redis.hget(this.key(raceId), 'phase');
    return (phase as RoomPhase | null) ?? null;
  }

  /**
   * Stamp the scramble-reveal instant — the anti-cheat baseline (spec §5).
   *
   * `NX` so a re-emitted countdown (a reconnect mid-countdown, a retried GO)
   * cannot move the baseline once set; the first reveal is the one every
   * plausibility check measures against. Returns the effective reveal time,
   * whether just written or already present.
   */
  async stampReveal(raceId: string, atMs: number): Promise<number> {
    const set = await this.redis.hsetnx(this.key(raceId), 'revealAt', String(atMs));
    await this.redis.expire(this.key(raceId), ROOM_TTL_SECONDS);
    if (set === 1) return atMs;
    return this.getRevealAt(raceId).then((v) => v ?? atMs);
  }

  /** The scramble-reveal stamp in ms epoch, or null if not yet revealed. */
  async getRevealAt(raceId: string): Promise<number | null> {
    const raw = await this.redis.hget(this.key(raceId), 'revealAt');
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * Claim the right to settle this room, exactly once.
   *
   * `HSETNX` is the atomic latch: the first caller flips `settling` 0→1 and gets
   * `true`; every subsequent caller (a second instance, a disconnect racing a
   * final submit) gets `false` and must not settle. This is belt-and-braces over
   * the DB's own idempotent `settle`, but it also prevents the *duplicate
   * `race:result` fan-out* the DB guard alone would not stop.
   */
  async claimSettlement(raceId: string): Promise<boolean> {
    const claimed = await this.redis.hsetnx(this.key(raceId), 'settling', '1');
    await this.redis.expire(this.key(raceId), ROOM_TTL_SECONDS);
    return claimed === 1;
  }

  /**
   * Claim the right to record **this participant's** finish, exactly once.
   *
   * The DB's `recordFinish` already guards with `finished_at is null`, so a
   * duplicate can never write *twice*. What that guard cannot decide is *which*
   * of two concurrent submissions wins — and they genuinely are concurrent:
   * Socket.IO delivers a socket's events in order, but the handler is `async`,
   * so two `solve:stop` frames emitted in the same tick interleave freely and
   * both reach the UPDATE with `finished_at` still null. Whichever commits
   * first wins, which is a coin flip.
   *
   * That is a cheat, not a nuisance: fire several `solve:stop` frames with
   * different times and one of them lands, so the submitted time stops being
   * the one the player actually earned. Caught by an e2e that emitted 1800
   * then 1600 and settled on 1600.
   *
   * `HSETNX` makes the *first* arrival the winner deterministically, before any
   * of them reach Postgres. Claimed only for a time that has already passed
   * plausibility, so a rejected submission does not burn the attempt.
   */
  async claimFinish(raceId: string, userId: string): Promise<boolean> {
    const claimed = await this.redis.hsetnx(this.key(raceId), `finished:${userId}`, '1');
    await this.redis.expire(this.key(raceId), ROOM_TTL_SECONDS);
    return claimed === 1;
  }

  /** Drop all live state for a room — called once it has settled or been abandoned. */
  async clear(raceId: string): Promise<void> {
    await this.redis.del(this.key(raceId));
  }
}
