import { Inject, Injectable } from '@nestjs/common';
import { SQL, sql } from 'drizzle-orm';

import { DRIZZLE, Database } from '../../db/drizzle.module';
import { friendships, solves, users } from '../../db/schema';
import { rankingKey } from '../../db/sql/ranking';
import { LeaderboardEntry, LeaderboardPage, LeaderboardScope } from './leaderboard.types';

/**
 * The columns every leaderboard row selects, in wire order.
 *
 * A `type` and not an `interface` on purpose: `db.execute<T>` constrains `T` to
 * `Record<string, unknown>`, which a type alias satisfies via TypeScript's
 * implicit index signature but an interface does not.
 */
type Row = {
  rank: string; // RANK() is bigint → arrives as a string
  user_id: string;
  display_name: string;
  country: string | null;
  value_ms: number; // int4 ranking key → a JS number
  solved_at: string; // timestamptz → the driver's ISO string
};

/**
 * The leaderboard, derived — never a stored table.
 *
 * There is deliberately no `leaderboard` table: a board is `solves` joined to
 * `users`, reduced to one best row per competitor and ranked with a window
 * function. Materialising it would be a cache with no invalidation, wrong the
 * moment anyone posts a faster solve. Redis sorted sets are a permitted cache
 * on top of this, not a replacement for it — and are out of scope for this
 * slice, which gets the SQL right first.
 *
 * Only `metric=single` lives here. The averages are dispatched away with a 501
 * by the service before they ever reach this class.
 */
@Injectable()
export class LeaderboardRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * One page of the board for an event, plus the viewer's own row.
   *
   * The whole board is ranked first (the `ranked` CTE), then the page is a
   * cursor-bounded slice of it and the viewer is a single-row lookup into the
   * *same* ranking — so the viewer's rank is their true place in the scope even
   * when they sit thousands of rows below page 1.
   *
   * `friends` and `country` need to know who is asking; with no viewer there is
   * nobody to be friends with or share a country, so the board is empty rather
   * than an error — the same answer the SQL would give, without the round trip.
   */
  async findSingle(
    event: string,
    scope: LeaderboardScope,
    viewerId: string | null,
    options: { cursor?: string | null; limit?: number } = {},
  ): Promise<LeaderboardPage> {
    if ((scope === 'friends' || scope === 'country') && !viewerId) {
      return { items: [], nextCursor: null, viewer: null };
    }

    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
    const cursor = decodeCursor(options.cursor);

    // The board, ranked, shared verbatim by the page query and the viewer
    // lookup so the two can never disagree about a rank.
    const board = sql`
      with per_user as (
        select distinct on (${solves.userId})
          ${solves.userId} as user_id,
          ${solves.solvedAt} as solved_at,
          (${rankingKey}) as value_ms
        from ${solves}
        where ${solves.event} = ${event}
          and ${solves.deleted} = false
          and (${rankingKey}) is not null
          ${this.scopeFilter(scope, viewerId)}
        order by ${solves.userId}, (${rankingKey}) asc, ${solves.solvedAt} asc, ${solves.id} asc
      ),
      ranked as (
        select
          user_id,
          solved_at,
          value_ms,
          rank() over (order by value_ms asc) as rank
        from per_user
      )
    `;

    const cursorFilter = cursor
      ? sql`where (ranked.value_ms, ranked.solved_at, ranked.user_id) > (${cursor.valueMs}, ${cursor.solvedAt}, ${cursor.userId}::uuid)`
      : sql``;

    const pageRows = await this.db.execute<Row>(sql`
      ${board}
      select
        ranked.rank as rank,
        ranked.user_id as user_id,
        ${users.displayName} as display_name,
        ${users.country} as country,
        ranked.value_ms as value_ms,
        ranked.solved_at as solved_at
      from ranked
      join ${users} on ${users.id} = ranked.user_id
      ${cursorFilter}
      order by ranked.value_ms asc, ranked.solved_at asc, ranked.user_id asc
      limit ${limit + 1}
    `);

    // One extra row tells us a next page exists without a count(*).
    const hasMore = pageRows.rows.length > limit;
    const items = pageRows.rows.slice(0, limit).map(toEntry);
    const last = items[items.length - 1];

    const viewer = viewerId ? await this.findViewer(board, viewerId) : null;

    return {
      items,
      nextCursor: hasMore && last ? encodeCursor(last) : null,
      viewer,
    };
  }

  /** The viewer's own row, ranked within the same board, or null. */
  private async findViewer(board: SQL, viewerId: string): Promise<LeaderboardEntry | null> {
    const rows = await this.db.execute<Row>(sql`
      ${board}
      select
        ranked.rank as rank,
        ranked.user_id as user_id,
        ${users.displayName} as display_name,
        ${users.country} as country,
        ranked.value_ms as value_ms,
        ranked.solved_at as solved_at
      from ranked
      join ${users} on ${users.id} = ranked.user_id
      where ranked.user_id = ${viewerId}::uuid
    `);

    const row = rows.rows[0];
    return row ? toEntry(row) : null;
  }

  /**
   * The scope's extra WHERE, folded into `per_user` so it runs before the
   * window function.
   *
   * - `global` adds nothing.
   * - `friends` is the viewer plus everyone they have an accepted friendship
   *   with — a "Friends" board that hid you would be a strange thing.
   * - `country` is everyone sharing the viewer's country; a viewer with a null
   *   country matches nobody and gets an empty board, not an error.
   */
  private scopeFilter(scope: LeaderboardScope, viewerId: string | null): SQL {
    if (scope === 'friends') {
      return sql`and (
        ${solves.userId} = ${viewerId}::uuid
        or exists (
          select 1 from ${friendships}
          where ${friendships.userId} = ${viewerId}::uuid
            and ${friendships.friendId} = ${solves.userId}
            and ${friendships.status} = 'accepted'
        )
      )`;
    }

    if (scope === 'country') {
      return sql`and ${solves.userId} in (
        select ${users.id} from ${users}
        where ${users.country} is not null
          and ${users.country} = (select ${users.country} from ${users} where ${users.id} = ${viewerId}::uuid)
      )`;
    }

    return sql``;
  }
}

// ---------------------------------------------------------------- helpers

function toEntry(row: Row): LeaderboardEntry {
  return {
    rank: Number(row.rank),
    userId: row.user_id,
    displayName: row.display_name,
    country: row.country,
    valueMs: row.value_ms,
    solvedAt: new Date(row.solved_at),
  };
}

/**
 * Opaque to the client, trivially decodable by us: `<valueMs>|<iso>|<uuid>`,
 * base64url. The three parts are exactly the total-order sort key the page
 * query walks — value, then the solve's timestamp, then the user id — so a
 * cursor resumes at precisely the row after the last one returned, with no gap
 * and no repeat even when two competitors share a value.
 */
export function encodeCursor(entry: LeaderboardEntry): string {
  return Buffer.from(`${entry.valueMs}|${entry.solvedAt.toISOString()}|${entry.userId}`).toString(
    'base64url',
  );
}

export function decodeCursor(
  cursor?: string | null,
): { valueMs: number; solvedAt: Date; userId: string } | null {
  if (!cursor) return null;

  const [rawValue, iso, userId] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const valueMs = Number(rawValue);
  const solvedAt = new Date(iso ?? '');

  // A malformed cursor is a client bug, not a server error — start from the top
  // rather than throw a 500 at someone with a stale bookmark.
  if (!userId || !Number.isFinite(valueMs) || Number.isNaN(solvedAt.getTime())) {
    return null;
  }

  return { valueMs, solvedAt, userId };
}
