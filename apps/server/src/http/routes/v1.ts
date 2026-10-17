import { Router } from 'express';
import type { HealthData } from '@cofoundry/shared';
import { sendData } from '../respond.js';

/**
 * /api/v1 router. Phase 1 exposes liveness only; feature routes (Sections 18-21) are added in
 * their own phases and documented in the OpenAPI specification as they land.
 */
export function createV1Router(): Router {
  const router = Router();

  // Section 18: GET /health — public liveness only, no internals.
  router.get('/health', (_req, res) => {
    const data: HealthData = { status: 'ok' };
    sendData(res, data);
  });

  return router;
}
