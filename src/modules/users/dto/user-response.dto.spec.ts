import { User } from '../../../db/schema';
import { toPublic, toSelf } from './user-response.dto';

/**
 * The email-leak wall (§1.7): the self shape may carry `email`; the public shape
 * must not, and neither may ever carry `password_hash`. This is the unit that
 * makes that contract a test rather than a hope.
 */
describe('user response shapes', () => {
  const user: User = {
    id: '22222222-2222-4222-8222-222222222222',
    email: 'ada@example.com',
    passwordHash: '$argon2id$v=19$secret-hash-material',
    displayName: 'Ada',
    country: 'GB',
    elo: 1180,
    createdAt: new Date('2026-07-30T12:34:56.000Z'),
    updatedAt: new Date('2026-07-30T12:34:56.000Z'),
  };

  it('self includes email and created_at, never the hash', () => {
    const dto = toSelf(user);

    expect(dto).toEqual({
      id: user.id,
      email: 'ada@example.com',
      display_name: 'Ada',
      country: 'GB',
      elo: 1180,
      created_at: '2026-07-30T12:34:56.000Z', // ISO 8601, explicit UTC offset
    });
    expect(dto).not.toHaveProperty('password_hash');
    expect(dto).not.toHaveProperty('passwordHash');
  });

  it('public omits email, created_at and the hash entirely', () => {
    const dto = toPublic(user);

    expect(dto).toEqual({
      id: user.id,
      display_name: 'Ada',
      country: 'GB',
      elo: 1180,
    });
    expect(dto).not.toHaveProperty('email');
    expect(dto).not.toHaveProperty('password_hash');
    expect(dto).not.toHaveProperty('passwordHash');
  });

  it('passes a null country through on both shapes', () => {
    const anon: User = { ...user, country: null };
    expect(toSelf(anon).country).toBeNull();
    expect(toPublic(anon).country).toBeNull();
  });
});
