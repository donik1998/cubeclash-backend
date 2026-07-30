import { drizzle } from 'drizzle-orm/node-postgres';
import { asc, eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';

import * as schema from '../src/db/schema';
import { Database } from '../src/db/drizzle.module';
import { tournamentRank } from '../src/db/sql/ranking';
import { SolvesRepository } from '../src/modules/solves/solves.repository';
import { PostgresHarness, migrate, startPostgres } from './postgres-harness';

/**
 * The fields the server owns but does not store.
 *
 * `is_pb` and a tournament `rank` were columns until it became clear both were
 * caches with no invalidation. These tests are the argument: several of them
 * describe a sequence that a stored flag gets *wrong*, and that a query gets
 * right for free.
 */
describe('derived server-owned fields (integration)', () => {
  jest.setTimeout(120_000);

  let harness: PostgresHarness;
  let pool: Pool;
  let db: Database;
  let repo: SolvesRepository;

  beforeAll(async () => {
    harness = await startPostgres();
    migrate(harness.url);
    pool = new Pool({ connectionString: harness.url });
    db = drizzle(pool, { schema, casing: 'snake_case' });
    repo = new SolvesRepository(db);
  });

  afterAll(async () => {
    await pool?.end();
    await harness?.stop();
  });

  beforeEach(async () => {
    await db.execute(sql`truncate table users, tournaments restart identity cascade`);
  });

  const newUser = async (name = 'Cuber') => {
    const [user] = await db
      .insert(schema.users)
      .values({ email: `${name}@example.com`, passwordHash: 'x', displayName: name })
      .returning();
    return user;
  };

  /** Solves land one minute apart, in call order, so "earlier" is unambiguous. */
  let clock = 0;
  const addSolve = async (userId: string, over: Partial<schema.NewSolve>) => {
    const [row] = await db
      .insert(schema.solves)
      .values({
        userId,
        event: '3x3',
        scramble: "R U R' U'",
        scrambleSource: 'random',
        timeMs: 12_000,
        solvedAt: new Date(Date.UTC(2026, 6, 1, 0, clock++)),
        clientId: `c-${clock}`,
        ...over,
      })
      .returning();
    return row;
  };

  beforeEach(() => {
    clock = 0;
  });

  /** History is newest-first; this reads it oldest-first for legibility. */
  const pbFlags = async (userId: string, event = '3x3') =>
    (await repo.findHistory(userId, event)).reverse().map((s) => s.isPb);

  // ------------------------------------------------------------- the basics

  it('marks the first ranked solve, then only genuine improvements', async () => {
    const user = await newUser();
    for (const timeMs of [15_000, 14_000, 14_500, 12_100, 13_000]) {
      await addSolve(user.id, { timeMs });
    }

    expect(await pbFlags(user.id)).toEqual([true, true, false, true, false]);
  });

  it('never marks a DNF, and does not let one reset the record', async () => {
    const user = await newUser();
    await addSolve(user.id, { timeMs: 12_000 });
    await addSolve(user.id, { timeMs: 5_000, penalty: 'dnf' });
    await addSolve(user.id, { timeMs: 13_000 });

    // The 5s DNF is not a PB (it is not a result at all), and the 13s that
    // follows still loses to the 12s that stands.
    expect(await pbFlags(user.id)).toEqual([true, false, false]);
  });

  it('folds +2 into the comparison rather than ranking the raw time', async () => {
    const user = await newUser();
    await addSolve(user.id, { timeMs: 11_500 });
    // 10.00 + 2 = 12.00, which loses to 11.50 despite the lower raw time.
    await addSolve(user.id, { timeMs: 10_000, penalty: 'plus2' });
    // 9.00 + 2 = 11.00, which wins.
    await addSolve(user.id, { timeMs: 9_000, penalty: 'plus2' });

    expect(await pbFlags(user.id)).toEqual([true, false, true]);
  });

  it('scopes personal bests per event', async () => {
    const user = await newUser();
    await addSolve(user.id, { event: '3x3', timeMs: 12_000 });
    await addSolve(user.id, { event: '2x2', timeMs: 30_000 });

    // A slow 2x2 is still a 2x2 PB; it never competes with the 3x3.
    expect(await pbFlags(user.id, '3x3')).toEqual([true]);
    expect(await pbFlags(user.id, '2x2')).toEqual([true]);
  });

  // ------------------------------------------- what a stored flag gets wrong

  describe('the cases a stored column could not survive', () => {
    it('re-derives after a penalty is applied retroactively', async () => {
      const user = await newUser();
      await addSolve(user.id, { timeMs: 12_000 });
      const record = await addSolve(user.id, { timeMs: 10_000 });
      await addSolve(user.id, { timeMs: 11_000 });

      expect(await pbFlags(user.id)).toEqual([true, true, false]);

      // PATCH /solves/:id — the 10.00 was actually a DNF.
      await db.update(schema.solves).set({ penalty: 'dnf' }).where(eq(schema.solves.id, record.id));

      // The 11.00 is now the record it always should have been. A stored flag
      // would still say the DNF was a PB, and that the 11.00 was not.
      expect(await pbFlags(user.id)).toEqual([true, false, true]);
    });

    it('promotes the next-best solve when the record holder is deleted', async () => {
      const user = await newUser();
      await addSolve(user.id, { timeMs: 12_000 });
      const record = await addSolve(user.id, { timeMs: 9_500 });
      await addSolve(user.id, { timeMs: 11_000 });

      await db.update(schema.solves).set({ deleted: true }).where(eq(schema.solves.id, record.id));

      // WHERE runs before the window, so the deleted row leaves the frame
      // entirely rather than holding a record it no longer has.
      expect(await pbFlags(user.id)).toEqual([true, true]);
    });
  });

  // ------------------------------------------------- the long-form events

  describe('events that do not rank on the clock', () => {
    it('ranks Fewest Moves on move count, ignoring the hour it took', async () => {
      const user = await newUser();
      const fmc = { event: '3x3-fmc' };

      await addSolve(user.id, { ...fmc, timeMs: 3_600_000, moveCount: 32 });
      // Much faster to write down, but a worse solution.
      await addSolve(user.id, { ...fmc, timeMs: 600_000, moveCount: 38 });
      // Slowest of the three, and the best result.
      await addSolve(user.id, { ...fmc, timeMs: 3_599_000, moveCount: 27 });

      expect(await pbFlags(user.id, '3x3-fmc')).toEqual([true, false, true]);
    });

    it('ranks Multi-Blind by points first, then by time', async () => {
      const user = await newUser();
      const mbld = { event: '3x3-mbld' };

      // 9 points in 54:22.
      await addSolve(user.id, {
        ...mbld,
        timeMs: 3_262_000,
        solvedCount: 11,
        attemptedCount: 13,
      });
      // Same 9 points, slower — not an improvement.
      await addSolve(user.id, {
        ...mbld,
        timeMs: 3_500_000,
        solvedCount: 11,
        attemptedCount: 13,
      });
      // 11 points, and slower still — more cubes wins regardless of the clock.
      await addSolve(user.id, {
        ...mbld,
        timeMs: 3_580_000,
        solvedCount: 12,
        attemptedCount: 13,
      });
      // Same 9 points as the first, but faster.
      await addSolve(user.id, {
        ...mbld,
        timeMs: 3_000_000,
        solvedCount: 11,
        attemptedCount: 13,
      });

      expect(await pbFlags(user.id, '3x3-mbld')).toEqual([true, false, true, false]);
    });

    it('auto-DNFs a Multi-Blind attempt under Regulation 9f12', async () => {
      const user = await newUser();
      const mbld = { event: '3x3-mbld' };

      // Fewer than two solved — not a result.
      await addSolve(user.id, { ...mbld, timeMs: 600_000, solvedCount: 1, attemptedCount: 2 });
      // 2 solved of 4 → 0 points, non-positive — not a result either.
      await addSolve(user.id, { ...mbld, timeMs: 900_000, solvedCount: 2, attemptedCount: 4 });
      // 2 of 3 → 1 point. The first real result, and so the first PB.
      await addSolve(user.id, { ...mbld, timeMs: 1_200_000, solvedCount: 2, attemptedCount: 3 });

      expect(await pbFlags(user.id, '3x3-mbld')).toEqual([false, false, true]);
    });
  });

  // --------------------------------------------------------- the read paths

  describe('personalBest', () => {
    it('returns the best attempt, not the most recent', async () => {
      const user = await newUser();
      await addSolve(user.id, { timeMs: 14_000 });
      await addSolve(user.id, { timeMs: 9_800 });
      await addSolve(user.id, { timeMs: 11_000 });

      const best = await repo.personalBest(user.id, '3x3');

      expect(best?.timeMs).toBe(9_800);
      expect(best?.rankingValue).toBe(9_800);
    });

    it('returns null when every attempt is a DNF', async () => {
      const user = await newUser();
      await addSolve(user.id, { timeMs: 10_000, penalty: 'dnf' });

      expect(await repo.personalBest(user.id, '3x3')).toBeNull();
    });
  });

  describe('wouldBePersonalBest — the write path', () => {
    it('answers without the column, for the analytics event', async () => {
      const user = await newUser();
      await addSolve(user.id, { timeMs: 12_000 });

      expect(await repo.wouldBePersonalBest(user.id, '3x3', 11_999)).toBe(true);
      expect(await repo.wouldBePersonalBest(user.id, '3x3', 12_000)).toBe(false);
      expect(await repo.wouldBePersonalBest(user.id, '3x3', 12_001)).toBe(false);
    });

    it('treats the very first result as a personal best', async () => {
      const user = await newUser();
      expect(await repo.wouldBePersonalBest(user.id, '3x3', 20_000)).toBe(true);
    });

    it('is never true for a DNF', async () => {
      const user = await newUser();
      expect(await repo.wouldBePersonalBest(user.id, '3x3', null)).toBe(false);
    });
  });

  // ------------------------------------------------------- tournament rank

  describe('tournament standings', () => {
    it('derives rank from best time, sharing a place on a tie', async () => {
      const [tournament] = await db
        .insert(schema.tournaments)
        .values({
          name: 'Summer Open',
          format: 'single',
          event: '3x3',
          startsAt: new Date('2026-08-01T10:00:00Z'),
          endsAt: new Date('2026-08-01T18:00:00Z'),
        })
        .returning();

      const entries: [string, number | null][] = [
        ['Ada', 9_800],
        ['Bo', 10_400],
        ['Cy', 10_400],
        ['Dee', 11_900],
        ['Eve', null], // registered, never posted a time
      ];

      for (const [name, bestTimeMs] of entries) {
        const user = await newUser(name);
        await db
          .insert(schema.tournamentEntries)
          .values({ tournamentId: tournament.id, userId: user.id, bestTimeMs });
      }

      const standings = await db
        .select({
          displayName: schema.users.displayName,
          bestTimeMs: schema.tournamentEntries.bestTimeMs,
          rank: sql<number>`${tournamentRank}`.as('rank'),
        })
        .from(schema.tournamentEntries)
        .innerJoin(schema.users, eq(schema.users.id, schema.tournamentEntries.userId))
        .where(eq(schema.tournamentEntries.tournamentId, tournament.id))
        .orderBy(asc(sql`rank`), asc(schema.users.displayName));

      expect(standings.map((s) => [s.displayName, Number(s.rank)])).toEqual([
        ['Ada', 1],
        // A tie is a tie — both read 2nd, and RANK() skips 3rd accordingly.
        ['Bo', 2],
        ['Cy', 2],
        ['Dee', 4],
        // No time posted sorts last rather than first.
        ['Eve', 5],
      ]);
    });
  });
});
