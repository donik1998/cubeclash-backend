import { relations, sql } from 'drizzle-orm';
import { boolean, index, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { tstz } from './columns';
import { penaltyEnum, scrambleSourceEnum } from './enums';
import { users } from './users';

/**
 * The core practice record.
 *
 * There is deliberately **no `sessions` table**: a session is a client-side
 * grouping, and the server does not track practice activity session-wise.
 */
export const solves = pgTable(
  'solves',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /** One of the seventeen ids in `src/domain/wca-events.ts`. Validated in the DTO, not by the DB. */
    event: text().notNull(),

    /**
     * Plain text, but **`\n` is significant** and must round-trip byte-for-byte:
     * Megaminx line breaks are semantic, and Multi-Blind is N scrambles, one per
     * line. This is exactly what TNoodle emits. Parsing notation is a client
     * display concern — the server only has to not mangle it.
     */
    scramble: text().notNull(),
    scrambleSource: scrambleSourceEnum().notNull(),

    /**
     * The attempt's duration, for **every** event. Fewest Moves and Multi-Blind
     * are timed too (one hour each) — they are simply not *ranked* on the clock.
     * Rank on the event's own result, never on `time_ms` alone.
     */
    timeMs: integer().notNull(),
    penalty: penaltyEnum().notNull().default('none'),
    solvedAt: tstz().notNull(),

    // --- Deliberately absent: `is_pb` ---------------------------------------
    // It is derived, not stored — see `isPersonalBest` in src/db/sql/ranking.ts.
    // `PATCH /solves/:id { penalty }` can apply a +2 or a DNF to a solve after
    // the fact, which changes its ranking key and therefore every later solve's
    // personal-best status. A stored flag would be a cache with no invalidation.
    // The field still appears on the wire and is still server-owned; the client
    // cannot tell the difference.

    // --- Long-form result columns -------------------------------------------
    // Null for the fifteen events where they are genuinely inapplicable rather
    // than zero. See `allowedResultColumns()` in src/domain/wca-events.ts.
    /** Fewest Moves: solution length. */
    moveCount: integer(),
    /** Multi-Blind: cubes solved. */
    solvedCount: integer(),
    /** Multi-Blind: cubes attempted. */
    attemptedCount: integer(),

    // --- Sync & integrity ----------------------------------------------------
    /** Client-generated. Makes `POST /solves` and `POST /sync` idempotent. */
    clientId: text().notNull(),
    updatedAt: tstz()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    /** Soft delete — last-write-wins reconciliation needs the tombstone. */
    deleted: boolean().notNull().default(false),
  },
  (t) => [
    // The one index every read path uses: a user's history for an event, newest first.
    index('solves_user_event_solved_at_idx').on(t.userId, t.event, t.solvedAt.desc()),
    // The idempotency guarantee: a retried offline sync can never duplicate a row.
    uniqueIndex('solves_user_client_id_key').on(t.userId, t.clientId),
    // Sync pulls "everything that changed since X" for one user.
    index('solves_user_updated_at_idx').on(t.userId, t.updatedAt),
    // Leaderboard singles scan live, non-DNF rows only.
    index('solves_event_time_idx')
      .on(t.event, t.timeMs)
      .where(sql`${t.deleted} = false and ${t.penalty} <> 'dnf'`),
  ],
);

export const solvesRelations = relations(solves, ({ one }) => ({
  user: one(users, { fields: [solves.userId], references: [users.id] }),
}));

export type Solve = typeof solves.$inferSelect;
export type NewSolve = typeof solves.$inferInsert;
