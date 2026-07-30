import { customType, timestamp } from 'drizzle-orm/pg-core';

/**
 * Case-insensitive text, for `users.email`.
 *
 * Requires the `citext` extension, which `src/db/migrate.ts` installs before
 * running migrations — drizzle-kit does not emit `CREATE EXTENSION` itself.
 */
export const citext = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'citext';
  },
});

/** Every timestamp in this schema is `timestamptz`. There are no naive times. */
export const tstz = (name?: string) =>
  name ? timestamp(name, { withTimezone: true }) : timestamp({ withTimezone: true });
