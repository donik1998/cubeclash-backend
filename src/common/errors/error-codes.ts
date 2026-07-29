/**
 * The `code` half of the documented error envelope.
 *
 * Machine-readable and stable: clients branch on these, and renaming one is a
 * breaking change. The human `message` beside it is free to change.
 */
export const ErrorCode = {
  VALIDATION_FAILED: 'validation_failed',
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  CONFLICT: 'conflict',
  RATE_LIMITED: 'rate_limited',
  UNKNOWN_EVENT: 'unknown_event',
  EVENT_NOT_RACEABLE: 'event_not_raceable',
  NOT_IMPLEMENTED: 'not_implemented',
  INTERNAL: 'internal_error',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}
