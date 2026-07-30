import request from 'supertest';

import { RegisteredUser, bearer, createE2EApp, E2EApp, registerUser } from './e2e-app';

/**
 * The solve endpoints end to end (§4): create + list, idempotent upsert,
 * penalty edits that move `is_pb`, soft delete leaving the PB frame, byte-exact
 * multi-line scrambles, unknown events, and cross-user isolation.
 */
describe('solves (e2e)', () => {
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

  // A stable clock so "earlier" and "later" are unambiguous across a test.
  let tick = 0;
  beforeEach(() => {
    tick = 0;
  });

  interface SolveBody {
    event: string;
    scramble: string;
    scramble_source: string;
    time_ms: number;
    penalty?: string;
    solved_at: string;
    client_id: string;
    move_count?: number;
    solved_count?: number;
    attempted_count?: number;
  }

  const postSolve = (auth: string, over: Partial<SolveBody> = {}) => {
    const body: SolveBody = {
      event: '3x3',
      scramble: "R U R' U'",
      scramble_source: 'random',
      time_ms: 12_000,
      solved_at: new Date(Date.UTC(2026, 6, 1, 0, tick++)).toISOString(),
      client_id: `client-${tick}`,
      ...over,
    };
    return http().post('/solves').set('Authorization', auth).send(body);
  };

  const list = (auth: string, qs = '') => http().get(`/solves${qs}`).set('Authorization', auth);

  let me: RegisteredUser;
  let auth: string;
  beforeEach(async () => {
    me = await registerUser(h.app);
    auth = bearer(me.tokens);
  });

  // ------------------------------------------------------------- create + list

  it('creates a solve (201) and lists it back with is_pb derived', async () => {
    const created = await postSolve(auth, { time_ms: 9_000, client_id: 'c1' });

    expect(created.status).toBe(201);
    expect(created.body.solve).toMatchObject({
      user_id: me.id,
      event: '3x3',
      time_ms: 9_000,
      penalty: 'none',
      client_id: 'c1',
      is_pb: true, // first ranked solve is always a PB
    });

    const listed = await list(auth, '?event=3x3');
    expect(listed.status).toBe(200);
    expect(listed.body.items).toHaveLength(1);
    expect(listed.body.items[0].client_id).toBe('c1');
    expect(listed.body.next_cursor).toBeNull();
  });

  it('is idempotent on (user, client_id): the same client_id twice is one row', async () => {
    const first = await postSolve(auth, { time_ms: 10_000, client_id: 'dup' });
    expect(first.status).toBe(201);

    // A retried submit updates and answers 200, never a duplicate 201.
    const retry = await postSolve(auth, { time_ms: 8_500, client_id: 'dup' });
    expect(retry.status).toBe(200);
    expect(retry.body.solve.time_ms).toBe(8_500);

    const listed = await list(auth, '?event=3x3');
    expect(listed.body.items).toHaveLength(1);
    expect(listed.body.items[0].time_ms).toBe(8_500);
  });

  // ------------------------------------------------------------- is_pb dynamics

  it('a retroactive penalty moves is_pb to the next-best solve', async () => {
    const a = await postSolve(auth, { time_ms: 10_000, client_id: 'a' }); // PB
    await postSolve(auth, { time_ms: 12_000, client_id: 'b' }); // not a PB

    // PATCH the record holder to a DNF; the 12s should inherit the badge.
    const patched = await http()
      .patch(`/solves/${a.body.solve.id}`)
      .set('Authorization', auth)
      .send({ penalty: 'dnf' });
    expect(patched.status).toBe(200);
    expect(patched.body.solve.is_pb).toBe(false); // a DNF is never a PB

    const items = (await list(auth, '?event=3x3')).body.items as Array<{
      client_id: string;
      is_pb: boolean;
    }>;
    const byClient = new Map(items.map((i) => [i.client_id, i.is_pb]));
    expect(byClient.get('a')).toBe(false);
    expect(byClient.get('b')).toBe(true); // now the first ranked solve
  });

  it('soft-delete hides a solve from history and from the PB frame', async () => {
    await postSolve(auth, { time_ms: 12_000, client_id: 'a' }); // PB
    const b = await postSolve(auth, { time_ms: 9_500, client_id: 'b' }); // record
    await postSolve(auth, { time_ms: 11_000, client_id: 'c' }); // not a PB while b stands

    const del = await http().delete(`/solves/${b.body.solve.id}`).set('Authorization', auth);
    expect(del.status).toBe(204);

    const items = (await list(auth, '?event=3x3')).body.items as Array<{
      client_id: string;
      is_pb: boolean;
    }>;
    expect(items.map((i) => i.client_id).sort()).toEqual(['a', 'c']);

    // With b gone, c (11s) now beats the standing 12s and becomes a PB — a stored
    // flag would never have noticed the record holder leaving.
    const byClient = new Map(items.map((i) => [i.client_id, i.is_pb]));
    expect(byClient.get('c')).toBe(true);
  });

  // ------------------------------------------------------------- scramble

  it('round-trips a multi-line scramble byte-for-byte', async () => {
    // Megaminx-style: line breaks are semantic and must not be touched.
    const scramble =
      "R++ D-- R++ D-- R++ D-- R++ D-- R++ U'\n" +
      "R++ D-- R++ D-- R++ D-- R++ D-- R++ U'\n" +
      '  leading spaces and trailing spaces preserved  ';

    const created = await postSolve(auth, { scramble, client_id: 'mega' });
    expect(created.status).toBe(201);
    expect(created.body.solve.scramble).toBe(scramble);

    const listed = await list(auth, '?event=3x3');
    expect(listed.body.items[0].scramble).toBe(scramble);
  });

  // ------------------------------------------------------------- long-form columns

  it('includes only the long-form keys the event allows', async () => {
    const fmc = await postSolve(auth, {
      event: '3x3-fmc',
      time_ms: 600_000,
      move_count: 27,
      client_id: 'fmc',
    });
    expect(fmc.status).toBe(201);
    expect(fmc.body.solve.move_count).toBe(27);
    expect(fmc.body.solve).not.toHaveProperty('solved_count');

    // A plain 3x3 carries none of the three keys at all (absent ≠ null).
    const cube = await postSolve(auth, { client_id: 'cube' });
    expect(cube.body.solve).not.toHaveProperty('move_count');
  });

  it('rejects a long-form count on an event that does not have it', async () => {
    const res = await postSolve(auth, { event: '3x3', move_count: 30, client_id: 'bad' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
  });

  it('refuses a client-supplied is_pb (never accepted)', async () => {
    const res = await http().post('/solves').set('Authorization', auth).send({
      event: '3x3',
      scramble: 'x',
      scramble_source: 'random',
      time_ms: 5000,
      solved_at: new Date().toISOString(),
      client_id: 'z',
      is_pb: true,
    });
    expect(res.status).toBe(400); // forbidNonWhitelisted rejects the unknown key
  });

  // ------------------------------------------------------------- errors

  it('rejects an unknown event with unknown_event', async () => {
    const res = await postSolve(auth, { event: 'not-a-cube', client_id: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('unknown_event');
    expect(res.body.error.message).toContain('not-a-cube');
  });

  it("404s on another user's solve — never 403, existence is not leaked", async () => {
    const created = await postSolve(auth, { client_id: 'mine' });
    const solveId = created.body.solve.id as string;

    const other = await registerUser(h.app, { email: 'intruder@example.com' });
    const intruder = bearer(other.tokens);

    const patch = await http()
      .patch(`/solves/${solveId}`)
      .set('Authorization', intruder)
      .send({ penalty: 'plus2' });
    const del = await http().delete(`/solves/${solveId}`).set('Authorization', intruder);

    expect(patch.status).toBe(404);
    expect(del.status).toBe(404);

    // ...and the owner's solve is untouched.
    const stillThere = await list(auth, '?event=3x3');
    expect(stillThere.body.items).toHaveLength(1);
  });

  it('requires authentication', async () => {
    expect((await http().get('/solves')).status).toBe(401);
    expect((await http().post('/solves').send({})).status).toBe(401);
  });
});
