import { BadRequestException } from '@nestjs/common';

import {
  DailyProgressPoint,
  SolveWithRanking,
  SolvesRepository,
} from '../solves/solves.repository';
import { StatsService } from './stats.service';

/**
 * `StatsService` in isolation: the ranking SQL is `SolvesRepository`'s job (and
 * its own e2e), so here the repository is faked and the focus is what the
 * service *assembles* on top — the progress passthrough and the in-memory
 * histogram — plus the `unknown_event` guard.
 */
describe('StatsService', () => {
  /** A ranked solve stub — only the two derived fields the service reads. */
  const solve = (rankingValue: number | null, isPb = false): SolveWithRanking =>
    ({ rankingValue, isPb }) as SolveWithRanking;

  const build = (history: SolveWithRanking[], progress: DailyProgressPoint[] = []) => {
    const findHistory = jest.fn().mockResolvedValue(history);
    const dailyProgress = jest.fn().mockResolvedValue(progress);
    const solves = { findHistory, dailyProgress } as unknown as SolvesRepository;
    return { service: new StatsService(solves), findHistory, dailyProgress };
  };

  it('rejects an unknown event before touching the repository', async () => {
    const { service, findHistory } = build([]);
    await expect(service.getStats('u1', 'not-a-cube')).rejects.toBeInstanceOf(BadRequestException);
    expect(findHistory).not.toHaveBeenCalled();
  });

  it('passes the daily progress series straight through', async () => {
    const progress: DailyProgressPoint[] = [
      { day: '2026-07-20', best_ms: 6289, average_ms: 6540, solve_count: 4 },
    ];
    const { service } = build([solve(6289)], progress);

    const res = await service.getStats('u1', '3x3');
    expect(res.progress).toEqual(progress);
  });

  it('builds the distribution from the ranked (non-DNF) singles only', async () => {
    // Newest-first history with a DNF (null) mixed in; the DNF must not appear.
    const { service } = build([solve(6002), solve(null), solve(6000), solve(6001)]);

    const res = await service.getStats('u1', '3x3');

    // Three ranked values 6000..6002 → span 3 → three 1 ms buckets.
    expect(res.distribution).toEqual([
      { from_ms: 6000, to_ms: 6001, count: 1 },
      { from_ms: 6001, to_ms: 6002, count: 1 },
      { from_ms: 6002, to_ms: 6003, count: 1 },
    ]);
  });

  it('returns empty progress and distribution for a cuber with no solves', async () => {
    const { service } = build([], []);
    const res = await service.getStats('u1', '3x3');
    expect(res.progress).toEqual([]);
    expect(res.distribution).toEqual([]);
  });
});
