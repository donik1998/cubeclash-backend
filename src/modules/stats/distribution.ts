/**
 * The solve-time histogram behind the Stats screen's distribution chart.
 *
 * The chart wants a *continuous x-axis*: contiguous buckets spanning the event's
 * fastest to slowest ranked solve, each `[from_ms, to_ms)` (from inclusive, to
 * exclusive), with no gaps and no overlaps. Buckets that happen to catch no
 * solve are still emitted with `count: 0` — a hole in the middle of the axis
 * would make the chart lie about the shape of the data.
 *
 * DNFs never reach here: the caller passes ranking keys, which are already
 * `null` for a DNF and filtered out. An empty input is an empty histogram — the
 * client renders "no data", never a degenerate single bar.
 *
 * This is deliberately TypeScript, not SQL. `GET /stats` computes `progress`
 * (the per-day series) in SQL because grouping by day *is* a `GROUP BY`; the
 * histogram, by contrast, is a fixed-bucket reduction over a list the service
 * already holds in memory, and expressing "include the empty middle buckets"
 * is far clearer as a loop than as a `generate_series` + `width_bucket` join.
 */

/** One histogram bar. `from_ms` inclusive, `to_ms` exclusive. */
export interface HistogramBucket {
  from_ms: number;
  to_ms: number;
  count: number;
}

/**
 * How many bars to aim for. Ten is the sweet spot for a phone-width chart: fine
 * enough to show a distribution's shape, coarse enough that each bar still holds
 * a meaningful count on the modest solve sets a single user accumulates. The
 * count is capped down for narrow ranges (see below) so bars never go
 * sub-millisecond.
 */
const TARGET_BUCKETS = 10;

/**
 * Bucket `values` (ranking keys, milliseconds) into a contiguous histogram.
 *
 * The range covered is the half-open `[min, max + 1)`, so the slowest solve
 * (`max`) lands inside the final bucket rather than falling off its exclusive
 * upper edge. Boundaries are rounded to whole milliseconds; the bucket count is
 * capped at the span width so every bucket is at least 1 ms wide and no two
 * boundaries collide (which would otherwise produce a zero-width phantom bar).
 */
export function histogram(
  values: readonly number[],
  targetBuckets = TARGET_BUCKETS,
): HistogramBucket[] {
  if (values.length === 0) return [];

  const min = Math.min(...values);
  const max = Math.max(...values);

  // Half-open span. `max + 1` guarantees the slowest solve is counted despite
  // the exclusive upper bound; the +1 also makes an all-identical set a single
  // 1 ms-wide bucket instead of a zero-width one.
  const lower = min;
  const upper = max + 1;
  const span = upper - lower;

  // Never more buckets than the span has whole milliseconds, so each boundary
  // step is >= 1 ms and the rounded boundaries below strictly increase.
  const bucketCount = Math.min(targetBuckets, span);

  // Rounded integer boundaries, length `bucketCount + 1`. First is exactly
  // `lower`, last is pinned to `upper` so no float drift leaves a solve outside.
  const boundaries: number[] = [];
  for (let i = 0; i <= bucketCount; i++) {
    boundaries.push(Math.round(lower + (span * i) / bucketCount));
  }
  boundaries[bucketCount] = upper;

  const counts = new Array<number>(bucketCount).fill(0);
  for (const value of values) {
    // Largest boundary index not exceeding the value — its bucket. Values are
    // in `[lower, upper)`, so this always lands in `[0, bucketCount)`.
    let index = bucketCount - 1;
    while (index > 0 && value < boundaries[index]) index--;
    counts[index]++;
  }

  return counts.map((count, i) => ({
    from_ms: boundaries[i],
    to_ms: boundaries[i + 1],
    count,
  }));
}
