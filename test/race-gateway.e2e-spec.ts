import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import type { AddressInfo } from 'node:net';
import type Redis from 'ioredis';
import { type Socket, io } from 'socket.io-client';

import { Database, DRIZZLE } from '../src/db/drizzle.module';
import { REDIS } from '../src/common/redis/redis.module';
import { RedisIoAdapter } from '../src/common/adapters/redis-io.adapter';
import { PostgresHarness, migrate, startPostgres } from './postgres-harness';
import { RedisHarness, startRedis } from './redis-harness';
import { RegisteredUser, registerUser } from './e2e-app';

/**
 * The race gateway end to end over **two real socket.io clients** (spec §1–§5).
 *
 * A mock socket proves nothing — the two payloads that are easy to get wrong
 * (`race:state.is_me`, `race:result.your_time/opp_time/elo_delta`) are
 * per-recipient, and a single-client test passes even if the server broadcast
 * one copy to everyone. So this drives two connections through a full race and
 * asserts each side sees its *own* personalised view.
 *
 * Unlike the REST e2e, this needs the app actually **listening** with the Redis
 * Socket.IO adapter wired (that is the transport under test), so it boots its own
 * app on an ephemeral port rather than using the in-memory `createE2EApp`.
 */
describe('race gateway (e2e, two real clients)', () => {
  jest.setTimeout(120_000);

  let pg: PostgresHarness;
  let redisHarness: RedisHarness;
  let app: INestApplication;
  let db: Database;
  let redis: Redis;
  let url: string;

  let host: RegisteredUser;
  let joiner: RegisteredUser;

  beforeAll(async () => {
    pg = await startPostgres();
    migrate(pg.url);
    redisHarness = await startRedis();

    process.env.DATABASE_URL = pg.url;
    process.env.DATABASE_SSL = 'false';
    process.env.REDIS_URL = redisHarness.url;
    process.env.JWT_ACCESS_SECRET = 'e2e-access-secret-at-least-32-characters-long';
    process.env.JWT_REFRESH_SECRET = 'e2e-refresh-secret-at-least-32-characters-long';
    process.env.JWT_ACCESS_TTL = '15m';
    process.env.JWT_REFRESH_TTL = '30d';
    process.env.NODE_ENV = 'test';
    process.env.CORS_ORIGINS = '*';

    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );

    // The transport under test: the same Redis adapter production uses.
    const adapter = new RedisIoAdapter(app);
    await adapter.connectToRedis();
    app.useWebSocketAdapter(adapter);

    await app.init();
    await app.listen(0); // ephemeral port

    const server = app.getHttpServer();
    const address = server.address() as AddressInfo;
    url = `http://127.0.0.1:${address.port}`;

    db = app.get<Database>(DRIZZLE);
    redis = app.get<Redis>(REDIS);
  });

  afterAll(async () => {
    await app?.close();
    await pg?.stop();
    await redisHarness?.stop();
  });

  beforeEach(async () => {
    await db.execute(sql`truncate table users restart identity cascade`);
    await redis.flushdb();
    host = await registerUser(app, { displayName: 'Host' });
    joiner = await registerUser(app, { displayName: 'Joiner' });
  });

  // ------------------------------------------------------------- socket helpers

  const openSockets: Socket[] = [];

  const connect = (token?: string): Socket => {
    const socket = io(`${url}/race`, {
      transports: ['websocket'],
      forceNew: true,
      auth: token ? { token } : {},
      reconnection: false,
    });
    openSockets.push(socket);
    return socket;
  };

  afterEach(() => {
    for (const s of openSockets.splice(0)) s.disconnect();
  });

  /** Resolve on the next matching event, or reject on timeout. */
  const once = <T>(socket: Socket, event: string, timeoutMs = 8_000): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
      socket.once(event, (payload: T) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });

  const waitConnect = (socket: Socket): Promise<void> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('connect timeout')), 8_000);
      socket.on('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.on('connect_error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

  interface StatePayload {
    race_id: string;
    status: string;
    code?: string;
    event: string;
    players: { user_id: string; is_me: boolean; ready: boolean }[];
  }
  interface ResultPayload {
    result: 'win' | 'loss';
    your_time: number | null;
    opp_time: number | null;
    opponent_dnf: boolean;
    elo_delta: number;
  }

  // ------------------------------------------------------------------- tests

  it('refuses an unauthenticated connection', async () => {
    const socket = connect(); // no token
    const err = await once<Error>(socket, 'connect_error').catch((e: Error) => e);
    // socket.io surfaces the server's forced disconnect as a connect_error or a
    // disconnect; either way the socket must not stay connected.
    await new Promise((r) => setTimeout(r, 500));
    expect(socket.connected).toBe(false);
    expect(err).toBeDefined();
  });

  it('drives a full race and delivers a PERSONALISED race:result to each player', async () => {
    const hostSock = connect(host.tokens.access);
    const joinSock = connect(joiner.tokens.access);
    await Promise.all([waitConnect(hostSock), waitConnect(joinSock)]);

    // --- create (private) : host learns its race_id + code from race:state ----
    const hostState = once<StatePayload>(hostSock, 'race:state');
    hostSock.emit('race:create', { mode: 'private', event: '3x3' });
    const created = await hostState;

    expect(created.status).toBe('waiting');
    expect(created.code).toMatch(/^[A-Z0-9]{6}$/);
    // is_me is true for the host in the host's own view.
    expect(created.players.find((p) => p.user_id === host.id)?.is_me).toBe(true);

    // --- join : both go to ready-check ---------------------------------------
    const joinerReadyCheck = once<StatePayload>(joinSock, 'race:state');
    const hostReadyCheck = once<StatePayload>(hostSock, 'race:state');
    joinSock.emit('race:join', { code: created.code });
    const [joinerView, hostView] = await Promise.all([joinerReadyCheck, hostReadyCheck]);

    expect(joinerView.status).toBe('ready-check');
    expect(hostView.status).toBe('ready-check');

    // ⚠️ per-viewer is_me: each sees itself as me and the other as NOT me.
    expect(hostView.players.find((p) => p.user_id === host.id)?.is_me).toBe(true);
    expect(hostView.players.find((p) => p.user_id === joiner.id)?.is_me).toBe(false);
    expect(joinerView.players.find((p) => p.user_id === joiner.id)?.is_me).toBe(true);
    expect(joinerView.players.find((p) => p.user_id === host.id)?.is_me).toBe(false);

    // --- both ready → countdown → scramble -----------------------------------
    const hostScramble = once<{ scramble: string }>(hostSock, 'race:scramble', 12_000);
    const joinScramble = once<{ scramble: string }>(joinSock, 'race:scramble', 12_000);
    const hostCountdownGo = new Promise<number>((resolve) => {
      hostSock.on('race:countdown', (p: { n: number }) => {
        if (p.n === 0) resolve(0);
      });
    });

    hostSock.emit('race:ready');
    joinSock.emit('race:ready');

    const [hostScr, joinScr, go] = await Promise.all([hostScramble, joinScramble, hostCountdownGo]);
    expect(go).toBe(0); // 0 means GO
    // Same scramble, same instant, byte-for-byte.
    expect(hostScr.scramble).toBe(joinScr.scramble);
    expect(hostScr.scramble.length).toBeGreaterThan(0);

    // --- both submit : host faster, so host wins -----------------------------
    // Wait past the reported times so the wall-clock plausibility check passes.
    await new Promise((r) => setTimeout(r, 2_200));

    const hostResult = once<ResultPayload>(hostSock, 'race:result', 12_000);
    const joinResult = once<ResultPayload>(joinSock, 'race:result', 12_000);

    hostSock.emit('solve:stop', { client_time_ms: 1_800 });
    joinSock.emit('solve:stop', { client_time_ms: 2_000 });

    const [hostRes, joinRes] = await Promise.all([hostResult, joinResult]);

    // Winner sees win with their own time and the opponent's; loser the mirror.
    expect(hostRes.result).toBe('win');
    expect(hostRes.your_time).toBe(1_800);
    expect(hostRes.opp_time).toBe(2_000);
    expect(hostRes.opponent_dnf).toBe(false);
    expect(hostRes.elo_delta).toBeGreaterThan(0);

    expect(joinRes.result).toBe('loss');
    expect(joinRes.your_time).toBe(2_000);
    expect(joinRes.opp_time).toBe(1_800);
    expect(joinRes.elo_delta).toBeLessThan(0);

    // Times are swapped and elo deltas oppositely signed.
    expect(hostRes.your_time).toBe(joinRes.opp_time);
    expect(hostRes.opp_time).toBe(joinRes.your_time);
    expect(Math.sign(hostRes.elo_delta)).toBe(-Math.sign(joinRes.elo_delta));

    console.log('HOST race:result   =>', JSON.stringify(hostRes));

    console.log('JOINER race:result =>', JSON.stringify(joinRes));
  });

  it('ignores a duplicate solve:stop (idempotent) — the recorded time does not change', async () => {
    const hostSock = connect(host.tokens.access);
    const joinSock = connect(joiner.tokens.access);
    await Promise.all([waitConnect(hostSock), waitConnect(joinSock)]);

    const hostState = once<StatePayload>(hostSock, 'race:state');
    hostSock.emit('race:create', { mode: 'private', event: '3x3' });
    const created = await hostState;

    const joined = once<StatePayload>(joinSock, 'race:state');
    joinSock.emit('race:join', { code: created.code });
    await joined;

    const hostScramble = once<{ scramble: string }>(hostSock, 'race:scramble', 12_000);
    hostSock.emit('race:ready');
    joinSock.emit('race:ready');
    await hostScramble;

    await new Promise((r) => setTimeout(r, 2_200));

    const hostResult = once<ResultPayload>(hostSock, 'race:result', 12_000);
    const joinResult = once<ResultPayload>(joinSock, 'race:result', 12_000);

    // Host submits, then immediately sprays four faster times in the same tick.
    // Only the first may count.
    //
    // One duplicate was not enough to catch the original bug. The handler is
    // async, so the frames interleave and all of them reach the DB's
    // `finished_at is null` guard while it is still null; that guard stops a
    // second *write* but lets the DB pick which one commits, so with a single
    // duplicate the correct time won most of the time and the suite went green.
    // It only failed once timing shifted. Several duplicates make the race wide
    // enough that a regression shows up reliably rather than one run in ten.
    hostSock.emit('solve:stop', { client_time_ms: 1_800 });
    for (const cheat of [1_600, 1_500, 1_400, 1_300]) {
      hostSock.emit('solve:stop', { client_time_ms: cheat });
    }
    joinSock.emit('solve:stop', { client_time_ms: 2_000 });

    const [hostRes, joinRes] = await Promise.all([hostResult, joinResult]);

    // Every duplicate was dropped; the host's recorded time is still the first one.
    expect(hostRes.your_time).toBe(1_800);
    expect(joinRes.opp_time).toBe(1_800);
    expect(hostRes.result).toBe('win');
  });

  it('rejects an implausible client_time_ms and does not settle on it', async () => {
    const hostSock = connect(host.tokens.access);
    const joinSock = connect(joiner.tokens.access);
    await Promise.all([waitConnect(hostSock), waitConnect(joinSock)]);

    const hostState = once<StatePayload>(hostSock, 'race:state');
    hostSock.emit('race:create', { mode: 'private', event: '3x3' });
    const created = await hostState;

    const joined = once<StatePayload>(joinSock, 'race:state');
    joinSock.emit('race:join', { code: created.code });
    await joined;

    const hostScramble = once<{ scramble: string }>(hostSock, 'race:scramble', 12_000);
    hostSock.emit('race:ready');
    joinSock.emit('race:ready');
    await hostScramble;

    // Immediately claim a 200ms 3x3 — below the human floor AND before any real
    // time has elapsed. The server must refuse it with race:error.
    const hostError = once<{ code: string; message: string }>(hostSock, 'race:error', 6_000);
    hostSock.emit('solve:stop', { client_time_ms: 200 });
    const err = await hostError;
    expect(err.code).toBe('implausible_time');

    // The race did NOT settle off the rejected time: no result arrives for it.
    const settledEarly = await once<ResultPayload>(hostSock, 'race:result', 1_500)
      .then(() => true)
      .catch(() => false);
    expect(settledEarly).toBe(false);
  });
});
