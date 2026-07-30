import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

/**
 * `GET /users/:id?event=` — the query for the Player Profile read.
 *
 * `event` is optional: the profile screen opens on 3×3, so an absent param
 * means "3×3" rather than an error. Validated for *shape* here (a non-empty
 * string) and for *existence* in the service against `wca-events`, which owns
 * the `unknown_event` code — the same split `GET /stats` uses.
 */
export class UserProfileQueryDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  event?: string;
}
