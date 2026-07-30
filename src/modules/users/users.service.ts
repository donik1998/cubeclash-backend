import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import { ErrorCode } from '../../common/errors/error-codes';
import { isUniqueViolation } from '../../common/db/pg-error';
import { User } from '../../db/schema';
import { UserProfilePatch, UsersRepository } from './users.repository';

/**
 * User lifecycle and access rules, on top of the dumb repository.
 *
 * This is where policy lives: a duplicate email is a `409 conflict` (§1.8, and
 * not a 422 — the request was well-formed, the world just already contains that
 * user), a valid token for a vanished account is a `404`, and the caller only
 * ever gets back a `User` entity — mapping it to the self-or-public wire shape
 * is the controller's decision, made per route, so the email-leak wall (§1.7)
 * is impossible to cross by accident.
 */
@Injectable()
export class UsersService {
  constructor(private readonly repository: UsersRepository) {}

  /**
   * Create a user from an already-hashed credential. Racing two registrations
   * for the same email leaves the unique index to arbitrate, and the loser
   * becomes a clean 409 rather than a 500 — check-then-insert would have a gap
   * the index does not.
   */
  async create(input: { email: string; passwordHash: string; displayName: string }): Promise<User> {
    try {
      return await this.repository.create(input);
    } catch (error) {
      if (isUniqueViolation(error, 'users_email_key')) {
        throw new ConflictException({
          code: ErrorCode.CONFLICT,
          message: 'An account with that email already exists',
        });
      }
      throw error;
    }
  }

  /** The auth path's lookup — returns the entity (hash included) or undefined. */
  findByEmail(email: string): Promise<User | undefined> {
    return this.repository.findByEmail(email);
  }

  /** Fetch a user by id or 404. Used for both `GET /me` and `GET /users/:id`. */
  async getById(id: string): Promise<User> {
    const user = await this.repository.findById(id);
    if (!user) {
      throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'User not found' });
    }
    return user;
  }

  /** Apply a profile patch or 404 if the caller's account no longer exists. */
  async updateProfile(id: string, patch: UserProfilePatch): Promise<User> {
    const user = await this.repository.updateProfile(id, patch);
    if (!user) {
      throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'User not found' });
    }
    return user;
  }
}
