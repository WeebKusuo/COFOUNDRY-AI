import { Router, type Request, type Response } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import {
  BRIEF_LIMITS,
  COLLABORATION_LIMITS as CL,
  CRITERION_OUTCOMES,
  CURRENCY,
  MATCH_REQUEST_STATUSES,
  MATCH_STATUSES,
  SPRINT_LIMITS as SL,
} from '@cofoundry/shared';
import type { IdempotencyStore } from '../../briefs/store.js';
import type { CollaborationService } from '../../collaboration/requests.js';
import type { SprintService } from '../../collaboration/sprints.js';
import { AppError } from '../errors.js';
import { runIdempotent } from '../idempotency.js';
import { currentUser, requireRole } from '../middleware/auth.js';
import { pageQuery, encodeCursor, pageRequest } from '../pagination.js';
import { requestIdOf, sendData, sendList } from '../respond.js';
import { objectIdString, withValidation } from '../validation.js';

/**
 * Collaboration routes (Phases 11-13; Contract Section 20). POST creates and transitions take
 * an Idempotency-Key; participation is checked in the services (404 for anyone else, 403 for a
 * participant whose role may not perform the action).
 */

const idParams = z.strictObject({ id: z.string() });
const text = (max: number) => z.string().max(max, `At most ${max} characters.`);
const required = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min, min === 1 ? 'Required.' : `At least ${min} characters.`)
    .max(max, `At most ${max} characters.`);

const reasonBody = z.strictObject({ reason: text(CL.reasonMax).optional() });
const requiredReason = z.strictObject({ reason: required(1, CL.reasonMax) });
const emptyBody = z.strictObject({});

const createRequestBody = z.strictObject({
  briefId: objectIdString,
  interviewId: objectIdString,
  candidateUserId: objectIdString,
  message: text(CL.requestMessageMax),
});

const requestListQuery = z.strictObject({
  box: z.enum(['inbox', 'sent']),
  status: z.enum(MATCH_REQUEST_STATUSES).optional(),
  interviewId: objectIdString.optional(),
  ...pageQuery,
});
const matchListQuery = z.strictObject({
  role: z.enum(['founder', 'candidate']),
  status: z.enum(MATCH_STATUSES).optional(),
  ...pageQuery,
});

export const compensationSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('paid'),
    amountMinor: z.number().int('Use a whole number of paise.').min(1).max(Number.MAX_SAFE_INTEGER),
    currency: z.literal(CURRENCY),
    payer: z.literal('founder'),
    paymentDueDays: z
      .number()
      .int()
      .min(BRIEF_LIMITS.paymentDueDaysMin)
      .max(BRIEF_LIMITS.paymentDueDaysMax),
    methodNote: required(1, BRIEF_LIMITS.methodNoteMax),
  }),
  z.strictObject({
    type: z.literal('credit_reference'),
    benefitDescription: required(
      BRIEF_LIMITS.benefitDescriptionMin,
      BRIEF_LIMITS.benefitDescriptionMax,
    ),
  }),
  z.strictObject({ type: z.literal('unpaid') }),
]);

const proposalShape = {
  title: z.string().max(SL.titleMax * 4),
  scope: z.string().max(SL.scopeMax * 2),
  deliverables: z.array(z.string().max(SL.itemMax * 2)).max(SL.itemsMax * 2),
  criteria: z.array(z.string().max(SL.itemMax * 2)).max(SL.itemsMax * 2),
  expectedHours: z.number(),
  deadline: z.iso.datetime({ offset: true, message: 'Enter a valid date and time.' }),
  compensation: compensationSchema,
};
const proposalBody = z.strictObject(proposalShape);
const patchBody = z.strictObject({
  expectedVersion: z.number().int().min(1),
  changes: z.strictObject(proposalShape).partial(),
});
const sendBody = z.strictObject({
  expectedVersion: z.number().int().min(1),
  acknowledgeUnpaid: z.boolean().optional(),
});
const approveBody = z.strictObject({
  expectedVersion: z.number().int().min(1),
  termsHash: z.string().regex(/^[a-f0-9]{64}$/, 'Invalid terms hash.'),
  acknowledgeUnpaid: z.boolean().optional(),
});
const rejectBody = z.strictObject({
  expectedVersion: z.number().int().min(1),
  reason: required(1, CL.reasonMax),
});
const submitBody = z.strictObject({
  url: z.string().max(4096),
  note: text(SL.noteMax).optional(),
  sharePermissionAcknowledged: z.literal(true, 'Confirm the founder may view this link.'),
});
const reviewBody = z.strictObject({
  criteriaResults: z
    .array(
      z.strictObject({
        criterionId: z.string().max(40),
        outcome: z.enum(CRITERION_OUTCOMES),
        reason: required(1, SL.reviewReasonMax),
      }),
    )
    .min(1)
    .max(SL.itemsMax),
  summary: text(SL.reviewSummaryMax).optional(),
});
const acknowledgeBody = z.strictObject({
  reviewVersion: z.number().int().min(1),
  disagreementNote: text(SL.disagreementMax).optional(),
});

const notFound = () => new AppError('NOT_FOUND', 'The requested resource was not found.');
const validId = (raw: string) => {
  if (!objectIdString.safeParse(raw).success) throw notFound();
  return raw;
};
const ctxOf = (res: Response) => ({ requestId: requestIdOf(res) });

export function createCollaborationRouter(
  collaboration: CollaborationService,
  sprints: SprintService,
  idempotency: IdempotencyStore,
): Router {
  const router = Router();
  const founder = requireRole('founder');
  const participant = requireRole('founder', 'candidate');

  /** Idempotent POST: create (fresh id) or transition (target id), replaying the resource. */
  const idem = async <T>(
    req: Request,
    res: Response,
    route: string,
    body: unknown,
    resourceId: string,
    execute: (id: string) => Promise<{ status: number; data: T }>,
    replay: (id: string) => Promise<T>,
  ) => {
    const out = await runIdempotent({
      store: idempotency,
      req,
      actor: currentUser(req),
      route,
      body,
      resourceId,
      execute,
      replay,
    });
    sendData(res, out.data, out.status);
  };
  const newId = () => new mongoose.Types.ObjectId().toHexString();

  // --- Match requests ------------------------------------------------------------------------------

  router.post(
    '/match-requests',
    founder,
    withValidation({ body: createRequestBody }, async ({ body }, req, res) => {
      const user = currentUser(req);
      await idem(
        req,
        res,
        'POST /match-requests',
        body,
        newId(),
        async (id) => ({
          status: 201,
          data: await collaboration.createRequest(user, body, id, ctxOf(res)),
        }),
        (id) => collaboration.getRequest(user, id),
      );
    }),
  );

  router.get(
    '/match-requests',
    participant,
    withValidation({ query: requestListQuery }, async ({ query }, req, res) => {
      const page = await collaboration.listRequests(
        currentUser(req),
        query.box,
        {
          ...(query.status ? { status: query.status } : {}),
          ...(query.interviewId ? { interviewId: query.interviewId } : {}),
        },
        pageRequest(query),
      );
      sendList(res, page.items, encodeCursor(page.next));
    }),
  );

  router.get(
    '/match-requests/:id',
    participant,
    withValidation({ params: idParams }, async ({ params }, req, res) => {
      sendData(res, await collaboration.getRequest(currentUser(req), validId(params.id)));
    }),
  );

  router.post(
    '/match-requests/:id/accept',
    participant,
    withValidation({ params: idParams, body: emptyBody }, async ({ params, body }, req, res) => {
      const user = currentUser(req);
      const id = validId(params.id);
      await idem(
        req,
        res,
        `POST /match-requests/${id}/accept`,
        body,
        id,
        async () => ({ status: 200, data: await collaboration.accept(user, id, ctxOf(res)) }),
        async () => collaboration.accept(user, id, ctxOf(res)),
      );
    }),
  );

  for (const action of ['decline', 'withdraw'] as const) {
    router.post(
      `/match-requests/:id/${action}`,
      participant,
      withValidation({ params: idParams, body: reasonBody }, async ({ params, body }, req, res) => {
        const user = currentUser(req);
        const id = validId(params.id);
        await idem(
          req,
          res,
          `POST /match-requests/${id}/${action}`,
          body,
          id,
          async () => ({
            status: 200,
            data: await collaboration[action](user, id, body.reason ?? '', ctxOf(res)),
          }),
          () => collaboration.getRequest(user, id),
        );
      }),
    );
  }

  // --- Matches -------------------------------------------------------------------------------------

  router.get(
    '/matches',
    participant,
    withValidation({ query: matchListQuery }, async ({ query }, req, res) => {
      const page = await collaboration.listMatches(
        currentUser(req),
        query.role,
        query.status ? { status: query.status } : {},
        pageRequest(query),
      );
      sendList(res, page.items, encodeCursor(page.next));
    }),
  );

  router.get(
    '/matches/:id',
    participant,
    withValidation({ params: idParams }, async ({ params }, req, res) => {
      sendData(res, await collaboration.getMatch(currentUser(req), validId(params.id)));
    }),
  );

  router.post(
    '/matches/:id/end',
    participant,
    withValidation(
      { params: idParams, body: requiredReason },
      async ({ params, body }, req, res) => {
        const user = currentUser(req);
        const id = validId(params.id);
        await idem(
          req,
          res,
          `POST /matches/${id}/end`,
          body,
          id,
          async () => ({
            status: 200,
            data: await collaboration.endMatch(user, id, body.reason, ctxOf(res)),
          }),
          () => collaboration.getMatch(user, id),
        );
      },
    ),
  );

  router.post(
    '/matches/:id/sprints',
    participant,
    withValidation({ params: idParams, body: proposalBody }, async ({ params, body }, req, res) => {
      const user = currentUser(req);
      const matchId = validId(params.id);
      await idem(
        req,
        res,
        `POST /matches/${matchId}/sprints`,
        body,
        newId(),
        async (id) => ({
          status: 201,
          data: await sprints.create(user, matchId, body, id, ctxOf(res)),
        }),
        (id) => sprints.get(user, id),
      );
    }),
  );

  // --- Sprints -------------------------------------------------------------------------------------

  router.get(
    '/sprints/:id',
    participant,
    withValidation({ params: idParams }, async ({ params }, req, res) => {
      sendData(res, await sprints.get(currentUser(req), validId(params.id)));
    }),
  );

  router.patch(
    '/sprints/:id',
    participant,
    withValidation({ params: idParams, body: patchBody }, async ({ params, body }, req, res) => {
      sendData(res, await sprints.patch(currentUser(req), validId(params.id), body, ctxOf(res)));
    }),
  );

  const transition = <B>(
    path: string,
    schema: z.ZodType<B>,
    run: (
      user: ReturnType<typeof currentUser>,
      id: string,
      body: B,
      res: Response,
    ) => Promise<unknown>,
  ) =>
    router.post(
      `/sprints/:id/${path}`,
      participant,
      withValidation({ params: idParams, body: schema }, async ({ params, body }, req, res) => {
        const user = currentUser(req);
        const id = validId(params.id);
        await idem(
          req,
          res,
          `POST /sprints/${id}/${path}`,
          body,
          id,
          async () => ({ status: 200, data: await run(user, id, body, res) }),
          () => sprints.get(user, id),
        );
      }),
    );

  transition('send', sendBody, (u, id, b, res) => sprints.send(u, id, b, ctxOf(res)));
  transition('approve', approveBody, (u, id, b, res) => sprints.approve(u, id, b, ctxOf(res)));
  transition('reject', rejectBody, (u, id, b, res) => sprints.reject(u, id, b, ctxOf(res)));
  transition('cancel', requiredReason, (u, id, b, res) =>
    sprints.cancel(u, id, b.reason, ctxOf(res)),
  );
  transition('submit', submitBody, (u, id, b, res) => sprints.submit(u, id, b, ctxOf(res)));
  transition('review', reviewBody, (u, id, b, res) => sprints.review(u, id, b, ctxOf(res)));
  transition('acknowledge', acknowledgeBody, (u, id, b, res) =>
    sprints.acknowledge(u, id, b, ctxOf(res)),
  );

  return router;
}
