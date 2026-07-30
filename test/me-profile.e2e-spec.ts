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
import { ProfileResponseDto } from '../src/modules/profile/dto/profile-response.dto';
import { ProfileController } from '../src/modules/profile/profile.controller';
import { ProfileRepository } from '../src/modules/profile/profile.repository';
import { ProfileService } from '../src/modules/profile/profile.service';
import { LeaderboardRepository } from '../src/modules/leaderboard/leaderboard.repository';
import { SolvesRepository } from '../src/modules/solves/solves.repository';
import { PostgresHarness, migrate, startPostgres } from './postgres-harness';

/**
 * `GET /me/profile` end to end against real Postgres.
 *
 * The composite is derived SQL — the aggregate counts, the reused best-in-event
 * query and the reused leaderboard rank are all properties of live queries, so
 * a mocked db would prove nothing. The app is booted with only the profile
 * slice (plus the two repositories it reuses) and a `DRIZZLE` handle pointed at
 * the test database, with the same ValidationPipe and error filter production
 * runs, so the error envelope is the real one.
 */
describe('GET /me/profile (e2e)', () => {
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
      controllers: [ProfileController],
      providers: [
        ProfileService,
        ProfileRepository,
        SolvesRepository,
        LeaderboardRepository,
        { provide: DRIZZLE, useValue: db },
      ],
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
    clock = 0;
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

  /** A race in some status with the given user recorded at the given result. */
  const addRaceResult = async (
    userId: string,
    status: schema.Race['status'],
    result: schema.RaceParticipant['result'],
  ) => {
    const [race] = await db
      .insert(schema.races)
      .values({
        event: '3x3',
        scramble: "R U R' U'",
        mode: 'quick',
        status,
        createdBy: userId,
      })
      .returning();
    await db.insert(schema.raceParticipants).values({ raceId: race.id, userId, result });
    return race;
  };

  const acceptedFriend = async (userId: string, friendId: string) =>
    db.insert(schema.friendships).values({ userId, friendId, status: 'accepted' });

  /** A profile request, typed to the success envelope. */
  const get = async (
    queryString: string,
    viewerId?: string,
  ): Promise<{ status: number; body: ProfileResponseDto }> => {
    const suffix = queryString ? `?${queryString}` : '';
    const base = request(app.getHttpServer()).get(`/me/profile${suffix}`);
    const res = await (viewerId ? base.set('x-user-id', viewerId) : base);
    return { status: res.status, body: res.body as ProfileResponseDto };
  };

  /** A profile request expected to fail, typed to the error envelope. */
  const getError = async (
    queryString: string,
    viewerId?: string,
  ): Promise<{ status: number; body: ErrorBody }> => {
    const suffix = queryString ? `?${queryString}` : '';
    const base = request(app.getHttpServer()).get(`/me/profile${suffix}`);
    const res = await (viewerId ? base.set('x-user-id', viewerId) : base);
    return { status: res.status, body: res.body as ErrorBody };
  };

  // ------------------------------------------------------------- nominal

  it('assembles the full profile the screen shows in one call', async () => {
    const viewer = await newUser('cuber_98', { country: 'UZ', elo: 1180 });
    // Two faster global competitors put the viewer at rank 3 for 3x3 single.
    const gb = await newUser('gb_fast', { country: 'GB' });
    const us = await newUser('us_fast', { country: 'US' });
    await addSolve(gb.id, { timeMs: 6_000 });
    await addSolve(us.id, { timeMs: 7_000 });

    // Viewer's solves: best 3x3 = 8420; a DNF and a deleted row are excluded
    // from "best" but the DNF still counts as a live solve; a 4x4 counts toward
    // total but not the 3x3 best.
    await addSolve(viewer.id, { timeMs: 9_000 });
    await addSolve(viewer.id, { timeMs: 8_420 }); // best single
    await addSolve(viewer.id, { timeMs: 5_000, penalty: 'dnf' });
    await addSolve(viewer.id, { timeMs: 4_000, deleted: true }); // excluded entirely
    await addSolve(viewer.id, { event: '4x4', timeMs: 30_000 });

    // Settled races decide win rate; dnf/left are excluded from both parts, and
    // an unsettled race is not counted at all even with a result attached.
    await addRaceResult(viewer.id, 'settled', 'win');
    await addRaceResult(viewer.id, 'settled', 'win');
    await addRaceResult(viewer.id, 'settled', 'loss');
    await addRaceResult(viewer.id, 'settled', 'dnf');
    await addRaceResult(viewer.id, 'settled', 'left');
    await addRaceResult(viewer.id, 'racing', 'win');

    const friendA = await newUser('friendA');
    const friendB = await newUser('friendB');
    const pendingC = await newUser('pendingC');
    await acceptedFriend(viewer.id, friendA.id);
    await acceptedFriend(viewer.id, friendB.id);
    await db
      .insert(schema.friendships)
      .values({ userId: viewer.id, friendId: pendingC.id, status: 'pending' });

    const res = await get('', viewer.id);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      user: { id: viewer.id, display_name: 'cuber_98', country: 'UZ', elo: 1180 },
      rank: { event: '3x3', metric: 'single', scope: 'global', position: 3 },
      stats: {
        best_single_ms: 8_420,
        best_single_event: '3x3',
        total_solves: 4, // 9000, 8420, dnf, 4x4 — deleted excluded
        win_rate: 2 / 3,
        wins: 2,
        losses: 1,
      },
      friend_count: 2, // pending is not a friend
    });
  });

  // ------------------------------------------------------------- null-collapsing states

  it('leaves country null when the user has none', async () => {
    const viewer = await newUser('no_country'); // country defaults to null
    await addSolve(viewer.id, { timeMs: 8_000 });

    const res = await get('', viewer.id);

    expect(res.body.user.country).toBeNull();
  });

  it('a brand-new user: rank null, best null, zero everything', async () => {
    const viewer = await newUser('fresh'); // no solves, no races, no friends

    const res = await get('', viewer.id);

    expect(res.status).toBe(200);
    expect(res.body.rank).toBeNull();
    expect(res.body.stats).toMatchObject({
      best_single_ms: null,
      best_single_event: '3x3',
      total_solves: 0,
      win_rate: null,
      wins: 0,
      losses: 0,
    });
    expect(res.body.friend_count).toBe(0);
    expect(res.body.user.elo).toBe(1000); // schema default
  });

  it('best is null while total_solves > 0 when every solve is a DNF', async () => {
    const viewer = await newUser('dnf_only');
    await addSolve(viewer.id, { timeMs: 5_000, penalty: 'dnf' });
    await addSolve(viewer.id, { timeMs: 6_000, penalty: 'dnf' });

    const res = await get('', viewer.id);

    expect(res.body.stats.best_single_ms).toBeNull();
    expect(res.body.stats.total_solves).toBe(2);
  });

  it('win rate is null (not zero) when there are no settled races', async () => {
    const viewer = await newUser('no_races');
    await addSolve(viewer.id, { timeMs: 8_000 });
    // Only an unsettled race exists — it must not create a 0/0 = null vs 0 trap.
    await addRaceResult(viewer.id, 'racing', 'win');

    const res = await get('', viewer.id);

    expect(res.body.stats.win_rate).toBeNull();
    expect(res.body.stats.wins).toBe(0);
    expect(res.body.stats.losses).toBe(0);
  });

  // ------------------------------------------------------------- query overrides

  it('honors event= for both best and rank', async () => {
    const viewer = await newUser('multi_event');
    await addSolve(viewer.id, { event: '3x3', timeMs: 8_000 });
    await addSolve(viewer.id, { event: '4x4', timeMs: 30_000 });

    const res = await get('event=4x4', viewer.id);

    expect(res.body.stats.best_single_ms).toBe(30_000);
    expect(res.body.stats.best_single_event).toBe('4x4');
    expect(res.body.rank).toMatchObject({ event: '4x4', position: 1 });
  });

  it('honors rank_scope=country — ranks the viewer within their country', async () => {
    const viewer = await newUser('local', { country: 'UZ' });
    const compatriot = await newUser('local_fast', { country: 'UZ' });
    const foreigner = await newUser('abroad_fastest', { country: 'DE' });
    await addSolve(compatriot.id, { timeMs: 6_000 }); // faster, same country
    await addSolve(foreigner.id, { timeMs: 5_000 }); // fastest, excluded by scope
    await addSolve(viewer.id, { timeMs: 8_000 });

    const res = await get('rank_scope=country', viewer.id);

    // Country board is {compatriot, viewer} → viewer is 2nd; the German is out.
    expect(res.body.rank).toEqual({
      event: '3x3',
      metric: 'single',
      scope: 'country',
      position: 2,
    });
  });

  // ------------------------------------------------------------- error paths

  it('401s when no principal header is present', async () => {
    const res = await getError('');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it('treats a malformed principal header as absent → 401', async () => {
    const res = await getError('', 'not-a-uuid');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it('rejects an unknown event with the standard envelope', async () => {
    const viewer = await newUser('someone');

    const res = await getError('event=not-a-cube', viewer.id);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('unknown_event');
    expect(res.body.error.message).toContain('not-a-cube');
  });

  it('rejects an out-of-range rank_scope as validation_failed', async () => {
    const viewer = await newUser('someone');

    const res = await getError('rank_scope=galaxy', viewer.id);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
  });

  it('404s when the principal is a well-formed uuid for no user', async () => {
    const res = await getError('', '99999999-9999-4999-8999-999999999999');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });
});
