import { decodeCursor, encodeCursor } from './leaderboard.repository';
import { LeaderboardEntry } from './leaderboard.types';

/**
 * The cursor codec is pure and load-bearing: it encodes the exact total-order
 * sort key the page query walks — `(value_ms, solved_at, user_id)` — so a
 * round trip has to preserve all three, and a malformed cursor has to degrade
 * to "start from the top" rather than throw.
 */
describe('leaderboard cursor codec', () => {
  const entry: LeaderboardEntry = {
    rank: 42,
    userId: '11111111-1111-4111-8111-111111111111',
    displayName: 'kian_r',
    country: 'IR',
    valueMs: 6310,
    solvedAt: new Date('2026-07-20T09:12:03.000Z'),
  };

  it('round-trips value, timestamp and user id', () => {
    const decoded = decodeCursor(encodeCursor(entry));

    expect(decoded).toEqual({
      valueMs: 6310,
      solvedAt: new Date('2026-07-20T09:12:03.000Z'),
      userId: '11111111-1111-4111-8111-111111111111',
    });
  });

  it('is opaque base64url, not the raw key', () => {
    const cursor = encodeCursor(entry);

    expect(cursor).not.toContain('|');
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('returns null for an absent cursor', () => {
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor('')).toBeNull();
  });

  it('treats a malformed cursor as the start rather than throwing', () => {
    expect(decodeCursor('not-a-real-cursor')).toBeNull();
    // Well-formed base64url but wrong internal shape — missing the user id.
    expect(
      decodeCursor(Buffer.from('6310|2026-07-20T09:12:03.000Z').toString('base64url')),
    ).toBeNull();
    // A non-numeric value part.
    expect(
      decodeCursor(Buffer.from('nope|2026-07-20T09:12:03.000Z|u-1').toString('base64url')),
    ).toBeNull();
  });
});
