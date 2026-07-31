import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type Redis from 'ioredis';

import { RateLimitGuard } from './rate-limit.guard';
import { RateLimitOptions } from './rate-limit.decorator';

/**
 * The guard's contract, and one thing it used to get wrong: a 429 with no
 * `Retry-After` forces every client to guess how long to wait. The Android
 * live suite guessed a linear 1-6s backoff against a 60s window and flaked;
 * Redis already knows the exact answer as the key's remaining TTL.
 */
describe('RateLimitGuard', () => {
  const OPTIONS: RateLimitOptions = { limit: 10, windowSeconds: 60 };

  let setHeader: jest.Mock;
  let redis: { incr: jest.Mock; expire: jest.Mock; ttl: jest.Mock };

  const context = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({
      getRequest: () => ({ method: 'POST', baseUrl: '/v1', path: '/auth/register', ip: '1.2.3.4' }),
      getResponse: () => ({ setHeader }),
    }),
  } as unknown as ExecutionContext;

  /**
   * Builds the guard for a given policy. Kept separate from [context] on
   * purpose: an earlier version created the guard *inside* the context factory
   * and was called as `guardWithPolicy().canActivate(context)`, which resolves
   * `guard.canActivate` before evaluating the argument — so every test but the
   * first silently ran against the previous test's guard and mocks.
   */
  const guardFor = (options: RateLimitOptions | undefined): RateLimitGuard =>
    new RateLimitGuard(
      { getAllAndOverride: () => options } as unknown as Reflector,
      redis as unknown as Redis,
    );

  // Explicit rather than a default parameter: `guardFor(undefined)` would
  // *trigger* a default, quietly handing the no-policy test the policy it was
  // written to omit.
  const guardWithPolicy = (): RateLimitGuard => guardFor(OPTIONS);
  const guardWithoutPolicy = (): RateLimitGuard => guardFor(undefined);

  beforeEach(() => {
    setHeader = jest.fn();
    redis = { incr: jest.fn(), expire: jest.fn(), ttl: jest.fn() };
  });

  it('allows a request inside the window', async () => {
    redis.incr.mockResolvedValue(3);

    await expect(guardWithPolicy().canActivate(context)).resolves.toBe(true);
    expect(setHeader).not.toHaveBeenCalled();
  });

  it('starts the window clock on the first hit only', async () => {
    redis.incr.mockResolvedValue(1);
    await guardWithPolicy().canActivate(context);
    expect(redis.expire).toHaveBeenCalledWith(
      expect.stringContaining('POST /v1/auth/register'),
      60,
    );

    redis.expire.mockClear();
    redis.incr.mockResolvedValue(2);
    await guardWithPolicy().canActivate(context);
    expect(redis.expire).not.toHaveBeenCalled();
  });

  it('sends Retry-After with the window’s remaining TTL when it throttles', async () => {
    redis.incr.mockResolvedValue(11);
    redis.ttl.mockResolvedValue(37);

    await expect(guardWithPolicy().canActivate(context)).rejects.toBeInstanceOf(HttpException);
    expect(setHeader).toHaveBeenCalledWith('Retry-After', '37');
  });

  it.each([
    ['no expiry set', -1],
    ['key already gone', -2],
  ])('falls back to the full window when the TTL is unusable (%s)', async (_label, ttl) => {
    redis.incr.mockResolvedValue(11);
    redis.ttl.mockResolvedValue(ttl);

    await expect(guardWithPolicy().canActivate(context)).rejects.toBeInstanceOf(HttpException);
    // Never a negative or zero Retry-After — that would invite a busy loop.
    expect(setHeader).toHaveBeenCalledWith('Retry-After', '60');
  });

  it('still throttles with a sane Retry-After if the TTL lookup itself fails', async () => {
    redis.incr.mockResolvedValue(11);
    redis.ttl.mockRejectedValue(new Error('redis blip'));

    await expect(guardWithPolicy().canActivate(context)).rejects.toBeInstanceOf(HttpException);
    expect(setHeader).toHaveBeenCalledWith('Retry-After', '60');
  });

  it('throws 429 with the documented error code', async () => {
    redis.incr.mockResolvedValue(11);
    redis.ttl.mockResolvedValue(5);

    await guardWithPolicy()
      .canActivate(context)
      .catch((error: HttpException) => {
        expect(error.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
        expect(error.getResponse()).toMatchObject({ code: 'rate_limited' });
      });
    expect.assertions(2);
  });

  it('fails open when Redis is unreachable — a throttle outage is not an auth outage', async () => {
    redis.incr.mockRejectedValue(new Error('down'));

    await expect(guardWithPolicy().canActivate(context)).resolves.toBe(true);
  });

  it('is a no-op on a route with no policy', async () => {
    await expect(guardWithoutPolicy().canActivate(context)).resolves.toBe(true);
    expect(redis.incr).not.toHaveBeenCalled();
  });
});
