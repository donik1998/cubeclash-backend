import { Transform } from 'class-transformer';
import { IsEmail, IsString } from 'class-validator';

/**
 * `POST /auth/login` body: `{ email, password }`.
 *
 * `email` is canonicalised exactly as on register so a mixed-case sign-in still
 * finds the row. There is deliberately **no length/shape check on `password`
 * here** beyond "is a string": rejecting a too-short password at login would
 * leak that the stored one is also short. A wrong password and a malformed one
 * must give the same generic 401 (§1.8).
 */
export class LoginDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  email!: string;

  @IsString()
  password!: string;
}
