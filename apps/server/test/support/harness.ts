import type { Express } from 'express';
import request from 'supertest';
import type { UserRole } from '@cofoundry/shared';
import { hashPassword } from '../../src/auth/crypto.js';
import { AuthService, type AuthServiceOptions } from '../../src/auth/service.js';
import type { IdentityStore, UserRecord } from '../../src/auth/store.js';
import type { AppConfig } from '../../src/config/env.js';
import { createApp, type AppDependencies } from '../../src/http/app.js';
import { TEST_ORIGIN, silentLogger, testConfig } from '../helpers.js';
import { MemoryIdentityStore } from './memory-store.js';

export const TEST_PASSWORD = 'correct-horse-battery';

let cachedHash: Promise<string> | null = null;
/** Hashing with the real Argon2id parameters is deliberately slow; share one hash in tests. */
export function testPasswordHash(): Promise<string> {
  cachedHash ??= hashPassword(TEST_PASSWORD);
  return cachedHash;
}

export async function addTestUser(
  store: MemoryIdentityStore,
  email: string,
  roles: UserRole[],
  overrides: Partial<UserRecord> = {},
): Promise<UserRecord> {
  return store.addUser({
    emailLower: email,
    passwordHash: await testPasswordHash(),
    displayName: email.split('@')[0] ?? email,
    roles,
    cohortId: 'test',
    status: 'active',
    accountMode: 'demo',
    authVersion: 1,
    emailVerifiedAt: null,
    ...overrides,
  });
}

export interface Harness {
  app: Express;
  store: IdentityStore;
  auth: AuthService;
}

export function buildHarness(
  options: {
    store?: IdentityStore;
    config?: Partial<AppConfig>;
    authOptions?: Partial<AuthServiceOptions>;
  } & Pick<AppDependencies, 'extraV1Routes' | 'rateLimiters'> = {},
): Harness {
  const store = options.store ?? new MemoryIdentityStore();
  const config = testConfig(options.config);
  const auth = new AuthService(store, {
    sessionTtlSeconds: config.sessionTtlSeconds,
    ...options.authOptions,
  });
  const app = createApp({
    config,
    logger: silentLogger,
    auth,
    ...(options.extraV1Routes ? { extraV1Routes: options.extraV1Routes } : {}),
    ...(options.rateLimiters ? { rateLimiters: options.rateLimiters } : {}),
  });
  return { app, store, auth };
}

/** Reads the session cookie value from a Set-Cookie header list. */
export function sessionCookie(res: request.Response, name = 'cofoundry-dev'): string | undefined {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  const line = raw?.find((c) => c.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1).split(';')[0] : undefined;
}

/** A browser-like client: keeps cookies, sends Origin and the current CSRF token. */
export class TestClient {
  readonly agent: ReturnType<typeof request.agent>;
  csrf: string | null = null;

  constructor(app: Express) {
    this.agent = request.agent(app);
  }

  async refreshCsrf(): Promise<string> {
    const res = await this.agent.get('/api/v1/auth/csrf');
    if (res.status !== 200) throw new Error(`csrf bootstrap failed: ${res.status}`);
    this.csrf = res.body.data.csrfToken as string;
    return this.csrf;
  }

  get(path: string) {
    return this.agent.get(`/api/v1${path}`);
  }

  async post(path: string, body: object = {}) {
    if (!this.csrf) await this.refreshCsrf();
    return this.agent
      .post(`/api/v1${path}`)
      .set('Origin', TEST_ORIGIN)
      .set('X-CSRF-Token', this.csrf ?? '')
      .send(body);
  }

  async login(email: string, password = TEST_PASSWORD) {
    const res = await this.post('/auth/login', { email, password });
    if (res.status === 200) await this.refreshCsrf();
    return res;
  }
}
