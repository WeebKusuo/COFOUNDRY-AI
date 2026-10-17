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
import { MemoryProfileStore } from './memory-profile-store.js';
import { ProfileService } from '../../src/profiles/service.js';
import type { ProfileStore } from '../../src/profiles/store.js';
import { BriefService } from '../../src/briefs/service.js';
import type { BriefStore, IdempotencyStore } from '../../src/briefs/store.js';
import { MemoryBriefStore, MemoryIdempotencyStore } from './memory-brief-store.js';
import { ResumeService } from '../../src/resumes/service.js';
import { createPdfTextExtractor, type PdfTextExtractor } from '../../src/resumes/extract.js';
import { createMemoryFileStorage, type ResumeFileStorage } from '../../src/resumes/storage.js';
import type { ResumeStore } from '../../src/resumes/store.js';
import { MemoryResumeStore } from './memory-resume-store.js';
import { RecommendationService } from '../../src/recommendations/service.js';
import type { RecommendationStore } from '../../src/recommendations/store.js';
import type { BlockPolicy } from '../../src/safety/blocks.js';
import { MemoryRecommendationStore } from './memory-recommendation-store.js';

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
  profileStore: ProfileStore;
  profiles: ProfileService;
  briefStore: BriefStore;
  briefs: BriefService;
  idempotencyStore: IdempotencyStore;
  resumeStore: ResumeStore;
  resumeFiles: ResumeFileStorage;
  resumes: ResumeService;
  recommendationStore: RecommendationStore;
  recommendations: RecommendationService;
}

export function buildHarness(
  options: {
    store?: IdentityStore;
    profileStore?: ProfileStore;
    briefStore?: BriefStore;
    idempotencyStore?: IdempotencyStore;
    resumeStore?: ResumeStore;
    resumeFiles?: ResumeFileStorage;
    extractor?: PdfTextExtractor;
    recommendationStore?: RecommendationStore;
    blocks?: BlockPolicy;
    now?: () => Date;
    config?: Partial<AppConfig>;
    authOptions?: Partial<AuthServiceOptions>;
  } & Pick<
    AppDependencies,
    'extraV1Routes' | 'rateLimiters' | 'resumeUploadLimiter' | 'searchLimiter'
  > = {},
): Harness {
  const store = options.store ?? new MemoryIdentityStore();
  const config = testConfig(options.config);
  const auth = new AuthService(store, {
    sessionTtlSeconds: config.sessionTtlSeconds,
    ...options.authOptions,
  });
  const profileStore = options.profileStore ?? new MemoryProfileStore();
  const profiles = new ProfileService(profileStore, store);
  const briefStore = options.briefStore ?? new MemoryBriefStore();
  const briefs = new BriefService(briefStore, store, profileStore);
  const idempotencyStore = options.idempotencyStore ?? new MemoryIdempotencyStore();
  const resumeStore = options.resumeStore ?? new MemoryResumeStore();
  const resumeFiles = options.resumeFiles ?? createMemoryFileStorage();
  const resumes = new ResumeService(
    resumeStore,
    resumeFiles,
    profileStore,
    options.extractor ?? createPdfTextExtractor(),
    silentLogger,
  );
  const recommendationStore = options.recommendationStore ?? new MemoryRecommendationStore();
  const recommendations = new RecommendationService(
    recommendationStore,
    briefStore,
    store,
    profileStore,
    options.blocks,
    options.now,
  );
  const app = createApp({
    config,
    logger: silentLogger,
    auth,
    profiles,
    briefs,
    idempotency: idempotencyStore,
    resumes,
    recommendations,
    ...(options.searchLimiter ? { searchLimiter: options.searchLimiter } : {}),
    ...(options.resumeUploadLimiter ? { resumeUploadLimiter: options.resumeUploadLimiter } : {}),
    ...(options.extraV1Routes ? { extraV1Routes: options.extraV1Routes } : {}),
    ...(options.rateLimiters ? { rateLimiters: options.rateLimiters } : {}),
  });
  return {
    app,
    store,
    auth,
    profileStore,
    profiles,
    briefStore,
    briefs,
    idempotencyStore,
    resumeStore,
    resumeFiles,
    resumes,
    recommendationStore,
    recommendations,
  };
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

  async post(path: string, body: object = {}, headers: Record<string, string> = {}) {
    return this.send('post', path, body, headers);
  }

  async put(path: string, body: object = {}, headers: Record<string, string> = {}) {
    return this.send('put', path, body, headers);
  }

  async patch(path: string, body: object = {}, headers: Record<string, string> = {}) {
    return this.send('patch', path, body, headers);
  }

  async delete(path: string, headers: Record<string, string> = {}) {
    return this.send('delete', path, {}, headers);
  }

  /** Raw body upload (e.g. application/pdf) with CSRF and Origin like a browser fetch. */
  async upload(path: string, bytes: Buffer, headers: Record<string, string>) {
    if (!this.csrf) await this.refreshCsrf();
    let req = this.agent
      .put(`/api/v1${path}`)
      .set('Origin', TEST_ORIGIN)
      .set('X-CSRF-Token', this.csrf ?? '');
    for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
    return req.send(bytes);
  }

  private async send(
    method: 'post' | 'put' | 'patch' | 'delete',
    path: string,
    body: object,
    headers: Record<string, string>,
  ) {
    if (!this.csrf) await this.refreshCsrf();
    let req = this.agent[method](`/api/v1${path}`)
      .set('Origin', TEST_ORIGIN)
      .set('X-CSRF-Token', this.csrf ?? '');
    for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
    return req.send(body);
  }

  async login(email: string, password = TEST_PASSWORD) {
    const res = await this.post('/auth/login', { email, password });
    if (res.status === 200) await this.refreshCsrf();
    return res;
  }
}
