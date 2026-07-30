import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Query, UseGuards } from '@nestjs/common'; // prettier-ignore

import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { UpdateMeDto } from './dto/update-me.dto';
import { UserProfileQueryDto } from './dto/user-profile-query.dto';
import { ProfileUserDto, SelfUserDto, toSelf } from './dto/user-response.dto';
import { UserProfilePatch } from './users.repository';
import { UsersService } from './users.service';

/**
 * Profiles: the caller's own (`/me`) and the public view of anyone else's
 * (`/users/:id`).
 *
 * Every route is behind `JwtAuthGuard` and takes its subject from
 * `@CurrentUser('id')` — never a path or a header the caller controls. This is
 * the retirement of the raw user-id header stand-in: identity is the token now.
 *
 * The self/public split is enforced here by *choosing the mapper per route*:
 * `/me` returns `toSelf` (email included, it is yours), `/users/:id` returns the
 * profile shape (no email, ever — §1.7; the email wall holds because `toProfile`
 * builds on `toPublic`). An unknown id is a `404`, not a leak.
 */
@Controller()
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  async getMe(@CurrentUser('id') userId: string): Promise<{ user: SelfUserDto }> {
    const user = await this.users.getById(userId);
    return { user: toSelf(user) };
  }

  @Patch('me')
  async updateMe(
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateMeDto,
  ): Promise<{ user: SelfUserDto }> {
    // Build the patch from only the keys the client actually sent, so an absent
    // `country` is left untouched while an explicit `null` clears it.
    const patch: UserProfilePatch = {};
    if (dto.display_name !== undefined) patch.displayName = dto.display_name;
    if (dto.country !== undefined) patch.country = dto.country;

    const user = await this.users.updateProfile(userId, patch);
    return { user: toSelf(user) };
  }

  @Get('users/:id')
  async getUser(
    @CurrentUser('id') viewerId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: UserProfileQueryDto,
  ): Promise<{ user: ProfileUserDto }> {
    const user = await this.users.getProfile(viewerId, id, query.event);
    return { user };
  }
}
