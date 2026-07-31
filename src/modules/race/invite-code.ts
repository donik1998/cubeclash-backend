import { randomInt } from 'node:crypto';

/**
 * Private-room invite codes.
 *
 * Six characters from an unambiguous alphabet — no `0`/`O`, no `1`/`I` — so a
 * code read aloud or typed from a screenshot does not collide with itself. That
 * is `32^6 ≈ 1.07 billion` possibilities, so a collision with one of the
 * handful of *simultaneously active* rooms is astronomically unlikely; the
 * retry loop in `RaceService` exists to make "unlikely" into "impossible",
 * because the partial unique index will reject a dup and we would rather mint a
 * fresh code than surface a 500.
 *
 * `randomInt` from `node:crypto` rather than `Math.random`: a guessable code is
 * an invite anyone can walk into. The cost is negligible at this call rate.
 */

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const INVITE_CODE_LENGTH = 6;

export function generateInviteCode(): string {
  let code = '';
  for (let i = 0; i < INVITE_CODE_LENGTH; i++) {
    code += ALPHABET[randomInt(ALPHABET.length)];
  }
  return code;
}
