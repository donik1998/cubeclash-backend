import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';

import { RateLimitGuard } from '../../common/guards/rate-limit.guard';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { JwtStrategy } from './jwt.strategy';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

/**
 * Registration, login, and the JWT lifecycle.
 *
 * Short-lived access tokens (~15 min, stateless) plus refresh tokens (~30 d)
 * that **rotate on every use with reuse detection** — a stolen refresh token is
 * usable exactly once before its replay is detected and every session for that
 * user is burned (see `TokenService`). Refresh sessions live in Redis, not a
 * table, so this whole module needs no schema change.
 *
 * `JwtModule` is registered empty on purpose: access and refresh tokens are
 * signed with *different* secrets, so the secret and TTL are passed per-call in
 * `TokenService` rather than fixed once here.
 *
 * `JwtStrategy` registers the Passport `jwt` strategy process-wide the moment
 * it is instantiated, which is why `JwtAuthGuard` works in every other module
 * without importing this one. It is still exported here for explicitness.
 *
 * Endpoints: POST /auth/register · /auth/login · /auth/refresh · /auth/logout
 */
@Module({
  imports: [UsersModule, PassportModule, JwtModule.register({})],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    TokenService,
    JwtStrategy,
    JwtAuthGuard,
    RateLimitGuard,
  ],
  exports: [JwtAuthGuard, TokenService],
})
export class AuthModule {}
