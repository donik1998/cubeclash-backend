import request from 'supertest';

import * as schema from '../src/db/schema';
import { RaceParticipant } from '../src/db/schema';
import { bearer, createE2EApp, E2EApp, RegisteredUser, registerUser } from './e2e-app';

/**
 * `GET /me`, `PATCH /me`, `GET /users/:id` end to end — with the email-leak wall
 * exercised across the self/public boundary (§1.7), and the Player Profile
 * composite: event bests and the viewer's head-to-head record.
 */
describe('users (e2e)', () => {
  jest.setTimeout(180_000);

  let h: E2EApp;
  const http = () => request(h.app.getHttpServer());

  beforeAll(async () => {
    h = await createE2EApp();
  });

  afterAll(async () => {
    await h?.stop();
  });

  beforeEach(async () => {
    await h.reset();
  });

  /** Post a ranked 3×3 solve as `user`. */
  const solve = (user: RegisteredUser, index: number, timeMs: number) =>
    http()
      .post('/solves')
      .set('Authorization', bearer(user.tokens))
      .send({
        event: '3x3',
        scramble: "R U R' U'",
        scramble_source: 'random',
        time_ms: timeMs,
        penalty: 'none',
        solved_at: new Date(Date.UTC(2026, 6, 1, 0, index)).toISOString(),
        client_id: `${user.id.slice(-6)}-${index}`,
      });

  /**
   * Seed a settled race between two users directly — there is no race endpoint
   * yet, and head-to-head only reads settled rows. `hostResult`/`oppResult` are
   * the server-owned adjudications the aggregate counts.
   */
  const settledRace = async (
    hostId: string,
    oppId: string,
    hostResult: RaceParticipant['result'],
    oppResult: RaceParticipant['result'],
  ) => {
    const [race] = await h.db
      .insert(schema.races)
      .values({
        event: '3x3',
        scramble: "R U R' U'",
        mode: 'private',
        createdBy: hostId,
        status: 'settled',
        settledAt: new Date(),
      })
      .returning();

    await h.db.insert(schema.raceParticipants).values([
      { raceId: race.id, userId: hostId, result: hostResult, timeMs: 10_000 },
      { raceId: race.id, userId: oppId, result: oppResult, timeMs: 11_000 },
    ]);
  };

  it('GET /me returns the self shape including email', async () => {
    const me = await registerUser(h.app, { email: 'self@example.com', displayName: 'Self' });

    const res = await http().get('/me').set('Authorization', bearer(me.tokens));

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({
      id: me.id,
      email: 'self@example.com',
      display_name: 'Self',
      country: null,
      elo: 1000,
    });
  });

  it('PATCH /me updates display name and upper-cases the country', async () => {
    const me = await registerUser(h.app);

    const res = await http()
      .patch('/me')
      .set('Authorization', bearer(me.tokens))
      .send({ display_name: 'Renamed', country: 'gb' });

    expect(res.status).toBe(200);
    expect(res.body.user.display_name).toBe('Renamed');
    expect(res.body.user.country).toBe('GB'); // upper-cased on write
  });

  it('PATCH /me can clear the country with null', async () => {
    const me = await registerUser(h.app);
    await http().patch('/me').set('Authorization', bearer(me.tokens)).send({ country: 'US' });

    const res = await http()
      .patch('/me')
      .set('Authorization', bearer(me.tokens))
      .send({ country: null });

    expect(res.status).toBe(200);
    expect(res.body.user.country).toBeNull();
  });

  it('PATCH /me rejects a non-ISO country as validation_failed', async () => {
    const me = await registerUser(h.app);

    const res = await http()
      .patch('/me')
      .set('Authorization', bearer(me.tokens))
      .send({ country: 'Wakanda' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
  });

  it('GET /users/:id returns the profile shape — never the email', async () => {
    const viewer = await registerUser(h.app);
    const other = await registerUser(h.app, { email: 'other@example.com', displayName: 'Other' });

    const res = await http().get(`/users/${other.id}`).set('Authorization', bearer(viewer.tokens));

    expect(res.status).toBe(200);
    // No solves, no shared races → bests and head-to-head are all null.
    expect(res.body.user).toEqual({
      id: other.id,
      display_name: 'Other',
      country: null,
      elo: 1000,
      best_single_ms: null,
      ao5: null,
      ao12: null,
      head_to_head: null,
    });
    expect(res.body.user).not.toHaveProperty('email');
  });

  it('GET /users/:id reports the profile’s event bests', async () => {
    const viewer = await registerUser(h.app);
    const other = await registerUser(h.app);

    // Five singles: best is 6000; the only ao5 window drops 6000 and 6004.
    for (const [i, v] of [6_000, 6_004, 6_002, 6_001, 6_003].entries()) {
      await solve(other, i, v);
    }

    const res = await http()
      .get(`/users/${other.id}?event=3x3`)
      .set('Authorization', bearer(viewer.tokens));

    expect(res.status).toBe(200);
    expect(res.body.user.best_single_ms).toBe(6_000);
    expect(res.body.user.ao5).toBe(6_002); // mean(6001,6002,6003)
    expect(res.body.user.ao12).toBeNull(); // fewer than twelve
  });

  it('GET /users/:id includes the viewer’s head-to-head, excluding DNFs', async () => {
    const viewer = await registerUser(h.app);
    const other = await registerUser(h.app, { displayName: 'Rival' });

    // Viewer beats Rival three times, loses once; a DNF counts toward neither.
    await settledRace(viewer.id, other.id, 'win', 'loss');
    await settledRace(other.id, viewer.id, 'loss', 'win'); // viewer wins as the guest
    await settledRace(viewer.id, other.id, 'win', 'loss');
    await settledRace(viewer.id, other.id, 'loss', 'win');
    await settledRace(viewer.id, other.id, 'dnf', 'win');

    const res = await http().get(`/users/${other.id}`).set('Authorization', bearer(viewer.tokens));

    expect(res.body.user.head_to_head).toEqual({ wins: 3, losses: 1 });
  });

  it('GET /users/:id head-to-head is null when the two have never raced', async () => {
    const viewer = await registerUser(h.app);
    const other = await registerUser(h.app);

    const res = await http().get(`/users/${other.id}`).set('Authorization', bearer(viewer.tokens));

    expect(res.body.user.head_to_head).toBeNull();
  });

  it('GET /users/:id rejects an unknown event', async () => {
    const viewer = await registerUser(h.app);
    const other = await registerUser(h.app);

    const res = await http()
      .get(`/users/${other.id}?event=not-a-cube`)
      .set('Authorization', bearer(viewer.tokens));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('unknown_event');
  });

  it('GET /users/:id is the profile shape for your own id, with a null head-to-head', async () => {
    const me = await registerUser(h.app);

    const res = await http().get(`/users/${me.id}`).set('Authorization', bearer(me.tokens));

    expect(res.status).toBe(200);
    expect(res.body.user).not.toHaveProperty('email');
    expect(res.body.user.head_to_head).toBeNull(); // no head-to-head with yourself
  });

  it('GET /users/:id 404s for a well-formed but unknown id', async () => {
    const me = await registerUser(h.app);

    const res = await http()
      .get('/users/99999999-9999-4999-8999-999999999999')
      .set('Authorization', bearer(me.tokens));

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('requires authentication', async () => {
    expect((await http().get('/me')).status).toBe(401);
    expect((await http().get('/users/99999999-9999-4999-8999-999999999999')).status).toBe(401);
  });
});
