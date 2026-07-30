import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';

import { DatabaseHealthIndicator, RedisHealthIndicator } from './health.indicators';

/**
 * Deliberately outside the `/v1` prefix: this is infrastructure, not API
 * surface, and the platform health check should not have to know the API
 * version. Railway polls `/health`; `/health/live` answers without touching a
 * dependency, so a Postgres blip restarts nothing.
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly database: DatabaseHealthIndicator,
    private readonly redis: RedisHealthIndicator,
  ) {}

  /** Readiness: can this instance actually serve traffic? */
  @Get()
  @HealthCheck()
  readiness() {
    return this.health.check([() => this.database.check(), () => this.redis.check()]);
  }

  /** Liveness: is the process up? No dependencies consulted, on purpose. */
  @Get('live')
  liveness() {
    return { status: 'ok', uptimeSeconds: Math.floor(process.uptime()) };
  }
}
