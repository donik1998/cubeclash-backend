import { relations } from 'drizzle-orm';
import { char, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { citext, tstz } from './columns';
import { friendships } from './social';
import { raceParticipants, races } from './races';
import { solves } from './solves';
import { tournamentEntries } from './tournaments';

export const users = pgTable(
  'users',
  {
    id: uuid().primaryKey().defaultRandom(),
    email: citext().notNull(),
    passwordHash: text().notNull(),
    displayName: text().notNull(),
    /** ISO 3166-1 alpha-2, for country-scoped leaderboards. Optional. */
    country: char({ length: 2 }),
    /**
     * Server-owned. Only ever written by race settlement.
     *
     * **Kept, unlike the other server-owned fields.** Elo is path-dependent: the
     * rating after a race depends on both players' ratings *at that moment*, so
     * deriving the current value means replaying every race in the pool in
     * order — a fold over history, not a join. And it is read constantly
     * (matchmaking, profile, every leaderboard row) while being written once per
     * race, which is the textbook case for materialising.
     */
    elo: integer().notNull().default(1000),
    createdAt: tstz().notNull().defaultNow(),
    updatedAt: tstz()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex('users_email_key').on(t.email)],
);

export const usersRelations = relations(users, ({ many }) => ({
  solves: many(solves),
  createdRaces: many(races),
  raceParticipations: many(raceParticipants),
  friendships: many(friendships, { relationName: 'user' }),
  tournamentEntries: many(tournamentEntries),
}));

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
