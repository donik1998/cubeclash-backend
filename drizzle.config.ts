import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit only ever *generates* SQL here — migrations are applied by
 * `src/db/migrate.ts`, which also installs the extensions the schema depends on
 * (citext) before running them. See README § Database.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/cubeclash',
  },
  casing: 'snake_case',
  verbose: true,
  strict: true,
});
