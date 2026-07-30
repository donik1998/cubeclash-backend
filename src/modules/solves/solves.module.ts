import { Module } from '@nestjs/common';

import { SolvesController } from './solves.controller';
import { SolvesRepository } from './solves.repository';
import { SolvesService } from './solves.service';

/**
 * The core practice record.
 *
 * Owns the one write the client cannot be trusted with: `is_pb` is decided
 * here, server-side, and is where the authoritative analytics event fires.
 * Upserts on `(user_id, client_id)` so a retried submit is a no-op.
 *
 * Note that `is_pb` is no longer a *column* — it is derived on read by
 * `src/db/sql/ranking.ts`, because a retroactive penalty edit changes it. The
 * server still owns it; it just stopped caching it.
 *
 * Endpoints: POST /solves · GET /solves · PATCH /solves/:id · DELETE /solves/:id
 *
 * The controller, service and repository are all built. `SolvesRepository` is
 * exported because the profile and stats read models reuse its ranked history
 * rather than reimplementing `is_pb`.
 */
@Module({
  controllers: [SolvesController],
  providers: [SolvesService, SolvesRepository],
  exports: [SolvesRepository],
})
export class SolvesModule {}
