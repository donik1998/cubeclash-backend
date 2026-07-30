import { relations, sql } from 'drizzle-orm';
import { check, index, pgTable, primaryKey, uuid } from 'drizzle-orm/pg-core';

import { tstz } from './columns';
import { friendshipStatusEnum } from './enums';
import { users } from './users';

/**
 * One row per direction. The inviter's row is written on invite; accepting
 * writes the reciprocal row. Keeping both directions makes "my friends" a
 * single-column index scan instead of an OR across two columns.
 */
export const friendships = pgTable(
  'friendships',
  {
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    friendId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: friendshipStatusEnum().notNull().default('pending'),
    createdAt: tstz().notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.friendId] }),
    index('friendships_friend_idx').on(t.friendId),
    check('friendships_no_self', sql`${t.userId} <> ${t.friendId}`),
  ],
);

export const friendshipsRelations = relations(friendships, ({ one }) => ({
  user: one(users, {
    fields: [friendships.userId],
    references: [users.id],
    relationName: 'user',
  }),
  friend: one(users, {
    fields: [friendships.friendId],
    references: [users.id],
    relationName: 'friend',
  }),
}));

export type Friendship = typeof friendships.$inferSelect;
export type NewFriendship = typeof friendships.$inferInsert;
