import { DailyProgressPoint } from '../../solves/solves.repository';
import { HistogramBucket } from '../distribution';

/**
 * `GET /stats` wire shape.
 *
 * Every average is `number | null` — `null` means "not enough data, or DNF",
 * and the client renders it as "—". `best_single_ms` is likewise nullable (a
 * cuber with only DNFs has no best). Times are integer milliseconds; the
 * ranking key already folds a `+2` in and drops a DNF, so these are ranking
 * values, not raw clock times.
 *
 * `progress` and `distribution` back the two charts on the screen. Both are
 * always arrays — `[]`, never `null`, when there are no ranked solves — so the
 * client can iterate without a null check. DNFs are excluded from both (an
 * unranked attempt has no place on a time axis).
 */
export interface StatsResponseDto {
  event: string;
  best_single_ms: number | null;
  ao5: number | null;
  ao12: number | null;
  ao100: number | null;
  session_average: number | null;
  pb_count: number;
  solve_count: number;
  /** One point per day with a ranked solve, ascending. The progress line. */
  progress: DailyProgressPoint[];
  /** Contiguous solve-time buckets spanning fastest→slowest. The histogram. */
  distribution: HistogramBucket[];
}
