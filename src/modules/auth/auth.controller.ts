import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';

import { RateLimit } from '../../common/guards/rate-limit.decorator';
import { RateLimitGuard } from '../../common/guards/rate-limit.guard';
import { SelfUserDto } from '../users/dto/user-response.dto';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { RegisterDto } from './dto/register.dto';
import { TokenResponseDto } from './dto/token-response.dto';

/**
 * `POST /auth/{register,login,refresh,logout}` — thin by design: validate,
 * delegate, shape the status code. All business logic is in `AuthService`.
 *
 * `register` and `login` wear the Redis-backed `RateLimitGuard` (§2, API Design
 * § Cross-cutting): they are the two pre-auth doors, so they are the two that
 * get throttled against credential stuffing and email enumeration. `refresh`
 * and `logout` are gated by possession of a valid refresh token instead.
 *
 * `refresh` and `logout` take the token in the body, not the `Authorization`
 * header — the header is for the (short-lived) access token, and the two must
 * not be confused.
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  @UseGuards(RateLimitGuard)
  @RateLimit({ limit: 10, windowSeconds: 60 })
  @HttpCode(HttpStatus.CREATED)
  register(@Body() dto: RegisterDto): Promise<{ user: SelfUserDto; tokens: TokenResponseDto }> {
    return this.auth.register(dto);
  }

  @Post('login')
  @UseGuards(RateLimitGuard)
  @RateLimit({ limit: 20, windowSeconds: 60 })
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto): Promise<{ tokens: TokenResponseDto }> {
    return this.auth.login(dto);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(@Body() dto: RefreshDto): Promise<{ tokens: TokenResponseDto }> {
    return this.auth.refresh(dto.refresh);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Body() dto: RefreshDto): Promise<void> {
    await this.auth.logout(dto.refresh);
  }
}
