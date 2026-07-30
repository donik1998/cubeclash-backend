import request from 'supertest';

import { bearer, createE2EApp, E2EApp, registerUser } from './e2e-app';

/**
 * `GET /me`, `PATCH /me`, `GET /users/:id` end to end — with the email-leak wall
 * exercised across the self/public boundary (§1.7).
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

  it('GET /users/:id returns the public shape — never the email', async () => {
    const viewer = await registerUser(h.app);
    const other = await registerUser(h.app, { email: 'other@example.com', displayName: 'Other' });

    const res = await http().get(`/users/${other.id}`).set('Authorization', bearer(viewer.tokens));

    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({
      id: other.id,
      display_name: 'Other',
      country: null,
      elo: 1000,
    });
    expect(res.body.user).not.toHaveProperty('email');
  });

  it('GET /users/:id is the public shape even for your own id', async () => {
    const me = await registerUser(h.app);

    const res = await http().get(`/users/${me.id}`).set('Authorization', bearer(me.tokens));

    expect(res.status).toBe(200);
    expect(res.body.user).not.toHaveProperty('email');
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
