import { eq } from 'drizzle-orm';
import request from 'supertest';

import * as schema from '../src/db/schema';
import { ErrorBody } from '../src/common/errors/error-codes';
import { ProfileResponseDto } from '../src/modules/profile/dto/profile-response.dto';
import { RegisteredUser, createE2EApp, E2EApp, registerUser } from './e2e-app';

/**
 * `GET /me/profile` end to end against the full app on real Postgres + Redis.
 *
 * Identity is the authenticated principal now — the raw user-id header is gone,
 * so the viewer is a registered user with a real access token, and their solves,
 * races and friendships are seeded directly.
 */
describe('GET /me/profile (e2e)', () => {
  jest.setTimeout(180_000);

  let h: E2EApp;

  beforeAll(async () => {
    h = await createE2EApp();
  });

  afterAll(async () => {
    await h?.stop();
  });

  let clock = 0;
  beforeEach(async () => {
    await h.reset();
    clock = 0;
  });

  // ------------------------------------------------------------- fixtures

  const newUser = async (displayName: string, over: Partial<schema.NewUser> = {}) => {
    const [user] = await h.db
      .insert(schema.users)
      .values({
        email: `${displayName.toLowerCase()}-${clock}@example.com`,
        passwordHash: 'x',
        displayName,
        ...over,
      })
      .returning();
    return user;
  };

  /** Register a viewer, then stamp server-owned fields the API does not set on signup. */
  const newViewer = async (
    displayName: string,
    over: Partial<Pick<schema.NewUser, 'country' | 'elo'>> = {},
  ): Promise<RegisteredUser> => {
    const viewer = await registerUser(h.app, { displayName });
    if (Object.keys(over).length > 0) {
      await h.db.update(schema.users).set(over).where(eq(schema.users.id, viewer.id));
    }
    return viewer;
  };

  const addSolve = async (userId: string, over: Partial<schema.NewSolve> = {}) => {
    const [row] = await h.db
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

  const addRaceResult = async (
    userId: string,
    status: schema.Race['status'],
    result: schema.RaceParticipant['result'],
  ) => {
    const [race] = await h.db
      .insert(schema.races)
      .values({ event: '3x3', scramble: "R U R' U'", mode: 'quick', status, createdBy: userId })
      .returning();
    await h.db.insert(schema.raceParticipants).values({ raceId: race.id, userId, result });
    return race;
  };

  const acceptedFriend = (userId: string, friendId: string) =>
    h.db.insert(schema.friendships).values({ userId, friendId, status: 'accepted' });

  const get = async (
    queryString: string,
    token: string,
  ): Promise<{ status: number; body: ProfileResponseDto }> => {
    const suffix = queryString ? `?${queryString}` : '';
    const res = await request(h.app.getHttpServer())
      .get(`/me/profile${suffix}`)
      .set('Authorization', `Bearer ${token}`);
    return { status: res.status, body: res.body as ProfileResponseDto };
  };

  // ------------------------------------------------------------- nominal

  it('assembles the full profile the screen shows in one call', async () => {
    const viewer = await newViewer('cuber_98', { country: 'UZ', elo: 1180 });
    const gb = await newUser('gb_fast', { country: 'GB' });
    const us = await newUser('us_fast', { country: 'US' });
    await addSolve(gb.id, { timeMs: 6_000 });
    await addSolve(us.id, { timeMs: 7_000 });

    await addSolve(viewer.id, { timeMs: 9_000 });
    await addSolve(viewer.id, { timeMs: 8_420 }); // best single
    await addSolve(viewer.id, { timeMs: 5_000, penalty: 'dnf' });
    await addSolve(viewer.id, { timeMs: 4_000, deleted: true }); // excluded entirely
    await addSolve(viewer.id, { event: '4x4', timeMs: 30_000 });

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
    await h.db
      .insert(schema.friendships)
      .values({ userId: viewer.id, friendId: pendingC.id, status: 'pending' });

    const res = await get('', viewer.tokens.access);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      user: { id: viewer.id, display_name: 'cuber_98', country: 'UZ', elo: 1180 },
      rank: { event: '3x3', metric: 'single', scope: 'global', position: 3 },
      stats: {
        best_single_ms: 8_420,
        best_single_event: '3x3',
        total_solves: 4,
        win_rate: 2 / 3,
        wins: 2,
        losses: 1,
      },
      friend_count: 2,
    });
  });

  // ------------------------------------------------------- null-collapsing states

  it('leaves country null when the user has none', async () => {
    const viewer = await newViewer('no_country');
    await addSolve(viewer.id, { timeMs: 8_000 });

    const res = await get('', viewer.tokens.access);
    expect(res.body.user.country).toBeNull();
  });

  it('a brand-new user: rank null, best null, zero everything', async () => {
    const viewer = await newViewer('fresh');

    const res = await get('', viewer.tokens.access);

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
    expect(res.body.user.elo).toBe(1000);
  });

  it('best is null while total_solves > 0 when every solve is a DNF', async () => {
    const viewer = await newViewer('dnf_only');
    await addSolve(viewer.id, { timeMs: 5_000, penalty: 'dnf' });
    await addSolve(viewer.id, { timeMs: 6_000, penalty: 'dnf' });

    const res = await get('', viewer.tokens.access);
    expect(res.body.stats.best_single_ms).toBeNull();
    expect(res.body.stats.total_solves).toBe(2);
  });

  it('win rate is null (not zero) when there are no settled races', async () => {
    const viewer = await newViewer('no_races');
    await addSolve(viewer.id, { timeMs: 8_000 });
    await addRaceResult(viewer.id, 'racing', 'win');

    const res = await get('', viewer.tokens.access);
    expect(res.body.stats.win_rate).toBeNull();
    expect(res.body.stats.wins).toBe(0);
    expect(res.body.stats.losses).toBe(0);
  });

  // ------------------------------------------------------------- query overrides

  it('honors event= for both best and rank', async () => {
    const viewer = await newViewer('multi_event');
    await addSolve(viewer.id, { event: '3x3', timeMs: 8_000 });
    await addSolve(viewer.id, { event: '4x4', timeMs: 30_000 });

    const res = await get('event=4x4', viewer.tokens.access);
    expect(res.body.stats.best_single_ms).toBe(30_000);
    expect(res.body.stats.best_single_event).toBe('4x4');
    expect(res.body.rank).toMatchObject({ event: '4x4', position: 1 });
  });

  it('honors rank_scope=country — ranks the viewer within their country', async () => {
    const viewer = await newViewer('local', { country: 'UZ' });
    const compatriot = await newUser('local_fast', { country: 'UZ' });
    const foreigner = await newUser('abroad_fastest', { country: 'DE' });
    await addSolve(compatriot.id, { timeMs: 6_000 });
    await addSolve(foreigner.id, { timeMs: 5_000 });
    await addSolve(viewer.id, { timeMs: 8_000 });

    const res = await get('rank_scope=country', viewer.tokens.access);
    expect(res.body.rank).toEqual({
      event: '3x3',
      metric: 'single',
      scope: 'country',
      position: 2,
    });
  });

  // ------------------------------------------------------------- error paths

  it('401s when no token is present', async () => {
    const res = await request(h.app.getHttpServer()).get('/me/profile');
    expect(res.status).toBe(401);
    expect((res.body as ErrorBody).error.code).toBe('unauthorized');
  });

  it('401s on a malformed token', async () => {
    const res = await request(h.app.getHttpServer())
      .get('/me/profile')
      .set('Authorization', 'Bearer not-a-real-token');
    expect(res.status).toBe(401);
    expect((res.body as ErrorBody).error.code).toBe('unauthorized');
  });

  it('rejects an unknown event with the standard envelope', async () => {
    const viewer = await newViewer('someone');

    const res = await request(h.app.getHttpServer())
      .get('/me/profile?event=not-a-cube')
      .set('Authorization', `Bearer ${viewer.tokens.access}`);
    expect(res.status).toBe(400);
    expect((res.body as ErrorBody).error.code).toBe('unknown_event');
    expect((res.body as ErrorBody).error.message).toContain('not-a-cube');
  });

  it('rejects an out-of-range rank_scope as validation_failed', async () => {
    const viewer = await newViewer('someone');

    const res = await request(h.app.getHttpServer())
      .get('/me/profile?rank_scope=galaxy')
      .set('Authorization', `Bearer ${viewer.tokens.access}`);
    expect(res.status).toBe(400);
    expect((res.body as ErrorBody).error.code).toBe('validation_failed');
  });

  it('404s when the token belongs to a since-deleted account', async () => {
    const viewer = await newViewer('ghost');
    // The account is gone, but the (still-valid) access token lives on.
    await h.db.delete(schema.users).where(eq(schema.users.id, viewer.id));

    const res = await get('', viewer.tokens.access);
    expect(res.status).toBe(404);
    expect((res.body as unknown as ErrorBody).error.code).toBe('not_found');
  });
});
