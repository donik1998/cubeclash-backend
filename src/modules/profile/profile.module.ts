import { Module } from '@nestjs/common';

import { LeaderboardModule } from '../leaderboard/leaderboard.module';
import { SolvesModule } from '../solves/solves.module';
import { ProfileController } from './profile.controller';
import { ProfileRepository } from './profile.repository';
import { ProfileService } from './profile.service';

/**
 * The "You · Profile" composite read model.
 *
 * A **read model**, not new storage: every value is a query over existing
 * tables. There is no `profile` table and no new column — the endpoint exists
 * only because the screen needs six values in one round trip.
 *
 * It owns just the aggregate query (`ProfileRepository`); best-in-event and
 * rank are reused from `SolvesModule` and `LeaderboardModule` rather than
 * reimplemented, which is why both are imported for their exported repositories.
 *
 * Endpoints: GET /me/profile
 */
@Module({
  imports: [SolvesModule, LeaderboardModule],
  controllers: [ProfileController],
  providers: [ProfileService, ProfileRepository],
})
export class ProfileModule {}
