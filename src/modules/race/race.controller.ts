import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { Page } from '../../common/dto/pagination.dto';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreateRaceDto } from './dto/create-race.dto';
import { CreateRaceResponseDto } from './dto/create-race-response.dto';
import { JoinRaceDto } from './dto/join-race.dto';
import { ListRacesDto } from './dto/list-races.dto';
import { RaceResponseDto, toRaceResponse } from './dto/race-response.dto';
import { RaceService } from './race.service';

/**
 * The race lobby's REST surface — spec §8. Every route is JWT-guarded and scoped
 * to `@CurrentUser`; the stateful part of a race lives in the Socket.IO gateway,
 * which shares `RaceService` with this controller so the two transports agree on
 * the rules.
 *
 * Thin as required: validate, delegate, shape. The one decision the controller
 * makes is passing the caller's id to `toRaceResponse` so a private room's
 * `code` is returned only to a participant — a wire-shaping concern, not a
 * business rule, which is why it lives here rather than in the service.
 */
@Controller('races')
@UseGuards(JwtAuthGuard)
export class RaceController {
  constructor(private readonly races: RaceService) {}

  /**
   * `POST /races` — open a room. Quick match enqueues (no code); private returns
   * a shareable code. 201, because a resource is created either way.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateRaceDto,
  ): Promise<CreateRaceResponseDto> {
    const { race } = await this.races.createRoom(userId, dto);
    const response: CreateRaceResponseDto = { race_id: race.id };
    if (race.code) response.code = race.code;
    return response;
  }

  /** `POST /races/join` — join a private room by code. Returns the race with competitors. */
  @Post('join')
  @HttpCode(HttpStatus.OK)
  async join(
    @CurrentUser('id') userId: string,
    @Body() dto: JoinRaceDto,
  ): Promise<{ race: RaceResponseDto }> {
    const race = await this.races.joinByCode(userId, dto.code);
    return { race: toRaceResponse(race, userId) };
  }

  /** `GET /races/:id` — one race with its competitors. `code` is withheld from non-participants. */
  @Get(':id')
  async getOne(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ race: RaceResponseDto }> {
    const race = await this.races.getRace(id);
    return { race: toRaceResponse(race, userId) };
  }

  /** `GET /races` — the caller's race history, newest first, cursor-paginated. */
  @Get()
  async history(
    @CurrentUser('id') userId: string,
    @Query() query: ListRacesDto,
  ): Promise<Page<RaceResponseDto>> {
    const page = await this.races.history(userId, { cursor: query.cursor, limit: query.limit });
    return {
      items: page.items.map((race) => toRaceResponse(race, userId)),
      next_cursor: page.nextCursor,
    };
  }
}
