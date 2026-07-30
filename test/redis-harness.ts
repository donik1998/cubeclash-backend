import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';

export interface RedisHarness {
  url: string;
  stop: () => Promise<void>;
}

/**
 * A real Redis for the integration suite — the auth flows store refresh
 * sessions in it, and the rate limiter counts in it, so a mock would prove
 * nothing about rotation or reuse detection.
 *
 * Mirrors `postgres-harness`'s two ways in: `TEST_REDIS_URL` when the CI job
 * already has a Redis service attached, otherwise a Testcontainers instance so a
 * laptop needs nothing but Docker running.
 */
export async function startRedis(): Promise<RedisHarness> {
  const provided = process.env.TEST_REDIS_URL;
  if (provided) {
    return { url: provided, stop: () => Promise.resolve() };
  }

  const container: StartedTestContainer = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
    .start();

  return {
    url: `redis://${container.getHost()}:${container.getMappedPort(6379)}`,
    stop: async () => {
      await container.stop();
    },
  };
}
