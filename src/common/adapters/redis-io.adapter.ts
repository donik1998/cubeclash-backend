import { INestApplicationContext, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
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
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private adapterConstructor?: ReturnType<typeof createAdapter>;

  constructor(private readonly app: INestApplicationContext) {
    super(app);
  }

  async connectToRedis(): Promise<void> {
    const config = this.app.get(ConfigService<Env, true>);
    const url = config.get('REDIS_URL', { infer: true });

    const pubClient = createRedisClient(url);
    const subClient = pubClient.duplicate();

    await Promise.all([pubClient.ping(), subClient.ping()]);

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
}
