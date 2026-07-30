import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';

import { ConfigModule } from './config/config.module';
import { DrizzleModule } from './db/drizzle.module';
import { RedisModule } from './common/redis/redis.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';

import { HealthModule } from './modules/health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { SolvesModule } from './modules/solves/solves.module';
import { SyncModule } from './modules/sync/sync.module';
import { ScrambleModule } from './modules/scramble/scramble.module';
import { StatsModule } from './modules/stats/stats.module';
import { LeaderboardModule } from './modules/leaderboard/leaderboard.module';
import { ProfileModule } from './modules/profile/profile.module';
import { RaceModule } from './modules/race/race.module';
import { FriendsModule } from './modules/friends/friends.module';
import { TournamentsModule } from './modules/tournaments/tournaments.module';

/**
 * A modular monolith: one deployable, ten domain modules, two planes.
 *
 * The stateless plane (auth, solves, sync, stats, leaderboard, lobby) scales
 * horizontally with no session affinity. The stateful plane (`RaceModule`'s
 * gateway) keeps room state in Redis and fans out over the Redis adapter, so it
 * scales the same way. Module boundaries are drawn so the race tier can be
 * lifted into its own service later without touching the others.
 */
@Module({
  imports: [
    // Infrastructure — all @Global.
    ConfigModule,
    DrizzleModule,
    RedisModule,

    // Operations.
    HealthModule,

    // Domain.
    AuthModule,
    UsersModule,
    SolvesModule,
    SyncModule,
    ScrambleModule,
    StatsModule,
    LeaderboardModule,
    ProfileModule,
    RaceModule,
    FriendsModule,
    TournamentsModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
  ],
})
export class AppModule {}
