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
