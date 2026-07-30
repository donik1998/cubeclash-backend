import { Module } from '@nestjs/common';

import { LeaderboardController } from './leaderboard.controller';
import { LeaderboardRepository } from './leaderboard.repository';
import { LeaderboardService } from './leaderboard.service';

/**
 * Ranking, global / friends / country scoped.
 *
 * The board is **derived**, not stored: `solves` joined to `users`, one best
 * row per competitor, ranked with `RANK()` so ties share a place. Postgres is
 * the source of truth. Redis sorted sets keyed `event:metric:scope` are a
 * permitted cache on top of correct SQL — deferred, not part of this slice.
 *
 * Endpoints: GET /leaderboard
 *
 * The `DRIZZLE` handle the repository injects comes from the @Global
 * `DrizzleModule`, so no import is needed here.
 */
@Module({
  controllers: [LeaderboardController],
  providers: [LeaderboardService, LeaderboardRepository],
  // `LeaderboardRepository` is exported so the profile composite can look up a
  // viewer's own rank without reimplementing the `RANK() OVER (...)` query.
  exports: [LeaderboardService, LeaderboardRepository],
})
export class LeaderboardModule {}
