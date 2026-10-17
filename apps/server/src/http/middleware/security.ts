import helmet from 'helmet';
import type { RequestHandler } from 'express';
import { AppError } from '../errors.js';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function isMutation(method: string): boolean {
  return MUTATING_METHODS.has(method.toUpperCase());
}

/**
 * Strict security headers (Section 23): scripts/styles only from our own build, no unsafe-eval,
 * browser connections same-origin only, no framing.
 */
export function securityHeaders(options: { hsts: boolean }): RequestHandler {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        manifestSrc: ["'self'"],
        workerSrc: ["'self'"],
        ...(options.hsts ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    strictTransportSecurity: options.hsts ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
  });
}

/**
 * Origin check for every browser mutation (Section 22): the Origin header must be present and
 * equal APP_ORIGIN exactly. The CSRF synchronizer token is added with sessions in Phase 2;
 * this guard is the first layer and never replaces it.
 */
export function requireSameOrigin(appOrigin: string): RequestHandler {
  return (req, _res, next) => {
    if (!isMutation(req.method)) return next();
    const origin = req.get('origin');
    if (!origin || origin !== appOrigin) {
      return next(new AppError('CSRF_INVALID', 'The request origin is not allowed.'));
    }
    next();
  };
}

/** A route allowed to receive one specific non-JSON body type (never multipart). */
export interface RawBodyRoute {
  method: string;
  /** Full path, e.g. /api/v1/candidate/resume. */
  path: string;
  contentType: string;
}

function pathOnly(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

/**
 * JSON only (Sections 17 and 23). Any request that carries a body must declare
 * application/json; multipart is always rejected. The Phase 4 amendment adds exactly one
 * exception — the resume upload, which takes a raw application/pdf body on its own route.
 */
export function createJsonBodyGuard(rawRoutes: readonly RawBodyRoute[] = []): RequestHandler {
  return (req, _res, next) => {
    const contentType = (req.get('content-type') ?? '').toLowerCase();
    if (contentType.startsWith('multipart/')) {
      return next(new AppError('BAD_REQUEST', 'File uploads are not supported.'));
    }
    const length = req.get('content-length');
    const hasBody =
      (length !== undefined && length !== '0') || req.get('transfer-encoding') !== undefined;
    if (!hasBody || /^application\/json(\s*;|$)/.test(contentType)) return next();
    const path = pathOnly(req.originalUrl);
    const raw = rawRoutes.find((r) => r.method === req.method && r.path === path);
    if (raw && contentType.split(';')[0]!.trim() === raw.contentType) return next();
    if (raw) return next(); // the route itself answers with a specific validation message
    next(new AppError('BAD_REQUEST', 'Request bodies must be JSON (application/json).'));
  };
}

export const requireJsonBody: RequestHandler = createJsonBodyGuard();
