import { IsOptional, IsString } from 'class-validator';

import { CursorPaginationDto } from '../../../common/dto/pagination.dto';

/**
 * `GET /solves?event=&cursor=&limit=`.
 *
 * Extends {@link CursorPaginationDto} so `cursor`/`limit` behave identically to
 * every other list endpoint. `event` is an optional filter — omitted, the page
 * spans every event, newest first; present, it is validated for existence in
 * the service (the `unknown_event` owner), not here.
 */
export class ListSolvesDto extends CursorPaginationDto {
  @IsOptional()
  @IsString()
  event?: string;
}
