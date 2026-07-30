import { BadRequestException, NotFoundException } from '@nestjs/common';

import { User } from '../../db/schema';
import { RaceRepository } from '../race/race.repository';
import { HeadToHead } from '../race/race.types';
import { SolveWithRanking, SolvesRepository } from '../solves/solves.repository';
import { UsersRepository } from './users.repository';
import { UsersService } from './users.service';

/**
 * `UsersService.getProfile` in isolation — the composite read model. The bests
 * ride on `ranking.ts`/`average.ts` (their own tests) and the head-to-head on
 * `RaceRepository` (its own e2e), so here the seams are faked and the focus is
 * how the service *composes* them: event validation, the self-profile and
 * never-raced null rules, and the head-to-head projection to `{ wins, losses }`.
 */
describe('UsersService.getProfile', () => {
  const viewerId = '11111111-1111-4111-8111-111111111111';
  const targetId = '22222222-2222-4222-8222-222222222222';

  const target: User = {
    id: targetId,
    email: 'other@example.com',
    passwordHash: 'x',
    displayName: 'Other',
    country: 'IR',
    elo: 1180,
    createdAt: new Date('2026-07-30T12:00:00.000Z'),
    updatedAt: new Date('2026-07-30T12:00:00.000Z'),
  };

  const solve = (rankingValue: number | null): SolveWithRanking =>
    ({ rankingValue }) as SolveWithRanking;

  const build = (over: {
    user?: User | undefined;
    history?: SolveWithRanking[];
    h2h?: HeadToHead | null;
  }) => {
    const findById = jest.fn().mockResolvedValue('user' in over ? over.user : target);
    const findHistory = jest.fn().mockResolvedValue(over.history ?? []);
    const headToHead = jest.fn().mockResolvedValue(over.h2h ?? null);
    const users = { findById } as unknown as UsersRepository;
    const solves = { findHistory } as unknown as SolvesRepository;
    const races = { headToHead } as unknown as RaceRepository;
    return { service: new UsersService(users, solves, races), findById, findHistory, headToHead };
  };

  it('rejects an unknown event as unknown_event, before any read', async () => {
    const { service, findById } = build({});
    await expect(service.getProfile(viewerId, targetId, 'not-a-cube')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(findById).not.toHaveBeenCalled();
  });

  it('404s when the target user does not exist', async () => {
    const { service } = build({ user: undefined });
    await expect(service.getProfile(viewerId, targetId)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('projects the head-to-head to just wins and losses', async () => {
    const h2h = {
      wins: 3,
      losses: 1,
      dnf: 2,
      abandoned: 1,
      played: 7,
    } as HeadToHead;
    // Newest-first history: singles 6000..6004 across five solves.
    const history = [6004, 6003, 6002, 6001, 6000].map(solve);
    const { service } = build({ history, h2h });

    const dto = await service.getProfile(viewerId, targetId);

    expect(dto.best_single_ms).toBe(6000);
    expect(dto.ao5).toBe(6002); // one clean window of five → drop 6000,6004 → mean = 6002
    expect(dto.ao12).toBeNull(); // fewer than twelve
    expect(dto.head_to_head).toEqual({ wins: 3, losses: 1 });
    expect(dto).not.toHaveProperty('email');
  });

  it('returns head_to_head null and never queries the self-join for your own id', async () => {
    const { service, headToHead } = build({ user: { ...target, id: viewerId }, history: [] });

    const dto = await service.getProfile(viewerId, viewerId);

    expect(dto.head_to_head).toBeNull();
    expect(headToHead).not.toHaveBeenCalled();
  });

  it('returns head_to_head null when the two have never raced', async () => {
    const { service } = build({ h2h: null });
    const dto = await service.getProfile(viewerId, targetId);
    expect(dto.head_to_head).toBeNull();
  });

  it('defaults to 3x3 when no event is given', async () => {
    const { service, findHistory } = build({});
    await service.getProfile(viewerId, targetId);
    expect(findHistory).toHaveBeenCalledWith(targetId, '3x3');
  });
});
