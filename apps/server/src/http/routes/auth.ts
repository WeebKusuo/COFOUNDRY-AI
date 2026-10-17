import { Router } from 'express';
import { z } from 'zod';
import type { CsrfData, LoginData, MeData } from '@cofoundry/shared';
import { clearSessionCookie, setSessionCookie, type CookieSettings } from '../../auth/cookies.js';
import { toSessionUser, type AuthService } from '../../auth/service.js';
import { AppError } from '../errors.js';
import { sendData } from '../respond.js';
import { withValidation } from '../validation.js';
import { currentUser } from '../middleware/auth.js';
import type { AuthRateLimiters } from '../middleware/rate-limit.js';

/** Routes reachable without a signed-in session (Section 17). Everything else is denied. */
export const PUBLIC_ROUTES = ['GET /health', 'GET /auth/csrf', 'POST /auth/login'] as const;

const loginBody = z.strictObject({
  email: z.string().min(3).max(254),
  // Length is not checked against the provisioning policy here, so errors stay generic.
  password: z.string().min(1).max(256),
});

const emptyBody = z.strictObject({});

const INVALID_CREDENTIALS = 'Email or password is incorrect.';

/** Section 18 identity routes: CSRF bootstrap, login, logout and the current user. */
export function createAuthRouter(
  auth: AuthService,
  cookies: CookieSettings,
  limiters: Pick<AuthRateLimiters, 'loginAccount' | 'loginIp' | 'csrf'>,
): Router {
  const router = Router();

  // GET /auth/csrf — creates the 15-minute anonymous bootstrap session when none exists, then
  // returns a fresh synchronizer token for the caller's session. Never cached (no-store on /api).
  router.get('/auth/csrf', limiters.csrf, async (req, res) => {
    let session = req.auth?.session ?? null;
    if (!session) {
      const issued = await auth.createAnonymousSession();
      setSessionCookie(res, cookies, issued.token, issued.maxAgeSeconds);
      session = issued.session;
    }
    const csrfToken = await auth.issueCsrfToken(session);
    if (!csrfToken) throw new AppError('CSRF_INVALID', 'Your session ended. Reload the page.');
    const data: CsrfData = { csrfToken };
    sendData(res, data);
  });

  // POST /auth/login — anonymous CSRF + Origin required (enforced before this handler).
  router.post(
    '/auth/login',
    limiters.loginIp,
    limiters.loginAccount,
    withValidation({ body: loginBody }, async ({ body }, req, res) => {
      const result = await auth.login(req.auth?.session ?? null, body.email, body.password);
      if (!result) {
        req.log?.info({ event: 'login_failure' }, 'login failed');
        throw new AppError('UNAUTHENTICATED', INVALID_CREDENTIALS);
      }
      setSessionCookie(res, cookies, result.issued.token, result.issued.maxAgeSeconds);
      req.log?.info({ event: 'login_success', userId: result.user.id }, 'login succeeded');
      const data: LoginData = { user: toSessionUser(result.user) };
      sendData(res, data);
    }),
  );

  // POST /auth/logout — revokes the current session and clears the cookie.
  router.post(
    '/auth/logout',
    withValidation({ body: emptyBody }, async (_input, req, res) => {
      const session = req.auth?.session;
      if (session) await auth.logout(session);
      clearSessionCookie(res, cookies);
      res.status(204).end();
    }),
  );

  // GET /me — own identity only.
  router.get('/me', (req, res) => {
    const data: MeData = { user: toSessionUser(currentUser(req)), profileSummaries: [] };
    sendData(res, data);
  });

  return router;
}
