/**
 * The small vocabulary the auth layer speaks.
 *
 * Deliberately minimal — a token is an identity claim, not a profile cache
 * (§1.6). The access token's payload is `sub` and nothing else; everything a
 * request needs about *who* is asking is the id, and everything about *what*
 * they are is a fresh read.
 */

/** What `@CurrentUser()` injects: the authenticated principal, and no more. */
export interface AuthPrincipal {
  /** The user's id — the JWT `sub`. */
  id: string;
}

/** The access-token claims. Nothing beyond the standard trio. */
export interface AccessTokenPayload {
  sub: string;
  iat: number;
  exp: number;
}

/**
 * The refresh-token claims. Same identity, plus a `jti` — the handle Redis
 * keys the rotatable session on, and the whole basis of reuse detection.
 */
export interface RefreshTokenPayload {
  sub: string;
  jti: string;
  iat: number;
  exp: number;
}

/** The token pair handed to the client. `expiresIn` is the access lifetime, in seconds. */
export interface TokenPair {
  access: string;
  refresh: string;
  expiresIn: number;
}
