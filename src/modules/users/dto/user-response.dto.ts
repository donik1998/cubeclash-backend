import { User } from '../../../db/schema';

/**
 * The two user shapes on the wire — and the wall between them.
 *
 * **Self** (`GET /me`, `PATCH /me`, the `register` response) may carry `email`:
 * it is the caller's own. **Public** (`GET /users/:id`) must not — §1.7 and
 * §7's email-leak rule. Neither shape ever includes `password_hash`.
 *
 * The separation is enforced by *type*, not discipline: there is no field that
 * could accidentally spill from one into the other, because each mapper names
 * its own keys explicitly. `created_at` is ISO 8601 with an explicit UTC offset,
 * per the wire contract.
 */
export interface SelfUserDto {
  id: string;
  email: string;
  display_name: string;
  country: string | null;
  elo: number;
  created_at: string;
}

export interface PublicUserDto {
  id: string;
  display_name: string;
  country: string | null;
  elo: number;
}

/** The viewer's settled-race record against this profile. Absent → they never raced. */
export interface HeadToHeadDto {
  wins: number;
  losses: number;
}

/**
 * `GET /users/:id` — the Player Profile shape: the public identity, plus the
 * event bests and the viewer-relative head-to-head the profile screen renders.
 *
 * Still **no email** — this is someone else's profile (or the public view of
 * your own), and the email wall applies exactly as it does to `toPublic`.
 *
 * The averages are named `ao5` / `ao12` to match `GET /stats`, deliberately: one
 * name for "average of five" across the whole API. Here they mean the *best*
 * such average the player ever posted (a record), where on `/stats` they mean
 * the current rolling one — same field, context decides which record it is.
 *
 * `head_to_head` is `null`, not `{ wins: 0, losses: 0 }`, when the two have
 * never met in a settled race, so the UI can hide the row rather than assert an
 * 0–0 rivalry that never happened.
 */
export interface ProfileUserDto extends PublicUserDto {
  best_single_ms: number | null;
  ao5: number | null;
  ao12: number | null;
  head_to_head: HeadToHeadDto | null;
}

/** The caller's own view — includes `email`. */
export function toSelf(user: User): SelfUserDto {
  return {
    id: user.id,
    email: user.email,
    display_name: user.displayName,
    country: user.country,
    elo: user.elo,
    created_at: user.createdAt.toISOString(),
  };
}

/** Anyone else's view — no `email`, no `created_at`, and certainly no hash. */
export function toPublic(user: User): PublicUserDto {
  return {
    id: user.id,
    display_name: user.displayName,
    country: user.country,
    elo: user.elo,
  };
}

/** The public identity widened with the profile screen's bests and head-to-head. */
export function toProfile(
  user: User,
  extras: {
    best_single_ms: number | null;
    ao5: number | null;
    ao12: number | null;
    head_to_head: HeadToHeadDto | null;
  },
): ProfileUserDto {
  return {
    ...toPublic(user),
    best_single_ms: extras.best_single_ms,
    ao5: extras.ao5,
    ao12: extras.ao12,
    head_to_head: extras.head_to_head,
  };
}
