import { TokenPair } from '../auth.types';

/**
 * The wire shape of a token pair: `{ access, refresh, expires_in }`.
 *
 * `expires_in` is snake_case and in **seconds** — the access lifetime, so a
 * client knows when to pre-emptively refresh without decoding the JWT. The
 * domain carries it as `expiresIn`; this is the one place that casing is
 * translated.
 */
export interface TokenResponseDto {
  access: string;
  refresh: string;
  expires_in: number;
}

export function toTokenResponse(pair: TokenPair): TokenResponseDto {
  return { access: pair.access, refresh: pair.refresh, expires_in: pair.expiresIn };
}
