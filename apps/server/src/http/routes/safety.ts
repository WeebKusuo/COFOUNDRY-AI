import { Router, type Request, type Response } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import {
  CASE_STATUSES,
  CORRECTION_TARGET_TYPES,
  REPORT_CATEGORIES,
  REPORT_TARGET_TYPES,
  SAFETY_LIMITS as L,
} from '@cofoundry/shared';
import type { IdempotencyStore } from '../../briefs/store.js';
import type { SafetyService } from '../../safety/service.js';
import { AppError } from '../errors.js';
import { runIdempotent } from '../idempotency.js';
import { currentUser, requireRole } from '../middleware/auth.js';
import { encodeCursor, pageQuery, pageRequest } from '../pagination.js';
import { requestIdOf, sendData, sendList } from '../respond.js';
import { objectIdString, withValidation } from '../validation.js';

/**
 * Safety and moderation routes (Phase 14; Contract Section 21). Any signed-in user may block,
 * report and request corrections within their legitimate visibility; /admin routes need the
 * moderator role and, for evidence, an assigned case.
 */

const idParams = z.strictObject({ id: z.string() });
const targetParams = z.strictObject({ targetUserId: z.string() });
const emptyBody = z.strictObject({});
const claimText = z
  .string()
  .trim()
  .min(L.textMin, `Describe the problem in at least ${L.textMin} characters.`)
  .max(L.textMax, `At most ${L.textMax} characters.`);

const blockBody = z.strictObject({ targetUserId: objectIdString });
const reportBody = z.strictObject({
  targetType: z.enum(REPORT_TARGET_TYPES),
  targetId: objectIdString,
  category: z.enum(REPORT_CATEGORIES),
  text: claimText,
});
const correctionBody = z.strictObject({
  targetType: z.enum(CORRECTION_TARGET_TYPES),
  targetId: objectIdString,
  text: claimText,
});
const listQuery = z.strictObject({ ...pageQuery });
const adminListQuery = z.strictObject({ status: z.enum(CASE_STATUSES).optional(), ...pageQuery });
const noteBody = z.strictObject({ text: z.string().trim().min(1).max(L.noteMax) });
const resolveBody = z.strictObject({
  decision: z.enum(['resolved', 'dismissed']),
  resolutionText: z.string().trim().min(L.resolutionMin, 'Required.').max(L.resolutionMax),
  displayCorrection: z.string().trim().min(1).max(L.correctionMax).optional(),
  quarantineReport: z.boolean(),
  suspendTarget: z.boolean(),
});

const notFound = () => new AppError('NOT_FOUND', 'The requested resource was not found.');
const validId = (raw: string) => {
  if (!objectIdString.safeParse(raw).success) throw notFound();
  return raw;
};
const ctxOf = (res: Response) => ({ requestId: requestIdOf(res) });

export function createSafetyRouter(safety: SafetyService, idempotency: IdempotencyStore): Router {
  const router = Router();
  const member = requireRole('founder', 'candidate');
  const moderator = requireRole('moderator');

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

  // --- Blocks ---------------------------------------------------------------------------------------

  router.post(
    '/blocks',
    member,
    withValidation({ body: blockBody }, async ({ body }, req, res) => {
      const user = currentUser(req);
      await idem(
        req,
        res,
        'POST /blocks',
        body,
        body.targetUserId,
        async () => ({
          status: 201,
          data: await safety.block(user, body.targetUserId, ctxOf(res)),
        }),
        async (target) => {
          const found = (await safety.listBlocks(user)).find((b) => b.targetUserId === target);
          if (!found) throw notFound();
          return found;
        },
      );
    }),
  );

  router.get('/blocks', member, async (req, res) => {
    sendData(res, await safety.listBlocks(currentUser(req)));
  });

  router.delete(
    '/blocks/:targetUserId',
    member,
    withValidation({ params: targetParams, body: emptyBody }, async ({ params }, req, res) => {
      await safety.unblock(currentUser(req), validId(params.targetUserId), ctxOf(res));
      res.status(204).end();
    }),
  );

  // --- Reports, corrections, own cases ------------------------------------------------------------

  router.post(
    '/reports',
    member,
    withValidation({ body: reportBody }, async ({ body }, req, res) => {
      const user = currentUser(req);
      await idem(
        req,
        res,
        'POST /reports',
        body,
        newId(),
        (id) => safety.report(user, body, id, ctxOf(res)),
        (id) => safety.getMyCase(user, id),
      );
    }),
  );

  router.post(
    '/corrections',
    member,
    withValidation({ body: correctionBody }, async ({ body }, req, res) => {
      const user = currentUser(req);
      await idem(
        req,
        res,
        'POST /corrections',
        body,
        newId(),
        (id) => safety.correction(user, body, id, ctxOf(res)),
        (id) => safety.getMyCase(user, id),
      );
    }),
  );

  router.get(
    '/cases',
    member,
    withValidation({ query: listQuery }, async ({ query }, req, res) => {
      const page = await safety.myCases(currentUser(req), pageRequest(query));
      sendList(res, page.items, encodeCursor(page.next));
    }),
  );

  router.get(
    '/cases/:id',
    member,
    withValidation({ params: idParams }, async ({ params }, req, res) => {
      sendData(res, await safety.getMyCase(currentUser(req), params.id));
    }),
  );

  // --- Moderation -----------------------------------------------------------------------------------

  router.get(
    '/admin/cases',
    moderator,
    withValidation({ query: adminListQuery }, async ({ query }, req, res) => {
      const page = await safety.listCases(currentUser(req), query.status, pageRequest(query));
      sendList(res, page.items, encodeCursor(page.next));
    }),
  );

  router.get(
    '/admin/cases/:id',
    moderator,
    withValidation({ params: idParams }, async ({ params }, req, res) => {
      sendData(res, await safety.caseSummary(currentUser(req), validId(params.id)));
    }),
  );

  router.post(
    '/admin/cases/:id/claim',
    moderator,
    withValidation({ params: idParams, body: emptyBody }, async ({ params }, req, res) => {
      sendData(res, await safety.claim(currentUser(req), validId(params.id), ctxOf(res)));
    }),
  );

  router.get(
    '/admin/cases/:id/context',
    moderator,
    withValidation({ params: idParams }, async ({ params }, req, res) => {
      sendData(res, await safety.context(currentUser(req), validId(params.id), ctxOf(res)));
    }),
  );

  router.post(
    '/admin/cases/:id/notes',
    moderator,
    withValidation({ params: idParams, body: noteBody }, async ({ params, body }, req, res) => {
      sendData(
        res,
        await safety.addNote(currentUser(req), validId(params.id), body.text, ctxOf(res)),
      );
    }),
  );

  router.post(
    '/admin/cases/:id/resolve',
    moderator,
    withValidation({ params: idParams, body: resolveBody }, async ({ params, body }, req, res) => {
      const user = currentUser(req);
      const id = validId(params.id);
      await idem(
        req,
        res,
        `POST /admin/cases/${id}/resolve`,
        body,
        id,
        async () => ({
          status: 200,
          data: await safety.resolve(
            user,
            id,
            {
              decision: body.decision,
              resolutionText: body.resolutionText,
              ...(body.displayCorrection !== undefined
                ? { displayCorrection: body.displayCorrection }
                : {}),
              quarantineReport: body.quarantineReport,
              suspendTarget: body.suspendTarget,
            },
            ctxOf(res),
          ),
        }),
        () => safety.context(user, id, ctxOf(res)),
      );
    }),
  );

  return router;
}
