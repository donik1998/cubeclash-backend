import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';

import { Page } from '../../common/dto/pagination.dto';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreateSolveDto } from './dto/create-solve.dto';
import { ListSolvesDto } from './dto/list-solves.dto';
import { SolveResponseDto } from './dto/solve-response.dto';
import { UpdateSolveDto } from './dto/update-solve.dto';
import { SolvesService } from './solves.service';

/**
 * The practice-record endpoints, all behind `JwtAuthGuard` and all scoped to
 * `@CurrentUser('id')` — a caller only ever touches their own solves.
 *
 * Thin as required: validate, delegate, shape the response. The one flourish is
 * `POST`, which answers **201 on create and 200 on the idempotent update path**
 * (a retried offline submit), so the client can tell a new row from a
 * de-duplicated one. That needs the real status at runtime, hence the
 * passthrough `Response`.
 */
@Controller('solves')
@UseGuards(JwtAuthGuard)
export class SolvesController {
  constructor(private readonly solves: SolvesService) {}

  @Post()
  async create(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateSolveDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ solve: SolveResponseDto }> {
    const { solve, created } = await this.solves.create(userId, dto);
    res.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return { solve };
  }

  @Get()
  list(
    @CurrentUser('id') userId: string,
    @Query() query: ListSolvesDto,
  ): Promise<Page<SolveResponseDto>> {
    return this.solves.list(userId, query);
  }

  @Patch(':id')
  async updatePenalty(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSolveDto,
  ): Promise<{ solve: SolveResponseDto }> {
    const solve = await this.solves.updatePenalty(userId, id, dto.penalty);
    return { solve };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.solves.remove(userId, id);
  }
}
