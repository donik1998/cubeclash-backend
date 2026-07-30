import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * Cursor pagination, per API Design § Conventions: `?cursor=…&limit=…` in,
 * `{ items, next_cursor }` out. Offsets are avoided on purpose — solve history
 * is append-heavy, and an offset walks rows the client has already seen.
 */
export class CursorPaginationDto {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 50;
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}
