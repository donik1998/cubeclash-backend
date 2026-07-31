import { RaceParticipant } from '../../db/schema';

/**
 * Who won — the pure ranking behind settlement (spec §5).
 *
 * Kept out of the gateway so it is a total function with no sockets, no clock and
 * no `db`: the gateway *collects* the finishes and *announces* the outcome, but
 * the rule for turning two finishes into a win/loss/dnf/left is here, where it is
 * trivially unit-testable. The gateway then hands the result to `RaceService`,
 * which owns the Elo consequence — this function never touches a rating.
 *
 * The server decides; the client renders (spec §5). Nothing a client sends
 * reaches this function except the already-*validated* `timeMs` (the anti-cheat
 * floor ran before persistence), so a doctored time cannot reach the ranking.
 */

/** One competitor's finish, as adjudication needs it. */
export interface Finish {
  userId: string;
  /** Validated finish time in ms, or null if they never posted one. */
  timeMs: number | null;
  penalty: RaceParticipant['penalty'];
}

/** The adjudicated result for one competitor, ready for `RaceService.settle`. */
export interface Adjudicated {
  userId: string;
  result: NonNullable<RaceParticipant['result']>;
  timeMs: number | null;
  penalty: RaceParticipant['penalty'];
}

/**
 * A reason to force a competitor to lose regardless of the clock: `dnf` (a DNF
 * penalty, or a finish with no valid time) or `left` (walked out / timed out on
 * the grace window). `null` means "rank this one on time".
 */
export type ForcedLoss = (finish: Finish) => 'dnf' | 'left' | null;

/**
 * Rank a set of finishes into results.
 *
 *  - A forced `left` is a walkout; a forced `dnf`, a DNF penalty, or a null time
 *    all rank as *no valid time* and lose on the clock.
 *  - Among competitors with a valid time, the strictly fastest wins; the rest
 *    lose.
 *  - If nobody has a valid time (both DNF'd / left), everyone gets their forced
 *    or `dnf` result and there is no `win` — `RaceService` still rates each
 *    against their opponent, which is why a mutual DNF is not a no-op.
 *
 * A tie at millisecond precision is vanishingly unlikely; the sort is stable, so
 * the first-listed of an exact tie is credited the win rather than freezing both
 * ratings with a draw (the spec's DNF-as-loss stance rejects the analogous
 * ratings-freeze).
 */
export function adjudicate(finishes: Finish[], forced: ForcedLoss): Adjudicated[] {
  const scored = finishes.map((f) => {
    const reason = forced(f);
    const valid = reason === null && f.penalty !== 'dnf' && f.timeMs !== null;
    return { finish: f, reason, valid };
  });

  const winner = scored
    .filter((s) => s.valid)
    .sort((a, b) => (a.finish.timeMs as number) - (b.finish.timeMs as number))[0];

  return scored.map((s) => {
    let result: NonNullable<RaceParticipant['result']>;
    if (s.reason === 'left') result = 'left';
    else if (!s.valid) result = 'dnf';
    else if (winner && s.finish.userId === winner.finish.userId) result = 'win';
    else result = 'loss';

    return {
      userId: s.finish.userId,
      result,
      timeMs: s.finish.timeMs,
      penalty: s.finish.penalty,
    };
  });
}
