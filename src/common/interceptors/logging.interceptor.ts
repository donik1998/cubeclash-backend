import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';

/**
 * One structured line per request. Deliberately does not log bodies: solves are
 * uninteresting and auth payloads are secrets.
 *
 * The authoritative product events (`race_completed`, `is_pb`) are a separate
 * concern and fire from the domain services, not from here — see
 * Observability & Analytics.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const startedAt = process.hrtime.bigint();

    return next.handle().pipe(
      tap({
        next: () => this.log(request, http.getResponse<Response>().statusCode, startedAt),
        // Take the status from the exception, not a hardcoded 500. This runs
        // *before* AllExceptionsFilter maps the error onto the response, so
        // `response.statusCode` is still the default here and the exception is
        // the only thing that knows the real answer. Logging every handled
        // error as a 500 buried genuine server faults under ordinary 400s and
        // 401s — which is exactly what an access log exists to tell apart.
        error: (error: unknown) => this.log(request, statusOf(error), startedAt),
      }),
    );
  }

  private log(request: Request, statusCode: number, startedAt: bigint): void {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    this.logger.log(
      `${request.method} ${request.originalUrl} ${statusCode} ${durationMs.toFixed(1)}ms`,
    );
  }
}

/**
 * The HTTP status an error will actually produce. Anything that is not an
 * `HttpException` genuinely is a 500 — it escaped the domain unhandled.
 */
function statusOf(error: unknown): number {
  return error instanceof HttpException ? error.getStatus() : 500;
}
