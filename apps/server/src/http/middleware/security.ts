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
        // Stylesheets from our build; <style> elements only with this response's nonce (the
        // lazily loaded code editor creates them at runtime). No 'unsafe-inline'.
        styleSrc: [
          "'self'",
          (_req, res) =>
            `'nonce-${String((res as { locals?: { cspNonce?: string } }).locals?.cspNonce ?? 'none')}'`,
        ],
        // Inline style ATTRIBUTES only (never <style> elements or scripts): the Monaco code
        // editor positions its view lines with style attributes in generated markup. React
        // escapes all user and model text, so this opens no markup-injection path.
        styleSrcAttr: ["'unsafe-inline'"],
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
  /** Full path, e.g. /api/v1/candidate/resume, or an anchored pattern for routes with ids. */
  path: string | RegExp;
  /** One exact type, or a list of accepted base types. */
  contentType: string | readonly string[];
}

function pathOnly(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

/**
 * JSON only (Sections 17 and 23). Any request that carries a body must declare
 * application/json; multipart is always rejected. Exceptions, each on its own route: the resume
 * upload (raw application/pdf, Phase 4) and an interview answer recording (raw audio, Phase 8).
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
    const raw = rawRoutes.find(
      (r) =>
        r.method === req.method &&
        (typeof r.path === 'string' ? r.path === path : r.path.test(path)),
    );
    const base = contentType.split(';')[0]!.trim();
    if (
      raw &&
      (typeof raw.contentType === 'string'
        ? base === raw.contentType
        : raw.contentType.includes(base))
    ) {
      return next();
    }
    if (raw) return next(); // the route itself answers with a specific validation message
    next(new AppError('BAD_REQUEST', 'Request bodies must be JSON (application/json).'));
  };
}

export const requireJsonBody: RequestHandler = createJsonBodyGuard();
