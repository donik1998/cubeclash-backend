import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';

import { Env } from '../../config/env';
import { ErrorCode } from '../../common/errors/error-codes';
import { REDIS } from '../../common/redis/redis.module';
import { RefreshTokenPayload, TokenPair } from './auth.types';
import { durationToSeconds } from './duration';

/**
 * jsonwebtoken accepts a duration *string* (`'15m'`) at runtime, but the typing
 * narrows to a `ms`-style template literal that a plain `string` from config
 * does not satisfy. The values are validated at boot, so this cast is safe.
 */
type ExpiresIn = JwtSignOptions['expiresIn'];

/** The Redis key a single refresh session lives under. */
const refreshKey = (jti: string): string => `refresh:${jti}`;
/** The set of every live `jti` for one user — the handle for "revoke everything". */
const userSessionsKey = (userId: string): string => `user_sessions:${userId}`;

/**
 * The JWT lifecycle: issue, rotate, revoke — and the reuse detection that makes
 * a stolen refresh token detectably single-use.
 *
 * **Refresh sessions live in Redis, not a table** (§1.2). A refresh session is
 * ephemeral hot state — created on login, rotated on every use, gone on
 * logout — which is exactly what Redis is for and exactly what Postgres is not.
 * This is why the slice needs no new table and no migration.
 *
 * **Access tokens are stateless** (§1.5): they are signed and never recorded.
 * Fifteen minutes is the whole blast radius of a leaked one, and a denylist
 * would put Redis in the path of every authenticated request for a threat that
 * short-lived tokens already bound.
 *
 * **Rotation with reuse detection** (§1.3) is the interesting part. Every
 * refresh token carries a `jti`, and issuing one writes `refresh:{jti} -> userId`.
 * `refresh()` atomically *deletes* that key as it reads it (`GETDEL`), so the
 * token it was presented with is now spent. Present it again and the key is
 * already gone — but the signature still verifies, which is the signature of a
 * **replay**: either an attacker is using a token the legitimate client already
 * rotated past, or vice versa. We cannot tell which, so we revoke *every*
 * session for that user and force a fresh login. A benign double-submit and a
 * real theft look identical here, and treating both as hostile is the safe
 * choice.
 */
@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);

  private readonly accessSecret: string;
  private readonly accessTtl: string;
  private readonly refreshSecret: string;
  private readonly refreshTtl: string;

  constructor(
    private readonly jwt: JwtService,
    config: ConfigService<Env, true>,
    @Inject(REDIS) private readonly redis: Redis,
  ) {
    this.accessSecret = config.get('JWT_ACCESS_SECRET', { infer: true });
    this.accessTtl = config.get('JWT_ACCESS_TTL', { infer: true });
    this.refreshSecret = config.get('JWT_REFRESH_SECRET', { infer: true });
    this.refreshTtl = config.get('JWT_REFRESH_TTL', { infer: true });
  }

  /**
   * Mint a fresh access + refresh pair and register the refresh session.
   *
   * The two tokens are signed with *different* secrets so a leaked access
   * secret can never be used to forge a refresh token, and vice versa. The
   * refresh `jti` is recorded both under its own key (for O(1) rotation) and in
   * the user's session set (so a full revoke is one `SMEMBERS`), and both keys
   * carry the refresh TTL so an abandoned session expires on its own.
   */
  async issueTokens(userId: string): Promise<TokenPair> {
    const access = await this.jwt.signAsync(
      {},
      { subject: userId, secret: this.accessSecret, expiresIn: this.accessTtl as ExpiresIn },
    );

    const jti = randomUUID();
    const refresh = await this.jwt.signAsync(
      {},
      {
        subject: userId,
        jwtid: jti,
        secret: this.refreshSecret,
        expiresIn: this.refreshTtl as ExpiresIn,
      },
    );

    const refreshTtlSeconds = durationToSeconds(this.refreshTtl);
    await this.redis
      .multi()
      .set(refreshKey(jti), userId, 'EX', refreshTtlSeconds)
      .sadd(userSessionsKey(userId), jti)
      .expire(userSessionsKey(userId), refreshTtlSeconds)
      .exec();

    return { access, refresh, expiresIn: durationToSeconds(this.accessTtl) };
  }

  /**
   * Rotate a refresh token: verify it, spend it, and issue a fresh pair.
   *
   * A valid signature whose `jti` is already gone is treated as reuse of a
   * spent token and triggers a full revoke — see the class doc.
   */
  async rotate(refreshToken: string): Promise<TokenPair> {
    const payload = await this.verifyRefresh(refreshToken);

    // Atomic read-and-delete: the token is spent the instant it is accepted,
    // so two concurrent uses of the same token cannot both succeed.
    const owner = await this.redis.getdel(refreshKey(payload.jti));

    if (owner === null) {
      // Signature valid, but the session is not on record — a replay of an
      // already-rotated (or logged-out) token. Assume compromise and burn it all.
      this.logger.warn(`Refresh reuse detected for user ${payload.sub}; revoking all sessions`);
      await this.revokeAllSessions(payload.sub);
      throw new UnauthorizedException({
        code: ErrorCode.UNAUTHORIZED,
        message: 'Session expired; please sign in again',
      });
    }

    await this.redis.srem(userSessionsKey(payload.sub), payload.jti);
    return this.issueTokens(owner);
  }

  /**
   * Log out one session: delete just the presented token's `jti` (§1.4).
   *
   * Logging out on a phone must not sign out a laptop, so this is deliberately
   * *not* a full revoke. It is idempotent and forgiving — an expired or
   * malformed token still returns cleanly, because "make this token stop
   * working" is already true of a token that no longer works.
   */
  async logout(refreshToken: string): Promise<void> {
    let payload: RefreshTokenPayload;
    try {
      payload = await this.verifyRefresh(refreshToken);
    } catch {
      return; // nothing to revoke — a no-op logout is still a successful logout
    }

    await this.redis
      .multi()
      .del(refreshKey(payload.jti))
      .srem(userSessionsKey(payload.sub), payload.jti)
      .exec();
  }

  /** Delete every refresh session for a user — the reuse-detection response. */
  async revokeAllSessions(userId: string): Promise<void> {
    const jtis = await this.redis.smembers(userSessionsKey(userId));
    const keys = jtis.map(refreshKey);
    await this.redis.del(...keys, userSessionsKey(userId));
  }

  private async verifyRefresh(token: string): Promise<RefreshTokenPayload> {
    try {
      return await this.jwt.verifyAsync<RefreshTokenPayload>(token, {
        secret: this.refreshSecret,
      });
    } catch {
      throw new UnauthorizedException({
        code: ErrorCode.UNAUTHORIZED,
        message: 'Invalid or expired refresh token',
      });
    }
  }
}
