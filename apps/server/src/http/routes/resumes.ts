import express, { Router, type RequestHandler } from 'express';
import {
  RESUME_CONSENT_HEADER,
  RESUME_CONTENT_TYPE,
  RESUME_EXPECTED_VERSION_HEADER,
  RESUME_FILENAME_HEADER,
  RESUME_LIMITS,
} from '@cofoundry/shared';
import type { ResumeService } from '../../resumes/service.js';
import { AppError } from '../errors.js';
import { currentUser, requireRole } from '../middleware/auth.js';
import { createRateLimiter } from '../middleware/rate-limit.js';
import { sendData } from '../respond.js';

export const RESUME_UPLOAD_PATH = '/candidate/resume';

/** Rejects anything but a raw application/pdf body before a single byte is read. */
const requirePdfContentType: RequestHandler = (req, _res, next) => {
  const type = (req.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== RESUME_CONTENT_TYPE) {
    return next(
      new AppError('VALIDATION_FAILED', 'Upload a PDF file.', {
        fieldErrors: { file: ['Upload a PDF file.'] },
      }),
    );
  }
  next();
};

/** Uploads/replacements per candidate (Phase 4 amendment). */
export function resumeUploadLimiter(): RequestHandler {
  return createRateLimiter({
    windowMs: 60 * 60_000,
    limit: RESUME_LIMITS.uploadsPerHour,
    keyGenerator: (req) => `resume:${req.auth?.user?.id ?? 'anonymous'}`,
  });
}

function decodeFilename(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    return decodeURIComponent(raw).slice(0, 512);
  } catch {
    return null;
  }
}

function expectedVersion(raw: string | undefined): number {
  if (raw === undefined || !/^\d{1,9}$/.test(raw)) {
    throw new AppError('VALIDATION_FAILED', 'Some fields are invalid.', {
      fieldErrors: {
        [`headers.${RESUME_EXPECTED_VERSION_HEADER}`]: ['Send the current resume version.'],
      },
    });
  }
  return Number(raw);
}

/** RFC 6266 Content-Disposition with an ASCII fallback and a UTF-8 name. */
function attachment(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * Candidate-only resume routes. The upload is the ONLY route that accepts a non-JSON body: a raw
 * application/pdf request (never multipart), capped at RESUME_LIMITS.maxBytes, after session,
 * Origin and CSRF checks have already passed.
 */
export function createResumeRouter(
  resumes: ResumeService,
  uploadLimiter: RequestHandler = resumeUploadLimiter(),
): Router {
  const router = Router();
  const candidate = requireRole('candidate');

  router.get(RESUME_UPLOAD_PATH, candidate, async (req, res) => {
    sendData(res, await resumes.get(currentUser(req)));
  });

  router.put(
    RESUME_UPLOAD_PATH,
    candidate,
    uploadLimiter,
    requirePdfContentType,
    express.raw({ type: RESUME_CONTENT_TYPE, limit: RESUME_LIMITS.maxBytes }),
    async (req, res) => {
      const bytes: unknown = req.body;
      const data = await resumes.upload(currentUser(req), {
        bytes: Buffer.isBuffer(bytes) ? new Uint8Array(bytes) : new Uint8Array(),
        filename: decodeFilename(req.get(RESUME_FILENAME_HEADER)),
        consentVersion: req.get(RESUME_CONSENT_HEADER) ?? null,
        expectedVersion: expectedVersion(req.get(RESUME_EXPECTED_VERSION_HEADER)),
      });
      sendData(res, data);
    },
  );

  router.delete(RESUME_UPLOAD_PATH, candidate, async (req, res) => {
    await resumes.remove(currentUser(req));
    res.status(204).end();
  });

  router.get(`${RESUME_UPLOAD_PATH}/file`, candidate, async (req, res) => {
    const { bytes, filename } = await resumes.file(currentUser(req));
    res.setHeader('Content-Type', RESUME_CONTENT_TYPE);
    res.setHeader('Content-Disposition', attachment(filename));
    res.setHeader('Content-Length', String(bytes.length));
    // Never rendered inline by this origin; downloaded as a file.
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    res.status(200).end(bytes);
  });

  router.get(`${RESUME_UPLOAD_PATH}/text`, candidate, async (req, res) => {
    sendData(res, await resumes.text(currentUser(req)));
  });

  return router;
}
