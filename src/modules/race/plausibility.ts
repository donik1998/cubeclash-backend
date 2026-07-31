/**
 * The anti-cheat floor — spec §5, §11.4.
 *
 * REST never sees `client_time_ms`; the gateway does, and it is the *only* layer
 * that can measure a reported solve against the moment the scramble was revealed.
 * So the plausibility floor lives here, not in the service, and the reveal stamp
 * it is measured against is the one the gateway writes into Redis at countdown.
 *
 * ## What we can and cannot check
 *
 * The server owns two timestamps: when it revealed the scramble, and when it
 * received `solve:stop`. Everything the anti-cheat can assert is bounded by those:
 *
 *  1. **A time cannot end before the scramble was revealed.** If `revealAt +
 *     client_time_ms` lands before `revealAt` — i.e. a *negative* or zero
 *     reported time — the client is lying about the frame it started in. Rejected
 *     outright.
 *  2. **A time cannot be faster than a human has ever solved the event.** A 2×2
 *     in 200 ms is a macro, not a solve. Each event has a floor set *below* the
 *     current world record with generous headroom, because the cost of a false
 *     reject (a legitimate world-class solve refused) is far worse than letting a
 *     merely-implausible-but-not-impossible time through to be caught by the
 *     wall-clock check below.
 *  3. **A reported time cannot exceed the wall-clock elapsed since reveal** (plus
 *     a network/clock-skew slack). You cannot have solved in 8 s if only 3 s of
 *     real time have passed since the scramble appeared. This is the check that
 *     actually catches a doctored `client_time_ms`, because unlike the per-event
 *     floor it has no honest headroom to hide behind — the server's own clock is
 *     the ceiling.
 *
 * We deliberately do **not** enforce an *upper* per-event bound (a "too slow"
 * check): a beginner genuinely can take five minutes on a 3×3, and the wall-clock
 * bound already stops a time claiming to be shorter than reality. Slowness is not
 * cheating.
 *
 * The floors are read off the client's `_plausibleTimeMs` distribution in
 * `fake_race_gateway.dart` and the real WCA single-solve world records as of
 * 2025, then halved-and-rounded-down so a record-breaking solve is never
 * refused. They are intentionally *loose*: this is a floor, not an adjudicator.
 */

/**
 * Per-event lower bound on a plausible single solve, in milliseconds.
 *
 * Set comfortably below each event's human world record — roughly half — so the
 * check only ever fires on a time no human could produce (a scripted/macro
 * submission), never on a real, even world-class, solve. An event absent from
 * this map falls back to {@link DEFAULT_FLOOR_MS}.
 */
export const EVENT_FLOOR_MS: Readonly<Record<string, number>> = {
  // WR singles ≈ 0.4–0.5 s (2x2), ~3.1 s (3x3), ~6 s OH. Floors sit at ~half.
  '2x2': 200,
  '3x3': 1_500,
  '3x3-oh': 3_000,
  '4x4': 8_000,
  '5x5': 15_000,
  '6x6': 30_000,
  '7x7': 45_000,
  clock: 2_000,
  megaminx: 12_000,
  pyraminx: 800,
  skewb: 800,
  'square-1': 2_000,
};

/**
 * The fallback floor for a raceable event without an explicit entry above.
 * One second is below any non-trivial puzzle's human record, so it errs toward
 * accepting rather than falsely rejecting.
 */
export const DEFAULT_FLOOR_MS = 1_000;

/**
 * Slack added to the wall-clock ceiling to absorb network latency and modest
 * clock skew between the client's stopwatch and the server's receipt.
 *
 * `solve:stop` travels a round trip and the client's local clock is not the
 * server's, so a reported time a little larger than the server-measured elapsed
 * is honest, not a lie. 750 ms comfortably covers a bad mobile RTT without
 * opening a window wide enough to fake a solve in.
 */
export const WALL_CLOCK_SLACK_MS = 750;

/** Why a reported time was refused — surfaced to the client so it can render it. */
export type PlausibilityRejection =
  'non_positive' | 'faster_than_humanly_possible' | 'before_reveal' | 'exceeds_elapsed';

export interface PlausibilityResult {
  ok: boolean;
  reason?: PlausibilityRejection;
}

/** The per-event floor, or the default for an unlisted raceable event. */
export function floorFor(event: string): number {
  return EVENT_FLOOR_MS[event] ?? DEFAULT_FLOOR_MS;
}

/**
 * Validate a client-reported solve against server authority (spec §5).
 *
 * Pure and total: no clock reads, no I/O — the caller passes the server's own
 * `revealAtMs` (when it stamped the scramble) and `receivedAtMs` (when
 * `solve:stop` arrived), so this is trivially unit-testable and the gateway
 * stays the only thing that touches the clock.
 */
export function checkPlausibility(input: {
  event: string;
  clientTimeMs: number;
  revealAtMs: number;
  receivedAtMs: number;
}): PlausibilityResult {
  const { event, clientTimeMs, revealAtMs, receivedAtMs } = input;

  // A time must be a positive, finite number of milliseconds.
  if (!Number.isFinite(clientTimeMs) || clientTimeMs <= 0) {
    return { ok: false, reason: 'non_positive' };
  }

  // No human has solved this event this fast — it is a macro, not a solve.
  if (clientTimeMs < floorFor(event)) {
    return { ok: false, reason: 'faster_than_humanly_possible' };
  }

  // The receipt cannot precede the reveal (a clock ran backwards / spoofed).
  const elapsed = receivedAtMs - revealAtMs;
  if (elapsed < 0) {
    return { ok: false, reason: 'before_reveal' };
  }

  // The reported solve cannot be longer than the real time that has passed since
  // the scramble was revealed. This is the check a doctored client_time_ms fails.
  if (clientTimeMs > elapsed + WALL_CLOCK_SLACK_MS) {
    return { ok: false, reason: 'exceeds_elapsed' };
  }

  return { ok: true };
}
