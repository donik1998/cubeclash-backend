import request from 'supertest';

import { RegisteredUser, bearer, createE2EApp, E2EApp, registerUser } from './e2e-app';

/**
 * `GET /stats` end to end (§4): ao5 / ao12 and the rest matched against
 * hand-computed values on a seeded set, plus the DNF and insufficient-data edge
 * cases. Data is seeded through the real `POST /solves`, so the ranking key and
 * `is_pb` are the production ones.
 */
describe('stats (e2e)', () => {
  jest.setTimeout(180_000);

  let h: E2EApp;
  const http = () => request(h.app.getHttpServer());

  beforeAll(async () => {
    h = await createE2EApp();
  });

  afterAll(async () => {
    await h?.stop();
  });

  let me: RegisteredUser;
  let auth: string;
  let tick = 0;

  beforeEach(async () => {
    await h.reset();
    tick = 0;
    me = await registerUser(h.app);
    auth = bearer(me.tokens);
  });

  /** Post a chronologically-increasing solve; `null` timeMs marks a DNF. */
  const seed = async (event: string, values: Array<number | null>) => {
    for (const value of values) {
      await http()
        .post('/solves')
        .set('Authorization', auth)
        .send({
          event,
          scramble: "R U R' U'",
          scramble_source: 'random',
          time_ms: value ?? 30_000,
          penalty: value === null ? 'dnf' : 'none',
          solved_at: new Date(Date.UTC(2026, 6, 1, 0, tick++)).toISOString(),
          client_id: `s-${event}-${tick}`,
        });
    }
  };

  const stats = (event: string) =>
    http()
      .get(`/stats?event=${encodeURIComponent(event)}`)
      .set('Authorization', auth);

  it('matches hand-computed aggregates on a five-solve set', async () => {
    // Posted in order: 10,8,12,9,11 (thousands). PBs: 10 (first), 8 (new best).
    await seed('3x3', [10_000, 8_000, 12_000, 9_000, 11_000]);

    const res = await stats('3x3');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      event: '3x3',
      best_single_ms: 8_000,
      ao5: 10_000, // drop 8 and 12 → mean(9,10,11) = 10
      ao12: null, // fewer than 12 solves
      ao100: null,
      session_average: 10_000, // trimmed mean over all five
      pb_count: 2,
      solve_count: 5,
    });
    // All five solves are on 2026-07-01 → a single progress point.
    expect(res.body.progress).toEqual([
      { day: '2026-07-01', best_ms: 8_000, average_ms: 10_000, solve_count: 5 },
    ]);
    // The histogram covers all five ranked singles, fastest bucket first.
    expect(res.body.distribution.reduce((s: number, b: { count: number }) => s + b.count, 0)).toBe(
      5,
    );
    expect(res.body.distribution[0].from_ms).toBe(8_000);
  });

  it('tolerates one DNF in the ao5 and still reports a best single', async () => {
    // 10, DNF, 12, 9, 11 → ao5 drops the best (9) and the DNF (worst) → mean(10,11,12) = 11
    await seed('3x3', [10_000, null, 12_000, 9_000, 11_000]);

    const res = await stats('3x3');

    expect(res.body.ao5).toBe(11_000);
    expect(res.body.best_single_ms).toBe(9_000);
    expect(res.body.solve_count).toBe(5); // the DNF is still a solve
  });

  it('returns null averages and a null best for a cuber with no solves', async () => {
    const res = await stats('3x3');

    expect(res.body).toEqual({
      event: '3x3',
      best_single_ms: null,
      ao5: null,
      ao12: null,
      ao100: null,
      session_average: null,
      pb_count: 0,
      solve_count: 0,
      progress: [], // never null — an empty array so the chart can iterate
      distribution: [],
    });
  });

  it('gives ao5 = null below the window even with a valid best', async () => {
    await seed('3x3', [10_000, 9_000, 11_000]); // only three

    const res = await stats('3x3');
    expect(res.body.ao5).toBeNull();
    expect(res.body.best_single_ms).toBe(9_000);
    expect(res.body.session_average).toBe(10_000); // trimmed mean of the three
  });

  it('is scoped per event', async () => {
    await seed('3x3', [9_000]);
    await seed('2x2', [3_000, 2_000, 4_000]);

    const cube = await stats('3x3');
    const two = await stats('2x2');

    expect(cube.body.best_single_ms).toBe(9_000);
    expect(cube.body.solve_count).toBe(1);
    expect(two.body.best_single_ms).toBe(2_000);
    expect(two.body.solve_count).toBe(3);
  });

  it('reports one progress point per day with a ranked solve, ascending, DNFs excluded', async () => {
    const post = (day: number, index: number, timeMs: number | null) =>
      http()
        .post('/solves')
        .set('Authorization', auth)
        .send({
          event: '3x3',
          scramble: "R U R' U'",
          scramble_source: 'random',
          time_ms: timeMs ?? 30_000,
          penalty: timeMs === null ? 'dnf' : 'none',
          solved_at: new Date(Date.UTC(2026, 6, day, 12, index)).toISOString(),
          client_id: `p-${day}-${index}`,
        });

    // Day 20: 6000 + 7000 → best 6000, mean 6500, count 2.
    // Day 21: 6289 and a DNF → the DNF drops out, so best/mean 6289, count 1.
    await post(20, 0, 6_000);
    await post(20, 1, 7_000);
    await post(21, 0, 6_289);
    await post(21, 1, null);

    const res = await stats('3x3');

    expect(res.body.progress).toEqual([
      { day: '2026-07-20', best_ms: 6_000, average_ms: 6_500, solve_count: 2 },
      { day: '2026-07-21', best_ms: 6_289, average_ms: 6_289, solve_count: 1 },
    ]);
  });

  it('bins ranked singles into contiguous buckets spanning fastest→slowest', async () => {
    await seed('3x3', [6_000, 6_100, 6_200, 6_300, 6_400, 6_500, null]);

    const dist = (await stats('3x3')).body.distribution as Array<{
      from_ms: number;
      to_ms: number;
      count: number;
    }>;

    // The DNF is excluded, so six singles are binned.
    expect(dist.reduce((s, b) => s + b.count, 0)).toBe(6);
    expect(dist[0].from_ms).toBe(6_000);
    expect(dist[dist.length - 1].to_ms).toBe(6_501); // max + 1, so the slowest is counted
    for (let i = 0; i < dist.length - 1; i++) {
      expect(dist[i].to_ms).toBe(dist[i + 1].from_ms); // contiguous, no gaps
    }
  });

  it('rejects an unknown event', async () => {
    const res = await stats('not-a-cube');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('unknown_event');
  });

  it('requires authentication', async () => {
    const res = await http().get('/stats?event=3x3');
    expect(res.status).toBe(401);
  });
});
