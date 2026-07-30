import { Module } from '@nestjs/common';

/**
 * Per-event aggregates: best, ao5 / ao12 / ao100, per-source averages,
 * distribution, efficiency index.

 * The rolling-average windows are hand-written SQL behind the repository
 * interface. That is deliberate: window functions are exactly where a typed
 * query builder stops paying for itself, and this is the part worth being able
 * to explain out loud.
 *
 * Endpoints: GET /stats
 *
 * Not implemented yet — registered so the module graph matches the documented
 * architecture from the first commit.
 */
@Module({})
export class StatsModule {}
