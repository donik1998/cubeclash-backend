import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ProfileQueryDto } from './dto/profile-query.dto';
import { ProfileResponseDto, toResponse } from './dto/profile-response.dto';
import { ProfileService } from './profile.service';

/**
 * `GET /me/profile` — the composite the "You · Profile" screen reads: user +
 * best single + total solves + win rate + rank + friend count in one round
 * trip. Additive to the documented thin `GET /me`, which is untouched (§11.4).
 *
 * **Viewer identity is the authenticated principal**, injected by
 * `@CurrentUser('id')` behind `JwtAuthGuard` — the retirement of the raw
 * user-id header stand-in. There is no anonymous "me": an unauthenticated
 * request is a `401` from the guard, and a token for a deleted account is a
 * `404` from the service.
 */
@Controller('me/profile')
@UseGuards(JwtAuthGuard)
export class ProfileController {
  constructor(private readonly service: ProfileService) {}

  @Get()
  async getProfile(
    @Query() query: ProfileQueryDto,
    @CurrentUser('id') viewerId: string,
  ): Promise<ProfileResponseDto> {
    const view = await this.service.getProfile({
      viewerId,
      event: query.event,
      rankScope: query.rank_scope,
    });

    return toResponse(view);
  }
}
