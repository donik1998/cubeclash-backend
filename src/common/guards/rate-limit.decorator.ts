import { SetMetadata } from '@nestjs/common';

export const RATE_LIMIT_KEY = 'rate_limit';

/** A fixed-window limit: at most `limit` requests per `windowSeconds`. */
export interface RateLimitOptions {
  limit: number;
  windowSeconds: number;
}

/**
 * `@RateLimit({ limit, windowSeconds })` — cap how often an unauthenticated
 * endpoint can be hit from one IP.
 *
 * Used on `register` and `login` (API Design § Cross-cutting): both are
 * pre-auth, both are the front door for credential-stuffing and enumeration, so
 * they are throttled where authenticated routes are not.
 */
export const RateLimit = (options: RateLimitOptions) => SetMetadata(RATE_LIMIT_KEY, options);
