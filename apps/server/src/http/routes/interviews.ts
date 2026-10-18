import express, { Router, type RequestHandler } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import {
  API_PREFIX,
  CODE_LANGUAGES,
  INTERVIEW_CLIENT_HEADER,
  INTERVIEW_CONSENT_ITEMS,
  INTERVIEW_CONSENT_POLICY_VERSION,
  INTERVIEW_LIMITS as L,
  INTERVIEW_STATUSES,
  VERSIONS,
  isSupportedAudioType,
} from '@cofoundry/shared';
import type { IdempotencyStore } from '../../briefs/store.js';
import type { InterviewService } from '../../interviews/service.js';
import { AppError } from '../errors.js';
import { runIdempotent } from '../idempotency.js';
import { currentUser, requireRole } from '../middleware/auth.js';
import { createRateLimiter } from '../middleware/rate-limit.js';
import { pageQuery } from '../pagination.js';
import { sendData, sendList } from '../respond.js';
import { objectIdString, withValidation } from '../validation.js';

/** POST /interviews/:id/turns/:n/audio is the only interview route with a raw (audio) body. */
export const INTERVIEW_AUDIO_PATH_PATTERN = new RegExp(
  `^${API_PREFIX.replace(/\//g, '\\/')}\\/interviews\\/[a-f0-9]{24}\\/turns\\/\\d{1,2}\\/audio$`,
);

export interface InterviewLimiters {
  audio: RequestHandler;
  speech: RequestHandler;
  answer: RequestHandler;
  codeRun: RequestHandler;
  codeDraft: RequestHandler;
}

const perUser = (name: string, limit: number): RequestHandler =>
  createRateLimiter({
    windowMs: 60_000,
    limit,
    keyGenerator: (req) => `${name}:${req.auth?.user?.id ?? 'anonymous'}`,
  });

export function defaultInterviewLimiters(): InterviewLimiters {
  return {
    audio: perUser('interview-audio', 15),
    speech: perUser('interview-speech', 40),
    answer: perUser('interview-answer', 30),
    codeRun: perUser('code-run', 6),
    codeDraft: perUser('code-draft', 30),
  };
}

const idParams = z.strictObject({ id: z.string() });
const turnParams = z.strictObject({
  id: z.string(),
  n: z.string().regex(/^\d{1,2}$/, 'Invalid turn.'),
});
const emptyBody = z.strictObject({});
const noQuery = z.strictObject({});
const text = (max: number) => z.string().max(max, `At most ${max} characters.`);

const createBody = z.strictObject({
  briefId: objectIdString,
  candidateUserId: objectIdString,
  batchId: objectIdString,
});
const listQuery = z.strictObject({
  role: z.enum(['founder', 'candidate']),
  briefId: objectIdString.optional(),
  status: z.enum(INTERVIEW_STATUSES).optional(),
  ...pageQuery,
});
const briefAccessBody = z.strictObject({
  confidentialityAcknowledged: z.literal(true, 'Acknowledge the confidentiality notice.'),
  noticeVersion: z.literal(VERSIONS.confidentialityNotice, 'Outdated notice.'),
});
const acceptBody = z.strictObject({
  briefVersion: z.number().int().min(1),
  profileRevision: z.number().int().min(0),
  consent: z.strictObject({
    policyVersion: z.literal(INTERVIEW_CONSENT_POLICY_VERSION, 'Outdated consent notice.'),
    items: z.strictObject(
      Object.fromEntries(INTERVIEW_CONSENT_ITEMS.map((i) => [i, z.boolean()])) as Record<
        (typeof INTERVIEW_CONSENT_ITEMS)[number],
        z.ZodBoolean
      >,
    ),
  }),
});
const declineBody = z.strictObject({ reason: text(L.reasonMaxChars).optional() });
const cancelBody = z.strictObject({ reason: text(L.reasonMaxChars).min(1, 'Give a reason.') });
const answerBody = z.strictObject({
  text: text(L.answerMaxChars),
  inputMode: z.enum(['voice', 'typed']),
  skip: z.boolean().optional(),
});
const finishBody = z.strictObject({ confirm: z.literal(true, 'Confirm to finish.') });
const codeBody = z.strictObject({
  language: z.enum(CODE_LANGUAGES),
  code: text(L.codeMaxChars),
});
const codeDraftBody = z.strictObject({
  language: z.enum(CODE_LANGUAGES),
  code: text(L.codeMaxChars),
  explanation: text(L.explanationMaxChars).optional(),
});
const submitCodeBody = z.strictObject({
  language: z.enum(CODE_LANGUAGES),
  code: text(L.codeMaxChars),
  explanation: text(L.explanationMaxChars),
  confirm: z.literal(true, 'Confirm to submit.'),
});

const notFound = () => new AppError('NOT_FOUND', 'The requested resource was not found.');
const validId = (raw: string) => {
  if (!objectIdString.safeParse(raw).success) throw notFound();
  return raw;
};
const clientIdOf = (req: express.Request): string | null => {
  const v = req.get(INTERVIEW_CLIENT_HEADER);
  return v && /^[0-9a-f-]{36}$/i.test(v) ? v.toLowerCase() : null;
};
const requireClientId = (req: express.Request): string => {
  const id = clientIdOf(req);
  if (!id) throw new AppError('BAD_REQUEST', `Send an ${INTERVIEW_CLIENT_HEADER} header (a UUID).`);
  return id;
};

function encodeInterviewCursor(next: { invitedAt: Date; id: string } | null): string | null {
  return next
    ? Buffer.from(JSON.stringify([next.invitedAt.toISOString(), next.id])).toString('base64url')
    : null;
}
function decodeInterviewCursor(cursor: string | undefined): { invitedAt: Date; id: string } | null {
  if (!cursor) return null;
  try {
    const [at, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as [
      string,
      string,
    ];
    const d = new Date(at);
    if (typeof id === 'string' && /^[a-f0-9]{24}$/.test(id) && !Number.isNaN(d.getTime()))
      return { invitedAt: d, id };
  } catch {
    // fall through
  }
  throw new AppError('VALIDATION_FAILED', 'Some fields are invalid.', {
    fieldErrors: { 'query.cursor': ['Invalid cursor.'] },
  });
}

const requireAudioType: RequestHandler = (req, _res, next) => {
  if (!isSupportedAudioType(req.get('content-type'))) {
    return next(
      new AppError(
        'VALIDATION_FAILED',
        'Upload the recording as audio (webm, ogg, wav, mp4 or mpeg).',
        { fieldErrors: { audio: ['Unsupported audio format.'] } },
      ),
    );
  }
  next();
};

function sendWav(res: express.Response, wav: Buffer): void {
  res.setHeader('Content-Type', 'audio/wav');
  res.setHeader('Content-Length', String(wav.length));
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  res.status(200).end(wav);
}

/**
 * Interview routes (Phases 7-10). Founders create invitations; candidates accept, prepare, take
 * the interview and submit; both read the report. Every route checks participation in the
 * service (404 for anyone else); browsers never call AI, speech or execution services directly.
 */
export function createInterviewRouter(
  interviews: InterviewService,
  idempotency: IdempotencyStore,
  overrides: Partial<InterviewLimiters> = {},
): Router {
  const router = Router();
  const limit = { ...defaultInterviewLimiters(), ...overrides };
  const candidate = requireRole('candidate');
  const participant = requireRole('founder', 'candidate');

  router.post(
    '/interviews',
    requireRole('founder'),
    withValidation({ body: createBody }, async ({ body }, req, res) => {
      const user = currentUser(req);
      const outcome = await runIdempotent({
        store: idempotency,
        req,
        actor: user,
        route: 'POST /interviews',
        body,
        resourceId: new mongoose.Types.ObjectId().toHexString(),
        execute: async (id) => ({ status: 201, data: await interviews.create(user, body, id) }),
        replay: (id) => interviews.get(user, id, null),
      });
      sendData(res, outcome.data, outcome.status);
    }),
  );

  router.get(
    '/interviews',
    participant,
    withValidation({ query: listQuery }, async ({ query }, req, res) => {
      const user = currentUser(req);
      if (!user.roles.includes(query.role))
        throw new AppError('FORBIDDEN', 'You do not have this role.');
      const page = await interviews.list(user, query.role, {
        ...(query.briefId ? { briefId: query.briefId } : {}),
        ...(query.status ? { status: query.status } : {}),
        after: decodeInterviewCursor(query.cursor),
        limit: query.limit ?? 20,
      });
      sendList(res, page.items, encodeInterviewCursor(page.next));
    }),
  );

  router.get(
    '/interviews/:id',
    participant,
    withValidation({ params: idParams, query: noQuery }, async ({ params }, req, res) => {
      sendData(res, await interviews.get(currentUser(req), validId(params.id), clientIdOf(req)));
    }),
  );

  const post = <B>(
    path: string,
    schema: z.ZodType<B>,
    run: (
      user: ReturnType<typeof currentUser>,
      id: string,
      body: B,
      req: express.Request,
    ) => Promise<unknown>,
    ...guards: RequestHandler[]
  ) =>
    router.post(
      `/interviews/:id${path}`,
      ...guards,
      withValidation({ params: idParams, body: schema }, async ({ params, body }, req, res) => {
        sendData(res, await run(currentUser(req), validId(params.id), body, req));
      }),
    );

  post('/brief-access', briefAccessBody, (u, id) => interviews.acknowledgeBrief(u, id), candidate);
  post('/accept', acceptBody, (u, id, b) => interviews.accept(u, id, b), candidate);
  post('/decline', declineBody, (u, id, b) => interviews.decline(u, id, b.reason ?? ''), candidate);
  post('/cancel', cancelBody, (u, id, b) => interviews.cancel(u, id, b.reason), participant);
  post('/consent/withdraw', emptyBody, (u, id) => interviews.withdrawConsent(u, id), candidate);
  post('/prepare', emptyBody, (u, id) => interviews.prepare(u, id), candidate);
  post(
    '/start',
    emptyBody,
    (u, id, _b, req) => interviews.start(u, id, requireClientId(req)),
    candidate,
  );
  post(
    '/attach',
    emptyBody,
    (u, id, _b, req) => interviews.attach(u, id, requireClientId(req)),
    candidate,
  );
  post(
    '/heartbeat',
    emptyBody,
    (u, id, _b, req) => interviews.heartbeat(u, id, requireClientId(req)),
    candidate,
  );
  post(
    '/next-question',
    emptyBody,
    (u, id, _b, req) => interviews.retryGeneration(u, id, clientIdOf(req)),
    candidate,
  );
  post(
    '/conversation/finish',
    finishBody,
    (u, id, _b, req) => interviews.finishConversation(u, id, clientIdOf(req)),
    candidate,
  );
  post(
    '/coding/run',
    codeBody,
    (u, id, b, req) => interviews.runCode(u, id, clientIdOf(req), b.language, b.code),
    candidate,
    limit.codeRun,
  );
  post(
    '/coding/submit',
    submitCodeBody,
    (u, id, b, req) => interviews.submitCode(u, id, clientIdOf(req), b),
    candidate,
  );
  post('/evaluation/retry', emptyBody, (u, id) => interviews.retryEvaluation(u, id), participant);

  router.put(
    '/interviews/:id/coding/draft',
    candidate,
    limit.codeDraft,
    withValidation(
      { params: idParams, body: codeDraftBody },
      async ({ params, body }, req, res) => {
        sendData(
          res,
          await interviews.saveCode(
            currentUser(req),
            validId(params.id),
            clientIdOf(req),
            body.language,
            body.code,
            body.explanation,
          ),
        );
      },
    ),
  );

  router.post(
    '/interviews/:id/turns/:n/answer',
    candidate,
    limit.answer,
    withValidation({ params: turnParams, body: answerBody }, async ({ params, body }, req, res) => {
      sendData(
        res,
        await interviews.submitAnswer(
          currentUser(req),
          validId(params.id),
          Number(params.n),
          clientIdOf(req),
          body,
        ),
      );
    }),
  );

  router.post(
    '/interviews/:id/turns/:n/audio',
    candidate,
    limit.audio,
    requireAudioType,
    express.raw({ type: () => true, limit: L.audioMaxBytes }),
    withValidation({ params: turnParams }, async ({ params }, req, res) => {
      const body: unknown = req.body;
      const audio = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
      sendData(
        res,
        await interviews.transcribe(
          currentUser(req),
          validId(params.id),
          Number(params.n),
          clientIdOf(req),
          audio,
          req.get('content-type') ?? '',
        ),
      );
    }),
  );

  router.get(
    '/interviews/:id/turns/:n/speech',
    candidate,
    limit.speech,
    withValidation({ params: turnParams, query: noQuery }, async ({ params }, req, res) => {
      sendWav(res, await interviews.speech(currentUser(req), validId(params.id), Number(params.n)));
    }),
  );

  router.get(
    '/interviews/:id/voice-test',
    candidate,
    limit.speech,
    withValidation({ params: idParams, query: noQuery }, async ({ params }, req, res) => {
      sendWav(res, await interviews.speech(currentUser(req), validId(params.id), 'voice-test'));
    }),
  );

  router.get(
    '/interviews/:id/report',
    participant,
    withValidation({ params: idParams, query: noQuery }, async ({ params }, req, res) => {
      sendData(res, await interviews.report(currentUser(req), validId(params.id)));
    }),
  );

  return router;
}
