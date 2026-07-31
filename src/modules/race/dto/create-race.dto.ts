import { IsIn, IsNotEmpty, IsString } from 'class-validator';

/**
 * `POST /races` body — spec §8.
 *
 * `mode` is `quick` or `private` only. `tournament` exists in the DB enum but is
 * not a mode a client opens a room in directly (a tournament mints its own
 * rooms), so it is deliberately absent from this whitelist — sending it is a
 * 400, not a silently-accepted third mode.
 *
 * `event` is validated for *shape* here and for *raceability* in the service,
 * which owns the `event_not_raceable` / `unknown_event` codes. Importing the WCA
 * registry into a DTO would turn those into generic validation-field errors with
 * the wrong code — the same split `CreateSolveDto` uses.
 */
export class CreateRaceDto {
  @IsIn(['quick', 'private'])
  mode!: 'quick' | 'private';

  @IsString()
  @IsNotEmpty()
  event!: string;
}
