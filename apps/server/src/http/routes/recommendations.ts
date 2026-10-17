import { Router, type RequestHandler } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { DISCOVERY_SEARCHES_PER_MINUTE } from '@cofoundry/shared';
import type { IdempotencyStore } from '../../briefs/store.js';
import type { RecommendationService } from '../../recommendations/service.js';
import { AppError } from '../errors.js';
import { runIdempotent } from '../idempotency.js';
import { currentUser, requireRole } from '../middleware/auth.js';
import { createRateLimiter } from '../middleware/rate-limit.js';
import { sendData } from '../respond.js';
import { objectIdString, withValidation } from '../validation.js';

const idParams = z.strictObject({ id: z.string() });
const emptyBody = z.strictObject({});
const noQuery = z.strictObject({});

function briefId(raw: string): string {
  if (!objectIdString.safeParse(raw).success) {
    throw new AppError('NOT_FOUND', 'The requested resource was not found.');
  }
  return raw;
}

/** Section 23: discovery searches, 10 per minute per founder. */
export function discoverySearchLimiter(): RequestHandler {
  return createRateLimiter({
    windowMs: 60_000,
    limit: DISCOVERY_SEARCHES_PER_MINUTE,
    keyGenerator: (req) => `discovery:${req.auth?.user?.id ?? 'anonymous'}`,
  });
}

/** Section 19 recommendation routes (founder owner only). */
export function createRecommendationRouter(
  recommendations: RecommendationService,
  idempotency: IdempotencyStore,
  searchLimiter: RequestHandler = discoverySearchLimiter(),
): Router {
  const router = Router();

  router.post(
    '/startups/:id/recommendations',
    requireRole('founder'),
    searchLimiter,
    withValidation({ params: idParams, body: emptyBody }, async ({ params, body }, req, res) => {
      const user = currentUser(req);
      const id = briefId(params.id);
      const outcome = await runIdempotent({
        store: idempotency,
        req,
        actor: user,
        route: `POST /startups/${id}/recommendations`,
        body,
        resourceId: new mongoose.Types.ObjectId().toHexString(),
        execute: async (batchId) => ({
          status: 201,
          data: await recommendations.generate(user, id, batchId),
        }),
        replay: (batchId) => recommendations.byId(user, id, batchId),
      });
      sendData(res, outcome.data, outcome.status);
    }),
  );

  router.get(
    '/startups/:id/recommendations',
    requireRole('founder'),
    withValidation({ params: idParams, query: noQuery }, async ({ params }, req, res) => {
      sendData(res, await recommendations.latest(currentUser(req), briefId(params.id)));
    }),
  );

  return router;
}
