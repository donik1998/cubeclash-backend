import { Controller, Get, Headers, Query } from '@nestjs/common';

import { ProfileQueryDto } from './dto/profile-query.dto';
import { ProfileResponseDto, toResponse } from './dto/profile-response.dto';
import { ProfileService } from './profile.service';

/** A v4-ish UUID; anything else in the principal header is treated as absent. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `GET /me/profile` — the composite the "You · Profile" screen reads: user +
 * best single + total solves + win rate + rank + friend count in one round
 * trip. Additive to the documented thin `GET /me`, which is untouched (§11.4).
 *
 * **Viewer identity comes from the `X-User-Id` header, not the query**, exactly
 * as `leaderboard.controller.ts` does. Auth is not wired in this repo yet
 * (`AuthModule` is a stub), so the header stands in for the authenticated
 * principal a JWT guard will later inject at `req.user.id`. Unlike the
 * leaderboard, a missing/malformed principal is a `401` here rather than an
 * empty board: there is no anonymous "me".
 */
@Controller('me/profile')
export class ProfileController {
  constructor(private readonly service: ProfileService) {}

  @Get()
  async getProfile(
    @Query() query: ProfileQueryDto,
    @Headers('x-user-id') rawViewerId?: string,
  ): Promise<ProfileResponseDto> {
    const viewerId = rawViewerId && UUID_RE.test(rawViewerId) ? rawViewerId : null;

    const view = await this.service.getProfile({
      viewerId,
      event: query.event,
      rankScope: query.rank_scope,
    });

    return toResponse(view);
  }
}
