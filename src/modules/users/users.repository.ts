import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import { DRIZZLE, Database } from '../../db/drizzle.module';
import { NewUser, User, users } from '../../db/schema';

/** The columns a profile update may touch. Everything else on `users` is server-owned. */
export interface UserProfilePatch {
  displayName?: string;
  country?: string | null;
}

/**
 * Reads and writes against `users`, and nothing cleverer.
 *
 * The interesting user-facing derivations — best single, rank, win rate — live
 * in the profile read model, not here; this repository is the plain CRUD seam
 * the auth and users services sit on. It stays dumb on purpose: the service
 * decides policy (what a duplicate email means, which shape a caller may see),
 * the repository just moves rows.
 */
@Injectable()
export class UsersRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** Insert a new user. A duplicate email raises `users_email_key`; the service maps it. */
  async create(input: Pick<NewUser, 'email' | 'passwordHash' | 'displayName'>): Promise<User> {
    const [user] = await this.db.insert(users).values(input).returning();
    return user;
  }

  /** Lookup by canonical (already lower-cased) email. `citext` makes the match case-insensitive. */
  async findByEmail(email: string): Promise<User | undefined> {
    const [user] = await this.db.select().from(users).where(eq(users.email, email)).limit(1);
    return user;
  }

  async findById(id: string): Promise<User | undefined> {
    const [user] = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    return user;
  }

  /**
   * Apply a profile patch and return the updated row, or `undefined` if no such
   * user (a valid token for a since-deleted account). `updatedAt` is bumped by
   * the schema's `$onUpdate`, so it is not set here.
   */
  async updateProfile(id: string, patch: UserProfilePatch): Promise<User | undefined> {
    const [user] = await this.db.update(users).set(patch).where(eq(users.id, id)).returning();
    return user;
  }
}
