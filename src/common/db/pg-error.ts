/**
 * Reading the *cause* of a Drizzle failure.
 *
 * Drizzle wraps a driver error in a `DrizzleQueryError` whose own message is
 * just the failed SQL — the real `pg` error, with its SQLSTATE and constraint
 * name, hangs off `.cause`. A service that wants to turn a unique-violation into
 * a clean 409 has to look there rather than match on English in the message.
 */

/** The SQLSTATE codes this schema's constraints raise. */
export const SqlState = {
  UNIQUE_VIOLATION: '23505',
} as const;

interface PgErrorShape {
  code?: string;
  constraint?: string;
  detail?: string;
}

/** Unwraps the underlying `pg` error from whatever Drizzle threw. */
export function pgErrorOf(error: unknown): PgErrorShape {
  const candidate = error instanceof Error && error.cause != null ? error.cause : error;
  return typeof candidate === 'object' && candidate !== null ? candidate : {};
}

/** True when `error` is a unique-constraint violation, optionally on a named constraint. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const pg = pgErrorOf(error);
  if (pg.code !== SqlState.UNIQUE_VIOLATION) return false;
  return constraint ? pg.constraint === constraint : true;
}
