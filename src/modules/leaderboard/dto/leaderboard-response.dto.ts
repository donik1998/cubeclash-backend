import { LeaderboardEntry, LeaderboardPage } from '../leaderboard.types';

/**
 * The wire shape, per API Design § `GET /leaderboard`.
 *
 * snake_case, and `event` is echoed onto every row so a client that fans a
 * single row out to a widget never has to thread the query event alongside it.
 * `country` is the alpha-2 code, nullable; `value_ms` is the ranking key.
 */
export interface LeaderboardItemDto {
  rank: number;
  user_id: string;
  display_name: string;
  country: string | null;
  value_ms: number;
  event: string;
  solved_at: string;
}

export interface LeaderboardResponseDto {
  items: LeaderboardItemDto[];
  /** null on the last page. */
  next_cursor: string | null;
  /** The viewer's own row, or null if unknown / no ranked attempt. */
  viewer: LeaderboardItemDto | null;
}

function toItem(entry: LeaderboardEntry, event: string): LeaderboardItemDto {
  return {
    rank: entry.rank,
    user_id: entry.userId,
    display_name: entry.displayName,
    country: entry.country,
    value_ms: entry.valueMs,
    event,
    solved_at: entry.solvedAt.toISOString(),
  };
}

/** Domain page → wire response. The only place the JSON casing is decided. */
export function toResponse(page: LeaderboardPage, event: string): LeaderboardResponseDto {
  return {
    items: page.items.map((entry) => toItem(entry, event)),
    next_cursor: page.nextCursor,
    viewer: page.viewer ? toItem(page.viewer, event) : null,
  };
}
