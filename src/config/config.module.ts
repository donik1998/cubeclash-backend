import { Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule, ConfigService } from '@nestjs/config';

import { Env, validateEnv } from './env';

/** `ConfigService` typed against the env schema — no stringly-typed `get()`. */
export type TypedConfigService = ConfigService<Env, true>;

@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      expandVariables: true,
      envFilePath: ['.env.local', '.env'],
      validate: validateEnv,
    }),
  ],
})
export class ConfigModule {}
