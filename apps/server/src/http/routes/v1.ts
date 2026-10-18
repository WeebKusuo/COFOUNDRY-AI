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
import type { BriefService } from '../../briefs/service.js';
import type { IdempotencyStore } from '../../briefs/store.js';
import { createBriefRouter } from './briefs.js';
import type { ResumeService } from '../../resumes/service.js';
import { createResumeRouter } from './resumes.js';
import type { RecommendationService } from '../../recommendations/service.js';
import { createRecommendationRouter } from './recommendations.js';
import type { InterviewService } from '../../interviews/service.js';
import { createInterviewRouter, type InterviewLimiters } from './interviews.js';
import type { RequestHandler } from 'express';
import type { CollaborationService } from '../../collaboration/requests.js';
import type { SprintService } from '../../collaboration/sprints.js';
import type { SafetyService } from '../../safety/service.js';
import { createCollaborationRouter } from './collaboration.js';
import { createSafetyRouter } from './safety.js';

export interface V1Options {
  auth: AuthService;
  profiles: ProfileService;
  briefs: BriefService;
  idempotency: IdempotencyStore;
  resumes: ResumeService;
  recommendations: RecommendationService;
  interviews: InterviewService;
  /** Phases 11-14 (absent only in narrow tests that build a partial app). */
  collaboration?: { requests: CollaborationService; sprints: SprintService };
  safety?: SafetyService;
  interviewLimiters?: Partial<InterviewLimiters>;
  /** Override the discovery search limiter (tests). */
  searchLimiter?: RequestHandler;
  /** Override the resume upload limiter (tests). */
  resumeUploadLimiter?: RequestHandler;
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
  router.use(
    createBriefRouter(options.briefs, options.idempotency, async (briefId) => {
      // Both cascades run even if the first fails (each is retried by its own sweep paths).
      try {
        await options.interviews.onBriefClosed(briefId);
      } finally {
        await options.collaboration?.requests.onBriefClosed(briefId);
      }
    }),
  );
  router.use(createResumeRouter(options.resumes, options.resumeUploadLimiter));
  router.use(
    createRecommendationRouter(options.recommendations, options.idempotency, options.searchLimiter),
  );
  router.use(
    createInterviewRouter(options.interviews, options.idempotency, options.interviewLimiters),
  );
  if (options.collaboration) {
    router.use(
      createCollaborationRouter(
        options.collaboration.requests,
        options.collaboration.sprints,
        options.idempotency,
      ),
    );
  }
  if (options.safety) router.use(createSafetyRouter(options.safety, options.idempotency));
  options.extraRoutes?.(router);
  return router;
}
