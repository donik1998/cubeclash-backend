/**
 * The "You · Profile" read model — the domain shape the service speaks. The
 * wire shape (snake_case, `avatar_url` deliberately absent per spec §11.1) is
 * derived from this in the DTO layer; nothing below the DTO knows the JSON
 * casing.
 *
 * This is a **read model**, not new storage: every value here is a query over
 * `users`, `solves`, `race_participants`/`races` and `friendships`, plus the
 * derived leaderboard rank. There is no `profile` table and no new column.
 */

/** Which scope the profile rank is taken from. Mirrors `LeaderboardScope`. */
export type RankScope = 'global' | 'country' | 'friends';

/** The stored facts about the viewer, straight off `users`. */
export interface ProfileUser {
  id: string;
  displayName: string;
  /** Alpha-2 code, nullable. The client maps it to a display name. */
  country: string | null;
  /** Stored, never recomputed for display (path-dependent — see `users.elo`). */
  elo: number;
}

/**
 * The viewer's place on the leaderboard for one `(event, metric, scope)`.
 *
 * Rank in this codebase is per-event and per-scope — there is no single global
 * rank column — so the profile pins the tuple it used and lets the client echo
 * it rather than guess. `metric` is always `single`: it is the only metric the
 * leaderboard implements.
 */
export interface ProfileRank {
  event: string;
  metric: 'single';
  scope: RankScope;
  position: number;
}

/** The three summary tiles plus the counts that back the win-rate tile. */
export interface ProfileStats {
  /** Best single in `bestSingleEvent`, in ms. Null when there is no ranked solve. */
  bestSingleMs: number | null;
  /** Echoes the event `bestSingleMs` is for, so the client never guesses. */
  bestSingleEvent: string;
  /** COUNT of live solves across every event. */
  totalSolves: number;
  /** wins / (wins + losses) over settled races. Null when the denominator is 0. */
  winRate: number | null;
  wins: number;
  losses: number;
}

export interface ProfileView {
  user: ProfileUser;
  /** Null when the viewer has no ranked solve in this event/scope. */
  rank: ProfileRank | null;
  stats: ProfileStats;
  friendCount: number;
}

/** What the controller hands the service. `viewerId` is the request principal. */
export interface ProfileQuery {
  viewerId: string | null;
  event: string;
  rankScope: RankScope;
}
