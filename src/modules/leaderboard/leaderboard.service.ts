import { BadRequestException, HttpException, HttpStatus, Injectable } from '@nestjs/common';

import { ErrorCode } from '../../common/errors/error-codes';
import { isKnownEvent } from '../../domain/wca-events';
import { LeaderboardResponseDto, toResponse } from './dto/leaderboard-response.dto';
import { LeaderboardRepository } from './leaderboard.repository';
import { LeaderboardQuery } from './leaderboard.types';

/**
 * Validation, metric dispatch, and the domain → wire mapping.
 *
 * The repository speaks the derived board and nothing else; this class is where
 * an unknown event becomes an `unknown_event` envelope and an unbuilt metric
 * becomes an honest `501` rather than a plausible-looking wrong number.
 */
@Injectable()
export class LeaderboardService {
  constructor(private readonly repository: LeaderboardRepository) {}

  async getLeaderboard(
    query: LeaderboardQuery & { metric: 'single' | 'ao5' | 'ao12' },
  ): Promise<LeaderboardResponseDto> {
    if (!isKnownEvent(query.event)) {
      throw new BadRequestException({
        code: ErrorCode.UNKNOWN_EVENT,
        message: `Unknown event '${query.event}'`,
      });
    }

    // ao5 / ao12 are rolling trimmed means (drop best and worst, DNF-aware) —
    // a correct windowed implementation is a slice of its own. Rather than ship
    // a number that is subtly wrong, `single` is implemented properly and the
    // averages are refused outright. See the spec's backend notes.
    if (query.metric !== 'single') {
      throw new HttpException(
        {
          code: ErrorCode.NOT_IMPLEMENTED,
          message: `metric '${query.metric}' is not implemented yet; only 'single' is available`,
        },
        HttpStatus.NOT_IMPLEMENTED,
      );
    }

    const page = await this.repository.findSingle(query.event, query.scope, query.viewerId, {
      cursor: query.cursor,
      limit: query.limit,
    });

    return toResponse(page, query.event);
  }
}
