import { Competitor, RaceWithCompetitors } from '../race.types';

/**
 * The wire shape of a race and its competitors — spec §8's "the race", used by
 * `POST /races/join` and `GET /races/:id`, and as each item of the history page.
 *
 * snake_case throughout; timestamps ISO 8601 with an explicit UTC offset;
 * `mode`, `status`, `penalty` and `result` in their raw Postgres enum forms.
 *
 * **`code` is a viewer-relative field.** A private room's code is an invite, and
 * handing it to a non-participant would let anyone with a race id walk into a
 * room they were not asked into. The mapper takes `isParticipant` and omits
 * `code` unless the viewer is in the room — the same "compute per viewer, don't
 * leak" rule the gateway applies to `race:state.code` and `is_me`.
 *
 * `scramble` is intentionally **not** on this shape. The scramble is revealed by
 * the gateway at countdown with a server-stamped reveal time (spec §4); leaking
 * it from the lobby REST read would hand a racer the puzzle before the anti-cheat
 * baseline exists. The lobby needs to know a race *exists*, not what to solve.
 */
export interface RaceResponseDto {
  race_id: string;
  event: string;
  mode: string;
  status: string;
  /** Present only for a private room the viewer is a participant of. */
  code?: string;
  created_by: string;
  created_at: string;
  settled_at: string | null;
  competitors: CompetitorDto[];
}

export interface CompetitorDto {
  user_id: string;
  display_name: string;
  country: string | null;
  elo: number;
  ready: boolean;
  time_ms: number | null;
  penalty: string;
  /** Null until the race settles. Server-owned. */
  result: string | null;
  finished_at: string | null;
  is_host: boolean;
}

function toCompetitorDto(c: Competitor): CompetitorDto {
  return {
    user_id: c.userId,
    display_name: c.displayName,
    country: c.country,
    elo: c.elo,
    ready: c.ready,
    time_ms: c.timeMs,
    penalty: c.penalty,
    result: c.result,
    finished_at: c.finishedAt ? c.finishedAt.toISOString() : null,
    is_host: c.isHost,
  };
}

/**
 * Map a race to its wire shape for a specific viewer.
 *
 * `viewerId` decides the one viewer-relative field, `code`: it is included only
 * when the viewer is among the competitors. Pass the id of the authenticated
 * caller; there is no "public" overload, because every race route is guarded.
 */
export function toRaceResponse(race: RaceWithCompetitors, viewerId: string): RaceResponseDto {
  const isParticipant = race.competitors.some((c) => c.userId === viewerId);

  const dto: RaceResponseDto = {
    race_id: race.id,
    event: race.event,
    mode: race.mode,
    status: race.status,
    created_by: race.createdBy,
    created_at: race.createdAt.toISOString(),
    settled_at: race.settledAt ? race.settledAt.toISOString() : null,
    competitors: race.competitors.map(toCompetitorDto),
  };

  // A private room's code is an invite; only a participant may read it back.
  if (race.code && isParticipant) {
    dto.code = race.code;
  }

  return dto;
}
