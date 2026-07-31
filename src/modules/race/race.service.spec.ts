import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';

import { Race } from '../../db/schema';
import { RaceRepository } from './race.repository';
import { RaceService } from './race.service';
import { RaceWithCompetitors } from './race.types';

/** Only the repository methods `RaceService` actually calls, each a plain `jest.fn()`. */
type RepoMock = jest.Mocked<
  Pick<
    RaceRepository,
    | 'createRoom'
    | 'addParticipant'
    | 'countParticipants'
    | 'setReady'
    | 'recordFinish'
    | 'settle'
    | 'findActiveByCode'
    | 'findWithCompetitors'
    | 'findHistory'
  >
>;

/**
 * The rules the repository is too dumb to enforce, exercised against a mocked
 * repository so each test asserts a *decision* — raceability, code-collision
 * retry, a settled or full room — not a query. The query-level properties are
 * covered by the integration suite; here we prove the branching.
 */
describe('RaceService', () => {
  let repo: RepoMock;
  let service: RaceService;

  const HOST = '11111111-1111-4111-8111-111111111111';
  const JOINER = '22222222-2222-4222-8222-222222222222';

  /** A minimal `races` row, overridable per test. */
  const race = (over: Partial<Race> = {}): Race => ({
    id: 'race-1',
    event: '3x3',
    scramble: 'SCRAMBLE 3x3 X',
    mode: 'private',
    status: 'waiting',
    code: 'ABCDEF',
    createdBy: HOST,
    createdAt: new Date('2026-07-31T10:00:00Z'),
    settledAt: null,
    ...over,
  });

  /** A race-with-competitors read, defaulting to just the host waiting. */
  const withCompetitors = (
    over: Partial<Race> = {},
    competitors: RaceWithCompetitors['competitors'] = [],
  ): RaceWithCompetitors => ({
    ...race(over),
    competitors:
      competitors.length > 0
        ? competitors
        : [
            {
              userId: HOST,
              displayName: 'Host',
              country: null,
              elo: 1000,
              ready: false,
              timeMs: null,
              penalty: 'none',
              result: null,
              finishedAt: null,
              isHost: true,
            },
          ],
  });

  beforeEach(() => {
    repo = {
      createRoom: jest.fn(),
      addParticipant: jest.fn(),
      countParticipants: jest.fn(),
      setReady: jest.fn(),
      recordFinish: jest.fn(),
      settle: jest.fn(),
      findActiveByCode: jest.fn(),
      findWithCompetitors: jest.fn(),
      findHistory: jest.fn(),
    };
    service = new RaceService(repo as unknown as RaceRepository);
  });

  // --------------------------------------------------------- event raceability

  describe('createRoom — event narrowing (spec §9)', () => {
    it('rejects an unknown event with unknown_event', async () => {
      await expect(service.createRoom(HOST, { mode: 'private', event: 'nope' })).rejects.toThrow(
        BadRequestException,
      );
      expect(repo.createRoom).not.toHaveBeenCalled();
    });

    it('rejects a known-but-not-raceable event (blindfolded) with event_not_raceable', async () => {
      await expect(
        service.createRoom(HOST, { mode: 'private', event: '3x3-bld' }),
      ).rejects.toMatchObject({ response: { code: 'event_not_raceable' } });
      expect(repo.createRoom).not.toHaveBeenCalled();
    });

    it('allows a raceable-but-not-quick event (4x4) as a PRIVATE room', async () => {
      repo.createRoom.mockResolvedValue(race({ event: '4x4', code: 'ABCDEF' }));

      const { race: created } = await service.createRoom(HOST, { mode: 'private', event: '4x4' });

      expect(created.event).toBe('4x4');
      expect(repo.createRoom).toHaveBeenCalledTimes(1);
    });

    it('REJECTS a raceable-but-not-quick event (4x4) for QUICK match', async () => {
      // §9: quick match narrows to 2x2 / 3x3 / 3x3-oh. A 4x4 quick queue never
      // fills, so it is refused up front rather than enqueued forever.
      await expect(service.createRoom(HOST, { mode: 'quick', event: '4x4' })).rejects.toMatchObject(
        { response: { code: 'event_not_raceable' } },
      );
      expect(repo.createRoom).not.toHaveBeenCalled();
    });

    it('accepts 3x3-oh for quick match', async () => {
      repo.createRoom.mockResolvedValue(race({ event: '3x3-oh', code: null, mode: 'quick' }));

      const { race: created } = await service.createRoom(HOST, { mode: 'quick', event: '3x3-oh' });

      expect(created.event).toBe('3x3-oh');
    });

    it('mints NO code for a quick match, but DOES for a private room', async () => {
      repo.createRoom.mockImplementation((input) =>
        Promise.resolve(race({ code: input.code ?? null, mode: input.mode })),
      );

      const quick = await service.createRoom(HOST, { mode: 'quick', event: '3x3' });
      expect(quick.race.code).toBeNull();

      const priv = await service.createRoom(HOST, { mode: 'private', event: '3x3' });
      expect(priv.race.code).toBeTruthy();
      expect(priv.race.code).toHaveLength(6);
    });
  });

  // ------------------------------------------------------ code-collision retry

  describe('createRoom — private code collision retry', () => {
    /** A Postgres unique violation as the pg driver raises it (SQLSTATE 23505). */
    const uniqueViolation = () =>
      Object.assign(new Error('duplicate key'), {
        cause: { code: '23505', constraint: 'races_active_code_key' },
      });

    it('retries with a fresh code when the partial unique index rejects one', async () => {
      repo.createRoom
        .mockRejectedValueOnce(uniqueViolation())
        .mockRejectedValueOnce(uniqueViolation())
        .mockResolvedValueOnce(race({ code: 'GOODAB' }));

      const { race: created } = await service.createRoom(HOST, { mode: 'private', event: '3x3' });

      expect(created.code).toBe('GOODAB');
      expect(repo.createRoom).toHaveBeenCalledTimes(3);
      // Each attempt used a distinct code — collision retry, not a resubmit.
      const codes = repo.createRoom.mock.calls.map(([input]) => input.code);
      expect(new Set(codes).size).toBe(3);
    });

    it('gives up after the attempt cap rather than looping forever', async () => {
      repo.createRoom.mockRejectedValue(uniqueViolation());

      await expect(
        service.createRoom(HOST, { mode: 'private', event: '3x3' }),
      ).rejects.toBeInstanceOf(Error);
      // Bounded: 5 attempts, not an unbounded hang on an exhausted pool.
      expect(repo.createRoom).toHaveBeenCalledTimes(5);
    });

    it('does not swallow a non-unique-violation error (a real failure surfaces)', async () => {
      repo.createRoom.mockRejectedValue(new Error('connection reset'));

      await expect(service.createRoom(HOST, { mode: 'private', event: '3x3' })).rejects.toThrow(
        'connection reset',
      );
      // A genuine failure is not retried as if it were a code collision.
      expect(repo.createRoom).toHaveBeenCalledTimes(1);
    });
  });

  // ------------------------------------------------------------- join by code

  describe('joinByCode', () => {
    it('404s when the code resolves to no active room (join-a-settled-room)', async () => {
      // findActiveByCode filters on status, so a settled room's released code is
      // null here — the caller cannot walk into a finished race.
      repo.findActiveByCode.mockResolvedValue(null);

      await expect(service.joinByCode(JOINER, 'ABCDEF')).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.addParticipant).not.toHaveBeenCalled();
    });

    it('409s when the room has already started (not waiting)', async () => {
      repo.findActiveByCode.mockResolvedValue(race({ status: 'racing' }));

      await expect(service.joinByCode(JOINER, 'ABCDEF')).rejects.toBeInstanceOf(ConflictException);
      expect(repo.addParticipant).not.toHaveBeenCalled();
    });

    it('409s a full room for a NEW joiner (join-a-full-room)', async () => {
      repo.findActiveByCode.mockResolvedValue(race({ status: 'waiting' }));
      repo.countParticipants.mockResolvedValue(2); // host + one already seated
      // The full-room branch confirms the caller is not already in it.
      repo.findWithCompetitors.mockResolvedValue(
        withCompetitors({ status: 'waiting' }, [
          {
            userId: HOST,
            displayName: 'Host',
            country: null,
            elo: 1000,
            ready: false,
            timeMs: null,
            penalty: 'none',
            result: null,
            finishedAt: null,
            isHost: true,
          },
          {
            userId: 'someone-else',
            displayName: 'Other',
            country: null,
            elo: 1000,
            ready: false,
            timeMs: null,
            penalty: 'none',
            result: null,
            finishedAt: null,
            isHost: false,
          },
        ]),
      );

      await expect(service.joinByCode(JOINER, 'ABCDEF')).rejects.toMatchObject({
        response: { code: 'conflict' },
      });
      expect(repo.addParticipant).not.toHaveBeenCalled();
    });

    it('seats a second player in a waiting room and returns the race', async () => {
      repo.findActiveByCode.mockResolvedValue(race({ status: 'waiting' }));
      repo.countParticipants.mockResolvedValue(1); // just the host
      repo.addParticipant.mockResolvedValue({ seated: true });
      repo.findWithCompetitors.mockResolvedValue(withCompetitors({ status: 'waiting' }));

      const result = await service.joinByCode(JOINER, 'ABCDEF');

      expect(repo.addParticipant).toHaveBeenCalledWith('race-1', JOINER);
      expect(result.id).toBe('race-1');
    });

    it('is idempotent: a re-join by an already-seated full-room player is allowed', async () => {
      repo.findActiveByCode.mockResolvedValue(race({ status: 'waiting' }));
      repo.countParticipants.mockResolvedValue(2);
      // The caller IS already one of the two — findWithCompetitors includes them.
      repo.findWithCompetitors.mockResolvedValue(
        withCompetitors({ status: 'waiting' }, [
          {
            userId: HOST,
            displayName: 'Host',
            country: null,
            elo: 1000,
            ready: false,
            timeMs: null,
            penalty: 'none',
            result: null,
            finishedAt: null,
            isHost: true,
          },
          {
            userId: JOINER,
            displayName: 'Me',
            country: null,
            elo: 1000,
            ready: false,
            timeMs: null,
            penalty: 'none',
            result: null,
            finishedAt: null,
            isHost: false,
          },
        ]),
      );
      repo.addParticipant.mockResolvedValue({ seated: false });

      const result = await service.joinByCode(JOINER, 'ABCDEF');

      expect(result.id).toBe('race-1');
      expect(repo.addParticipant).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------- settlement

  describe('settle — Elo payout', () => {
    const two = (): RaceWithCompetitors =>
      withCompetitors({ status: 'racing' }, [
        {
          userId: HOST,
          displayName: 'Host',
          country: null,
          elo: 1000,
          ready: true,
          timeMs: 10_000,
          penalty: 'none',
          result: null,
          finishedAt: new Date(),
          isHost: true,
        },
        {
          userId: JOINER,
          displayName: 'Joiner',
          country: null,
          elo: 1000,
          ready: true,
          timeMs: 12_000,
          penalty: 'none',
          result: null,
          finishedAt: new Date(),
          isHost: false,
        },
      ]);

    it('pays out +/-16 Elo for even ratings and returns per-user deltas', async () => {
      repo.findWithCompetitors.mockResolvedValue(two());
      repo.settle.mockResolvedValue({ settled: true });

      const { settled, eloByUser } = await service.settle('race-1', {
        results: [
          { userId: HOST, result: 'win', timeMs: 10_000, penalty: 'none' },
          { userId: JOINER, result: 'loss', timeMs: 12_000, penalty: 'none' },
        ],
      });

      expect(settled).toBe(true);
      // K=32, even ratings → expected 0.5 → ±16.
      expect(eloByUser[HOST]).toBe(16);
      expect(eloByUser[JOINER]).toBe(-16);
    });

    it('treats a DNF as a loss for rating (spec §11.2)', async () => {
      repo.findWithCompetitors.mockResolvedValue(two());
      repo.settle.mockResolvedValue({ settled: true });

      const { eloByUser } = await service.settle('race-1', {
        results: [
          { userId: HOST, result: 'win', timeMs: 10_000, penalty: 'none' },
          { userId: JOINER, result: 'dnf', timeMs: null, penalty: 'dnf' },
        ],
      });

      expect(eloByUser[JOINER]).toBe(-16);
    });

    it('returns no deltas when another worker already settled (idempotent)', async () => {
      repo.findWithCompetitors.mockResolvedValue(two());
      repo.settle.mockResolvedValue({ settled: false });

      const { settled, eloByUser } = await service.settle('race-1', {
        results: [
          { userId: HOST, result: 'win', timeMs: 10_000, penalty: 'none' },
          { userId: JOINER, result: 'loss', timeMs: 12_000, penalty: 'none' },
        ],
      });

      expect(settled).toBe(false);
      expect(eloByUser).toEqual({});
    });
  });

  // ------------------------------------------------------------------- ready

  describe('markReady', () => {
    it('reports allReady only when both of two players are ready', async () => {
      repo.setReady.mockResolvedValue(true);
      repo.findWithCompetitors.mockResolvedValue(
        withCompetitors({ status: 'waiting' }, [
          {
            userId: HOST,
            displayName: 'Host',
            country: null,
            elo: 1000,
            ready: true,
            timeMs: null,
            penalty: 'none',
            result: null,
            finishedAt: null,
            isHost: true,
          },
          {
            userId: JOINER,
            displayName: 'Joiner',
            country: null,
            elo: 1000,
            ready: true,
            timeMs: null,
            penalty: 'none',
            result: null,
            finishedAt: null,
            isHost: false,
          },
        ]),
      );

      const { allReady } = await service.markReady('race-1', JOINER, true);
      expect(allReady).toBe(true);
    });

    it('404s a caller who is not a participant', async () => {
      repo.setReady.mockResolvedValue(false);

      await expect(service.markReady('race-1', 'ghost', true)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
