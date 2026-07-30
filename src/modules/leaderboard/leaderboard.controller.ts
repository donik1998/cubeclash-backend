import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { LeaderboardResponseDto } from './dto/leaderboard-response.dto';
import { LeaderboardQueryDto } from './dto/leaderboard-query.dto';
import { LeaderboardService } from './leaderboard.service';

/**
 * `GET /leaderboard` — the ranked board, cursor-paginated, with the viewer's
 * own row pinned alongside.
 *
 * **Viewer identity is the authenticated principal**, injected by
 * `@CurrentUser('id')` behind `JwtAuthGuard`. This replaces the raw user-id
 * header that stood in before auth existed: the documented query contract
 * (`event/metric/scope/cursor/limit`) stays clean of identity — a client must
 * not be able to name itself — and now the server proves who is asking rather
 * than trusting a forgeable header.
 */
@Controller('leaderboard')
@UseGuards(JwtAuthGuard)
export class LeaderboardController {
  constructor(private readonly service: LeaderboardService) {}

  @Get()
  getLeaderboard(
    @Query() query: LeaderboardQueryDto,
    @CurrentUser('id') viewerId: string,
  ): Promise<LeaderboardResponseDto> {
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
