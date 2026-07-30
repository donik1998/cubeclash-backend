import { Module } from '@nestjs/common';

/**
 * Offline reconciliation.

 * Last-write-wins on `updated_at`, idempotent on `client_id`, tombstoned via
 * `deleted` — the three columns on `solves` that exist for this module alone.
 *
 * Endpoints: POST /sync
 *
 * Not implemented yet — registered so the module graph matches the documented
 * architecture from the first commit.
 */
@Module({})
export class SyncModule {}
