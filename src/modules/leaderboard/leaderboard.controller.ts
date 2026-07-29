import { Controller, Get, Headers, Query } from '@nestjs/common';

import { LeaderboardResponseDto } from './dto/leaderboard-response.dto';
import { LeaderboardQueryDto } from './dto/leaderboard-query.dto';
import { LeaderboardService } from './leaderboard.service';

/** A v4-ish UUID; anything else in the principal header is treated as absent. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `GET /leaderboard` — the ranked board, cursor-paginated, with the viewer's
 * own row pinned alongside.
 *
 * **Viewer identity comes from the `X-User-Id` header, not the query.** Auth is
 * not wired in this repo yet (`AuthModule` is still a stub), so the header
 * stands in for the authenticated principal that a JWT guard will later inject.
 * The documented query contract (`event/metric/scope/cursor/limit`) is kept
 * clean of it deliberately — a client must not be able to name itself. A
 * malformed id is treated as no viewer rather than a 500 on the `::uuid` cast:
 * `global` still ranks, and `friends`/`country` fall to an empty board.
 */
@Controller('leaderboard')
export class LeaderboardController {
  constructor(private readonly service: LeaderboardService) {}

  @Get()
  getLeaderboard(
    @Query() query: LeaderboardQueryDto,
    @Headers('x-user-id') rawViewerId?: string,
  ): Promise<LeaderboardResponseDto> {
    const viewerId = rawViewerId && UUID_RE.test(rawViewerId) ? rawViewerId : null;

    return this.service.getLeaderboard({
      event: query.event,
      metric: query.metric,
      scope: query.scope,
      viewerId,
      cursor: query.cursor,
      limit: query.limit,
    });
  }
}
