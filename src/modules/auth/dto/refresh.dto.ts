import { IsString, IsNotEmpty } from 'class-validator';

/**
 * The body shared by `POST /auth/refresh` and `POST /auth/logout`: `{ refresh }`.
 *
 * Both take the refresh token in the body rather than the `Authorization`
 * header: the access token (or none) rides in that header, and conflating the
 * two is how a client ends up sending the wrong one. The token's contents are
 * verified cryptographically in `TokenService`; the DTO only insists it is a
 * non-empty string.
 */
export class RefreshDto {
  @IsString()
  @IsNotEmpty()
  refresh!: string;
}
