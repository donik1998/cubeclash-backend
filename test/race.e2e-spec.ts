import request from 'supertest';

import { RegisteredUser, bearer, createE2EApp, E2EApp, registerUser } from './e2e-app';

/**
 * The race lobby's REST surface end to end (spec §8): create quick vs private,
 * join by code, the code-leak rule on `GET /races/:id`, join failures
 * (settled / full / not-waiting / bad event), and cursor-paginated history.
 *
 * Booted against the whole `AppModule` on real Postgres + Redis, per the repo's
 * e2e convention — auth guards, the validation pipe and the error filter are all
 * in the path, so these assert the wire contract the three clients depend on.
 */
describe('race lobby (e2e)', () => {
  jest.setTimeout(180_000);

  let h: E2EApp;
  let host: RegisteredUser;
  let joiner: RegisteredUser;
  const http = () => request(h.app.getHttpServer());

  beforeAll(async () => {
    h = await createE2EApp();
  });

  afterAll(async () => {
    await h?.stop();
  });

  beforeEach(async () => {
    await h.reset();
    host = await registerUser(h.app, { displayName: 'Host' });
    joiner = await registerUser(h.app, { displayName: 'Joiner' });
  });

  const createRace = (auth: string, body: { mode: string; event: string }) =>
    http().post('/races').set('Authorization', auth).send(body);

  const joinRace = (auth: string, code: string) =>
    http().post('/races/join').set('Authorization', auth).send({ code });

  // ----------------------------------------------------------------- create

  describe('POST /races', () => {
    it('opens a private room and returns a 6-char code', async () => {
      const res = await createRace(bearer(host.tokens), { mode: 'private', event: '3x3' });

      expect(res.status).toBe(201);
      expect(res.body.race_id).toEqual(expect.any(String));
      expect(res.body.code).toMatch(/^[A-Z0-9]{6}$/);
    });

    it('opens a quick match with NO code (it enqueues, nothing to share)', async () => {
      const res = await createRace(bearer(host.tokens), { mode: 'quick', event: '3x3' });

      expect(res.status).toBe(201);
      expect(res.body.race_id).toEqual(expect.any(String));
      expect(res.body.code).toBeUndefined();
    });

    it('rejects an unknown event with unknown_event', async () => {
      const res = await createRace(bearer(host.tokens), { mode: 'private', event: 'nope' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('unknown_event');
    });

    it('rejects a non-raceable event (blindfolded) with event_not_raceable', async () => {
      const res = await createRace(bearer(host.tokens), { mode: 'private', event: '3x3-bld' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('event_not_raceable');
    });

    it('rejects 4x4 for QUICK match but allows it PRIVATE (spec §9)', async () => {
      const quick = await createRace(bearer(host.tokens), { mode: 'quick', event: '4x4' });
      expect(quick.status).toBe(400);
      expect(quick.body.error.code).toBe('event_not_raceable');

      const priv = await createRace(bearer(host.tokens), { mode: 'private', event: '4x4' });
      expect(priv.status).toBe(201);
    });

    it('rejects an unknown mode via the validation pipe', async () => {
      const res = await createRace(bearer(host.tokens), { mode: 'tournament', event: '3x3' });
      expect(res.status).toBe(400);
    });

    it('401s an unauthenticated request', async () => {
      const res = await http().post('/races').send({ mode: 'private', event: '3x3' });
      expect(res.status).toBe(401);
    });
  });

  // ------------------------------------------------------------------- join

  describe('POST /races/join', () => {
    it('seats a second player in a waiting room', async () => {
      const created = await createRace(bearer(host.tokens), { mode: 'private', event: '3x3' });
      const code = created.body.code as string;

      const res = await joinRace(bearer(joiner.tokens), code);

      expect(res.status).toBe(200);
      const ids = res.body.race.competitors.map((c: { user_id: string }) => c.user_id);
      expect(ids).toEqual(expect.arrayContaining([host.id, joiner.id]));
      expect(res.body.race.competitors).toHaveLength(2);
    });

    it('accepts a lower-cased code (normalised before lookup)', async () => {
      const created = await createRace(bearer(host.tokens), { mode: 'private', event: '3x3' });
      const code = (created.body.code as string).toLowerCase();

      const res = await joinRace(bearer(joiner.tokens), code);
      expect(res.status).toBe(200);
    });

    it('404s an unknown code', async () => {
      const res = await joinRace(bearer(joiner.tokens), 'ZZZZZZ');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('not_found');
    });

    it('409s a full room (join-a-full-room)', async () => {
      const created = await createRace(bearer(host.tokens), { mode: 'private', event: '3x3' });
      const code = created.body.code as string;

      // Second player fills it.
      await joinRace(bearer(joiner.tokens), code);

      // A third, distinct player is refused.
      const third = await registerUser(h.app, { displayName: 'Third' });
      const res = await joinRace(bearer(third.tokens), code);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('conflict');
    });

    it('is idempotent for the same joiner re-firing the request', async () => {
      const created = await createRace(bearer(host.tokens), { mode: 'private', event: '3x3' });
      const code = created.body.code as string;

      const first = await joinRace(bearer(joiner.tokens), code);
      const second = await joinRace(bearer(joiner.tokens), code);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      // No duplicate seat: still exactly two competitors.
      expect(second.body.race.competitors).toHaveLength(2);
    });

    it('rejects a malformed (wrong-length) code at the validation pipe', async () => {
      const res = await joinRace(bearer(joiner.tokens), 'AB');
      expect(res.status).toBe(400);
    });
  });

  // --------------------------------------------------------------- get one

  describe('GET /races/:id', () => {
    it('returns the race with competitors for a participant, INCLUDING the code', async () => {
      const created = await createRace(bearer(host.tokens), { mode: 'private', event: '3x3' });
      const raceId = created.body.race_id as string;
      const code = created.body.code as string;

      const res = await http().get(`/races/${raceId}`).set('Authorization', bearer(host.tokens));

      expect(res.status).toBe(200);
      expect(res.body.race.race_id).toBe(raceId);
      // The host is a participant, so they see the code.
      expect(res.body.race.code).toBe(code);
    });

    it('WITHHOLDS the private code from a non-participant', async () => {
      const created = await createRace(bearer(host.tokens), { mode: 'private', event: '3x3' });
      const raceId = created.body.race_id as string;

      // A stranger who is not in the room can see the race exists but not its code.
      const stranger = await registerUser(h.app, { displayName: 'Stranger' });
      const res = await http()
        .get(`/races/${raceId}`)
        .set('Authorization', bearer(stranger.tokens));

      expect(res.status).toBe(200);
      expect(res.body.race.race_id).toBe(raceId);
      expect(res.body.race.code).toBeUndefined();
    });

    it('never returns the scramble from the lobby read', async () => {
      const created = await createRace(bearer(host.tokens), { mode: 'private', event: '3x3' });
      const raceId = created.body.race_id as string;

      const res = await http().get(`/races/${raceId}`).set('Authorization', bearer(host.tokens));
      expect(res.body.race.scramble).toBeUndefined();
    });

    it('404s a race that does not exist', async () => {
      const res = await http()
        .get('/races/00000000-0000-4000-8000-000000000000')
        .set('Authorization', bearer(host.tokens));
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('not_found');
    });

    it('400s a non-uuid id (ParseUUIDPipe)', async () => {
      const res = await http().get('/races/not-a-uuid').set('Authorization', bearer(host.tokens));
      expect(res.status).toBe(400);
    });
  });

  // ---------------------------------------------------------------- history

  describe('GET /races (history)', () => {
    it('returns the caller races newest-first, cursor-paginated', async () => {
      // Three private rooms the host is in.
      for (let i = 0; i < 3; i++) {
        await createRace(bearer(host.tokens), { mode: 'private', event: '3x3' });
      }

      const firstPage = await http()
        .get('/races?limit=2')
        .set('Authorization', bearer(host.tokens));

      expect(firstPage.status).toBe(200);
      expect(firstPage.body.items).toHaveLength(2);
      expect(firstPage.body.next_cursor).toEqual(expect.any(String));

      const secondPage = await http()
        .get(`/races?limit=2&cursor=${encodeURIComponent(firstPage.body.next_cursor)}`)
        .set('Authorization', bearer(host.tokens));

      expect(secondPage.body.items).toHaveLength(1);
      expect(secondPage.body.next_cursor).toBeNull();

      // No race appears on both pages.
      const firstIds = firstPage.body.items.map((r: { race_id: string }) => r.race_id);
      const secondIds = secondPage.body.items.map((r: { race_id: string }) => r.race_id);
      expect(firstIds.filter((id: string) => secondIds.includes(id))).toHaveLength(0);
    });

    it('scopes history to the caller — a stranger sees none of the host races', async () => {
      await createRace(bearer(host.tokens), { mode: 'private', event: '3x3' });

      const stranger = await registerUser(h.app, { displayName: 'Nobody' });
      const res = await http().get('/races').set('Authorization', bearer(stranger.tokens));

      expect(res.status).toBe(200);
      expect(res.body.items).toEqual([]);
      expect(res.body.next_cursor).toBeNull();
    });
  });
});
