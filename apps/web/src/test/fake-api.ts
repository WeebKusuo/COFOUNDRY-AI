import { vi } from 'vitest';
import type { SessionUser, UserRole } from '@cofoundry/shared';

/**
 * A small stateful stand-in for the auth API used by component tests. It mirrors the server's
 * observable contract (envelopes, CSRF requirement, generic 401). The real server behaviour is
 * covered by the server test suite and the Playwright E2E tests.
 */
export interface FakeApiOptions {
  user?: SessionUser | null;
  password?: string;
  /** Force sign-in to fail with this error code. */
  loginError?: { status: number; code: string; message: string; retryAfter?: number };
  healthy?: boolean;
  /** Extra signed-in routes: return a response, or undefined to fall through to 404. */
  routes?: (
    method: string,
    path: string,
    body: unknown,
  ) => { status: number; body?: unknown } | undefined;
}

export function demoUser(roles: UserRole[], overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: '65f0c0ffee0000000000000a',
    email: 'founder@demo.cofoundry.test',
    displayName: 'Rohan (PayPilot)',
    roles,
    accountMode: 'demo',
    emailVerifiedAt: null,
    ...overrides,
  };
}

export function installFakeApi(options: FakeApiOptions = {}) {
  const state = {
    user: options.user ?? null,
    pendingUser: options.user ?? demoUser(['founder']),
    csrf: 0,
    calls: [] as Array<{ method: string; path: string; csrf?: string }>,
    /** Flip to simulate the server-side session ending (expiry, revocation). */
    expire() {
      state.user = null;
    },
  };

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  const err = (status: number, code: string, message: string, headers?: Record<string, string>) =>
    json(status, { error: { code, message }, requestId: 'req' }, headers);

  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const path = url.replace(/^\/api\/v1/, '').split('?')[0] ?? '';
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const csrfHeader = headers['X-CSRF-Token'];
    state.calls.push({ method, path, ...(csrfHeader ? { csrf: csrfHeader } : {}) });

    if (path === '/health') {
      return options.healthy === false
        ? err(503, 'SERVICE_UNAVAILABLE', 'down')
        : json(200, { data: { status: 'ok' }, requestId: 'req' });
    }
    if (path === '/auth/csrf') {
      state.csrf += 1;
      return json(200, { data: { csrfToken: `csrf-${state.csrf}` }, requestId: 'req' });
    }
    if (method !== 'GET' && csrfHeader !== `csrf-${state.csrf}`) {
      return err(403, 'CSRF_INVALID', 'Your security token is missing or expired.');
    }
    if (path === '/auth/login') {
      if (options.loginError) {
        const { status, code, message, retryAfter } = options.loginError;
        return err(status, code, message, retryAfter ? { 'Retry-After': String(retryAfter) } : {});
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as { email?: string; password?: string };
      if (
        body.email !== state.pendingUser.email ||
        body.password !== (options.password ?? 'right-password')
      ) {
        return err(401, 'UNAUTHENTICATED', 'Email or password is incorrect.');
      }
      state.user = state.pendingUser;
      return json(200, { data: { user: state.user }, requestId: 'req' });
    }
    if (!state.user) return err(401, 'UNAUTHENTICATED', 'Sign in to continue.');
    if (path === '/auth/logout') {
      state.user = null;
      return new Response(null, { status: 204 });
    }
    if (path === '/me') {
      return json(200, { data: { user: state.user, profileSummaries: [] }, requestId: 'req' });
    }
    const extra = options.routes?.(
      method,
      path,
      init?.body ? JSON.parse(String(init.body)) : undefined,
    );
    if (extra) {
      return extra.body === undefined
        ? new Response(null, { status: extra.status })
        : json(extra.status, extra.body);
    }
    return err(404, 'NOT_FOUND', 'The requested resource was not found.');
  });

  vi.stubGlobal('fetch', fetchFn);
  return { state, fetchFn };
}
