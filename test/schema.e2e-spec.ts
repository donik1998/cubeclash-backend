import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';

import * as schema from '../src/db/schema';
import {
  PostgresHarness,
  SqlState,
  expectViolation,
  migrate,
  startPostgres,
} from './postgres-harness';

/**
 * Integration tests for the parts of the schema that encode a *rule* rather
 * than a shape. A column list is already asserted by the migration itself; what
 * is worth testing is the behaviour the application leans on and would
 * otherwise only discover in production.
 */
describe('schema (integration)', () => {
  jest.setTimeout(120_000);

  let harness: PostgresHarness;
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  const newUser = async (email: string) => {
    const [user] = await db
      .insert(schema.users)
      .values({ email, passwordHash: 'x', displayName: email.split('@')[0] })
      .returning();
    return user;
  };

  const solve = (userId: string, clientId: string, over: Partial<schema.NewSolve> = {}) => ({
    userId,
    event: '3x3',
    scramble: "R U R' U'",
    scrambleSource: 'random' as const,
    timeMs: 12_340,
    solvedAt: new Date(),
    clientId,
    ...over,
  });

  beforeAll(async () => {
    harness = await startPostgres();
    migrate(harness.url);
    pool = new Pool({ connectionString: harness.url });
    db = drizzle(pool, { schema, casing: 'snake_case' });
  });

  afterAll(async () => {
    await pool?.end();
    await harness?.stop();
  });

  beforeEach(async () => {
    await db.execute(sql`truncate table users, races, tournaments restart identity cascade`);
  });

  it('installs citext, so email comparison is case-insensitive', async () => {
    await newUser('Doniyor@Example.COM');

    const found = await db.query.users.findFirst({
      where: eq(schema.users.email, 'doniyor@example.com'),
    });

    expect(found).toBeDefined();
    // …and the unique index inherits that, so a differently-cased duplicate is
    // rejected rather than creating a second account.
    await expectViolation(
      newUser('DONIYOR@example.com'),
      SqlState.UNIQUE_VIOLATION,
      'users_email_key',
    );
  });

  describe('offline sync idempotency', () => {
    it('rejects a second solve with the same (user_id, client_id)', async () => {
      const user = await newUser('sync@example.com');
      await db.insert(schema.solves).values(solve(user.id, 'client-abc'));

      await expectViolation(
        db.insert(schema.solves).values(solve(user.id, 'client-abc')),
        SqlState.UNIQUE_VIOLATION,
        'solves_user_client_id_key',
      );
    });

    it('scopes the constraint per user, so two clients can share an id', async () => {
      const a = await newUser('a@example.com');
      const b = await newUser('b@example.com');

      await db.insert(schema.solves).values(solve(a.id, 'client-abc'));
      await db.insert(schema.solves).values(solve(b.id, 'client-abc'));

      const rows = await db.select().from(schema.solves);
      expect(rows).toHaveLength(2);
    });

    it('makes a retried submit a no-op via onConflictDoNothing', async () => {
      const user = await newUser('retry@example.com');
      const values = solve(user.id, 'client-xyz');

      await db.insert(schema.solves).values(values);
      await db
        .insert(schema.solves)
        .values(values)
        .onConflictDoNothing({ target: [schema.solves.userId, schema.solves.clientId] });

      const rows = await db.select().from(schema.solves);
      expect(rows).toHaveLength(1);
    });
  });

  it('round-trips a multi-line scramble byte for byte', async () => {
    // Megaminx line breaks are semantic and Multi-Blind is N scrambles, one per
    // line. The server does not parse notation, but it must not mangle it.
    const user = await newUser('mega@example.com');
    const scramble = [
      "R++ D-- R++ D-- R-- D++ R-- D++ R++ D++ U'",
      'R-- D-- R++ D++ R++ D-- R++ D-- R++ D++ U',
      "R++ D++ R-- D-- R-- D-- R++ D++ R++ D-- U'",
    ].join('\n');

    await db
      .insert(schema.solves)
      .values(solve(user.id, 'mega-1', { event: 'megaminx', scramble }));

    const [stored] = await db.select().from(schema.solves);
    expect(stored.scramble).toBe(scramble);
    expect(stored.scramble.split('\n')).toHaveLength(3);
  });

  it('leaves the long-form columns null for the fifteen events they do not apply to', async () => {
    const user = await newUser('longform@example.com');
    await db.insert(schema.solves).values(solve(user.id, 'plain-1'));

    const [stored] = await db.select().from(schema.solves);
    expect(stored.moveCount).toBeNull();
    expect(stored.solvedCount).toBeNull();
    expect(stored.attemptedCount).toBeNull();
  });

  it('stores a Multi-Blind result as points plus a duration', async () => {
    const user = await newUser('mbld@example.com');
    await db.insert(schema.solves).values(
      solve(user.id, 'mbld-1', {
        event: '3x3-mbld',
        timeMs: 54 * 60_000 + 22_000, // 54:22 — still a real duration
        solvedCount: 11,
        attemptedCount: 13,
      }),
    );

    const [stored] = await db.select().from(schema.solves);
    expect(stored.solvedCount).toBe(11);
    expect(stored.attemptedCount).toBe(13);
    expect(stored.timeMs).toBe(3_262_000);
  });

  describe('race join codes', () => {
    const race = (createdBy: string, code: string, over: Partial<schema.NewRace> = {}) => ({
      event: '3x3',
      scramble: "R U R'",
      mode: 'private' as const,
      code,
      createdBy,
      ...over,
    });

    it('are unique among joinable rooms', async () => {
      const user = await newUser('host@example.com');
      await db.insert(schema.races).values(race(user.id, 'CUBE42'));

      await expectViolation(
        db.insert(schema.races).values(race(user.id, 'CUBE42')),
        SqlState.UNIQUE_VIOLATION,
        'races_active_code_key',
      );
    });

    it('are released back into the pool once a race settles', async () => {
      const user = await newUser('host2@example.com');
      await db.insert(schema.races).values(race(user.id, 'CUBE42', { status: 'settled' }));

      // The partial index excludes settled rooms, so the code is free again.
      await expect(db.insert(schema.races).values(race(user.id, 'CUBE42'))).resolves.toBeDefined();
    });
  });

  it('refuses to let a user befriend themselves', async () => {
    const user = await newUser('lonely@example.com');

    await expectViolation(
      db.insert(schema.friendships).values({ userId: user.id, friendId: user.id }),
      SqlState.CHECK_VIOLATION,
      'friendships_no_self',
    );
  });

  it('cascades a deleted user to their solves', async () => {
    const user = await newUser('gone@example.com');
    await db.insert(schema.solves).values(solve(user.id, 'bye-1'));

    await db.delete(schema.users).where(eq(schema.users.id, user.id));

    expect(await db.select().from(schema.solves)).toHaveLength(0);
  });

  it('serves a user + event history read from the composite index', async () => {
    const user = await newUser('indexed@example.com');
    await db
      .insert(schema.solves)
      .values([
        solve(user.id, 's1', { solvedAt: new Date('2026-07-01T10:00:00Z'), timeMs: 15_000 }),
        solve(user.id, 's2', { solvedAt: new Date('2026-07-02T10:00:00Z'), timeMs: 11_000 }),
        solve(user.id, 's3', { event: '2x2', solvedAt: new Date('2026-07-03T10:00:00Z') }),
      ]);

    const history = await db
      .select()
      .from(schema.solves)
      .where(and(eq(schema.solves.userId, user.id), eq(schema.solves.event, '3x3')))
      .orderBy(sql`${schema.solves.solvedAt} desc`);

    expect(history.map((s) => s.clientId)).toEqual(['s2', 's1']);
  });
});
