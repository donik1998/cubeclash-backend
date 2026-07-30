/**
 * WCA-style trimmed averages, and the DNF edge cases that make them subtle.
 *
 * An "average of N" is not the arithmetic mean: you **drop the single best and
 * the single worst**, then mean what remains (§2 stats). The DNF handling falls
 * straight out of treating a DNF as *worse than any time*:
 *
 *  - One DNF is the worst result, so it is the value that gets dropped — the
 *    average survives. This is why an ao5 "tolerates one DNF".
 *  - Two or more DNFs mean one is still left after the worst is dropped, and a
 *    real DNF in the trimmed set poisons the mean → the whole average is DNF,
 *    represented on the wire as `null`.
 *  - Fewer solves than the window → `null`, never a partial average.
 *
 * Values are ranking keys (see `ranking.ts`): a number, or `null` for a DNF /
 * unranked attempt. Order-independent — the caller passes chronological values
 * and the slice picks the most recent window; the trim itself sorts.
 */

/** A ranking value per attempt, oldest-first. `null` is a DNF. */
export type RankingValue = number | null;

/**
 * The trimmed average of the most recent `windowSize` values, or `null`.
 *
 * `null` when there are fewer than `windowSize` values, or when two or more of
 * that window are DNFs. Otherwise: take the window, sort with DNF as the worst,
 * drop one best and one worst, and round the mean of the rest.
 */
export function trimmedAverage(values: readonly RankingValue[], windowSize: number): number | null {
  // Below 3 there is nothing left after dropping a best and a worst.
  if (windowSize < 3) return null;
  if (values.length < windowSize) return null;

  const window = values.slice(-windowSize);
  const dnfCount = window.filter((v) => v === null).length;
  if (dnfCount >= 2) return null;

  // DNF sorts last (worst). With at most one DNF, dropping the worst removes it,
  // so the trimmed middle is guaranteed to be all real numbers.
  const sorted = window
    .map((v) => (v === null ? Number.POSITIVE_INFINITY : v))
    .sort((a, b) => a - b);
  const middle = sorted.slice(1, -1);
  const sum = middle.reduce((acc, v) => acc + v, 0);

  return Math.round(sum / middle.length);
}

/**
 * The "session average": a trimmed mean over the *entire* event history, same
 * rules as any `aoN`. Needs at least three solves (best + worst + one), and is
 * DNF per the same one-tolerated rule.
 *
 * NOTE (a decision the spec left open, §6): "session" has no server-side
 * meaning here — there is no `sessions` table by design — so this is the trimmed
 * mean of all recorded solves for the event, which is the only session-free
 * reading consistent with "averages are trimmed means".
 */
export function sessionAverage(values: readonly RankingValue[]): number | null {
  if (values.length < 3) return null;
  return trimmedAverage(values, values.length);
}
