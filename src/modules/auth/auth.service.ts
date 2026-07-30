import { Injectable, UnauthorizedException } from '@nestjs/common';

import { ErrorCode } from '../../common/errors/error-codes';
import { SelfUserDto, toSelf } from '../users/dto/user-response.dto';
import { UsersService } from '../users/users.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { TokenResponseDto, toTokenResponse } from './dto/token-response.dto';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

/**
 * The four auth flows, orchestrated: register, login, refresh, logout.
 *
 * It owns none of the mechanism — hashing is `PasswordService`, the JWT and
 * refresh-session lifecycle is `TokenService`, the credential store is
 * `UsersService` — it owns the *sequence* and the security-relevant decisions
 * between the steps: hash-then-create, verify-then-issue, and the generic 401
 * that never reveals whether an email is on file.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
  ) {}

  async register(dto: RegisterDto): Promise<{ user: SelfUserDto; tokens: TokenResponseDto }> {
    const passwordHash = await this.passwords.hash(dto.password);
    // A duplicate email surfaces as a 409 from the service — see UsersService.create.
    const user = await this.users.create({
      email: dto.email,
      passwordHash,
      displayName: dto.display_name,
    });

    const tokens = await this.tokens.issueTokens(user.id);
    return { user: toSelf(user), tokens: toTokenResponse(tokens) };
  }

  async login(dto: LoginDto): Promise<{ tokens: TokenResponseDto }> {
    const user = await this.users.findByEmail(dto.email);

    if (!user) {
      // Burn the same CPU a real verify would, so a missing email cannot be
      // distinguished from a wrong password by response time (§1.8).
      await this.passwords.verifyDummy(dto.password);
      throw this.invalidCredentials();
    }

    const ok = await this.passwords.verify(user.passwordHash, dto.password);
    if (!ok) {
      throw this.invalidCredentials();
    }

    const tokens = await this.tokens.issueTokens(user.id);
    return { tokens: toTokenResponse(tokens) };
  }

  async refresh(refreshToken: string): Promise<{ tokens: TokenResponseDto }> {
    const tokens = await this.tokens.rotate(refreshToken);
    return { tokens: toTokenResponse(tokens) };
  }

  logout(refreshToken: string): Promise<void> {
    return this.tokens.logout(refreshToken);
  }

  /** One message, one code, for both "no such email" and "wrong password". */
  private invalidCredentials(): UnauthorizedException {
    return new UnauthorizedException({
      code: ErrorCode.UNAUTHORIZED,
      message: 'Invalid email or password',
    });
  }
}
