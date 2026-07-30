import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import { Page } from '../../common/dto/pagination.dto';
import { ErrorCode } from '../../common/errors/error-codes';
import { allowedResultColumns, isKnownEvent } from '../../domain/wca-events';
import { CreateSolveDto } from './dto/create-solve.dto';
import { SolveResponseDto, toSolveResponse } from './dto/solve-response.dto';
import { ListSolvesDto } from './dto/list-solves.dto';
import { SolveUpsert, SolvesRepository } from './solves.repository';

/** The client-supplied long-form fields, paired with their wire column names. */
const LONG_FORM_FIELDS = [
  ['move_count', 'moveCount'],
  ['solved_count', 'solvedCount'],
  ['attempted_count', 'attemptedCount'],
] as const;

/**
 * The rules the repository is too dumb to enforce.
 *
 * The repository moves rows; this class decides what a valid solve *is*: a known
 * event, long-form counts only where the event allows them, and — the one the
 * client cannot be trusted with — the authoritative `is_pb`, recomputed on read
 * and returned rather than accepted. Ownership is enforced by returning `404`
 * (never `403`) for another user's solve, so the API never confirms that an id
 * it will not let you touch even exists.
 */
@Injectable()
export class SolvesService {
  constructor(private readonly repository: SolvesRepository) {}

  async create(
    userId: string,
    dto: CreateSolveDto,
  ): Promise<{ solve: SolveResponseDto; created: boolean }> {
    this.assertKnownEvent(dto.event);
    this.assertLongFormAllowed(dto);

    const allowed = new Set(allowedResultColumns(dto.event));
    const upsert: SolveUpsert = {
      userId,
      event: dto.event,
      scramble: dto.scramble, // byte-for-byte; never trimmed or normalised
      scrambleSource: dto.scramble_source,
      timeMs: dto.time_ms,
      penalty: dto.penalty,
      solvedAt: new Date(dto.solved_at),
      clientId: dto.client_id,
      moveCount: allowed.has('move_count') ? (dto.move_count ?? null) : null,
      solvedCount: allowed.has('solved_count') ? (dto.solved_count ?? null) : null,
      attemptedCount: allowed.has('attempted_count') ? (dto.attempted_count ?? null) : null,
    };

    const { solve, created } = await this.repository.upsert(upsert);

    // Re-read with `is_pb` computed over the whole event history — the write
    // path owes the client the authoritative badge, and an upsert of an older
    // client_id can change the ranking of rows around it.
    const ranked = await this.repository.findRankedById(userId, solve.event, solve.id);
    return {
      solve: toSolveResponse(ranked ?? { ...solve, isPb: false, rankingValue: null }),
      created,
    };
  }

  async list(userId: string, query: ListSolvesDto): Promise<Page<SolveResponseDto>> {
    if (query.event) this.assertKnownEvent(query.event);

    const page = await this.repository.findHistoryPage(userId, query.event, {
      cursor: query.cursor,
      limit: query.limit,
    });

    return { items: page.items.map(toSolveResponse), next_cursor: page.nextCursor };
  }

  async updatePenalty(
    userId: string,
    id: string,
    penalty: 'none' | 'plus2' | 'dnf',
  ): Promise<SolveResponseDto> {
    const existing = await this.ownedSolve(userId, id);

    await this.repository.updatePenalty(id, penalty);

    const ranked = await this.repository.findRankedById(userId, existing.event, id);
    // Defensive: the row is live (ownedSolve rejected tombstones), so it is here.
    return toSolveResponse(ranked ?? { ...existing, penalty, isPb: false, rankingValue: null });
  }

  async remove(userId: string, id: string): Promise<void> {
    const existing = await this.repository.findRawById(id);

    // Someone else's id — or none — is a 404, never a 403: existence is not leaked.
    if (!existing || existing.userId !== userId) {
      throw this.notFound();
    }
    // Already a tombstone: deleting again is a no-op that still succeeds (204).
    if (existing.deleted) return;

    await this.repository.softDelete(id);
  }

  /** Fetch a live solve the caller owns, or 404 — the guard for PATCH. */
  private async ownedSolve(userId: string, id: string) {
    const existing = await this.repository.findRawById(id);
    if (!existing || existing.userId !== userId || existing.deleted) {
      throw this.notFound();
    }
    return existing;
  }

  private assertKnownEvent(event: string): void {
    if (!isKnownEvent(event)) {
      throw new BadRequestException({
        code: ErrorCode.UNKNOWN_EVENT,
        message: `Unknown event '${event}'`,
      });
    }
  }

  /** Reject a long-form count sent for an event that does not have that result kind. */
  private assertLongFormAllowed(dto: CreateSolveDto): void {
    const allowed = new Set(allowedResultColumns(dto.event));
    for (const [wire] of LONG_FORM_FIELDS) {
      if (dto[wire] !== undefined && !allowed.has(wire)) {
        throw new BadRequestException({
          code: ErrorCode.VALIDATION_FAILED,
          message: `'${wire}' is not a valid field for event '${dto.event}'`,
        });
      }
    }
  }

  private notFound(): NotFoundException {
    return new NotFoundException({ code: ErrorCode.NOT_FOUND, message: 'Solve not found' });
  }
}
