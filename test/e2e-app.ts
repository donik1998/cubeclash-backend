import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import request from 'supertest';

import { Database, DRIZZLE } from '../src/db/drizzle.module';
import { REDIS } from '../src/common/redis/redis.module';
import { PostgresHarness, migrate, startPostgres } from './postgres-harness';
import { RedisHarness, startRedis } from './redis-harness';

/**
 * The full application, booted against real Postgres and real Redis.
 *
 * Every core-API e2e spec runs through here rather than hand-assembling a slim
 * module: auth guards, the rate limiter, refresh sessions and the ranking SQL
 * all cross module boundaries, so the honest test is the whole `AppModule` with
 * its production `ValidationPipe` and error filter, pointed at throwaway
 * containers. The `v1` global prefix from `main.ts` is intentionally *not*
 * applied — the suite talks to unprefixed routes, matching the repo's existing
 * e2e convention.
 */
export interface E2EApp {
  app: INestApplication;
  db: Database;
  redis: Redis;
  /** Truncate all data and flush Redis — call in `beforeEach`. */
  reset: () => Promise<void>;
  stop: () => Promise<void>;
}

/** The tokens envelope the auth endpoints return. */
export interface Tokens {
  access: string;
  refresh: string;
  expires_in: number;
}

export async function createE2EApp(): Promise<E2EApp> {
  const pg: PostgresHarness = await startPostgres();
  migrate(pg.url);
  const redisHarness: RedisHarness = await startRedis();

  // The env AppModule's ConfigModule validates at import — set before compile.
  process.env.DATABASE_URL = pg.url;
  process.env.DATABASE_SSL = 'false';
  process.env.REDIS_URL = redisHarness.url;
  process.env.JWT_ACCESS_SECRET = 'e2e-access-secret-at-least-32-characters-long';
  process.env.JWT_REFRESH_SECRET = 'e2e-refresh-secret-at-least-32-characters-long';
  process.env.JWT_ACCESS_TTL = '15m';
  process.env.JWT_REFRESH_TTL = '30d';
  process.env.NODE_ENV = 'test';
  process.env.CORS_ORIGINS = '*';

  // Import AppModule *after* the env is set: its ConfigModule.forRoot validates
  // the environment at import time, and DATABASE_URL/REDIS_URL are only known
  // once the containers above have started.
  const { AppModule } = await import('../src/app.module');

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  // The error filter is already wired via APP_FILTER in AppModule.
  await app.init();

  const db = app.get<Database>(DRIZZLE);
  const redis = app.get<Redis>(REDIS);

  return {
    app,
    db,
    redis,
    reset: async () => {
      await db.execute(sql`truncate table users restart identity cascade`);
      await redis.flushdb();
    },
    stop: async () => {
      await app.close();
      await pg.stop();
      await redisHarness.stop();
    },
  };
}

// ------------------------------------------------------------- HTTP helpers

export interface RegisteredUser {
  id: string;
  email: string;
  displayName: string;
  tokens: Tokens;
}

/** Register a user through the real endpoint and return their id + tokens. */
export async function registerUser(
  app: INestApplication,
  over: Partial<{ email: string; password: string; displayName: string }> = {},
): Promise<RegisteredUser> {
  const email = over.email ?? `user-${randomUUID()}@example.com`;
  const password = over.password ?? 'password123';
  const displayName = over.displayName ?? 'Cuber';

  const res = await request(app.getHttpServer())
    .post('/auth/register')
    .send({ email, password, display_name: displayName });

  if (res.status !== 201) {
    throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  }

  const body = res.body as { user: { id: string }; tokens: Tokens };
  return { id: body.user.id, email, displayName, tokens: body.tokens };
}

/** `Authorization: Bearer <access>` header value. */
export function bearer(tokens: Tokens): string {
  return `Bearer ${tokens.access}`;
}
