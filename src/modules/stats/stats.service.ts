import { BadRequestException, Injectable } from '@nestjs/common';

import { ErrorCode } from '../../common/errors/error-codes';
import { isKnownEvent } from '../../domain/wca-events';
import { SolvesRepository } from '../solves/solves.repository';
import { StatsResponseDto } from './dto/stats-response.dto';
import { RankingValue, sessionAverage, trimmedAverage } from './average';

/**
 * Per-event aggregates: best single, rolling ao5 / ao12 / ao100, session
 * average, PB count and solve count — all derived, none stored.
 *
 * **Where the SQL ends and TypeScript begins.** The ranking key and the `is_pb`
 * window are SQL (`ranking.ts`), reused verbatim through `SolvesRepository` so a
 * `+2` folds in and a DNF drops out exactly as everywhere else. The *trimmed
 * mean with its DNF tolerance* is deliberately here in TypeScript: drop-best-
 * drop-worst-unless-two-DNFs is a fiddly, edge-case-heavy reduction that is far
 * clearer — and far more testable — as a pure function (`average.ts`, with the
 * required 0/1/2-DNF matrix) than as a window expression. One indexed read of
 * the event history feeds all of it.
 */
@Injectable()
export class StatsService {
  constructor(private readonly solves: SolvesRepository) {}

  async getStats(userId: string, event: string): Promise<StatsResponseDto> {
    if (!isKnownEvent(event)) {
      throw new BadRequestException({
        code: ErrorCode.UNKNOWN_EVENT,
        message: `Unknown event '${event}'`,
      });
    }

    // Newest-first, tombstones already excluded, `is_pb` and ranking value
    // computed in SQL over the whole live history.
    const history = await this.solves.findHistory(userId, event);

    const solveCount = history.length;
    const pbCount = history.filter((s) => s.isPb).length;

    const rankedValues = history.map((s) => s.rankingValue).filter((v): v is number => v !== null);
    const bestSingleMs = rankedValues.length > 0 ? Math.min(...rankedValues) : null;

    // Averages walk the window most-recent-last, so flip to chronological order.
    const chronological: RankingValue[] = [...history].reverse().map((s) => s.rankingValue);

    return {
      event,
      best_single_ms: bestSingleMs,
      ao5: trimmedAverage(chronological, 5),
      ao12: trimmedAverage(chronological, 12),
      ao100: trimmedAverage(chronological, 100),
      session_average: sessionAverage(chronological),
      pb_count: pbCount,
      solve_count: solveCount,
    };
  }
}
