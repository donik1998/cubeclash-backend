import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { RaceController } from './race.controller';
import { RaceGateway } from './race.gateway';
import { RaceRepository } from './race.repository';
import { RaceRoomStore } from './race-room.store';
import { RaceService } from './race.service';

/**
 * Live 1v1 racing — the highest-signal part of this codebase.
 *
 * Two halves: a stateless REST controller for the lobby (create, join, read,
 * history) and a stateful Socket.IO gateway for the race itself. Room state
 * lives in Redis so any instance can serve any socket, with the Redis adapter as
 * the pub/sub backplane. The server is authoritative: it owns the countdown, the
 * result, and the elo delta.
 *
 * Endpoints: POST /races · POST /races/join · GET /races/:id · GET /races
 * Gateway: see Real-time Race Protocol (spec `race-gateway.md` §1–§5)
 *
 * Built: `RaceRepository` (the competitor-composing reads plus the room writes —
 * create, join, ready, record-finish, settle), `RaceService` (the rules: event
 * raceability, code minting with collision retry, join-by-code, and the guarded
 * transitions the gateway drives), and `RaceController` (the REST lobby).
 *
 * `RaceService` is **exported for the gateway** to consume: it drives
 * `markReady`, `submitTime`, `settle` and `advanceStatus` through the service so
 * the real-time transport shares one source of truth with REST — a client can
 * never make the socket and the lobby disagree about whether a room is joinable
 * or already settled. `RaceRepository` stays exported for the stats module's
 * head-to-head.
 *
 * `RaceGateway` is the Socket.IO half (namespace `/race`): it owns the countdown,
 * the scramble-reveal stamp, the anti-cheat time validation and the disconnect
 * grace window — everything that needs the clock and cannot be done over REST. It
 * drives `RaceService` for every rule, so REST and the socket cannot disagree,
 * and keeps its in-flight room state in `RaceRoomStore` (Redis) so any instance
 * can serve any socket, fanned out over the Redis adapter.
 *
 * `JwtModule.register({})` is imported empty, as auth does it: the gateway
 * verifies the handshake token with the access secret passed per-call
 * (`JwtService.verifyAsync`), matching how `JwtStrategy` validates the REST
 * bearer token — one secret, two transports.
 */
@Module({
  imports: [JwtModule.register({})],
  controllers: [RaceController],
  providers: [RaceService, RaceRepository, RaceRoomStore, RaceGateway],
  exports: [RaceService, RaceRepository],
})
export class RaceModule {}
