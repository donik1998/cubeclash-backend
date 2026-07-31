import { CursorPaginationDto } from '../../../common/dto/pagination.dto';

/**
 * `GET /races?history&cursor=&limit=` — spec §8's paginated history.
 *
 * Extends {@link CursorPaginationDto} so `cursor`/`limit` behave identically to
 * every other list endpoint (row-value cursor on `(created_at, id)`, never an
 * offset). The `history` flag in the spec's URL is descriptive: this endpoint
 * *is* the caller's history, scoped to `@CurrentUser` in the controller, so
 * there is no separate query field to whitelist — a bare `GET /races` returns
 * the same page.
 */
export class ListRacesDto extends CursorPaginationDto {}
