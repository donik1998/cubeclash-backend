import { BadRequestException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common'; // prettier-ignore

import { ErrorCode } from '../../common/errors/error-codes';
import { isKnownEvent } from '../../domain/wca-events';
import { LeaderboardRepository } from '../leaderboard/leaderboard.repository';
import { SolvesRepository } from '../solves/solves.repository';
import { ProfileRepository } from './profile.repository';
import { ProfileQuery, ProfileView } from './profile.types';

/**
 * The "You · Profile" composite — six values the screen needs in one round trip,
 * assembled from parts that already exist.
 *
 * Nothing here reinvents ranking: **best-in-event** is `SolvesRepository`'s
 * personal-best query (which folds a `+2` in and drops a DNF via `ranking.ts`),
 * and **rank** is the leaderboard's own `RANK() OVER (...)` looked up for the
 * viewer's own row. This class validates the event, refuses an anonymous
 * caller, runs the three reads concurrently, and does the one bit of arithmetic
 * the wire owes the client — the win-rate ratio.
 */
@Injectable()
export class ProfileService {
  constructor(
    private readonly repository: ProfileRepository,
    private readonly solves: SolvesRepository,
    private readonly leaderboard: LeaderboardRepository,
  ) {}

  async getProfile(query: ProfileQuery): Promise<ProfileView> {
    // No path or query names the user — identity is the principal, so with no
    // principal there is no profile to return.
    if (!query.viewerId) {
      throw new HttpException(
        { code: ErrorCode.UNAUTHORIZED, message: 'Authentication required' },
        HttpStatus.UNAUTHORIZED,
      );
    }

    if (!isKnownEvent(query.event)) {
      throw new BadRequestException({
        code: ErrorCode.UNKNOWN_EVENT,
        message: `Unknown event '${query.event}'`,
      });
    }

    // Three independent reads: the aggregate (user + counts), the best single,
    // and the ranked board for the viewer's own row. They share nothing, so
    // they run together rather than in series.
    const [aggregate, best, page] = await Promise.all([
      this.repository.findAggregate(query.viewerId),
      this.solves.personalBest(query.viewerId, query.event),
      this.leaderboard.findSingle(query.event, query.rankScope, query.viewerId, { limit: 1 }),
    ]);

    // A valid principal that resolves to no user — a deleted account still
    // holding a token. Not our own row to invent, so a 404 rather than a lie.
    if (!aggregate) {
      throw new NotFoundException({
        code: ErrorCode.NOT_FOUND,
        message: 'Profile not found',
      });
    }

    const total = aggregate.wins + aggregate.losses;

    return {
      user: aggregate.user,
      // The viewer's leaderboard row carries their true place in the scope even
      // when it sits far below page 1; null when they have no ranked solve.
      rank: page.viewer
        ? {
            event: query.event,
            metric: 'single',
            scope: query.rankScope,
            position: page.viewer.rank,
          }
        : null,
      stats: {
        bestSingleMs: best?.rankingValue ?? null,
        bestSingleEvent: query.event,
        totalSolves: aggregate.totalSolves,
        // Null, not 0, when there is nothing to divide — the client renders "—".
        winRate: total === 0 ? null : aggregate.wins / total,
        wins: aggregate.wins,
        losses: aggregate.losses,
      },
      friendCount: aggregate.friendCount,
    };
  }
}
