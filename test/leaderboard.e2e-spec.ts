import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import request from 'supertest';

import * as schema from '../src/db/schema';
import { Database, DRIZZLE } from '../src/db/drizzle.module';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { ErrorBody } from '../src/common/errors/error-codes';
import { LeaderboardResponseDto } from '../src/modules/leaderboard/dto/leaderboard-response.dto';
import { LeaderboardController } from '../src/modules/leaderboard/leaderboard.controller';
import { LeaderboardRepository } from '../src/modules/leaderboard/leaderboard.repository';
import { LeaderboardService } from '../src/modules/leaderboard/leaderboard.service';
import { PostgresHarness, migrate, startPostgres } from './postgres-harness';

/**
 * `GET /leaderboard` end to end against real Postgres.
 *
 * The board is derived SQL — ordering, tie handling, scope filters and the
 * viewer's out-of-page rank are all properties of the query, so a mocked db
 * would prove nothing. The app is booted with only the leaderboard slice and a
 * `DRIZZLE` handle pointed at the test database, plus the same ValidationPipe
 * and error filter production runs, so the error envelope is the real one.
 */
describe('GET /leaderboard (e2e)', () => {
  jest.setTimeout(120_000);

  let harness: PostgresHarness;
  let pool: Pool;
  let db: Database;
  let app: INestApplication;

  beforeAll(async () => {
    harness = await startPostgres();
    migrate(harness.url);
    pool = new Pool({ connectionString: harness.url });
    db = drizzle(pool, { schema, casing: 'snake_case' });

    const moduleRef = await Test.createTestingModule({
      controllers: [LeaderboardController],
      providers: [LeaderboardService, LeaderboardRepository, { provide: DRIZZLE, useValue: db }],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: false },
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await harness?.stop();
  });

  beforeEach(async () => {
    await db.execute(sql`truncate table users restart identity cascade`);
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

  let clock = 0;
  const addSolve = async (userId: string, over: Partial<schema.NewSolve> = {}) => {
    const [row] = await db
      .insert(schema.solves)
      .values({
        userId,
        event: '3x3',
        scramble: "R U R' U'",
        scrambleSource: 'random',
        timeMs: 12_000,
        solvedAt: new Date(Date.UTC(2026, 6, 1, 0, clock++)),
        clientId: `c-${userId}-${clock}`,
        ...over,
      })
      .returning();
    return row;
  };

  beforeEach(() => {
    clock = 0;
  });

  /** A board request, typed to the success envelope. */
  const get = async (
    queryString: string,
    viewerId?: string,
  ): Promise<{ status: number; body: LeaderboardResponseDto }> => {
    const base = request(app.getHttpServer()).get(`/leaderboard?${queryString}`);
    const res = await (viewerId ? base.set('x-user-id', viewerId) : base);
    return { status: res.status, body: res.body as LeaderboardResponseDto };
  };

  /** A board request expected to fail, typed to the error envelope. */
  const getError = async (queryString: string): Promise<{ status: number; body: ErrorBody }> => {
    const res = await request(app.getHttpServer()).get(`/leaderboard?${queryString}`);
    return { status: res.status, body: res.body as ErrorBody };
  };

  // ------------------------------------------------------------- global order

  it('ranks the global board best-first, one best row per competitor', async () => {
    const ada = await newUser('Ada', { country: 'GB' });
    const bo = await newUser('Bo', { country: 'US' });
    const cy = await newUser('Cy', { country: 'IR' });

    // Each has several solves; only their best should count.
    await addSolve(ada.id, { timeMs: 8_000 });
    await addSolve(ada.id, { timeMs: 6_310 }); // Ada's best
    await addSolve(bo.id, { timeMs: 7_000 });
    await addSolve(cy.id, { timeMs: 9_500 });

    const res = await get('event=3x3&scope=global');

    expect(res.status).toBe(200);
    expect(res.body.items.map((i) => [i.display_name, i.rank, i.value_ms])).toEqual([
      ['Ada', 1, 6_310],
      ['Bo', 2, 7_000],
      ['Cy', 3, 9_500],
    ]);
    // Wire contract: event echoed, country pass-through, ISO timestamp.
    expect(res.body.items[0]).toMatchObject({ event: '3x3', country: 'GB' });
    expect(res.body.items[0].solved_at).toMatch(/^2026-07-01T/);
    expect(res.body.next_cursor).toBeNull();
  });

  it('folds a +2 into value_ms rather than ranking the raw time', async () => {
    const fast = await newUser('Fast');
    const clean = await newUser('Clean');

    // 5.0s +2 = 7.0s ranking value, which loses to a clean 6.5s.
    await addSolve(fast.id, { timeMs: 5_000, penalty: 'plus2' });
    await addSolve(clean.id, { timeMs: 6_500 });

    const res = await get('event=3x3&scope=global');

    expect(res.body.items.map((i) => [i.display_name, i.value_ms])).toEqual([
      ['Clean', 6_500],
      ['Fast', 7_000],
    ]);
  });

  it('shares a rank on a tie and skips the next place (RANK, not ROW_NUMBER)', async () => {
    const ada = await newUser('Ada');
    const bo = await newUser('Bo');
    const cy = await newUser('Cy');

    await addSolve(ada.id, { timeMs: 6_000 });
    await addSolve(bo.id, { timeMs: 6_550 });
    await addSolve(cy.id, { timeMs: 6_550 }); // ties Bo

    const res = await get('event=3x3&scope=global');

    const ranks = new Map(res.body.items.map((i) => [i.display_name, i.rank]));
    expect(ranks.get('Ada')).toBe(1);
    expect(ranks.get('Bo')).toBe(2);
    expect(ranks.get('Cy')).toBe(2); // a tie is a tie
    // No competitor reads 3rd — RANK() skips it.
    expect([...ranks.values()]).not.toContain(3);
  });

  it('excludes a DNF entirely — never as a value, never as a competitor', async () => {
    const ranked = await newUser('Ranked');
    const onlyDnf = await newUser('OnlyDnf');

    await addSolve(ranked.id, { timeMs: 5_000, penalty: 'dnf' }); // ignored
    await addSolve(ranked.id, { timeMs: 9_000 }); // Ranked's real best
    await addSolve(onlyDnf.id, { timeMs: 4_000, penalty: 'dnf' }); // no ranked attempt

    const res = await get('event=3x3&scope=global');

    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ display_name: 'Ranked', value_ms: 9_000 });
  });

  it('excludes soft-deleted solves', async () => {
    const user = await newUser('User');
    await addSolve(user.id, { timeMs: 5_000, deleted: true });
    await addSolve(user.id, { timeMs: 9_000 });

    const res = await get('event=3x3&scope=global');

    expect(res.body.items[0].value_ms).toBe(9_000);
  });

  // ------------------------------------------------------------- the viewer

  it('returns the viewer row with its true rank even when far below page 1', async () => {
    // 12 faster competitors, then the viewer 13th. Page size 5.
    for (let i = 0; i < 12; i++) {
      const u = await newUser(`U${i}`);
      await addSolve(u.id, { timeMs: 5_000 + i });
    }
    const viewer = await newUser('Viewer');
    await addSolve(viewer.id, { timeMs: 20_000 });

    const res = await get('event=3x3&scope=global&limit=5', viewer.id);

    expect(res.body.items).toHaveLength(5);
    // The viewer is nowhere on the first page...
    expect(res.body.items.map((i) => i.display_name)).not.toContain('Viewer');
    // ...but their own row carries their real place in the whole board.
    expect(res.body.viewer).toMatchObject({ display_name: 'Viewer', rank: 13, value_ms: 20_000 });
    expect(res.body.next_cursor).not.toBeNull();
  });

  it('returns a null viewer when the viewer has no ranked attempt', async () => {
    const other = await newUser('Other');
    await addSolve(other.id, { timeMs: 8_000 });
    const viewer = await newUser('Viewer'); // no solves

    const res = await get('event=3x3&scope=global', viewer.id);

    expect(res.body.viewer).toBeNull();
    expect(res.body.items).toHaveLength(1);
  });

  // ---------------------------------------------------------------- scopes

  it('scopes to the viewer plus their accepted friends', async () => {
    const viewer = await newUser('Viewer');
    const friend = await newUser('Friend');
    const pendingFriend = await newUser('Pending');
    const stranger = await newUser('Stranger');

    await addSolve(viewer.id, { timeMs: 10_000 });
    await addSolve(friend.id, { timeMs: 6_000 });
    await addSolve(pendingFriend.id, { timeMs: 5_000 });
    await addSolve(stranger.id, { timeMs: 4_000 });

    await db.insert(schema.friendships).values([
      { userId: viewer.id, friendId: friend.id, status: 'accepted' },
      { userId: viewer.id, friendId: pendingFriend.id, status: 'pending' },
    ]);

    const res = await get('event=3x3&scope=friends', viewer.id);

    // Friend and the viewer only — pending is not a friend, stranger is nobody.
    expect(res.body.items.map((i) => i.display_name)).toEqual(['Friend', 'Viewer']);
    expect(res.body.viewer).toMatchObject({ display_name: 'Viewer', rank: 2 });
  });

  it('returns an empty friends board when there is no viewer', async () => {
    const someone = await newUser('Someone');
    await addSolve(someone.id, { timeMs: 6_000 });

    const res = await get('event=3x3&scope=friends');

    expect(res.body).toEqual({ items: [], next_cursor: null, viewer: null });
  });

  it('scopes to the viewer country and excludes everyone else', async () => {
    const viewer = await newUser('Viewer', { country: 'UZ' });
    const compatriot = await newUser('Compatriot', { country: 'UZ' });
    const foreigner = await newUser('Foreigner', { country: 'DE' });

    await addSolve(viewer.id, { timeMs: 10_000 });
    await addSolve(compatriot.id, { timeMs: 6_000 });
    await addSolve(foreigner.id, { timeMs: 5_000 });

    const res = await get('event=3x3&scope=country', viewer.id);

    expect(res.body.items.map((i) => i.display_name)).toEqual(['Compatriot', 'Viewer']);
  });

  it('gives a null-country viewer an empty country board rather than an error', async () => {
    const viewer = await newUser('Viewer'); // country null
    await addSolve(viewer.id, { timeMs: 6_000 });

    const res = await get('event=3x3&scope=country', viewer.id);

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.viewer).toBeNull();
  });

  // ------------------------------------------------------------- pagination

  it('walks every competitor across cursor pages without skip or repeat', async () => {
    for (let i = 0; i < 7; i++) {
      const u = await newUser(`U${i}`);
      await addSolve(u.id, { timeMs: 5_000 + i * 100 });
    }

    const seen: string[] = [];
    let cursor: string | null = null;

    do {
      const qs = `event=3x3&scope=global&limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await get(qs);
      seen.push(...res.body.items.map((i) => i.user_id));
      cursor = res.body.next_cursor;
    } while (cursor);

    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });

  // ------------------------------------------------------------- error paths

  it('rejects an unknown event with the standard error envelope', async () => {
    const res = await getError('event=not-a-cube&scope=global');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('unknown_event');
    expect(res.body.error.message).toContain('not-a-cube');
    expect(res.body.error.details).toBeUndefined();
  });

  it('answers metric=ao5 with 501 not_implemented', async () => {
    const res = await getError('event=3x3&scope=global&metric=ao5');

    expect(res.status).toBe(501);
    expect(res.body.error.code).toBe('not_implemented');
  });

  it('rejects a missing event as validation_failed', async () => {
    const res = await getError('scope=global');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
  });
});
