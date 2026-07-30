/**
 * Migration runner. Invoked as Railway's release command and by CI before the
 * integration suite: `npm run db:migrate`.
 *
 * It exists rather than calling `drizzle-kit migrate` directly because the
 * schema depends on the `citext` extension, and drizzle-kit does not emit
 * `CREATE EXTENSION`. Installing it here keeps a fresh database one command
 * away from correct.
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import * as path from 'node:path';

/**
 * Migrations live at the repo root (`./drizzle`), not under `src/`, so that the
 * same relative path works when this runs from `src/` via tsx and from `dist/`
 * inside the container.
 */
const MIGRATIONS_DIR = path.resolve(process.cwd(), 'drizzle');

const EXTENSIONS = ['citext'] as const;

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error('DATABASE_URL is required to run migrations');
  }

  const pool = new Pool({
    connectionString,
    max: 1,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });
  const db = drizzle(pool);

  try {
    for (const extension of EXTENSIONS) {
      await db.execute(sql.raw(`create extension if not exists "${extension}"`));
      console.log(`✓ extension ${extension}`);
    }

    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
    console.log('✓ migrations applied');
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('✗ migration failed');
  console.error(error);
  process.exit(1);
});
