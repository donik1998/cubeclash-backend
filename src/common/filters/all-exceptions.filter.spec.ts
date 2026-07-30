import {
  ArgumentsHost,
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { AllExceptionsFilter } from './all-exceptions.filter';
import { ErrorBody, ErrorCode } from '../errors/error-codes';

/**
 * The error envelope is a contract the Flutter client already parses, so it is
 * tested as one: every throw, whatever its origin, leaves as
 * `{ error: { code, message, details? } }`.
 */
describe('AllExceptionsFilter', () => {
  let filter: AllExceptionsFilter;
  let sentStatus: number | undefined;
  let sentBody: ErrorBody | undefined;
  let host: ArgumentsHost;

  /** A minimal stand-in for `express.Response` — typed, so lint stays honest. */
  const response = {
    status(code: number) {
      sentStatus = code;
      return this;
    },
    json(body: ErrorBody) {
      sentBody = body;
    },
  };

  const captured = (): ErrorBody => {
    if (!sentBody) throw new Error('filter did not send a response body');
    return sentBody;
  };

  beforeEach(() => {
    filter = new AllExceptionsFilter();
    sentStatus = undefined;
    sentBody = undefined;

    host = {
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => ({ method: 'POST', url: '/v1/solves' }),
      }),
    } as unknown as ArgumentsHost;

    // The filter logs every error it handles; that is the point of it, but it
    // is not what this suite is asserting on.
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('maps 404 to not_found', () => {
    filter.catch(new NotFoundException('No such solve'), host);

    expect(sentStatus).toBe(HttpStatus.NOT_FOUND);
    expect(captured()).toEqual({
      error: { code: ErrorCode.NOT_FOUND, message: 'No such solve' },
    });
  });

  it('maps 409 to conflict', () => {
    filter.catch(new ConflictException('Already synced'), host);

    expect(sentStatus).toBe(HttpStatus.CONFLICT);
    expect(captured().error.code).toBe(ErrorCode.CONFLICT);
  });

  it("folds ValidationPipe's message array into details.fields", () => {
    // This is the shape Nest's ValidationPipe actually throws.
    filter.catch(
      new BadRequestException({
        statusCode: 400,
        message: ['event must be a string', 'time_ms must be a positive number'],
        error: 'Bad Request',
      }),
      host,
    );

    expect(sentStatus).toBe(HttpStatus.BAD_REQUEST);
    expect(captured()).toEqual({
      error: {
        code: ErrorCode.VALIDATION_FAILED,
        message: 'Request validation failed',
        details: { fields: ['event must be a string', 'time_ms must be a positive number'] },
      },
    });
  });

  it('honours a domain-specific code when one is thrown', () => {
    filter.catch(
      new HttpException(
        { code: ErrorCode.EVENT_NOT_RACEABLE, message: '3x3-mbld cannot be raced' },
        HttpStatus.UNPROCESSABLE_ENTITY,
      ),
      host,
    );

    expect(captured().error.code).toBe(ErrorCode.EVENT_NOT_RACEABLE);
    expect(captured().error.message).toBe('3x3-mbld cannot be raced');
  });

  it('never leaks internals from an unexpected throw', () => {
    filter.catch(new Error('connect ECONNREFUSED 10.0.0.4:5432'), host);

    expect(sentStatus).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(captured()).toEqual({
      error: { code: ErrorCode.INTERNAL, message: 'An unexpected error occurred' },
    });
    expect(JSON.stringify(captured())).not.toContain('ECONNREFUSED');
  });
});
