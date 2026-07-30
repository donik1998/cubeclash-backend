import { Global, Inject, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis, { RedisOptions } from 'ioredis';

import { Env } from '../../config/env';

export const REDIS = Symbol('REDIS');

/**
 * Connection options for a CubeClash Redis client.
 *
 * **The Railway trap, handled.** Railway's private network is IPv6-only, and
 * ioredis defaults its socket to IPv4, so a `*.railway.internal` URL fails to
 * connect with `ENOTFOUND` unless `family` is forced to 6. This is the one
 * deployment gotcha ADR-001 flagged; it is cheaper to detect here than to
 * rediscover at 2am. Public URLs and localhost keep dual-stack (`family: 0`).
 */
export function redisOptionsFor(url: string): RedisOptions {
  const isRailwayInternal = new URL(url).hostname.endsWith('.railway.internal');

  return {
    family: isRailwayInternal ? 6 : 0,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
    retryStrategy: (times) => Math.min(times * 200, 5_000),
  };
}

export function createRedisClient(url: string): Redis {
  return new Redis(url, redisOptionsFor(url));
}

/**
 * Redis holds everything ephemeral: race-room state, the matchmaking queue,
 * leaderboard sorted sets, hot-read caches, and the Socket.IO pub/sub backplane.
 * Nothing in here is a source of truth — that is Postgres's job.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        createRedisClient(config.get('REDIS_URL', { infer: true })),
    },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnApplicationShutdown {
  private readonly logger = new Logger(RedisModule.name);

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit();
    this.logger.log('Redis connection closed');
  }
}
