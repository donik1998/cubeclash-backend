import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

import { Env } from '../../config/env';
import { ErrorCode } from '../../common/errors/error-codes';
import { AccessTokenPayload, AuthPrincipal } from './auth.types';

/**
 * Validates the `Authorization: Bearer <access>` token on protected routes.
 *
 * It does exactly one thing: check the signature and expiry, then hand back the
 * principal. It deliberately does **not** hit the database — access tokens are
 * stateless (§1.5), so a request costs one HMAC verification and no round trip.
 * A token for a since-deleted user still validates here; the endpoint that
 * needs the user record (e.g. `GET /me`) is where that surfaces as a 404, which
 * is the right place for it.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService<Env, true>) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get('JWT_ACCESS_SECRET', { infer: true }),
    });
  }

  validate(payload: AccessTokenPayload): AuthPrincipal {
    if (!payload?.sub) {
      throw new UnauthorizedException({
        code: ErrorCode.UNAUTHORIZED,
        message: 'Malformed access token',
      });
    }
    return { id: payload.sub };
  }
}
