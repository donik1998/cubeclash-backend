import { Transform } from 'class-transformer';
import { IsEmail, IsString, Length, MinLength } from 'class-validator';

/**
 * `POST /auth/register` body: `{ email, password, display_name }`.
 *
 * `email` is lower-cased and trimmed on the way in so the citext unique index
 * and every later lookup agree on one canonical form. `password` is floored at
 * 8 characters here (§2 auth) — cost belongs at the policy edge, not scattered
 * through the service. `display_name` is 2–32 chars. The wire key is
 * `display_name`, matching the snake_case contract that `forbidNonWhitelisted`
 * would otherwise reject.
 */
export class RegisterDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8, { message: 'password must be at least 8 characters' })
  password!: string;

  @IsString()
  @Length(2, 32)
  display_name!: string;
}
