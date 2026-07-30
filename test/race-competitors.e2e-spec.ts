import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';

import * as schema from '../src/db/schema';
import { Database } from '../src/db/drizzle.module';
import { RaceRepository } from '../src/modules/race/race.repository';
import { PostgresHarness, migrate, startPostgres } from './postgres-harness';

/**
 * The competitors read model: a race plus the people in it, composed by joining
 * `races → race_participants → users`.
 *
 * These are integration tests rather than unit tests with a mocked db because
 * every property worth asserting here is a property of the *query* — grouping,
 * page boundaries, aggregate filters. A mock would only prove the mock works.
 */
describe('race competitors (integration)', () => {
  jest.setTimeout(120_000);

  let harness: PostgresHarness;
  let pool: Pool;
  let db: Database;
  let repo: RaceRepository;

  /** Counts every statement Drizzle issues — the N+1 tripwire. */
  let queryLog: string[] = [];

  beforeAll(async () => {
    harness = await startPostgres();
    migrate(harness.url);
    pool = new Pool({ connectionString: harness.url });
    db = drizzle(pool, {
      schema,
      casing: 'snake_case',
      logger: {
        logQuery: (query) => queryLog.push(query),
      },
    });
    repo = new RaceRepository(db);
  });

  afterAll(async () => {
    await pool?.end();
    await harness?.stop();
  });

  beforeEach(async () => {
    await db.execute(sql`truncate table users, races restart identity cascade`);
    queryLog = [];
  });

  // ------------------------------------------------------------- fixtures

  const newUser = async (displayName: string, over: Partial<schema.NewUser> = {}) => {
    const [user] = await db
      .insert(schema.users)
      .values({
        email: `${displayName.toLowerCase()}@example.com`,
        passwordHash: 'x',
        displayName,
        ...over,
      })
      .returning();
    return user;
  };

  const newRace = async (
    host: schema.User,
    others: schema.User[],
    over: Partial<schema.NewRace> = {},
    results: Partial<schema.NewRaceParticipant>[] = [],
  ) => {
    const [race] = await db
      .insert(schema.races)
      .values({
        event: '3x3',
        scramble: "R U R' U'",
        mode: 'private',
        createdBy: host.id,
        ...over,
      })
      .returning();

    const roster = [host, ...others];
    await db.insert(schema.raceParticipants).values(
      roster.map((u, i) => ({
        raceId: race.id,
        userId: u.id,
        ...(results[i] ?? {}),
      })),
    );

    return race;
  };

  // -------------------------------------------------------- one race read

  describe('findWithCompetitors', () => {
    it('joins each participant to their user row', async () => {
      const host = await newUser('Doniyor', { country: 'UZ', elo: 1240 });
      const rival = await newUser('Anna', { country: 'DE', elo: 1310 });
      const race = await newRace(host, [rival], { status: 'settled' }, [
        { timeMs: 11_240, result: 'win', ready: true, finishedAt: new Date() },
        { timeMs: 12_980, result: 'loss', ready: true, finishedAt: new Date() },
      ]);

      const found = await repo.findWithCompetitors(race.id);

      expect(found).not.toBeNull();
      expect(found!.id).toBe(race.id);
      expect(found!.competitors).toHaveLength(2);

      const [first, second] = found!.competitors;
      // Host first — the room's owner leads the roster.
      expect(first).toMatchObject({
        userId: host.id,
        displayName: 'Doniyor',
        country: 'UZ',
        elo: 1240,
        timeMs: 11_240,
        result: 'win',
        isHost: true,
      });
      expect(second).toMatchObject({
        userId: rival.id,
        displayName: 'Anna',
        country: 'DE',
        elo: 1310,
        timeMs: 12_980,
        result: 'loss',
        isHost: false,
      });
    });

    it('is a single round trip', async () => {
      const host = await newUser('Solo');
      const race = await newRace(host, [await newUser('Other')]);
      queryLog = [];

      await repo.findWithCompetitors(race.id);

      expect(queryLog).toHaveLength(1);
    });

    it('returns a waiting room with nobody but the host', async () => {
      const host = await newUser('Waiting');
      const race = await newRace(host, []);

      const found = await repo.findWithCompetitors(race.id);

      expect(found!.status).toBe('waiting');
      expect(found!.competitors).toHaveLength(1);
      expect(found!.competitors[0].ready).toBe(false);
      expect(found!.competitors[0].result).toBeNull();
    });

    it('returns null for a race that does not exist', async () => {
      expect(await repo.findWithCompetitors('00000000-0000-4000-8000-000000000000')).toBeNull();
    });
  });

  // ------------------------------------------------------------- lobby read

  describe('findOpenRooms', () => {
    it('lists only waiting rooms for the event, with who is already in them', async () => {
      const a = await newUser('Ann');
      const b = await newUser('Bob');

      await newRace(a, [], { event: '3x3', code: 'OPEN01' });
      await newRace(b, [a], { event: '3x3', code: 'FULL01', status: 'racing' });
      await newRace(b, [], { event: '4x4', code: 'OPEN02' });

      const rooms = await repo.findOpenRooms('3x3');

      expect(rooms).toHaveLength(1);
      expect(rooms[0].code).toBe('OPEN01');
      expect(rooms[0].competitors.map((c) => c.displayName)).toEqual(['Ann']);
    });
  });

  // ----------------------------------------------------------- history read

  describe('findHistory', () => {
    const at = (iso: string) => new Date(iso);

    it("keeps each race's competitors with that race and no other", async () => {
      const me = await newUser('Me');
      const x = await newUser('Xavier');
      const y = await newUser('Yara');

      await newRace(me, [x], { createdAt: at('2026-07-01T10:00:00Z'), status: 'settled' });
      await newRace(me, [y], { createdAt: at('2026-07-02T10:00:00Z'), status: 'settled' });

      const page = await repo.findHistory(me.id);

      expect(page.items).toHaveLength(2);
      // Newest first.
      expect(page.items[0].competitors.map((c) => c.displayName).sort()).toEqual(['Me', 'Yara']);
      expect(page.items[1].competitors.map((c) => c.displayName).sort()).toEqual(['Me', 'Xavier']);
    });

    it('does not slice a race in half at the page boundary', async () => {
      // The bug this guards against: joining competitors and then LIMIT-ing
      // returns a race missing an opponent. Three two-player races, page of two.
      const me = await newUser('Me');
      const opponents = [await newUser('One'), await newUser('Two'), await newUser('Three')];

      for (const [i, opponent] of opponents.entries()) {
        await newRace(me, [opponent], {
          createdAt: at(`2026-07-0${i + 1}T10:00:00Z`),
          status: 'settled',
        });
      }

      const page = await repo.findHistory(me.id, { limit: 2 });

      expect(page.items).toHaveLength(2);
      for (const race of page.items) {
        expect(race.competitors).toHaveLength(2);
      }
      expect(page.nextCursor).not.toBeNull();
    });

    it('walks pages with the cursor without skipping or repeating a race', async () => {
      const me = await newUser('Me');
      for (let i = 0; i < 5; i++) {
        await newRace(me, [await newUser(`Opp${i}`)], {
          createdAt: at(`2026-07-0${i + 1}T10:00:00Z`),
          status: 'settled',
        });
      }

      const seen: string[] = [];
      let cursor: string | null = null;

      do {
        const page: Awaited<ReturnType<RaceRepository['findHistory']>> = await repo.findHistory(
          me.id,
          { limit: 2, cursor },
        );
        seen.push(...page.items.map((r) => r.id));
        cursor = page.nextCursor;
      } while (cursor);

      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
    });

    it('costs two queries regardless of how many races come back', async () => {
      // One to settle the page of ids, one to join their competitors. Never
      // one-per-race.
      const me = await newUser('Me');
      for (let i = 0; i < 6; i++) {
        await newRace(me, [await newUser(`Rival${i}`)], {
          createdAt: at(`2026-07-0${i + 1}T10:00:00Z`),
        });
      }
      queryLog = [];

      const page = await repo.findHistory(me.id, { limit: 6 });

      expect(page.items).toHaveLength(6);
      expect(queryLog).toHaveLength(2);
    });

    it('treats a malformed cursor as the start rather than an error', async () => {
      const me = await newUser('Me');
      await newRace(me, [await newUser('Opp')]);

      const page = await repo.findHistory(me.id, { cursor: 'not-a-real-cursor' });

      expect(page.items).toHaveLength(1);
    });

    it('returns an empty page for someone who has never raced', async () => {
      const nobody = await newUser('Nobody');

      const page = await repo.findHistory(nobody.id);

      expect(page).toEqual({ items: [], nextCursor: null });
    });
  });

  // ------------------------------------------------------------ head to head

  describe('headToHead', () => {
    it('counts wins, losses, DNFs and walkouts separately', async () => {
      const me = await newUser('Me');
      const rival = await newUser('Rival');

      const settled = { status: 'settled' as const, settledAt: new Date('2026-07-05T12:00:00Z') };

      await newRace(me, [rival], settled, [
        { timeMs: 10_500, result: 'win' },
        { timeMs: 12_000, result: 'loss' },
      ]);
      await newRace(me, [rival], settled, [
        { timeMs: 13_100, result: 'loss' },
        { timeMs: 11_800, result: 'win' },
      ]);
      await newRace(me, [rival], settled, [
        { timeMs: 30_000, penalty: 'dnf', result: 'dnf' },
        { timeMs: 11_000, result: 'win' },
      ]);
      await newRace(me, [rival], settled, [{ result: 'left' }, { timeMs: 12_400, result: 'win' }]);

      const h2h = await repo.headToHead(me.id, rival.id);

      expect(h2h).toMatchObject({
        opponentId: rival.id,
        opponentDisplayName: 'Rival',
        played: 4,
        wins: 1,
        losses: 1,
        dnf: 1,
        abandoned: 1,
      });
      // The DNF attempt is excluded from my best, so 10,500 stands.
      expect(h2h!.bestTimeMs).toBe(10_500);
      expect(h2h!.opponentBestTimeMs).toBe(11_000);
      expect(h2h!.lastRaceAt).toEqual(new Date('2026-07-05T12:00:00Z'));
    });

    it('ignores races that have not settled', async () => {
      const me = await newUser('Me');
      const rival = await newUser('Rival');

      await newRace(me, [rival], { status: 'racing' }, [{ timeMs: 9_000 }, { timeMs: 9_500 }]);

      expect(await repo.headToHead(me.id, rival.id)).toBeNull();
    });

    it('returns null for two people who have never met', async () => {
      const me = await newUser('Me');
      const stranger = await newUser('Stranger');

      expect(await repo.headToHead(me.id, stranger.id)).toBeNull();
    });

    it('does not count a user against themselves', async () => {
      const me = await newUser('Me');
      await newRace(me, [await newUser('Rival')], {
        status: 'settled',
        settledAt: new Date(),
      });

      expect(await repo.headToHead(me.id, me.id)).toBeNull();
    });
  });
});
