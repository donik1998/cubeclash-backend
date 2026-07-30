import { Module } from '@nestjs/common';

/**
 * Registration, login, and JWT lifecycle.

 * Short-lived access (~15 min) plus a refresh token (~30 d) with rotation, so a
 * stolen refresh token is usable exactly once before it is detectably burned.
 *
 * Endpoints: POST /auth/register · /auth/login · /auth/refresh · /auth/logout
 *
 * Not implemented yet — registered so the module graph matches the documented
 * architecture from the first commit.
 */
@Module({})
export class AuthModule {}
