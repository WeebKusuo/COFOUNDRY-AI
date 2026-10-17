/**
 * API envelope contract (Section 17). Every response carries a requestId.
 */

export const ERROR_CODES = [
  'BAD_REQUEST',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'CSRF_INVALID',
  'NOT_FOUND',
  'INVALID_STATE',
  'VERSION_CONFLICT',
  'STALE_RECOMMENDATION',
  'DUPLICATE_PAIR',
  'GATE_CHANGED',
  'EXPIRED',
  'QUESTION_CLOSED',
  'IDEMPOTENCY_CONFLICT',
  'BODY_TOO_LARGE',
  'VALIDATION_FAILED',
  'NO_SKILL_GAP',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
  'UPSTREAM_FAILED',
  'SERVICE_UNAVAILABLE',
  'CAPACITY_LIMIT',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Canonical HTTP status for each stable error code. */
export const ERROR_STATUS: Readonly<Record<ErrorCode, number>> = Object.freeze({
  BAD_REQUEST: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  CSRF_INVALID: 403,
  NOT_FOUND: 404,
  INVALID_STATE: 409,
  VERSION_CONFLICT: 409,
  STALE_RECOMMENDATION: 409,
  DUPLICATE_PAIR: 409,
  GATE_CHANGED: 409,
  EXPIRED: 409,
  QUESTION_CLOSED: 409,
  IDEMPOTENCY_CONFLICT: 409,
  BODY_TOO_LARGE: 413,
  VALIDATION_FAILED: 422,
  NO_SKILL_GAP: 422,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  UPSTREAM_FAILED: 502,
  SERVICE_UNAVAILABLE: 503,
  CAPACITY_LIMIT: 503,
});

/** Field path (dot notation) -> human-readable messages. */
export type FieldErrors = Record<string, string[]>;

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    fieldErrors?: FieldErrors;
  };
  requestId: string;
}

export interface ApiSuccess<T> {
  data: T;
  requestId: string;
}

export interface ApiList<T> {
  data: T[];
  nextCursor: string | null;
  requestId: string;
}

/** GET /api/v1/health — liveness only, no internals (Section 18). */
export interface HealthData {
  status: 'ok';
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

export function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null) return false;
  const err = (value as { error?: unknown }).error;
  if (typeof err !== 'object' || err === null) return false;
  const { code, message } = err as { code?: unknown; message?: unknown };
  return isErrorCode(code) && typeof message === 'string';
}
