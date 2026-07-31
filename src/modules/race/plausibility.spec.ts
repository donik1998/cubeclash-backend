import { DEFAULT_FLOOR_MS, WALL_CLOCK_SLACK_MS, checkPlausibility, floorFor } from './plausibility';

/**
 * The anti-cheat floor (spec §5). Pure, so exhaustively testable without a
 * socket: each case fixes the server's own two stamps (reveal, receipt) and a
 * reported client time, and asserts the verdict.
 */
describe('checkPlausibility', () => {
  const base = { event: '3x3', revealAtMs: 1_000_000, receivedAtMs: 1_012_000 }; // 12s elapsed

  it('accepts a normal solve well within the wall-clock window', () => {
    expect(checkPlausibility({ ...base, clientTimeMs: 9_500 })).toEqual({ ok: true });
  });

  it('rejects a non-positive time', () => {
    expect(checkPlausibility({ ...base, clientTimeMs: 0 })).toEqual({
      ok: false,
      reason: 'non_positive',
    });
    expect(checkPlausibility({ ...base, clientTimeMs: -5 }).reason).toBe('non_positive');
  });

  it('rejects NaN and Infinity as non-positive (non-finite)', () => {
    expect(checkPlausibility({ ...base, clientTimeMs: Number.NaN }).reason).toBe('non_positive');
    expect(checkPlausibility({ ...base, clientTimeMs: Number.POSITIVE_INFINITY }).reason).toBe(
      'non_positive',
    );
  });

  it('rejects a time faster than any human for the event (below the per-event floor)', () => {
    // 3x3 floor is 1500ms; 200ms is a macro, not a solve.
    expect(checkPlausibility({ ...base, clientTimeMs: 200 })).toEqual({
      ok: false,
      reason: 'faster_than_humanly_possible',
    });
  });

  it('accepts a world-class time that clears the (deliberately loose) floor', () => {
    expect(checkPlausibility({ ...base, clientTimeMs: 3_200 })).toEqual({ ok: true });
  });

  it('rejects a receipt that precedes the reveal (clock ran backwards)', () => {
    expect(
      checkPlausibility({ ...base, receivedAtMs: base.revealAtMs - 1, clientTimeMs: 5_000 }),
    ).toEqual({ ok: false, reason: 'before_reveal' });
  });

  it('rejects a reported time longer than the real elapsed since reveal', () => {
    // Only 3s of real time have passed, but the client claims an 8s solve.
    const verdict = checkPlausibility({
      event: '3x3',
      revealAtMs: 1_000_000,
      receivedAtMs: 1_003_000,
      clientTimeMs: 8_000,
    });
    expect(verdict).toEqual({ ok: false, reason: 'exceeds_elapsed' });
  });

  it('tolerates network/clock slack right at the wall-clock boundary', () => {
    const revealAtMs = 1_000_000;
    const elapsed = 9_000;
    const receivedAtMs = revealAtMs + elapsed;
    // A reported time up to elapsed + slack is honest.
    expect(
      checkPlausibility({
        event: '3x3',
        revealAtMs,
        receivedAtMs,
        clientTimeMs: elapsed + WALL_CLOCK_SLACK_MS,
      }),
    ).toEqual({ ok: true });
    // One ms beyond the slack is rejected.
    expect(
      checkPlausibility({
        event: '3x3',
        revealAtMs,
        receivedAtMs,
        clientTimeMs: elapsed + WALL_CLOCK_SLACK_MS + 1,
      }).reason,
    ).toBe('exceeds_elapsed');
  });
});

describe('floorFor', () => {
  it('uses the per-event floor where one exists', () => {
    expect(floorFor('2x2')).toBe(200);
    expect(floorFor('megaminx')).toBe(12_000);
  });

  it('falls back to the default for an unlisted event', () => {
    expect(floorFor('some-new-event')).toBe(DEFAULT_FLOOR_MS);
  });
});
