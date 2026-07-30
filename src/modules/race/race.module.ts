import { Module } from '@nestjs/common';

import { RaceRepository } from './race.repository';

/**
 * Live 1v1 racing — the highest-signal part of this codebase.
 *
 * Two halves: a stateless REST controller for the lobby (create, join, history)
 * and a stateful Socket.IO gateway for the race itself. Room state lives in
 * Redis so any instance can serve any socket, with the Redis adapter as the
 * pub/sub backplane. The server is authoritative: it owns the countdown, the
 * result, and the elo delta.
 *
 * Endpoints: POST /races · POST /races/join · GET /races/:id · GET /races
 * Gateway: see Real-time Race Protocol
 *
 * Built so far: `RaceRepository` — the reads that compose a race's
 * **competitors** from `races → race_participants → users`, plus the
 * head-to-head aggregate those competitors make possible. Exported, because the
 * stats module wants that join rather than its own copy of it.
 *
 * Still to come: the controller, the gateway, and the service that owns
 * matchmaking, the countdown and elo settlement.
 */
@Module({
  providers: [RaceRepository],
  exports: [RaceRepository],
})
export class RaceModule {}
