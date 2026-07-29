/**
 * The leaderboard read model — the domain shape the service and controller
 * speak. The wire shape (snake_case, `event` echoed onto every row) is derived
 * from this in the DTO layer; nothing below the DTO knows the JSON casing.
 */

/** Which ranking value a row is ranked on. Only `single` is implemented. */
export type LeaderboardMetric = 'single' | 'ao5' | 'ao12';

/** Whose results the board covers. */
export type LeaderboardScope = 'global' | 'friends' | 'country';

/**
 * One ranked competitor.
 *
 * `rank` is `RANK()` over the scope, so ties share a place. `valueMs` is the
 * event's **ranking key** (a `+2` folded in, a DNF excluded entirely), not the
 * raw `time_ms`. `solvedAt` is when that ranking attempt was set. `country` is
 * the alpha-2 code and stays nullable — mapping it to a display name is the
 * client's job.
 */
export interface LeaderboardEntry {
  rank: number;
  userId: string;
  displayName: string;
  country: string | null;
  valueMs: number;
  solvedAt: Date;
}

/**
 * A page of the board plus the viewer's own row.
 *
 * `viewer` is a separate field rather than an item flag: the viewer's rank is
 * almost never on page 1, so folding it into `items` would mean a second
 * request or a lie about pagination. It is null when the viewer is unknown or
 * has no ranked attempt in this scope.
 */
export interface LeaderboardPage {
  items: LeaderboardEntry[];
  nextCursor: string | null;
  viewer: LeaderboardEntry | null;
}

export interface LeaderboardQuery {
  event: string;
  scope: LeaderboardScope;
  viewerId: string | null;
  cursor?: string | null;
  limit?: number;
}
