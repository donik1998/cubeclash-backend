import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import type Redis from 'ioredis';

import { ErrorCode } from '../errors/error-codes';
import { REDIS } from '../redis/redis.module';
import { RATE_LIMIT_KEY, RateLimitOptions } from './rate-limit.decorator';

/**
 * A fixed-window rate limiter backed by Redis.
 *
 * Redis, not in-process memory, because the API scales horizontally: a
 * per-instance counter would let an attacker get `limit × instanceCount`
 * attempts, and would reset every deploy. The window is a single `INCR` keyed by
 * route + client IP, given a TTL on the first hit of the window — one round trip
 * per request, no background sweeper, and the key evicts itself.
 *
 * **Fail-open.** If Redis is unreachable the guard *allows* the request rather
 * than 500-ing the login endpoint: a throttle outage must not become an
 * authentication outage. The trade-off (no limiting while Redis is down) is the
 * right one for a availability-critical front door.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);

  constructor(
    private readonly reflector: Reflector,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options = this.reflector.getAllAndOverride<RateLimitOptions | undefined>(RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!options) return true; // no policy on this route → nothing to enforce

    const request = context.switchToHttp().getRequest<Request>();
    const key = this.keyFor(request);

    let count: number;
    try {
      count = await this.redis.incr(key);
      if (count === 1) {
        // First hit of a new window — start its clock.
        await this.redis.expire(key, options.windowSeconds);
      }
    } catch (error) {
      // A throttle that cannot reach Redis must not take auth down with it.
      this.logger.error(`Rate-limit check failed open: ${String(error)}`);
      return true;
    }

    if (count > options.limit) {
      throw new HttpException(
        { code: ErrorCode.RATE_LIMITED, message: 'Too many requests; please slow down' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }

  /** `ratelimit:<METHOD path>:<ip>` — one window per route per client. */
  private keyFor(request: Request): string {
    const route = `${request.method} ${request.baseUrl}${request.path}`;
    return `ratelimit:${route}:${request.ip ?? 'unknown'}`;
  }
}
