import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'; // prettier-ignore

import { ErrorCode } from '../../common/errors/error-codes';
import { isUniqueViolation } from '../../common/db/pg-error';
import { isKnownEvent } from '../../domain/wca-events';
import { User } from '../../db/schema';
import { RaceRepository } from '../race/race.repository';
import { SolvesRepository } from '../solves/solves.repository';
import { bestAverage } from '../stats/average';
import { ProfileUserDto, toProfile } from './dto/user-response.dto';
import { UserProfilePatch, UsersRepository } from './users.repository';

/** The profile screen opens on 3×3, so an unqualified request means 3×3. */
const DEFAULT_EVENT = '3x3';

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
  constructor(
    private readonly repository: UsersRepository,
    private readonly solves: SolvesRepository,
    private readonly races: RaceRepository,
  ) {}

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

  /**
   * The Player Profile read model: a user's public identity widened with their
   * event bests and the viewer's head-to-head record against them.
   *
   * A composite, not new storage. **Bests** reuse `ranking.ts` through
   * `SolvesRepository.findHistory` (so a `+2` folds in and a DNF drops out) and
   * `average.ts`'s trimmed mean via `bestAverage` — the *record* ao5/ao12, the
   * lowest the player ever posted, not the current rolling one. **Head-to-head**
   * is `RaceRepository.headToHead`, the same self-join the race history already
   * owns; here only its `wins`/`losses` matter.
   *
   * `head_to_head` is `null` when the viewer looks at their own profile, or when
   * the two have never met in a settled race — never a fabricated 0–0.
   */
  async getProfile(
    viewerId: string,
    targetId: string,
    event: string = DEFAULT_EVENT,
  ): Promise<ProfileUserDto> {
    // Shape is validated in the DTO; existence is validated here, so this owns
    // the `unknown_event` code exactly as `GET /stats` does.
    if (!isKnownEvent(event)) {
      throw new BadRequestException({
        code: ErrorCode.UNKNOWN_EVENT,
        message: `Unknown event '${event}'`,
      });
    }

    // Three independent reads — identity, ranked history, head-to-head — share
    // nothing, so they run together. Your own profile skips the self-join
    // entirely: there is no head-to-head with yourself.
    const [user, history, record] = await Promise.all([
      this.repository.findById(targetId),
      this.solves.findHistory(targetId, event),
      viewerId === targetId ? Promise.resolve(null) : this.races.headToHead(viewerId, targetId),
    ]);

    if (!user) {
      throw new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'User not found' });
    }

    const rankedValues = history.map((s) => s.rankingValue).filter((v): v is number => v !== null);
    // Averages read most-recent-last, so hand `bestAverage` chronological order.
    const chronological = [...history].reverse().map((s) => s.rankingValue);

    return toProfile(user, {
      best_single_ms: rankedValues.length > 0 ? Math.min(...rankedValues) : null,
      ao5: bestAverage(chronological, 5),
      ao12: bestAverage(chronological, 12),
      head_to_head: record ? { wins: record.wins, losses: record.losses } : null,
    });
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
