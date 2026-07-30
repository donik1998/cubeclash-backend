import { execFileSync } from 'node:child_process';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';

export interface PostgresHarness {
  url: string;
  stop: () => Promise<void>;
}

/**
 * A real Postgres for the integration suite — never a mock, and never the
 * developer's own database.
 *
 * Two ways in, because they suit two environments:
 *
 *  - **`TEST_DATABASE_URL` set** — use it. This is how CI runs, where the
 *    workflow already has a Postgres *service container* attached: spinning a
 *    second one up from inside the job would mean docker-in-docker for no gain.
 *  - **unset** — start one with Testcontainers. This is the local path, so
 *    `npm run test:e2e` on a laptop needs nothing but Docker running.
 *
 * Either way the suite talks to a genuine server, and migrations are applied by
 * the same `db:migrate` entrypoint that production uses. A migration that only
 * works on an empty in-memory shim is not a migration that has been tested.
 */
export async function startPostgres(): Promise<PostgresHarness> {
  const provided = process.env.TEST_DATABASE_URL;

  if (provided) {
    return { url: provided, stop: () => Promise.resolve() };
  }

  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('cubeclash_test')
    .withUsername('cubeclash')
    .withPassword('cubeclash')
    .start();

  return {
    url: container.getConnectionUri(),
    stop: async () => {
      await container.stop();
    },
  };
}

/** Runs the production migration entrypoint against `url`. */
export function migrate(url: string): void {
  execFileSync('npx', ['tsx', 'src/db/migrate.ts'], {
    env: { ...process.env, DATABASE_URL: url, DATABASE_SSL: 'false' },
    stdio: 'pipe',
  });
}

/** The SQLSTATE codes this schema's constraints raise. */
export const SqlState = {
  UNIQUE_VIOLATION: '23505',
  CHECK_VIOLATION: '23514',
  FOREIGN_KEY_VIOLATION: '23503',
  NOT_NULL_VIOLATION: '23502',
} as const;

interface PostgresError {
  code?: string;
  constraint?: string;
  detail?: string;
}

/**
 * Drizzle wraps driver failures in a `DrizzleQueryError` whose own message is
 * just the failed SQL, so asserting on the message text tells you nothing about
 * *why* it failed. The real Postgres error hangs off `cause` — and it carries
 * the SQLSTATE and the constraint name, which is a far sharper assertion than
 * matching on English.
 */
export function pgErrorOf(error: unknown): PostgresError {
  const candidate = error instanceof Error && error.cause != null ? error.cause : error;
  return typeof candidate === 'object' && candidate !== null ? candidate : {};
}

/** Asserts a query fails with a specific SQLSTATE, and optionally a named constraint. */
export async function expectViolation(
  query: Promise<unknown>,
  sqlState: (typeof SqlState)[keyof typeof SqlState],
  constraint?: string,
): Promise<void> {
  try {
    await query;
  } catch (error) {
    const pg = pgErrorOf(error);
    expect(pg.code).toBe(sqlState);
    if (constraint) {
      expect(pg.constraint).toBe(constraint);
    }
    return;
  }

  throw new Error(`expected the query to fail with SQLSTATE ${sqlState}, but it succeeded`);
}
