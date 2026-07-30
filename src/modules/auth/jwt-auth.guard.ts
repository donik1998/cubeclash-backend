import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * The guard every authenticated route wears: `@UseGuards(JwtAuthGuard)`.
 *
 * A thin alias over Passport's `jwt` strategy, exported from the auth module so
 * the other domain modules protect their routes without re-declaring the
 * mechanism. On failure Passport throws `UnauthorizedException`, which the
 * global filter renders as the standard `{ error: { code: 'unauthorized' } }`
 * envelope — so an unauthenticated request looks the same everywhere.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
