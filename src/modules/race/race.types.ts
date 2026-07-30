import { Race, RaceParticipant, User } from '../../db/schema';

/**
 * One competitor in a race — a `race_participants` row joined to the
 * `users` row it points at.
 *
 * This shape only exists on the *read* side. There is no `competitors` column
 * on `races`, and deliberately so: `race_participants` already **is** the
 * competitor list, and it is the only place a competitor's result can live
 * without duplicating it. A parallel array on `races` would either repeat
 * `time_ms` / `penalty` / `result` (two sources of truth, and nothing stopping
 * them from disagreeing) or hold bare user ids, which would still need this
 * join to render a single row of the results screen.
 *
 * What the array buys us is the shape the client and the stats layer want,
 * composed in one query. See `RaceRepository`.
 */
export interface Competitor {
  /** Identity, from `users`. */
  userId: string;
  displayName: string;
  country: string | null;
  elo: number;

  /** Performance, from `race_participants`. */
  ready: boolean;
  timeMs: number | null;
  penalty: RaceParticipant['penalty'];
  /** Null until the race settles. Server-owned. */
  result: RaceParticipant['result'];
  finishedAt: Date | null;

  /** True for the competitor who opened the room. */
  isHost: boolean;
}

/** A race as the lobby, the results screen and race history all want it. */
export interface RaceWithCompetitors extends Race {
  competitors: Competitor[];
}

/** A user's record against one opponent, across every race they both entered. */
export interface HeadToHead {
  opponentId: string;
  opponentDisplayName: string;
  /** Settled races where this user has a result. `wins + losses + dnf + abandoned`. */
  played: number;
  wins: number;
  losses: number;
  /** Counted separately: a DNF is not a loss on the clock, it is a non-result. */
  dnf: number;
  /** Walked out mid-race (`result = 'left'`). Also not a loss on the clock. */
  abandoned: number;
  /** Best single by each side across the head-to-head, in ms. Null if never set. */
  bestTimeMs: number | null;
  opponentBestTimeMs: number | null;
  lastRaceAt: Date | null;
}

/** Row shape returned by the competitor join before grouping. */
export interface RaceCompetitorRow {
  race: Race;
  participant: RaceParticipant;
  user: Pick<User, 'id' | 'displayName' | 'country' | 'elo'>;
}
