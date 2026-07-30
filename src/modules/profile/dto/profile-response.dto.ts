import { ProfileView } from '../profile.types';

/**
 * The wire shape, per spec §6 (`GET /me/profile`).
 *
 * snake_case throughout; times in **ms** not formatted strings; win rate a
 * **ratio** 0..1 not a percent; country an **alpha-2 code** not a name; rank a
 * **number** not "#1,204". All human formatting is the client's job.
 *
 * `avatar_url` is deliberately absent: §11.1 resolved the avatar to a pure
 * initials placeholder with no wire field and no column. Do not add it.
 */
export interface ProfileUserDto {
  id: string;
  display_name: string;
  /** Nullable alpha-2. Client rule: null → drop the country subtitle segment. */
  country: string | null;
  /** Always present (default 1000). Client always renders "Elo {n}". */
  elo: number;
}

export interface ProfileRankDto {
  event: string;
  metric: 'single';
  scope: string;
  position: number;
}

export interface ProfileStatsDto {
  /** Nullable int ms (DNF excluded). Client rule: null → "—". */
  best_single_ms: number | null;
  best_single_event: string;
  total_solves: number;
  /** Nullable ratio 0..1 (null when wins+losses = 0). Client rule: null → "—". */
  win_rate: number | null;
  wins: number;
  losses: number;
}

export interface ProfileResponseDto {
  user: ProfileUserDto;
  /** Nullable object. Client rule: null → drop the "#…" subtitle segment. */
  rank: ProfileRankDto | null;
  stats: ProfileStatsDto;
  friend_count: number;
}

/** Domain view → wire response. The only place the JSON casing is decided. */
export function toResponse(view: ProfileView): ProfileResponseDto {
  return {
    user: {
      id: view.user.id,
      display_name: view.user.displayName,
      country: view.user.country,
      elo: view.user.elo,
    },
    rank: view.rank
      ? {
          event: view.rank.event,
          metric: view.rank.metric,
          scope: view.rank.scope,
          position: view.rank.position,
        }
      : null,
    stats: {
      best_single_ms: view.stats.bestSingleMs,
      best_single_event: view.stats.bestSingleEvent,
      total_solves: view.stats.totalSolves,
      win_rate: view.stats.winRate,
      wins: view.stats.wins,
      losses: view.stats.losses,
    },
    friend_count: view.friendCount,
  };
}
