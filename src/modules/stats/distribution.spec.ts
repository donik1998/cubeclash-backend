import { histogram } from './distribution';

/**
 * The histogram behind the Stats distribution chart: contiguous buckets, empty
 * middles kept, the slowest solve counted despite the exclusive upper bound, and
 * no zero-width phantom bars on a narrow range.
 */
describe('histogram', () => {
  it('is empty for no solves — never a degenerate single bar', () => {
    expect(histogram([])).toEqual([]);
  });

  it('keeps empty middle buckets so the x-axis stays continuous', () => {
    // span = 6009 - 6000 + 1 = 10 → 10 buckets of width 1, boundaries 6000..6010.
    const result = histogram([6000, 6001, 6002, 6002, 6009]);

    expect(result).toEqual([
      { from_ms: 6000, to_ms: 6001, count: 1 },
      { from_ms: 6001, to_ms: 6002, count: 1 },
      { from_ms: 6002, to_ms: 6003, count: 2 },
      { from_ms: 6003, to_ms: 6004, count: 0 },
      { from_ms: 6004, to_ms: 6005, count: 0 },
      { from_ms: 6005, to_ms: 6006, count: 0 },
      { from_ms: 6006, to_ms: 6007, count: 0 },
      { from_ms: 6007, to_ms: 6008, count: 0 },
      { from_ms: 6008, to_ms: 6009, count: 0 },
      // The slowest solve (6009) lands in the final bucket, not off its edge.
      { from_ms: 6009, to_ms: 6010, count: 1 },
    ]);
  });

  it('collapses an all-identical set into one 1 ms bucket', () => {
    expect(histogram([5000, 5000, 5000])).toEqual([{ from_ms: 5000, to_ms: 5001, count: 3 }]);
  });

  it('caps the bucket count on a narrow range so no bucket is zero-width', () => {
    // span = 3, so 3 buckets of width 1 rather than 10 collapsed onto each other.
    const result = histogram([100, 102]);

    expect(result).toEqual([
      { from_ms: 100, to_ms: 101, count: 1 },
      { from_ms: 101, to_ms: 102, count: 0 },
      { from_ms: 102, to_ms: 103, count: 1 },
    ]);
  });

  it('is contiguous, gap-free, and counts every solve on a wide messy range', () => {
    const values = [6289, 6540, 7001, 6600, 9000, 6301, 6295, 8123, 6999, 7777, 6400];
    const result = histogram(values);

    // At most the target ten bars, at least one.
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result.length).toBeLessThanOrEqual(10);

    // Every solve is counted exactly once.
    expect(result.reduce((sum, b) => sum + b.count, 0)).toBe(values.length);

    // Contiguous: each bucket's upper bound is the next's lower bound.
    for (let i = 0; i < result.length - 1; i++) {
      expect(result[i].to_ms).toBe(result[i + 1].from_ms);
      expect(result[i].to_ms).toBeGreaterThan(result[i].from_ms); // no zero-width
    }

    // Spans exactly [min, max + 1).
    expect(result[0].from_ms).toBe(Math.min(...values));
    expect(result[result.length - 1].to_ms).toBe(Math.max(...values) + 1);
  });
});
