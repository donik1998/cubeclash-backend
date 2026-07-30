import { Module } from '@nestjs/common';

import { SolvesModule } from '../solves/solves.module';
import { StatsController } from './stats.controller';
import { StatsService } from './stats.service';

/**
 * Per-event aggregates: best single, ao5 / ao12 / ao100, session average, PB
 * count, solve count.
 *
 * A **read model**, not new storage — there is no `stats` table and no cached
 * aggregate. It reuses `SolvesModule`'s ranked history (hence the import) so the
 * ranking key and `is_pb` are computed once, in SQL, and never diverge from the
 * leaderboard or the profile. The trimmed-mean windows live in `average.ts` as a
 * pure, unit-tested function rather than a window query — see `StatsService` for
 * why.
 *
 * Endpoints: GET /stats
 */
@Module({
  imports: [SolvesModule],
  controllers: [StatsController],
  providers: [StatsService],
})
export class StatsModule {}
