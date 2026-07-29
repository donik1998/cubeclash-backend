import { HttpException, HttpStatus } from '@nestjs/common';

import { ErrorCode } from '../../common/errors/error-codes';
import { LeaderboardRepository } from './leaderboard.repository';
import { LeaderboardService } from './leaderboard.service';
import { LeaderboardEntry, LeaderboardPage } from './leaderboard.types';

/**
 * The service's job is validation, metric dispatch, and the domain → wire
 * mapping. The ranking and scope SQL is a property of the query and is tested
 * against real Postgres in `test/leaderboard.e2e-spec.ts`; a mocked db here
 * would only prove the mock. So the repository is faked, and what is asserted
 * is the contract the service owns: which inputs become which error envelope,
 * and that a domain page comes out snake_cased with `event` echoed on.
 */
describe('LeaderboardService', () => {
  const entry: LeaderboardEntry = {
    rank: 1,
    userId: '11111111-1111-4111-8111-111111111111',
    displayName: 'kian_r',
    country: 'IR',
    valueMs: 6310,
    solvedAt: new Date('2026-07-20T09:12:03.000Z'),
  };

  const page: LeaderboardPage = {
    items: [entry],
    nextCursor: 'CURSOR',
    viewer: { ...entry, rank: 1204, displayName: 'me' },
  };

  const makeService = (findSingle = jest.fn().mockResolvedValue(page)) => {
    const repository = { findSingle } as unknown as LeaderboardRepository;
    return { service: new LeaderboardService(repository), findSingle };
  };

  const baseQuery = {
    event: '3x3',
    scope: 'global' as const,
    viewerId: null,
    metric: 'single' as const,
  };

  it('rejects an unknown event with the unknown_event envelope', async () => {
    const { service, findSingle } = makeService();

    await expect(
      service.getLeaderboard({ ...baseQuery, event: 'not-a-cube' }),
    ).rejects.toMatchObject({ response: { code: ErrorCode.UNKNOWN_EVENT } });
    expect(findSingle).not.toHaveBeenCalled();
  });

  it.each(['ao5', 'ao12'] as const)(
    'answers metric=%s with 501 not_implemented',
    async (metric) => {
      const { service, findSingle } = makeService();

      try {
        await service.getLeaderboard({ ...baseQuery, metric });
        throw new Error('expected the call to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(HttpException);
        expect((error as HttpException).getStatus()).toBe(HttpStatus.NOT_IMPLEMENTED);
        expect((error as HttpException).getResponse()).toMatchObject({
          code: ErrorCode.NOT_IMPLEMENTED,
        });
      }
      expect(findSingle).not.toHaveBeenCalled();
    },
  );

  it('passes event, scope, viewer and pagination through to the repository', async () => {
    const { service, findSingle } = makeService();

    await service.getLeaderboard({
      event: '3x3',
      scope: 'friends',
      viewerId: 'v-1',
      metric: 'single',
      cursor: 'abc',
      limit: 10,
    });

    expect(findSingle).toHaveBeenCalledWith('3x3', 'friends', 'v-1', { cursor: 'abc', limit: 10 });
  });

  it('maps the domain page to the snake_case wire shape with event echoed on', async () => {
    const { service } = makeService();

    const result = await service.getLeaderboard(baseQuery);

    expect(result).toEqual({
      items: [
        {
          rank: 1,
          user_id: entry.userId,
          display_name: 'kian_r',
          country: 'IR',
          value_ms: 6310,
          event: '3x3',
          solved_at: '2026-07-20T09:12:03.000Z',
        },
      ],
      next_cursor: 'CURSOR',
      viewer: {
        rank: 1204,
        user_id: entry.userId,
        display_name: 'me',
        country: 'IR',
        value_ms: 6310,
        event: '3x3',
        solved_at: '2026-07-20T09:12:03.000Z',
      },
    });
  });

  it('carries a null viewer through as null', async () => {
    const { service } = makeService(
      jest.fn().mockResolvedValue({ items: [], nextCursor: null, viewer: null }),
    );

    const result = await service.getLeaderboard(baseQuery);

    expect(result.viewer).toBeNull();
    expect(result.next_cursor).toBeNull();
    expect(result.items).toEqual([]);
  });
});
