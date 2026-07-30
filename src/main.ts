import 'source-map-support/register';

import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';

import { AppModule } from './app.module';
import { Env } from './config/env';
import { RedisIoAdapter } from './common/adapters/redis-io.adapter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get(ConfigService<Env, true>);
  const logger = new Logger('Bootstrap');

  app.use(helmet());

  const origins = config.get('CORS_ORIGINS', { infer: true });
  app.enableCors({
    origin: origins === '*' ? true : origins.split(',').map((o) => o.trim()),
    credentials: true,
  });

  // `/health` sits outside the version prefix: it is infrastructure, and the
  // platform's health check should not have to track the API version.
  app.setGlobalPrefix('v1', { exclude: ['health', 'health/live'] });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      // An unknown key is a client bug or a version mismatch. Failing loudly
      // beats silently dropping a field the client believed it sent.
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  const redisIoAdapter = new RedisIoAdapter(app);
  await redisIoAdapter.connectToRedis();
  app.useWebSocketAdapter(redisIoAdapter);

  // Lets the Drizzle pool and Redis connection close cleanly on SIGTERM, which
  // is what Railway sends on redeploy.
  app.enableShutdownHooks();

  const port = config.get('PORT', { infer: true });
  await app.listen(port, '0.0.0.0');

  logger.log(`CubeClash API listening on :${port} (${config.get('NODE_ENV', { infer: true })})`);
}

void bootstrap();
