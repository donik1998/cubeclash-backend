import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

import { ErrorBody, ErrorCode } from '../errors/error-codes';

const STATUS_TO_CODE: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: ErrorCode.VALIDATION_FAILED,
  [HttpStatus.UNAUTHORIZED]: ErrorCode.UNAUTHORIZED,
  [HttpStatus.FORBIDDEN]: ErrorCode.FORBIDDEN,
  [HttpStatus.NOT_FOUND]: ErrorCode.NOT_FOUND,
  [HttpStatus.CONFLICT]: ErrorCode.CONFLICT,
  [HttpStatus.UNPROCESSABLE_ENTITY]: ErrorCode.VALIDATION_FAILED,
  [HttpStatus.TOO_MANY_REQUESTS]: ErrorCode.RATE_LIMITED,
};

/**
 * Every error leaves this server in one shape:
 *
 * ```json
 * { "error": { "code": "…", "message": "…", "details": {} } }
 * ```
 *
 * The Flutter client already parses exactly this (see API Design § Errors), so
 * the filter is a contract, not a convenience. An unrecognised throw becomes a
 * 500 with a generic message — internals never reach the wire — but is logged
 * in full with its stack.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const { status, body } = this.toErrorBody(exception);

    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} → ${status}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.warn(`${request.method} ${request.url} → ${status} ${body.error.code}`);
    }

    response.status(status).json(body);
  }

  private toErrorBody(exception: unknown): { status: number; body: ErrorBody } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();

      // Nest's ValidationPipe throws with `{ message: string[] }`; everything
      // else throws a string or an object. Normalise all three.
      if (typeof payload === 'string') {
        return {
          status,
          body: { error: { code: STATUS_TO_CODE[status] ?? ErrorCode.INTERNAL, message: payload } },
        };
      }

      const record = payload as Record<string, unknown>;
      const rawMessage = record.message;
      const isFieldList = Array.isArray(rawMessage);

      return {
        status,
        body: {
          error: {
            code:
              typeof record.code === 'string'
                ? record.code
                : (STATUS_TO_CODE[status] ?? ErrorCode.INTERNAL),
            message: isFieldList
              ? 'Request validation failed'
              : typeof rawMessage === 'string'
                ? rawMessage
                : exception.message,
            ...(isFieldList
              ? { details: { fields: rawMessage as string[] } }
              : typeof record.details === 'object' && record.details !== null
                ? { details: record.details as Record<string, unknown> }
                : {}),
          },
        },
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        error: {
          code: ErrorCode.INTERNAL,
          message: 'An unexpected error occurred',
        },
      },
    };
  }
}
