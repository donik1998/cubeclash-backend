import { Type } from 'class-transformer';
import { IsIn, IsISO8601, IsInt, IsNotEmpty, IsOptional, IsString, Min } from 'class-validator';

/**
 * `POST /solves` body.
 *
 * Wire keys are snake_case to match the contract under `forbidNonWhitelisted`.
 * `event` is validated for *shape* here and for *existence* against the WCA
 * registry in the service, which owns the `unknown_event` code — importing the
 * registry into a DTO would turn a 400 into a validation-field error with the
 * wrong code.
 *
 * **`scramble` is never trimmed or normalised.** `\n` is significant — Megaminx
 * line breaks and Multi-Blind's N scrambles are semantic — so there is
 * deliberately no `@Transform` touching it; it round-trips byte-for-byte.
 *
 * The three long-form counts are optional here and *further* constrained by the
 * service to the events they apply to: a `move_count` on a 3×3 is a 400, not a
 * silently dropped field.
 */
export class CreateSolveDto {
  @IsString()
  @IsNotEmpty()
  event!: string;

  @IsString()
  @IsNotEmpty()
  scramble!: string;

  @IsIn(['random', 'wca', 'reused'])
  scramble_source!: 'random' | 'wca' | 'reused';

  @Type(() => Number)
  @IsInt()
  @Min(0)
  time_ms!: number;

  @IsOptional()
  @IsIn(['none', 'plus2', 'dnf'])
  penalty: 'none' | 'plus2' | 'dnf' = 'none';

  @IsISO8601()
  solved_at!: string;

  @IsString()
  @IsNotEmpty()
  client_id!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  move_count?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  solved_count?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  attempted_count?: number;
}
