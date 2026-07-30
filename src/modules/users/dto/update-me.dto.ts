import { Transform } from 'class-transformer';
import { IsISO31661Alpha2, IsOptional, IsString, Length, ValidateIf } from 'class-validator';

/**
 * `PATCH /me` body: `{ display_name?, country? }`.
 *
 * Both fields are optional — a patch touches only what it names. `country`
 * validates as an ISO 3166-1 alpha-2 code and is **upper-cased on write** so the
 * column has one canonical form (country leaderboards join on it). It is
 * explicitly nullable: sending `null` clears the country, which
 * `@ValidateIf` allows through the alpha-2 check while a bare string still has
 * to be a real code.
 */
export class UpdateMeDto {
  @IsOptional()
  @IsString()
  @Length(2, 32)
  display_name?: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toUpperCase() : value,
  )
  @IsISO31661Alpha2()
  country?: string | null;
}
