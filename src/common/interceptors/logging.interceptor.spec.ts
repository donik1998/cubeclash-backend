import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';

import { LoggingInterceptor } from './logging.interceptor';

/**
 * The access log's whole job is telling a server fault apart from a client
 * mistake. It used to log a hardcoded 500 on every error path, so a validation
 * failure and a genuine crash read identically — found by pointing the Android
 * client at a live server and seeing `POST /v1/auth/logout 500` logged directly
 * above `→ 400 validation_failed`.
 */
describe('LoggingInterceptor', () => {
  let interceptor: LoggingInterceptor;
  let logged: string[];

  const contextWithStatus = (statusCode: number): ExecutionContext =>
    ({
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: () => ({ method: 'POST', originalUrl: '/v1/auth/logout' }),
        getResponse: () => ({ statusCode }),
      }),
    }) as unknown as ExecutionContext;

  const failingWith = (error: unknown): CallHandler =>
    ({ handle: () => throwError(() => error) }) as CallHandler;

  beforeEach(() => {
    logged = [];
    interceptor = new LoggingInterceptor();
    jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation((message: unknown) => void logged.push(String(message)));
  });

  afterEach(() => jest.restoreAllMocks());

  const runExpectingError = async (error: unknown): Promise<void> => {
    await expect(
      lastValueFrom(interceptor.intercept(contextWithStatus(200), failingWith(error))),
    ).rejects.toBe(error);
  };

  it.each([
    ['a 400', new BadRequestException('nope'), 400],
    ['a 401', new UnauthorizedException(), 401],
    ['a 404', new NotFoundException(), 404],
  ])("logs %s with the exception's own status, not 500", async (_label, error, expected) => {
    await runExpectingError(error);

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(`POST /v1/auth/logout ${expected} `);
    expect(logged[0]).not.toContain(' 500 ');
  });

  it('still logs 500 for a non-HttpException, which really is a server fault', async () => {
    await runExpectingError(new Error('boom'));

    expect(logged[0]).toContain('POST /v1/auth/logout 500 ');
  });

  it('logs the response status on the success path', async () => {
    await lastValueFrom(
      interceptor.intercept(contextWithStatus(204), {
        handle: () => of(null),
      } as CallHandler),
    );

    expect(logged[0]).toContain('POST /v1/auth/logout 204 ');
  });

  it('passes non-http contexts straight through without logging', async () => {
    const rpc = { getType: () => 'rpc' } as unknown as ExecutionContext;

    await lastValueFrom(interceptor.intercept(rpc, { handle: () => of('x') } as CallHandler));

    expect(logged).toHaveLength(0);
  });
});
