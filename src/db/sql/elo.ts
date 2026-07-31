/**
 * Elo rating maths for 1v1 race settlement.
 *
 * Kept out of the service so it is a pure function with no `db` and no Nest —
 * trivially unit-testable, and the one place the K-factor and the DNF policy
 * are decided. Both were left open by the spec (§11.2); the choices are named
 * in the constants below and defended in their doc comments.
 *
 * This is deliberately *not* SQL. Elo is path-dependent — the delta depends on
 * both ratings at the instant of the race — so it is computed in application
 * code from the two ratings the settlement transaction already has in hand, and
 * written back as two integer updates inside that same transaction. Pushing it
 * into a query would buy nothing and cost readability.
 */

/**
 * §11.2 — **K = 32.** The classic Elo constant, and the conservative pick: it
 * is what a chess club uses for unrated/provisional players, it moves a rating
 * fast enough that a new racer converges in a handful of games, and it is a
 * number a reviewer recognises on sight rather than having to trust. A
 * rating-bucket-aware K is roadmap, not MVP.
 */
export const ELO_K_FACTOR = 32;

/**
 * §11.2 — **a DNF counts as a loss for rating.** The conservative reading: a
 * race has a winner and a non-winner, and rating tracks who tends to win. A DNF
 * still cost the opponent a completed race, so the opponent is credited the win
 * and the DNF'ing player is debited the loss. `left` (a walkout) is treated
 * identically — leaving is losing, and rating it otherwise would make ragequit
 * a way to protect a rating.
 */

/** The outcome of a race from one player's perspective, for scoring purposes. */
export type EloOutcome = 'win' | 'loss' | 'draw';

/**
 * The expected score for `ratingA` against `ratingB` — the logistic Elo
 * expectation, a number in (0, 1). 0.5 when the ratings are equal; it climbs
 * toward 1 as A out-rates B.
 */
export function expectedScore(ratingA: number, ratingB: number): number {
  return 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
}

/**
 * The signed rating change for a player rated `rating` who scored `actual`
 * (1 win / 0 loss / 0.5 draw) against an opponent rated `opponentRating`.
 *
 * Rounded to an integer because `users.elo` is an `integer` column, and rounded
 * *once* here rather than accumulated as a float — two players' deltas are
 * therefore not guaranteed to be exact mirror images after rounding, which is
 * correct: each player's delta is computed against their own rating.
 */
export function eloDelta(rating: number, opponentRating: number, outcome: EloOutcome): number {
  const actual = outcome === 'win' ? 1 : outcome === 'draw' ? 0.5 : 0;
  return Math.round(ELO_K_FACTOR * (actual - expectedScore(rating, opponentRating)));
}
