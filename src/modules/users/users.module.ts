import { Module } from '@nestjs/common';

import { RaceModule } from '../race/race.module';
import { SolvesModule } from '../solves/solves.module';
import { UsersController } from './users.controller';
import { UsersRepository } from './users.repository';
import { UsersService } from './users.service';

/**
 * Profiles — the caller's own, and the public view of anyone else's.
 *
 * `UsersService` and `UsersRepository` are exported because `AuthModule`
 * composes them: registration creates a user and login reads one, both through
 * this module's service, so the credential store has a single owner.
 *
 * `SolvesModule` and `RaceModule` are imported because `GET /users/:id` is a
 * composite read: it reuses `SolvesRepository`'s ranked history for the profile
 * bests and `RaceRepository`'s head-to-head self-join for the rivalry record,
 * rather than reimplementing either.
 *
 * The `DRIZZLE` handle the repository injects comes from the @Global
 * `DrizzleModule`, so no import is needed for it.
 *
 * Endpoints: GET /me · PATCH /me · GET /users/:id
 */
@Module({
  imports: [SolvesModule, RaceModule],
  controllers: [UsersController],
  providers: [UsersService, UsersRepository],
  exports: [UsersService, UsersRepository],
})
export class UsersModule {}
