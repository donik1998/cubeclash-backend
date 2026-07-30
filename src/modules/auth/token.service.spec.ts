import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type Redis from 'ioredis';

import { Env } from '../../config/env';
import { RefreshTokenPayload } from './auth.types';
import { TokenService } from './token.service';

/**
 * A tiny in-memory Redis, implementing exactly the commands `TokenService`
 * uses. Dependency-free on purpose — the rotation and reuse-detection logic is
 * what is under test, not ioredis, and a fake makes the "which keys exist now"
 * assertions trivial and deterministic.
 */
class FakeRedis {
  readonly strings = new Map<string, string>();
  readonly sets = new Map<string, Set<string>>();

  set(key: string, value: string): Promise<'OK'> {
    this.strings.set(key, value);
    return Promise.resolve('OK');
  }

  getdel(key: string): Promise<string | null> {
    const value = this.strings.get(key) ?? null;
    this.strings.delete(key);
    return Promise.resolve(value);
  }

  sadd(key: string, ...members: string[]): Promise<number> {
    const set = this.sets.get(key) ?? new Set<string>();
    members.forEach((m) => set.add(m));
    this.sets.set(key, set);
    return Promise.resolve(members.length);
  }

  srem(key: string, ...members: string[]): Promise<number> {
    const set = this.sets.get(key);
    let removed = 0;
    members.forEach((m) => set?.delete(m) && removed++);
    return Promise.resolve(removed);
  }

  smembers(key: string): Promise<string[]> {
    return Promise.resolve([...(this.sets.get(key) ?? [])]);
  }

  expire(): Promise<number> {
    return Promise.resolve(1);
  }

  del(...keys: string[]): Promise<number> {
    let removed = 0;
    keys.forEach((k) => {
      if (this.strings.delete(k)) removed++;
      this.sets.delete(k);
    });
    return Promise.resolve(removed);
  }

  multi(): FakeMulti {
    return new FakeMulti(this);
  }
}

/** Queues commands and runs them on exec, like ioredis's pipeline. */
class FakeMulti {
  private readonly ops: Array<() => Promise<unknown>> = [];
  constructor(private readonly redis: FakeRedis) {}

  set(...args: [string, string, ...unknown[]]): this {
    this.ops.push(() => this.redis.set(args[0], args[1]));
    return this;
  }
  sadd(key: string, ...members: string[]): this {
    this.ops.push(() => this.redis.sadd(key, ...members));
    return this;
  }
  srem(key: string, ...members: string[]): this {
    this.ops.push(() => this.redis.srem(key, ...members));
    return this;
  }
  expire(): this {
    this.ops.push(() => this.redis.expire());
    return this;
  }
  del(...keys: string[]): this {
    this.ops.push(() => this.redis.del(...keys));
    return this;
  }
  async exec(): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const op of this.ops) results.push([null, await op()]);
    return results;
  }
}

const CONFIG: Record<string, string> = {
  JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters-long',
  JWT_ACCESS_TTL: '15m',
  JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters-long',
  JWT_REFRESH_TTL: '30d',
};

describe('TokenService', () => {
  const USER = '11111111-1111-4111-8111-111111111111';
  let redis: FakeRedis;
  let jwt: JwtService;
  let service: TokenService;

  const config = {
    get: (key: string) => CONFIG[key],
  } as unknown as ConfigService<Env, true>;

  const jtiOf = (refresh: string): string => jwt.decode<RefreshTokenPayload>(refresh).jti;

  beforeEach(() => {
    redis = new FakeRedis();
    jwt = new JwtService({});
    service = new TokenService(jwt, config, redis as unknown as Redis);
  });

  // ------------------------------------------------------------- issue

  it('issues an access token carrying only sub, and expires_in in seconds', async () => {
    const pair = await service.issueTokens(USER);

    const access = jwt.verify<{ sub: string; email?: string }>(pair.access, {
      secret: CONFIG.JWT_ACCESS_SECRET,
    });
    expect(access.sub).toBe(USER);
    expect(access.email).toBeUndefined(); // minimal payload (§1.6)
    expect(pair.expiresIn).toBe(900); // 15m

    // The refresh session is recorded under its jti and in the user's set.
    const jti = jtiOf(pair.refresh);
    expect(redis.strings.get(`refresh:${jti}`)).toBe(USER);
    expect(await redis.smembers(`user_sessions:${USER}`)).toContain(jti);
  });

  // ------------------------------------------------------------- rotation

  it('rotates: a fresh pair, the old jti burned, the new one live', async () => {
    const first = await service.issueTokens(USER);
    const firstJti = jtiOf(first.refresh);

    const second = await service.rotate(first.refresh);
    const secondJti = jtiOf(second.refresh);

    expect(secondJti).not.toBe(firstJti);
    expect(redis.strings.has(`refresh:${firstJti}`)).toBe(false); // spent
    expect(redis.strings.get(`refresh:${secondJti}`)).toBe(USER); // live
    expect(await redis.smembers(`user_sessions:${USER}`)).toEqual([secondJti]);
  });

  it('rejects an old refresh token once it has been rotated away', async () => {
    const first = await service.issueTokens(USER);
    await service.rotate(first.refresh);

    await expect(service.rotate(first.refresh)).rejects.toMatchObject({ status: 401 });
  });

  // -------------------------------------------------- reuse detection

  it('reuse of a rotated token revokes every session for that user', async () => {
    // Two independent sessions — phone and laptop.
    const phone = await service.issueTokens(USER);
    const laptop = await service.issueTokens(USER);
    const laptopJti = jtiOf(laptop.refresh);

    // Phone rotates normally...
    const phone2 = await service.rotate(phone.refresh);
    expect(redis.strings.size).toBe(2); // phone2 + laptop still live

    // ...then the *original* phone token is replayed (stolen, or a bug).
    await expect(service.rotate(phone.refresh)).rejects.toMatchObject({ status: 401 });

    // Every session is gone — not just the replayed one.
    expect(redis.strings.size).toBe(0);
    expect(await redis.smembers(`user_sessions:${USER}`)).toEqual([]);

    // And the laptop, which did nothing wrong, is now signed out too.
    await expect(service.rotate(laptop.refresh)).rejects.toMatchObject({ status: 401 });
    await expect(service.rotate(phone2.refresh)).rejects.toMatchObject({ status: 401 });
    expect(laptopJti).toBeDefined();
  });

  // ------------------------------------------------------------- logout

  it('logout burns only the presented session, leaving others alone', async () => {
    const phone = await service.issueTokens(USER);
    const laptop = await service.issueTokens(USER);
    const laptopJti = jtiOf(laptop.refresh);

    await service.logout(phone.refresh);

    // Phone is out; laptop is untouched and can still rotate.
    expect(redis.strings.has(`refresh:${jtiOf(phone.refresh)}`)).toBe(false);
    expect(redis.strings.get(`refresh:${laptopJti}`)).toBe(USER);
    await expect(service.rotate(laptop.refresh)).resolves.toHaveProperty('access');
  });

  it('logout is a forgiving no-op for a garbage token', async () => {
    await expect(service.logout('not-a-jwt')).resolves.toBeUndefined();
  });
});
