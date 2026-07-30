import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { StatsQueryDto } from './dto/stats-query.dto';
import { StatsResponseDto } from './dto/stats-response.dto';
import { StatsService } from './stats.service';

/**
 * `GET /stats?event=` — the caller's own per-event aggregates, behind
 * `JwtAuthGuard`. Thin: validate the query, delegate, return the wire shape the
 * service already built.
 */
@Controller('stats')
@UseGuards(JwtAuthGuard)
export class StatsController {
  constructor(private readonly stats: StatsService) {}

  @Get()
  getStats(
    @CurrentUser('id') userId: string,
    @Query() query: StatsQueryDto,
  ): Promise<StatsResponseDto> {
    return this.stats.getStats(userId, query.event);
  }
}
