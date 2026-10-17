import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import type { FieldErrors } from '@cofoundry/shared';
import { AppError } from './errors.js';

/**
 * Route-boundary validation (Sections 17 and 23). Schemas should be strict objects so that
 * unknown fields are rejected, never silently dropped. Failures become
 * 422 VALIDATION_FAILED with per-field messages.
 */

export interface RouteSchemas<B, Q, P> {
  body?: z.ZodType<B>;
  query?: z.ZodType<Q>;
  params?: z.ZodType<P>;
}

export interface Validated<B, Q, P> {
  body: B;
  query: Q;
  params: P;
}

export function zodIssuesToFieldErrors(issues: z.core.$ZodIssue[], prefix?: string): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        const p = [prefix, ...issue.path.map(String), key].filter(Boolean).join('.');
        (out[p] ??= []).push('Unknown field.');
      }
      continue;
    }
    const p = [prefix, ...issue.path.map(String)].filter(Boolean).join('.') || prefix || '_';
    (out[p] ??= []).push(issue.message);
  }
  return out;
}

function parsePart<T>(
  schema: z.ZodType<T> | undefined,
  value: unknown,
  prefix: string,
  errors: FieldErrors,
): T {
  if (!schema) return undefined as T;
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  Object.assign(errors, zodIssuesToFieldErrors(result.error.issues, prefix));
  return undefined as T;
}

/**
 * Wraps a handler so it only runs with validated, typed input.
 * Express 5 forwards rejected promises to the error handler automatically.
 */
export function withValidation<B = undefined, Q = undefined, P = undefined>(
  schemas: RouteSchemas<B, Q, P>,
  handler: (
    input: Validated<B, Q, P>,
    req: Request,
    res: Response,
    next: NextFunction,
  ) => unknown | Promise<unknown>,
): RequestHandler {
  return async (req, res, next) => {
    const fieldErrors: FieldErrors = {};
    const body = parsePart(schemas.body, req.body ?? {}, 'body', fieldErrors);
    const query = parsePart(schemas.query, req.query, 'query', fieldErrors);
    const params = parsePart(schemas.params, req.params, 'params', fieldErrors);
    if (Object.keys(fieldErrors).length > 0) {
      throw new AppError('VALIDATION_FAILED', 'Some fields are invalid.', { fieldErrors });
    }
    await handler({ body, query, params }, req, res, next);
  };
}

/** MongoDB ObjectId rendered as a 24-character lowercase hex string (Section 03). */
export const objectIdString = z.string().regex(/^[a-f0-9]{24}$/, 'Must be a valid identifier.');

/** Idempotency-Key header value (Section 17): a UUID. */
export const idempotencyKey = z.uuid('Idempotency-Key must be a UUID.');
