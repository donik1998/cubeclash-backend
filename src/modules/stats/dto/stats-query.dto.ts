import { IsString, IsNotEmpty } from 'class-validator';

/**
 * `GET /stats?event=`.
 *
 * `event` is required — stats are always per-event (a 3×3 average and a
 * Multi-Blind result share no unit). Validated for *shape* here and for
 * *existence* in the service, which owns the `unknown_event` code.
 */
export class StatsQueryDto {
  @IsString()
  @IsNotEmpty()
  event!: string;
}
