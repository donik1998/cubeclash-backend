import { Module } from '@nestjs/common';

/**
 * Profiles — the caller's own, and the public view of anyone else's.

 * Endpoints: GET /me · PATCH /me · GET /users/:id
 *
 * Not implemented yet — registered so the module graph matches the documented
 * architecture from the first commit.
 */
@Module({})
export class UsersModule {}
