import { Global, Inject, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { Env } from '../config/env';
import * as schema from './schema';

export const DRIZZLE = Symbol('DRIZZLE');
export const PG_POOL = Symbol('PG_POOL');

/** The typed handle repositories inject. `db.query.*` is schema-aware. */
export type Database = NodePgDatabase<typeof schema>;

/**
 * The ~20 lines ADR-001 signed up for.
 *
 * Drizzle ships no first-party NestJS integration, so the database handle is
 * wired as a plain custom provider: build a `pg.Pool`, hand it to
 * `drizzle(pool, { schema })`, export it under an injection token. Everything
 * below this line is ordinary Drizzle — which is the point. Repositories take
 * `Database` via DI and are trivially swappable for a test double or a
 * transaction handle.
 */
@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        new Pool({
          connectionString: config.get('DATABASE_URL', { infer: true }),
          max: config.get('DATABASE_POOL_MAX', { infer: true }),
          ssl: config.get('DATABASE_SSL', { infer: true }) ? { rejectUnauthorized: false } : false,
          // Railway's private network is IPv6-only. Node 20+ resolves
          // `*.railway.internal` correctly via happy-eyeballs, but being
          // explicit here costs nothing and documents the trap.
          application_name: 'cubeclash-backend',
        }),
    },
    {
      provide: DRIZZLE,
      inject: [PG_POOL],
      useFactory: (pool: Pool): Database =>
        drizzle(pool, {
          schema,
          casing: 'snake_case',
          logger: process.env.NODE_ENV === 'development',
        }),
    },
  ],
  exports: [DRIZZLE, PG_POOL],
})
export class DrizzleModule implements OnApplicationShutdown {
  private readonly logger = new Logger(DrizzleModule.name);

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
    this.logger.log('Postgres pool closed');
  }
}
