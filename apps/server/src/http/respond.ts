import type { Response } from 'express';
import type { ApiErrorBody, ApiList, ApiSuccess, ErrorCode, FieldErrors } from '@cofoundry/shared';

export function requestIdOf(res: Response): string {
  return (res.locals.requestId as string | undefined) ?? 'unknown';
}

export function sendData<T>(res: Response, data: T, status = 200): void {
  const body: ApiSuccess<T> = { data, requestId: requestIdOf(res) };
  res.status(status).json(body);
}

export function sendList<T>(res: Response, data: T[], nextCursor: string | null): void {
  const body: ApiList<T> = { data, nextCursor, requestId: requestIdOf(res) };
  res.status(200).json(body);
}

export function sendError(
  res: Response,
  status: number,
  code: ErrorCode,
  message: string,
  fieldErrors?: FieldErrors,
): void {
  const body: ApiErrorBody = {
    error: fieldErrors ? { code, message, fieldErrors } : { code, message },
    requestId: requestIdOf(res),
  };
  res.status(status).json(body);
}
