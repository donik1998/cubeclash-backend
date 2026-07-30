import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
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
        error: () => this.log(request, 500, startedAt),
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
