import { Module } from '@nestjs/common';

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
 * The `DRIZZLE` handle the repository injects comes from the @Global
 * `DrizzleModule`, so no import is needed here.
 *
 * Endpoints: GET /me · PATCH /me · GET /users/:id
 */
@Module({
  controllers: [UsersController],
  providers: [UsersService, UsersRepository],
  exports: [UsersService, UsersRepository],
})
export class UsersModule {}
