import { Router } from 'express';
import type { HealthData } from '@cofoundry/shared';
import type { CookieSettings } from '../../auth/cookies.js';
import type { AuthService } from '../../auth/service.js';
import { requireCsrf, requireSignedInExcept } from '../middleware/auth.js';
import type { AuthRateLimiters } from '../middleware/rate-limit.js';
import { sendData } from '../respond.js';
import { PUBLIC_ROUTES, createAuthRouter } from './auth.js';
import { createProfileRouter } from './profiles.js';
import type { ProfileService } from '../../profiles/service.js';

export interface V1Options {
  auth: AuthService;
  profiles: ProfileService;
  cookies: CookieSettings;
  limiters: AuthRateLimiters;
  /** Test-only routes, mounted behind the same CSRF and deny-by-default guards. */
  extraRoutes?: (router: Router) => void;
}

/**
 * /api/v1 router. Every mutation needs a valid CSRF token, and every route needs a signed-in
 * session unless it is listed in PUBLIC_ROUTES. Feature routes (Sections 18-21) are added in
 * their own phases and documented in docs/api/openapi.yaml as they land.
 */
export function createV1Router(options: V1Options): Router {
  const router = Router();
  router.use(requireCsrf);
  router.use(requireSignedInExcept(PUBLIC_ROUTES));

  // Section 18: GET /health — public liveness only, no internals.
  router.get('/health', (_req, res) => {
    const data: HealthData = { status: 'ok' };
    sendData(res, data);
  });

  router.use(
    createAuthRouter(options.auth, options.cookies, options.limiters, (user) =>
      options.profiles.summaries(user),
    ),
  );
  router.use(createProfileRouter(options.profiles));
  options.extraRoutes?.(router);
  return router;
}
