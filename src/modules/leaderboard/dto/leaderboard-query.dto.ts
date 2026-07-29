import { IsIn, IsString } from 'class-validator';

import { CursorPaginationDto } from '../../../common/dto/pagination.dto';
import { LeaderboardMetric, LeaderboardScope } from '../leaderboard.types';

/**
 * `GET /leaderboard?event=&metric=&scope=&cursor=&limit=`.
 *
 * Reuses {@link CursorPaginationDto} for `cursor` / `limit` so the pagination
 * contract is identical to every other list endpoint. `event` is validated for
 * *shape* here and for *existence* in the service, which owns the
 * `unknown_event` envelope — the DTO cannot import the event registry without
 * turning a 400 into a validation-field error with the wrong code.
 *
 * `metric` and `scope` are constrained to their known values; an out-of-range
 * value is a client bug and fails as `validation_failed`. `ao5`/`ao12` are
 * *valid* values that the service then answers with `501 not_implemented` —
 * they are known metrics that simply are not built yet, not bad input.
 *
 * The viewer's identity is deliberately **not** a query field: it is the
 * authenticated principal, read from a header, never something the caller
 * names for themselves.
 */
export class LeaderboardQueryDto extends CursorPaginationDto {
  @IsString()
  event!: string;

  @IsIn(['single', 'ao5', 'ao12'])
  metric: LeaderboardMetric = 'single';

  @IsIn(['global', 'friends', 'country'])
  scope: LeaderboardScope = 'global';
}
