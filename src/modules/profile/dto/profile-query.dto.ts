import { IsIn, IsString } from 'class-validator';

import { RankScope } from '../profile.types';

/**
 * `GET /me/profile?event=&rank_scope=`.
 *
 * Both params are optional overrides with the spec's §11.2/§11.3 defaults —
 * `3x3` / `global`. `event` is validated for *shape* here and for *existence*
 * in the service, which owns the `unknown_event` envelope; the DTO cannot
 * import the event registry without turning a 400 into a validation-field error
 * with the wrong code.
 *
 * The viewer's identity is deliberately **not** a query field: it is the
 * authenticated principal read from a header, never something the caller names
 * for themselves. The property is `rank_scope` (not camelCase) so it matches the
 * wire key under the `forbidNonWhitelisted` pipe, which would otherwise reject
 * the snake_case query param as unknown.
 */
export class ProfileQueryDto {
  @IsString()
  event: string = '3x3';

  @IsIn(['global', 'country', 'friends'])
  rank_scope: RankScope = 'global';
}
