import { IsIn } from 'class-validator';

/**
 * `PATCH /solves/:id` body: `{ penalty }`.
 *
 * Penalty is the only mutable field — a solve's time, scramble and moment are
 * facts, but a `+2` or `dnf` can be applied after the fact (a judge's call, a
 * cuber correcting their own log). This is the edit `is_pb` is derived rather
 * than stored for: changing a penalty changes the ranking key, and therefore
 * every later solve's personal-best status, with no stored flag to invalidate.
 */
export class UpdateSolveDto {
  @IsIn(['none', 'plus2', 'dnf'])
  penalty!: 'none' | 'plus2' | 'dnf';
}
