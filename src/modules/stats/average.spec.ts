import { bestAverage, RankingValue, sessionAverage, trimmedAverage } from './average';

/**
 * The trimmed-mean matrix (§4): 0 / 1 / 2 DNFs, exactly the window, fewer than
 * the window, all-DNF. These are the WCA edge cases the spec calls an interview
 * talking point, so they are pinned to hand-computed numbers rather than to the
 * implementation.
 */
describe('trimmedAverage', () => {
  describe('ao5 (window 5)', () => {
    it('0 DNFs: drops best and worst, means the middle three', () => {
      // sorted 8,9,10,11,12 → drop 8 and 12 → mean(9,10,11) = 10
      expect(trimmedAverage([10_000, 8_000, 12_000, 9_000, 11_000], 5)).toBe(10_000);
    });

    it('1 DNF: the DNF is the discarded worst, average survives', () => {
      // one DNF sorts last and is dropped → mean(10,11,12) = 11
      const values: RankingValue[] = [10_000, null, 12_000, 9_000, 11_000];
      expect(trimmedAverage(values, 5)).toBe(11_000);
    });

    it('2 DNFs: a DNF survives the trim → the average is DNF (null)', () => {
      const values: RankingValue[] = [10_000, null, null, 9_000, 11_000];
      expect(trimmedAverage(values, 5)).toBeNull();
    });

    it('all DNFs → null', () => {
      expect(trimmedAverage([null, null, null, null, null], 5)).toBeNull();
    });

    it('fewer than the window → null, never a partial average', () => {
      expect(trimmedAverage([10_000, 9_000, 11_000], 5)).toBeNull();
    });

    it('uses the most recent window when there are more than five', () => {
      // Six solves; the oldest (99_000) is outside the window and ignored.
      // window = last 5 = [8,12,9,11,10]k → drop 8 and 12 → mean(9,10,11)=10
      const values = [99_000, 8_000, 12_000, 9_000, 11_000, 10_000];
      expect(trimmedAverage(values, 5)).toBe(10_000);
    });

    it('rounds the mean to an integer millisecond', () => {
      // middle = 9000, 10000, 10001 → mean 9667.0 → 9667
      expect(trimmedAverage([8_000, 9_000, 10_000, 10_001, 12_000], 5)).toBe(9_667);
    });
  });

  describe('ao12 (window 12)', () => {
    const twelve = Array.from({ length: 12 }, (_, i) => (i + 1) * 1_000);

    it('0 DNFs: drops the single best and worst of twelve', () => {
      // 1000..12000; drop 1000 and 12000; mean of 2000..11000 = 6500
      expect(trimmedAverage(twelve, 12)).toBe(6_500);
    });

    it('tolerates exactly one DNF', () => {
      const withOneDnf: RankingValue[] = [...twelve.slice(0, 11), null];
      // drop 1000 (best) and the DNF (worst) → mean of 2000..11000 = 6500
      expect(trimmedAverage(withOneDnf, 12)).toBe(6_500);
    });

    it('two DNFs → null', () => {
      const withTwoDnf: RankingValue[] = [...twelve.slice(0, 10), null, null];
      expect(trimmedAverage(withTwoDnf, 12)).toBeNull();
    });
  });
});

describe('bestAverage', () => {
  it('is the lowest ao5 across every sliding window, not the last one', () => {
    // Windows of 5 over 7 solves:
    //   [12,10,8,9,11] → drop 8,12 → mean(9,10,11) = 10
    //   [10,8,9,11,7]  → drop 7,11 → mean(8,9,10) = 9   ← best
    //   [8,9,11,7,13]  → drop 7,13 → mean(8,9,11) ≈ 9333
    const values = [12_000, 10_000, 8_000, 9_000, 11_000, 7_000, 13_000];
    expect(bestAverage(values, 5)).toBe(9_000);
  });

  it('skips a window that is itself DNF rather than letting it poison the record', () => {
    // First window has two DNFs (→ null, skipped); the second is clean.
    //   [null,null,10,11,12] → null
    //   [null,10,11,12,9]    → one DNF dropped → mean(10,11,12) = 11
    const values: RankingValue[] = [null, null, 10_000, 11_000, 12_000, 9_000];
    expect(bestAverage(values, 5)).toBe(11_000);
  });

  it('is null below the window', () => {
    expect(bestAverage([10_000, 9_000, 11_000], 5)).toBeNull();
  });

  it('is null when no window yields a real average', () => {
    expect(bestAverage([null, null, null, null, null], 5)).toBeNull();
  });

  it('equals the single window when there are exactly windowSize solves', () => {
    expect(bestAverage([10_000, 8_000, 12_000, 9_000, 11_000], 5)).toBe(10_000);
  });
});

describe('sessionAverage', () => {
  it('is a trimmed mean over the whole set', () => {
    // drop 4000 and 20000 → mean(8000, 15000) = 11500
    expect(sessionAverage([15_000, 4_000, 20_000, 8_000])).toBe(11_500);
  });

  it('needs at least three solves', () => {
    expect(sessionAverage([10_000, 12_000])).toBeNull();
    expect(sessionAverage([])).toBeNull();
  });

  it('is DNF (null) with two or more DNFs, like any average', () => {
    expect(sessionAverage([10_000, null, null, 9_000])).toBeNull();
  });
});
