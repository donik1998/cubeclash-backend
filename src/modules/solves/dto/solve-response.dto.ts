import { allowedResultColumns } from '../../../domain/wca-events';
import { SolveWithRanking } from '../solves.repository';

/**
 * The wire shape of a solve.
 *
 * snake_case throughout; `solved_at` is ISO 8601 with an explicit UTC offset;
 * `penalty` and `scramble_source` are their raw Postgres enum forms.
 *
 * `is_pb` is **derived, returned, never stored and never accepted** from the
 * client — it is the ranking answer computed on read.
 *
 * The three long-form counts obey the contract's absent-vs-null rule: for the
 * fifteen events they do not apply to, the keys are **omitted entirely** (an
 * index signature, populated only for FMC and Multi-Blind). An absent key means
 * *inapplicable*; a present `null` would mean *applicable but unknown*, which is
 * a different and wrong claim for a 3×3.
 */
export interface SolveResponseDto {
  id: string;
  user_id: string;
  event: string;
  scramble: string;
  scramble_source: string;
  time_ms: number;
  penalty: string;
  solved_at: string;
  client_id: string;
  is_pb: boolean;
  move_count?: number | null;
  solved_count?: number | null;
  attempted_count?: number | null;
}

/** Column-name → value on the stored row, for the conditional long-form keys. */
const LONG_FORM: Record<string, (s: SolveWithRanking) => number | null> = {
  move_count: (s) => s.moveCount,
  solved_count: (s) => s.solvedCount,
  attempted_count: (s) => s.attemptedCount,
};

export function toSolveResponse(solve: SolveWithRanking): SolveResponseDto {
  const dto: SolveResponseDto = {
    id: solve.id,
    user_id: solve.userId,
    event: solve.event,
    scramble: solve.scramble,
    scramble_source: solve.scrambleSource,
    time_ms: solve.timeMs,
    penalty: solve.penalty,
    solved_at: solve.solvedAt.toISOString(),
    client_id: solve.clientId,
    is_pb: solve.isPb,
  };

  // Only attach the long-form keys the event is allowed to carry.
  for (const column of allowedResultColumns(solve.event)) {
    dto[column as 'move_count' | 'solved_count' | 'attempted_count'] = LONG_FORM[column](solve);
  }

  return dto;
}
