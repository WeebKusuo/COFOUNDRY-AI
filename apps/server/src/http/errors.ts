import { ERROR_STATUS, type ErrorCode, type FieldErrors } from '@cofoundry/shared';

/**
 * The only error type route code should throw for expected failures. Anything else reaching the
 * error handler becomes a generic 500 INTERNAL_ERROR with no internals exposed.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly fieldErrors: FieldErrors | undefined;
  readonly headers: Record<string, string> | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: { fieldErrors?: FieldErrors; headers?: Record<string, string>; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.fieldErrors = options.fieldErrors;
    this.headers = options.headers;
  }
}

export const errors = {
  badRequest: (message = 'The request could not be processed.') =>
    new AppError('BAD_REQUEST', message),
  notFound: (message = 'The requested resource was not found.') =>
    new AppError('NOT_FOUND', message),
  forbidden: (message = 'You are not allowed to perform this action.') =>
    new AppError('FORBIDDEN', message),
  unauthenticated: (message = 'Sign in to continue.') => new AppError('UNAUTHENTICATED', message),
  validation: (fieldErrors: FieldErrors, message = 'Some fields are invalid.') =>
    new AppError('VALIDATION_FAILED', message, { fieldErrors }),
  serviceUnavailable: (message = 'This service is temporarily unavailable.') =>
    new AppError('SERVICE_UNAVAILABLE', message),
};
