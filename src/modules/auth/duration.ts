/**
 * Turning a config string like `15m` or `30d` into seconds.
 *
 * `@nestjs/jwt` accepts these duration strings verbatim (it hands them to
 * jsonwebtoken, which understands `ms`-style units), so token *signing* never
 * needs this. Redis does: a refresh session's key gets an `EX` in **seconds**,
 * and `expires_in` on the wire is the access lifetime in **seconds** — both have
 * to agree with the same TTL the token itself carries, so they are derived from
 * the one source rather than hard-coded a second time.
 */

const UNIT_SECONDS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 60 * 60,
  d: 24 * 60 * 60,
};

/**
 * Parses `<number>` (bare seconds) or `<number><s|m|h|d>` into seconds.
 * Throws on anything else — a malformed TTL is a boot-time config error, not
 * something to silently coerce to a surprising number.
 */
export function durationToSeconds(value: string): number {
  const trimmed = value.trim();

  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed);
  }

  const match = /^(\d+)\s*([smhd])$/.exec(trimmed);
  if (!match) {
    throw new Error(`Unparseable duration '${value}' (expected e.g. '900', '15m', '30d')`);
  }

  return Number(match[1]) * UNIT_SECONDS[match[2]];
}
