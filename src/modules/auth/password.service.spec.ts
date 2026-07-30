import { PasswordService } from './password.service';

/**
 * Real argon2, not a mock — the whole point of the seam is that a hash actually
 * verifies and a wrong password actually fails. These run a genuine (memory-
 * hard) hash, so they are a touch slower than a typical unit test by design.
 */
describe('PasswordService', () => {
  const service = new PasswordService();

  it('produces an argon2id hash that is not the plaintext', async () => {
    const hash = await service.hash('correct horse battery staple');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(hash).not.toContain('correct horse');
  });

  it('verifies the right password and rejects the wrong one', async () => {
    const hash = await service.hash('s3cret-password');
    expect(await service.verify(hash, 's3cret-password')).toBe(true);
    expect(await service.verify(hash, 'wrong-password')).toBe(false);
  });

  it('salts: the same password hashes to different strings', async () => {
    const [a, b] = await Promise.all([service.hash('same'), service.hash('same')]);
    expect(a).not.toBe(b);
    // ...yet both still verify.
    expect(await service.verify(a, 'same')).toBe(true);
    expect(await service.verify(b, 'same')).toBe(true);
  });

  it('treats a malformed stored hash as a failed verify, not a throw', async () => {
    await expect(service.verify('not-a-hash', 'anything')).resolves.toBe(false);
  });

  it('verifyDummy runs without throwing (the constant-time login path)', async () => {
    await expect(service.verifyDummy('whatever')).resolves.toBeUndefined();
  });
});
