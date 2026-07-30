import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';

import { DRIZZLE, Database } from '../../db/drizzle.module';
import { Race, raceParticipants, races, users } from '../../db/schema';
import { Competitor, HeadToHead, RaceCompetitorRow, RaceWithCompetitors } from './race.types';

export interface RaceHistoryPage {
  items: RaceWithCompetitors[];
  nextCursor: string | null;
}

/**
 * Reads for the race lobby, the results screen and race history.
 *
 * Every method here composes the **competitors** array — a race plus the people
 * in it — by joining `races → race_participants → users`. That join is the
 * feature; there is no denormalised competitor column on `races` to keep in
 * step with it, and there is no per-race follow-up query either.
 */
@Injectable()
export class RaceRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * The join, in one place. Everything below reuses it, so the competitor shape
   * can only ever be defined once.
   *
   * `innerJoin` on `users` is correct rather than `leftJoin`: `race_participants
   * .user_id` is NOT NULL with a FK, so a participant without a user cannot
   * exist. A left join here would only hide a broken invariant behind nulls.
   */
  private competitorSelect() {
    return this.db
      .select({
        race: races,
        participant: raceParticipants,
        user: {
          id: users.id,
          displayName: users.displayName,
          country: users.country,
          elo: users.elo,
        },
      })
      .from(races)
      .innerJoin(raceParticipants, eq(raceParticipants.raceId, races.id))
      .innerJoin(users, eq(users.id, raceParticipants.userId));
  }

  /** One race, with everyone in it. Single round trip. */
  async findWithCompetitors(raceId: string): Promise<RaceWithCompetitors | null> {
    const rows = await this.competitorSelect()
      .where(eq(races.id, raceId))
      .orderBy(desc(sql`${raceParticipants.userId} = ${races.createdBy}`), asc(users.displayName));

    return groupByRace(rows)[0] ?? null;
  }

  /** Every joinable room for an event — the lobby list, with who is already waiting. */
  async findOpenRooms(event: string): Promise<RaceWithCompetitors[]> {
    const rows = await this.competitorSelect()
      .where(and(eq(races.event, event), eq(races.status, 'waiting')))
      .orderBy(
        desc(races.createdAt),
        desc(sql`${raceParticipants.userId} = ${races.createdBy}`),
        asc(users.displayName),
      );

    return groupByRace(rows);
  }

  /**
   * A user's race history, newest first, with the competitors of each race.
   *
   * **Why this is not the obvious query.** Joining competitors and then
   * `LIMIT`-ing would slice the result set mid-race and hand back a race missing
   * an opponent. So the page of race ids is settled first, in a CTE, and the
   * competitor join is applied only to that page — one round trip, correct
   * boundaries, and no N+1 follow-up per race.
   *
   * The cursor is a row-value comparison on `(created_at, id)` rather than an
   * OFFSET: race history is append-heavy, and an offset re-walks rows the client
   * has already seen. `id` breaks ties so two races created in the same
   * millisecond cannot straddle a page boundary and be skipped.
   */
  async findHistory(
    userId: string,
    options: { cursor?: string | null; limit?: number } = {},
  ): Promise<RaceHistoryPage> {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    const cursor = decodeCursor(options.cursor);

    const page = this.db.$with('page').as(
      this.db
        .select({ id: races.id, createdAt: races.createdAt })
        .from(races)
        .innerJoin(raceParticipants, eq(raceParticipants.raceId, races.id))
        .where(
          and(
            eq(raceParticipants.userId, userId),
            cursor
              ? sql`(${races.createdAt}, ${races.id}) < (${cursor.createdAt}, ${cursor.id})`
              : undefined,
          ),
        )
        .orderBy(desc(races.createdAt), desc(races.id))
        // One extra row tells us whether another page exists without a count(*).
        .limit(limit + 1),
    );

    const pageIds = await this.db.with(page).select({ id: page.id }).from(page);
    const hasMore = pageIds.length > limit;
    const ids = pageIds.slice(0, limit).map((r) => r.id);

    if (ids.length === 0) {
      return { items: [], nextCursor: null };
    }

    const rows = await this.competitorSelect()
      .where(inArray(races.id, ids))
      .orderBy(
        desc(races.createdAt),
        desc(races.id),
        desc(sql`${raceParticipants.userId} = ${races.createdBy}`),
        asc(users.displayName),
      );

    const items = groupByRace(rows);
    const last = items[items.length - 1];

    return {
      items,
      nextCursor: hasMore && last ? encodeCursor(last) : null,
    };
  }

  /**
   * A user's record against one opponent.
   *
   * This is what the competitors list is *for*: once you can name who was in a
   * race, "how do I do against this person" becomes answerable. It is a
   * self-join on `race_participants` — my row and theirs in the same race —
   * aggregated with `FILTER`, which is the readable way to count four different
   * outcomes in one pass instead of four correlated subqueries.
   *
   * Hand-written SQL on purpose, per ADR-001: the typed builder stops paying for
   * itself at aggregate filters, and this is a query worth being able to read
   * out loud.
   */
  async headToHead(userId: string, opponentId: string): Promise<HeadToHead | null> {
    const result = await this.db.execute<{
      opponent_id: string;
      opponent_display_name: string;
      played: string;
      wins: string;
      losses: string;
      dnf: string;
      abandoned: string;
      best_time_ms: number | null;
      opponent_best_time_ms: number | null;
      // A raw `execute` bypasses Drizzle's column mappers, so `timestamptz`
      // arrives as the driver's string and `count(*)` as a bigint string. Typed
      // honestly here and converted below — claiming `Date` at this boundary
      // would be a lie the compiler cannot catch.
      last_race_at: string | null;
    }>(sql`
      select
        opponent.user_id                                            as opponent_id,
        opponent_user.display_name                                  as opponent_display_name,
        count(*) filter (where me.result is not null)               as played,
        count(*) filter (where me.result = 'win')                   as wins,
        count(*) filter (where me.result = 'loss')                  as losses,
        count(*) filter (where me.result = 'dnf')                   as dnf,
        count(*) filter (where me.result = 'left')                  as abandoned,
        min(me.time_ms)       filter (where me.penalty <> 'dnf')       as best_time_ms,
        min(opponent.time_ms) filter (where opponent.penalty <> 'dnf') as opponent_best_time_ms,
        max(race.settled_at)                                        as last_race_at
      from race_participants me
      join race_participants opponent
        on opponent.race_id = me.race_id
       and opponent.user_id <> me.user_id
      join races race on race.id = me.race_id
      join users opponent_user on opponent_user.id = opponent.user_id
      where me.user_id = ${userId}
        and opponent.user_id = ${opponentId}
        and race.status = 'settled'
      group by opponent.user_id, opponent_user.display_name
    `);

    const row = result.rows[0];
    if (!row) return null;

    return {
      opponentId: row.opponent_id,
      opponentDisplayName: row.opponent_display_name,
      played: Number(row.played),
      wins: Number(row.wins),
      losses: Number(row.losses),
      dnf: Number(row.dnf),
      abandoned: Number(row.abandoned),
      bestTimeMs: row.best_time_ms,
      opponentBestTimeMs: row.opponent_best_time_ms,
      lastRaceAt: row.last_race_at ? new Date(row.last_race_at) : null,
    };
  }
}

// ---------------------------------------------------------------- helpers

/**
 * Collapse the joined rows into races with a competitors array.
 *
 * A join returns one row per competitor, so a two-player race arrives twice
 * with its race columns repeated. Grouping in memory keeps it to one round
 * trip; the alternative — `json_agg` in the query — avoids the duplication on
 * the wire but gives up the typed row and pushes the shape into SQL. At two
 * competitors per race the duplication is not worth that trade.
 *
 * Insertion order is preserved, so whatever the query's ORDER BY decided still
 * holds after grouping.
 */
export function groupByRace(rows: RaceCompetitorRow[]): RaceWithCompetitors[] {
  const byId = new Map<string, RaceWithCompetitors>();

  for (const { race, participant, user } of rows) {
    let entry = byId.get(race.id);
    if (!entry) {
      entry = { ...race, competitors: [] };
      byId.set(race.id, entry);
    }
    entry.competitors.push(toCompetitor(race, participant, user));
  }

  return [...byId.values()];
}

function toCompetitor(
  race: Race,
  participant: RaceCompetitorRow['participant'],
  user: RaceCompetitorRow['user'],
): Competitor {
  return {
    userId: user.id,
    displayName: user.displayName,
    country: user.country,
    elo: user.elo,
    ready: participant.ready,
    timeMs: participant.timeMs,
    penalty: participant.penalty,
    result: participant.result,
    finishedAt: participant.finishedAt,
    isHost: participant.userId === race.createdBy,
  };
}

/** Opaque to the client, trivially decodable by us: `<iso>|<uuid>`, base64url. */
export function encodeCursor(race: Race): string {
  return Buffer.from(`${race.createdAt.toISOString()}|${race.id}`).toString('base64url');
}

export function decodeCursor(cursor?: string | null): { createdAt: Date; id: string } | null {
  if (!cursor) return null;

  const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const createdAt = new Date(iso ?? '');

  // A malformed cursor is a client bug, not a server error — start from the
  // top rather than throwing a 500 at someone with a stale bookmark.
  if (!id || Number.isNaN(createdAt.getTime())) return null;

  return { createdAt, id };
}
