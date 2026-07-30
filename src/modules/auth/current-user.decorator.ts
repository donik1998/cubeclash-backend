import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import { Request } from 'express';

import { AuthPrincipal } from './auth.types';

/**
 * `@CurrentUser()` — the authenticated principal a `JwtAuthGuard` route can
 * inject, replacing the raw user-id header stand-in that predated auth.
 *
 * `@CurrentUser()` yields the whole `{ id }` principal; `@CurrentUser('id')`
 * yields just the id, for the common case. It reads `req.user`, which Passport
 * populated from `JwtStrategy.validate`, so it only makes sense on a guarded
 * route — off one, there is no principal to hand back.
 */
export const CurrentUser = createParamDecorator(
  (field: keyof AuthPrincipal | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<Request & { user?: AuthPrincipal }>();
    const principal = request.user;
    return field ? principal?.[field] : principal;
  },
);
