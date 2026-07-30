import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DRIZZLE, Database } from '../../db/drizzle.module';
import { ProfileUser } from './profile.types';

/**
 * The viewer's stored profile plus the three counts that hang off `users` by a
 * plain aggregate — total solves, settled-race wins/losses, accepted friends.
 *
 * Best-in-event (`solves` + `ranking.ts`) and rank (the leaderboard query) are
 * *not* here: they are reused wholesale from their owning repositories rather
 * than reinvented, and the service composes all three. What this class owns is
 * the part that would otherwise be four separate round trips.
 */
export interface ProfileAggregate {
  user: ProfileUser;
  totalSolves: number;
  wins: number;
  losses: number;
  friendCount: number;
}

/**
 * A `raw execute` bypasses Drizzle's column mappers, so `count(*)` arrives as a
 * bigint **string** and is converted below — claiming `number` at this boundary
 * would be a lie the compiler cannot catch.
 *
 * A `type`, not an `interface`, so it satisfies `db.execute<T>`'s
 * `Record<string, unknown>` constraint via the implicit index signature.
 */
type Row = {
  id: string;
  display_name: string;
  country: string | null;
  elo: number;
  total_solves: string;
  wins: string;
  losses: string;
  friend_count: string;
};

@Injectable()
export class ProfileRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * User row + the three scalar counts, in one round trip.
   *
   * The counts are correlated subqueries rather than joins on purpose: joining
   * `solves`, `race_participants` and `friendships` all onto one `users` row
   * would multiply their cardinalities together and need three `count(distinct)`
   * to undo. A scalar subquery per count stays a clean per-table aggregate.
   *
   * - **total_solves** — live solves across every event (`deleted = false`).
   * - **wins / losses** — settled races only; `dnf` and `left` count toward
   *   neither, so win rate is `win / (win + loss)` and nothing else.
   * - **friend_count** — accepted friendships in the viewer's own direction row.
   *
   * Returns null when no such user exists (a principal that resolves to nobody).
   */
  async findAggregate(userId: string): Promise<ProfileAggregate | null> {
    const result = await this.db.execute<Row>(sql`
      select
        u.id                                        as id,
        u.display_name                              as display_name,
        u.country                                   as country,
        u.elo                                       as elo,
        (
          select count(*) from solves s
          where s.user_id = u.id and s.deleted = false
        )                                           as total_solves,
        (
          select count(*) from race_participants rp
          join races r on r.id = rp.race_id
          where rp.user_id = u.id
            and r.status = 'settled'
            and rp.result = 'win'
        )                                           as wins,
        (
          select count(*) from race_participants rp
          join races r on r.id = rp.race_id
          where rp.user_id = u.id
            and r.status = 'settled'
            and rp.result = 'loss'
        )                                           as losses,
        (
          select count(*) from friendships f
          where f.user_id = u.id and f.status = 'accepted'
        )                                           as friend_count
      from users u
      where u.id = ${userId}::uuid
    `);

    const row = result.rows[0];
    if (!row) return null;

    return {
      user: {
        id: row.id,
        displayName: row.display_name,
        country: row.country,
        elo: row.elo,
      },
      totalSolves: Number(row.total_solves),
      wins: Number(row.wins),
      losses: Number(row.losses),
      friendCount: Number(row.friend_count),
    };
  }
}
