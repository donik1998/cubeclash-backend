import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

/**
 * Password hashing, isolated behind one seam.
 *
 * **Argon2id, not bcrypt** (§1.1): it is the current OWASP first choice and is
 * memory-hard, so a GPU attacker cannot parallelise it the way bcrypt allows.
 * The algorithm and its cost parameters live here and nowhere else, so raising
 * the memory cost later is a one-line change with no call-site churn.
 *
 * `argon2` encodes the salt and every parameter *into* the hash string, so
 * there is no separate salt column and `verify` needs nothing but the stored
 * string and the candidate password.
 */
@Injectable()
export class PasswordService {
  /**
   * A real dummy hash, computed once, used to burn the same CPU on a missing
   * user as on a real one.
   *
   * Login must not leak whether an email exists (§1.8). If we skipped the hash
   * comparison when the user was not found, an unknown email would answer
   * *measurably faster* than a known one with a wrong password — a timing
   * oracle. Verifying against a genuine argon2 hash equalises the two paths. It
   * is computed lazily (argon2 cannot run in a constructor) and cached, so every
   * miss after the first pays the same verify cost a real login does.
   */
  private dummyHash?: Promise<string>;

  hash(plain: string): Promise<string> {
    return argon2.hash(plain, { type: argon2.argon2id });
  }

  async verify(hash: string, plain: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plain);
    } catch {
      // A malformed stored hash should read as "wrong password", never a 500.
      return false;
    }
  }

  /** Verify against the dummy hash to keep the no-such-user path constant-time. */
  async verifyDummy(plain: string): Promise<void> {
    this.dummyHash ??= this.hash('cubeclash-timing-equaliser-not-a-real-password');
    await this.verify(await this.dummyHash, plain);
  }
}
