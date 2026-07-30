import { relations, sql } from 'drizzle-orm';
import { boolean, index, integer, pgTable, primaryKey, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'; // prettier-ignore

import { tstz } from './columns';
import { penaltyEnum, raceModeEnum, raceResultEnum, raceStatusEnum } from './enums';
import { users } from './users';

export const races = pgTable(
  'races',
  {
    id: uuid().primaryKey().defaultRandom(),
    /** Must be in `RACEABLE_EVENT_IDS`; `quick` mode narrows further. */
    event: text().notNull(),
    /** Both players get the same one. Same `\n` significance as `solves.scramble`. */
    scramble: text().notNull(),
    mode: raceModeEnum().notNull(),
    status: raceStatusEnum().notNull().default('waiting'),
    /** Join code, private rooms only. */
    code: text(),
    createdBy: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: tstz().notNull().defaultNow(),
    settledAt: tstz(),
  },
  (t) => [
    // A code only has to be unique among rooms you can still join, so settled
    // rooms release theirs back into the pool.
    uniqueIndex('races_active_code_key')
      .on(t.code)
      .where(sql`${t.code} is not null and ${t.status} <> 'settled'`),
    index('races_status_event_idx').on(t.status, t.event),
    index('races_created_by_created_at_idx').on(t.createdBy, t.createdAt.desc()),
  ],
);

export const raceParticipants = pgTable(
  'race_participants',
  {
    raceId: uuid()
      .notNull()
      .references(() => races.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Null until the participant finishes or the race settles without them. */
    timeMs: integer(),
    penalty: penaltyEnum().notNull().default('none'),
    ready: boolean().notNull().default(false),
    /**
     * Server-owned. Null while the race is unsettled.
     *
     * **Kept, unlike `is_pb`.** A result is not a comparison, it is an
     * adjudication the server announced and then paid out elo against; freezing
     * it is the point. And it is not fully derivable anyway — `left` records
     * that someone walked out, which no comparison of times can reconstruct,
     * since a null `time_ms` is equally consistent with still racing.
     */
    result: raceResultEnum(),
    finishedAt: tstz(),
  },
  (t) => [
    primaryKey({ columns: [t.raceId, t.userId] }),
    index('race_participants_user_idx').on(t.userId),
  ],
);

export const racesRelations = relations(races, ({ one, many }) => ({
  creator: one(users, { fields: [races.createdBy], references: [users.id] }),
  participants: many(raceParticipants),
}));

export const raceParticipantsRelations = relations(raceParticipants, ({ one }) => ({
  race: one(races, { fields: [raceParticipants.raceId], references: [races.id] }),
  user: one(users, { fields: [raceParticipants.userId], references: [users.id] }),
}));

export type Race = typeof races.$inferSelect;
export type NewRace = typeof races.$inferInsert;
export type RaceParticipant = typeof raceParticipants.$inferSelect;
export type NewRaceParticipant = typeof raceParticipants.$inferInsert;
