import request from 'supertest';

import { Tokens, bearer, createE2EApp, E2EApp } from './e2e-app';

/**
 * The auth flows end to end against real Postgres and Redis (§4).
 *
 * The security-relevant behaviours — generic login failure, rotation with a
 * one-shot refresh token, reuse detection revoking every session, per-token
 * logout — are only meaningful against a real Redis, so they run here rather
 * than in the unit suite.
 */
describe('auth (e2e)', () => {
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

  const CREDS = { email: 'ada@example.com', password: 'password123', display_name: 'Ada' };

  const register = (over: Partial<typeof CREDS> = {}) =>
    http()
      .post('/auth/register')
      .send({ ...CREDS, ...over });

  const login = (email: string, password: string) =>
    http().post('/auth/login').send({ email, password });

  // ------------------------------------------------------------- register

  it('registers, returns the self shape + tokens, and authenticates GET /me', async () => {
    const res = await register();

    expect(res.status).toBe(201);
    expect(res.body.user).toEqual({
      id: expect.any(String),
      email: 'ada@example.com',
      display_name: 'Ada',
      country: null,
      elo: 1000,
      created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:\d{2})$/),
    });
    // No credential material ever leaves the server.
    expect(res.body.user).not.toHaveProperty('password_hash');
    expect(res.body.tokens).toEqual({
      access: expect.any(String),
      refresh: expect.any(String),
      expires_in: 900,
    });

    const me = await http()
      .get('/me')
      .set('Authorization', bearer(res.body.tokens as Tokens));
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('ada@example.com');
  });

  it('normalises email case, and a duplicate is a 409 conflict', async () => {
    await register();
    const dup = await register({ email: 'ADA@example.com' }); // same address, different case

    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('conflict');
  });

  // ------------------------------------------------------------- login

  it('logs in with correct credentials', async () => {
    await register();
    const res = await login('ada@example.com', 'password123');

    expect(res.status).toBe(200);
    expect(res.body.tokens.access).toEqual(expect.any(String));
  });

  it('answers a wrong password and an unknown email with the same generic 401', async () => {
    await register();

    const wrong = await login('ada@example.com', 'not-the-password');
    const unknown = await login('nobody@example.com', 'whatever12');

    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.code).toBe('unauthorized');
    // Identical message: the response must not reveal whether the email exists.
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
  });

  it('rejects an unauthenticated GET /me', async () => {
    const res = await http().get('/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  // ------------------------------------------------------------- refresh

  it('rotates on refresh, and the old refresh token then fails', async () => {
    const reg = await register();
    const first = reg.body.tokens as Tokens;

    const rotated = await http().post('/auth/refresh').send({ refresh: first.refresh });
    expect(rotated.status).toBe(200);
    const second = rotated.body.tokens as Tokens;
    expect(second.refresh).not.toBe(first.refresh);

    // The spent token is dead...
    const reused = await http().post('/auth/refresh').send({ refresh: first.refresh });
    expect(reused.status).toBe(401);

    // ...but the new one works, and its access token authenticates.
    const me = await http().get('/me').set('Authorization', bearer(second));
    expect(me.status).toBe(200);
  });

  it('reuse of a rotated token kills every other session', async () => {
    const reg = await register(); // phone
    const phone = reg.body.tokens as Tokens;
    const laptopRes = await login('ada@example.com', 'password123'); // laptop
    const laptop = laptopRes.body.tokens as Tokens;

    // Phone rotates once, legitimately.
    const phone2Res = await http().post('/auth/refresh').send({ refresh: phone.refresh });
    const phone2 = phone2Res.body.tokens as Tokens;
    expect(phone2Res.status).toBe(200);

    // The original phone token is replayed → reuse detected.
    const replay = await http().post('/auth/refresh').send({ refresh: phone.refresh });
    expect(replay.status).toBe(401);

    // Every session is now revoked — the laptop and the phone's fresh token alike.
    const laptopReuse = await http().post('/auth/refresh').send({ refresh: laptop.refresh });
    const phone2Reuse = await http().post('/auth/refresh').send({ refresh: phone2.refresh });
    expect(laptopReuse.status).toBe(401);
    expect(phone2Reuse.status).toBe(401);
  });

  // ------------------------------------------------------------- logout

  it('logout invalidates only the presented token', async () => {
    const reg = await register(); // phone
    const phone = reg.body.tokens as Tokens;
    const laptopRes = await login('ada@example.com', 'password123'); // laptop
    const laptop = laptopRes.body.tokens as Tokens;

    const out = await http().post('/auth/logout').send({ refresh: phone.refresh });
    expect(out.status).toBe(204);

    // The laptop is untouched by the phone's logout and can still rotate.
    const laptopAfter = await http().post('/auth/refresh').send({ refresh: laptop.refresh });
    expect(laptopAfter.status).toBe(200);

    // The phone's token is dead. (Replaying a *logged-out* token has its jti
    // already gone, so — exactly like replaying a rotated one — it reads as
    // reuse and is rejected. That it would also revoke the laptop is the
    // spec's §1.3 rule, so it is checked last, after the laptop's own assertion.)
    const phoneAfter = await http().post('/auth/refresh').send({ refresh: phone.refresh });
    expect(phoneAfter.status).toBe(401);
  });

  it('logout is idempotent even with a garbage token (204)', async () => {
    const res = await http().post('/auth/logout').send({ refresh: 'not-a-jwt' });
    expect(res.status).toBe(204);
  });

  // ------------------------------------------------------------- validation

  it('rejects a too-short password as validation_failed', async () => {
    const res = await register({ password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
  });
});
