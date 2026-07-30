import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, getTableColumns, sql } from 'drizzle-orm';

import { DRIZZLE, Database } from '../../db/drizzle.module';
import { Solve, solves } from '../../db/schema';
import { bestFirst, isPersonalBest, rankingKey } from '../../db/sql/ranking';

/** A stored solve plus the two facts that are computed, never stored. */
export interface SolveWithRanking extends Solve {
  /** Was this a personal best at the moment it was set? */
  isPb: boolean;
  /** The event-appropriate ordering key. Null for a DNF. */
  rankingValue: number | null;
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
}
