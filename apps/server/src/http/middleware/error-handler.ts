import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError } from '../errors.js';
import { sendError } from '../respond.js';

interface BodyParserError {
  type?: string;
  status?: number;
}

function fromBodyParser(err: unknown): AppError | null {
  if (typeof err !== 'object' || err === null) return null;
  const { type } = err as BodyParserError;
  switch (type) {
    case 'entity.too.large':
      return new AppError('BODY_TOO_LARGE', 'The request body is too large.');
    case 'entity.parse.failed':
      return new AppError('BAD_REQUEST', 'The request body is not valid JSON.');
    case 'charset.unsupported':
    case 'encoding.unsupported':
    case 'request.aborted':
    case 'request.size.invalid':
      return new AppError('BAD_REQUEST', 'The request body could not be read.');
    default:
      return null;
  }
}

/** 404 for any unmatched /api route, in the standard envelope. */
export const apiNotFound: RequestHandler = (_req, _res, next) => {
  next(new AppError('NOT_FOUND', 'The requested resource was not found.'));
};

/**
 * Final error handler: stable codes, standard envelope, no stack traces or upstream secrets
 * (Section 17). Unexpected errors are logged server-side with the requestId for correlation.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err);

  const appError = err instanceof AppError ? err : fromBodyParser(err);
  if (appError) {
    if (appError.headers) {
      for (const [name, value] of Object.entries(appError.headers)) res.setHeader(name, value);
    }
    if (appError.status >= 500) {
      req.log?.error({ err: appError, code: appError.code }, 'request failed');
    }
    sendError(res, appError.status, appError.code, appError.message, appError.fieldErrors);
    return;
  }

  req.log?.error({ err }, 'unhandled error');
  sendError(res, 500, 'INTERNAL_ERROR', 'Something went wrong on our side. Try again.');
};
