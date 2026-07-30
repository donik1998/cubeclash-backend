import { relations } from 'drizzle-orm';
import { char, index, integer, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';

import { tstz } from './columns';
import { tournamentFormatEnum, tournamentScopeEnum, tournamentStatusEnum } from './enums';
import { users } from './users';

/** Roadmap — modelled now so the schema does not have to move later. */
export const tournaments = pgTable(
  'tournaments',
  {
    id: uuid().primaryKey().defaultRandom(),
    name: text().notNull(),
    format: tournamentFormatEnum().notNull(),
    event: text().notNull(),
    scope: tournamentScopeEnum().notNull().default('global'),
    /** Set when `scope = 'country'`; ISO 3166-1 alpha-2. */
    country: char({ length: 2 }),
    startsAt: tstz().notNull(),
    endsAt: tstz().notNull(),
    status: tournamentStatusEnum().notNull().default('scheduled'),
    createdAt: tstz().notNull().defaultNow(),
  },
  (t) => [index('tournaments_status_starts_at_idx').on(t.status, t.startsAt)],
);

export const tournamentEntries = pgTable(
  'tournament_entries',
  {
    tournamentId: uuid()
      .notNull()
      .references(() => tournaments.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    bestTimeMs: integer(),
    // No `rank` column. Standings are `rank() over (partition by tournament_id
    // order by best_time_ms asc nulls last)` — always current, where a stored
    // rank would need a recompute job every time anyone improves a time, and
    // would be silently stale in between.
    registeredAt: tstz().notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tournamentId, t.userId] }),
    index('tournament_entries_user_idx').on(t.userId),
    index('tournament_entries_leaderboard_idx').on(t.tournamentId, t.bestTimeMs),
  ],
);

export const tournamentsRelations = relations(tournaments, ({ many }) => ({
  entries: many(tournamentEntries),
}));

export const tournamentEntriesRelations = relations(tournamentEntries, ({ one }) => ({
  tournament: one(tournaments, {
    fields: [tournamentEntries.tournamentId],
    references: [tournaments.id],
  }),
  user: one(users, { fields: [tournamentEntries.userId], references: [users.id] }),
}));

export type Tournament = typeof tournaments.$inferSelect;
export type TournamentEntry = typeof tournamentEntries.$inferSelect;
