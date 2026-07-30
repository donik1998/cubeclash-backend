import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Note what is *not* here: `event`.
 *
 * Event ids stay `text` rather than becoming a Postgres enum, because the
 * client is deliberately lenient about unknown ids so that a server which
 * grows an eighteenth event before the client does cannot crash the timer.
 * A DB enum would make every new event a migration and a coordinated deploy.
 * Validation lives in the DTO layer against `src/domain/wca-events.ts`.
 */

/** Where a scramble came from. Surfaces in per-source stats. */
export const scrambleSourceEnum = pgEnum('scramble_source', ['random', 'wca', 'reused']);

/**
 * WCA penalties. `plus2` is a *time* penalty only — it is meaningless on a
 * Fewest Moves move count, and Multi-Blind has no inspection to overrun, so
 * the client hides the control for both. A DNF applies to every event.
 */
export const penaltyEnum = pgEnum('penalty', ['none', 'plus2', 'dnf']);

export const raceModeEnum = pgEnum('race_mode', ['quick', 'private', 'tournament']);

export const raceStatusEnum = pgEnum('race_status', ['waiting', 'countdown', 'racing', 'settled']);

export const raceResultEnum = pgEnum('race_result', ['win', 'loss', 'dnf', 'left']);

export const friendshipStatusEnum = pgEnum('friendship_status', ['pending', 'accepted']);

export const tournamentFormatEnum = pgEnum('tournament_format', ['single', 'double', 'swiss']);

export const tournamentScopeEnum = pgEnum('tournament_scope', ['global', 'country']);

export const tournamentStatusEnum = pgEnum('tournament_status', [
  'scheduled',
  'active',
  'completed',
  'cancelled',
]);
