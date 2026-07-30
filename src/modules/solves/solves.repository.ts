import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, getTableColumns, sql } from 'drizzle-orm';

import { DRIZZLE, Database } from '../../db/drizzle.module';
import { NewSolve, Solve, solves } from '../../db/schema';
import { bestFirst, isPersonalBest, rankingKey } from '../../db/sql/ranking';

/** A stored solve plus the two facts that are computed, never stored. */
export interface SolveWithRanking extends Solve {
  /** Was this a personal best at the moment it was set? */
  isPb: boolean;
  /** The event-appropriate ordering key. Null for a DNF. */
  rankingValue: number | null;
}

/** The mutable columns a `POST /solves` upsert writes. */
export type SolveUpsert = Pick<
  NewSolve,
  | 'userId'
  | 'event'
  | 'scramble'
  | 'scrambleSource'
  | 'timeMs'
  | 'penalty'
  | 'solvedAt'
  | 'clientId'
  | 'moveCount'
  | 'solvedCount'
  | 'attemptedCount'
>;

/** One page of ranked history plus the keyset cursor for the next. */
export interface SolveHistoryPage {
  items: SolveWithRanking[];
  nextCursor: string | null;
}

@Injectable()
export class SolvesRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  private rankedSelect() {
    return this.db
      .select({
        // Every stored column, without restating them — a column added to the
        // schema cannot be silently dropped from this read.
        ...getTableColumns(solves),
        isPb: sql<boolean>`${isPersonalBest}`.as('is_pb'),
        rankingValue: sql<number | null>`${rankingKey}`.as('ranking_value'),
      })
      .from(solves);
  }

  /**
   * A user's history for one event, newest first, with `is_pb` recomputed.
   *
   * The `deleted = false` filter is load-bearing beyond hiding tombstones: WHERE
   * runs before window functions, so a deleted solve also drops out of the
   * personal-best frame. Delete the solve that held a record and the next-best
   * solve correctly becomes the personal best — which a stored flag would never
   * have noticed.
   */
  async findHistory(userId: string, event: string): Promise<SolveWithRanking[]> {
    return this.rankedSelect()
      .where(and(eq(solves.userId, userId), eq(solves.event, event), eq(solves.deleted, false)))
      .orderBy(desc(solves.solvedAt), desc(solves.id));
  }

  /** The single best attempt for an event, or null if every attempt is a DNF. */
  async personalBest(userId: string, event: string): Promise<SolveWithRanking | null> {
    const [best] = await this.rankedSelect()
      .where(
        and(
          eq(solves.userId, userId),
          eq(solves.event, event),
          eq(solves.deleted, false),
          sql`${rankingKey} is not null`,
        ),
      )
      .orderBy(bestFirst, asc(solves.solvedAt))
      .limit(1);

    return best ?? null;
  }

  /**
   * Would a result with this ranking key be a personal best?
   *
   * The write path still needs the answer — `POST /solves` fires the
   * authoritative `is_pb` analytics event, and the client wants to celebrate
   * immediately. Dropping the column moved the *storage*, not the ownership:
   * this is one indexed aggregate against the record so far, not a full replay.
   */
  async wouldBePersonalBest(
    userId: string,
    event: string,
    candidateKey: number | null,
  ): Promise<boolean> {
    if (candidateKey === null) return false; // a DNF is never a personal best

    const [row] = await this.db
      .select({ best: sql<number | null>`min(${rankingKey})` })
      .from(solves)
      .where(and(eq(solves.userId, userId), eq(solves.event, event), eq(solves.deleted, false)));

    const best = row?.best ?? null;
    return best === null || candidateKey < best;
  }

  /**
   * Idempotent create-or-update, keyed on `(user_id, client_id)`.
   *
   * The client generates `client_id`; a retried submit — the norm on a flaky
   * mobile connection — therefore lands on the same row and *updates* it rather
   * than inserting a duplicate. The `xmax = 0` trick in the RETURNING clause
   * tells insert from update in the same round trip (a freshly inserted row has
   * no prior tuple version, so its `xmax` is zero), which is how the controller
   * knows to answer `201` versus `200`.
   *
   * `deleted` is reset to false on the update path: re-submitting a solve is the
   * client asserting it exists, which un-tombstones one previously deleted.
   */
  async upsert(input: SolveUpsert): Promise<{ solve: Solve; created: boolean }> {
    const [row] = await this.db
      .insert(solves)
      .values(input)
      .onConflictDoUpdate({
        target: [solves.userId, solves.clientId],
        set: {
          event: input.event,
          scramble: input.scramble,
          scrambleSource: input.scrambleSource,
          timeMs: input.timeMs,
          penalty: input.penalty,
          solvedAt: input.solvedAt,
          moveCount: input.moveCount ?? null,
          solvedCount: input.solvedCount ?? null,
          attemptedCount: input.attemptedCount ?? null,
          deleted: false,
        },
      })
      .returning({
        ...getTableColumns(solves),
        // `xmax` is the id of the transaction that produced the *prior* version
        // of a row; a brand-new insert has none, so `xmax = 0` ⇔ it was created.
        // Cast through text→bigint: `xid` has no direct `= integer` operator, and
        // a 32-bit xid can exceed int4, so bigint is the safe landing type.
        created: sql<boolean>`(xmax::text::bigint = 0)`,
      });

    const { created, ...solve } = row;
    return { solve, created };
  }

  /** The raw stored row (tombstones included) — for ownership and existence checks. */
  async findRawById(id: string): Promise<Solve | undefined> {
    const [row] = await this.db.select().from(solves).where(eq(solves.id, id)).limit(1);
    return row;
  }

  /** Apply a retroactive penalty. `updatedAt` is bumped by the schema's `$onUpdate`. */
  async updatePenalty(id: string, penalty: Solve['penalty']): Promise<void> {
    await this.db.update(solves).set({ penalty }).where(eq(solves.id, id));
  }

  /** Soft-delete: set the tombstone rather than removing the row, so sync can reconcile. */
  async softDelete(id: string): Promise<void> {
    await this.db.update(solves).set({ deleted: true }).where(eq(solves.id, id));
  }

  /**
   * One ranked solve by id, with `is_pb` computed over the user's *whole* event
   * history — not just this row.
   *
   * The ranking is evaluated in the inner select (`rankedHistory`) over every
   * live solve for the event, and only then is the one row picked out. Filtering
   * to the id *before* the window ran would give it an empty frame and always
   * report `is_pb = true`. This is the read the write path uses to return an
   * authoritative `is_pb` after a create or a penalty edit.
   */
  async findRankedById(
    userId: string,
    event: string,
    id: string,
  ): Promise<SolveWithRanking | null> {
    const history = await this.rankedHistory(userId, event);
    return history.find((s) => s.id === id) ?? null;
  }

  /**
   * A cursor-paginated page of a user's history, newest first, optionally scoped
   * to one event.
   *
   * Keyset, not offset (§0): the page is bounded by `(solved_at, id) <` the
   * cursor, so it never re-walks rows the client has already seen and never
   * skips one inserted mid-scroll. Crucially the ranking runs in a subquery over
   * the full history *before* the cursor bound is applied in the outer query, so
   * `is_pb` stays correct on every page — the same WHERE-before-window care the
   * single-row read takes, expressed as a subquery boundary.
   */
  async findHistoryPage(
    userId: string,
    event: string | undefined,
    options: { cursor?: string | null; limit?: number } = {},
  ): Promise<SolveHistoryPage> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
    const cursor = decodeSolveCursor(options.cursor);

    const conditions = [eq(solves.userId, userId), eq(solves.deleted, false)];
    if (event) conditions.push(eq(solves.event, event));

    const ranked = this.rankedSelect()
      .where(and(...conditions))
      .as('ranked_history');

    const paged = this.db.select().from(ranked);
    const query = cursor
      ? paged.where(
          sql`(${ranked.solvedAt}, ${ranked.id}) < (${cursor.solvedAt}, ${cursor.id}::uuid)`,
        )
      : paged;

    const rows = (await query
      .orderBy(desc(ranked.solvedAt), desc(ranked.id))
      .limit(limit + 1)) as SolveWithRanking[];

    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];

    return { items, nextCursor: hasMore && last ? encodeSolveCursor(last) : null };
  }

  /** The full ranked history for one event, newest first — the frame `is_pb` needs. */
  private async rankedHistory(userId: string, event: string): Promise<SolveWithRanking[]> {
    return this.rankedSelect()
      .where(and(eq(solves.userId, userId), eq(solves.event, event), eq(solves.deleted, false)))
      .orderBy(desc(solves.solvedAt), desc(solves.id));
  }
}

// ---------------------------------------------------------------- cursor

/**
 * Opaque to the client, trivially decodable by us: `<iso>|<uuid>`, base64url —
 * exactly the `(solved_at, id)` total-order key the page walks, so a cursor
 * resumes at the row immediately after the last one returned even when two
 * solves share a timestamp.
 */
export function encodeSolveCursor(solve: Pick<Solve, 'solvedAt' | 'id'>): string {
  return Buffer.from(`${solve.solvedAt.toISOString()}|${solve.id}`).toString('base64url');
}

export function decodeSolveCursor(cursor?: string | null): { solvedAt: Date; id: string } | null {
  if (!cursor) return null;

  const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const solvedAt = new Date(iso ?? '');

  // A stale or corrupt cursor starts the client from the top rather than 500ing.
  if (!id || Number.isNaN(solvedAt.getTime())) return null;

  return { solvedAt, id };
}
