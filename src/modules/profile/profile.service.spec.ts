import { HttpException, HttpStatus } from '@nestjs/common';

import { LeaderboardRepository } from '../leaderboard/leaderboard.repository';
import { LeaderboardEntry, LeaderboardPage } from '../leaderboard/leaderboard.types';
import { SolvesRepository, SolveWithRanking } from '../solves/solves.repository';
import { ProfileAggregate, ProfileRepository } from './profile.repository';
import { ProfileService } from './profile.service';
import { ProfileQuery } from './profile.types';

/**
 * The composite's orchestration and the one calculation it owns — the win-rate
 * ratio — against stubbed reads. The reads themselves (best-in-event, rank, the
 * counts) are covered end to end against real Postgres in the e2e suite; here we
 * pin the assembly: which errors fire, when `rank`/`best` collapse to null, and
 * that win rate is `wins / (wins + losses)` with a null-not-zero denominator
 * guard.
 */
describe('ProfileService', () => {
  const VIEWER = '11111111-1111-4111-8111-111111111111';

  let repository: jest.Mocked<Pick<ProfileRepository, 'findAggregate'>>;
  let solves: jest.Mocked<Pick<SolvesRepository, 'personalBest'>>;
  let leaderboard: jest.Mocked<Pick<LeaderboardRepository, 'findSingle'>>;
  let service: ProfileService;

  const aggregate = (over: Partial<ProfileAggregate> = {}): ProfileAggregate => ({
    user: { id: VIEWER, displayName: 'cuber_98', country: 'UZ', elo: 1180 },
    totalSolves: 3204,
    wins: 217,
    losses: 102,
    friendCount: 48,
    ...over,
  });

  const viewerEntry = (rank: number): LeaderboardEntry => ({
    rank,
    userId: VIEWER,
    displayName: 'cuber_98',
    country: 'UZ',
    valueMs: 8420,
    solvedAt: new Date('2026-07-01T00:00:00.000Z'),
  });

  const page = (viewer: LeaderboardEntry | null): LeaderboardPage => ({
    items: [],
    nextCursor: null,
    viewer,
  });

  const best = (ms: number | null): SolveWithRanking =>
    ({ rankingValue: ms }) as unknown as SolveWithRanking;

  const query = (over: Partial<ProfileQuery> = {}): ProfileQuery => ({
    viewerId: VIEWER,
    event: '3x3',
    rankScope: 'global',
    ...over,
  });

  beforeEach(() => {
    repository = { findAggregate: jest.fn().mockResolvedValue(aggregate()) };
    solves = { personalBest: jest.fn().mockResolvedValue(best(8420)) };
    leaderboard = { findSingle: jest.fn().mockResolvedValue(page(viewerEntry(1204))) };

    service = new ProfileService(
      repository as unknown as ProfileRepository,
      solves as unknown as SolvesRepository,
      leaderboard as unknown as LeaderboardRepository,
    );
  });

  it('assembles the nominal profile from the three reads', async () => {
    const view = await service.getProfile(query());

    expect(view).toEqual({
      user: { id: VIEWER, displayName: 'cuber_98', country: 'UZ', elo: 1180 },
      rank: { event: '3x3', metric: 'single', scope: 'global', position: 1204 },
      stats: {
        bestSingleMs: 8420,
        bestSingleEvent: '3x3',
        totalSolves: 3204,
        winRate: 217 / 319,
        wins: 217,
        losses: 102,
      },
      friendCount: 48,
    });
  });

  it('rejects an anonymous caller with 401 before touching any read', async () => {
    await expect(service.getProfile(query({ viewerId: null }))).rejects.toMatchObject({
      status: HttpStatus.UNAUTHORIZED,
    });

    expect(repository.findAggregate).not.toHaveBeenCalled();
    expect(solves.personalBest).not.toHaveBeenCalled();
    expect(leaderboard.findSingle).not.toHaveBeenCalled();
  });

  it('rejects an unknown event as unknown_event (400)', async () => {
    const error = await service.getProfile(query({ event: 'not-a-cube' })).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect((error as HttpException).getResponse()).toMatchObject({ code: 'unknown_event' });
    expect(repository.findAggregate).not.toHaveBeenCalled();
  });

  it('404s when the principal resolves to no user', async () => {
    repository.findAggregate.mockResolvedValue(null);

    await expect(service.getProfile(query())).rejects.toMatchObject({
      status: HttpStatus.NOT_FOUND,
    });
  });

  it('drops rank to null when the viewer has no ranked solve', async () => {
    leaderboard.findSingle.mockResolvedValue(page(null));

    const view = await service.getProfile(query());

    expect(view.rank).toBeNull();
  });

  it('renders best as null when there is no ranked solve', async () => {
    solves.personalBest.mockResolvedValue(null);

    const view = await service.getProfile(query());

    expect(view.stats.bestSingleMs).toBeNull();
  });

  it('makes win rate null (not zero) when there are no settled races', async () => {
    repository.findAggregate.mockResolvedValue(aggregate({ wins: 0, losses: 0 }));

    const view = await service.getProfile(query());

    expect(view.stats.winRate).toBeNull();
    expect(view.stats.wins).toBe(0);
    expect(view.stats.losses).toBe(0);
  });

  it('echoes the requested event and scope onto rank and best', async () => {
    await service.getProfile(query({ event: '4x4', rankScope: 'country' }));

    expect(solves.personalBest).toHaveBeenCalledWith(VIEWER, '4x4');
    expect(leaderboard.findSingle).toHaveBeenCalledWith(
      '4x4',
      'country',
      VIEWER,
      expect.objectContaining({ limit: 1 }),
    );
  });
});
