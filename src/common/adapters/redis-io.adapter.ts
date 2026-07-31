import { INestApplicationContext, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import type Redis from 'ioredis';
import { ServerOptions } from 'socket.io';

import { Env } from '../../config/env';
import { createRedisClient } from '../redis/redis.module';

/**
 * The pub/sub backplane that makes the race tier horizontally scalable.
 *
 * Without it, two players routed to different instances would sit in the same
 * room id and never hear each other. With it, `server.to(room).emit(...)` fans
 * out through Redis and any instance can serve any socket — which is what lets
 * the stateful half of the monolith scale like the stateless half.
 *
 * Socket.IO requires two *separate* connections (a subscribing client cannot
 * issue other commands), hence the duplicate.
 *
 * Both clients are held so [close] can quit them. They are not owned by the
 * `RedisModule` provider graph — they are created here — so nothing else will
 * ever shut them down, and two sockets left open keep the Node event loop
 * alive. In production that only delays a shutdown; in tests it hangs the
 * runner, which is how this surfaced: after the gateway landed, `test:e2e`
 * printed "Jest did not exit one second after the test run has completed" and
 * CI, which has no `--forceExit`, would have sat there until the job timeout.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private adapterConstructor?: ReturnType<typeof createAdapter>;
  private pubClient?: Redis;
  private subClient?: Redis;

  constructor(private readonly app: INestApplicationContext) {
    super(app);
  }

  async connectToRedis(): Promise<void> {
    const config = this.app.get(ConfigService<Env, true>);
    const url = config.get('REDIS_URL', { infer: true });

    const pubClient = createRedisClient(url);
    const subClient = pubClient.duplicate();

    await Promise.all([pubClient.ping(), subClient.ping()]);

    this.pubClient = pubClient;
    this.subClient = subClient;
    this.adapterConstructor = createAdapter(pubClient, subClient);
    this.logger.log('Socket.IO Redis adapter connected');
  }

  override createIOServer(port: number, options?: ServerOptions): unknown {
    const server = super.createIOServer(port, options) as {
      adapter: (a: ReturnType<typeof createAdapter>) => void;
    };

    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
    }

    return server;
  }

  /**
   * Nest calls this when the app shuts down. Close the two Redis connections
   * as well as the io server — nothing else holds a reference to them.
   *
   * `quit()` waits for a clean QUIT round trip and can reject if the socket is
   * already gone, which must not turn an ordinary shutdown into a failure; so
   * each falls back to `disconnect()`, which tears the socket down locally and
   * cannot fail.
   */
  override async close(server: Parameters<IoAdapter['close']>[0]): Promise<void> {
    await super.close(server);

    await Promise.all(
      [this.pubClient, this.subClient].map(async (client) => {
        if (!client) return;
        try {
          await client.quit();
        } catch {
          client.disconnect();
        }
      }),
    );

    this.pubClient = undefined;
    this.subClient = undefined;
    this.adapterConstructor = undefined;
  }
}
