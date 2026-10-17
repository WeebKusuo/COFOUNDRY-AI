import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { sha256, hashPassword, verifyPassword, assertPasswordPolicy } from '../src/auth/crypto.js';
import { assertOwnedBy, currentUser, requireRole } from '../src/http/middleware/auth.js';
import { sendData } from '../src/http/respond.js';
import { TEST_ORIGIN } from './helpers.js';
import { MemoryIdentityStore } from './support/memory-store.js';
import {
  TEST_PASSWORD,
  TestClient,
  addTestUser,
  buildHarness,
  sessionCookie,
  type Harness,
} from './support/harness.js';

const FOUNDER = 'founder@test.example';
const CANDIDATE = 'candidate@test.example';
const MODERATOR = 'moderator@test.example';
const DUAL = 'dual@test.example';

/** Role-guarded test routes: real middleware, no invented product endpoints. */
const rbacRoutes: NonNullable<Parameters<typeof buildHarness>[0]>['extraV1Routes'] = (router) => {
  router.get('/__test/founder-only', requireRole('founder'), (_req, res) =>
    sendData(res, { ok: true }),
  );
  router.get('/__test/moderator-only', requireRole('moderator'), (_req, res) =>
    sendData(res, { ok: true }),
  );
  router.get('/__test/owned/:ownerId', (req, res) => {
    assertOwnedBy(String(req.params.ownerId), currentUser(req));
    sendData(res, { ok: true });
  });
};

let store: MemoryIdentityStore;
let clock: { now: Date };
let h: Harness;

beforeEach(async () => {
  store = new MemoryIdentityStore();
  await addTestUser(store, FOUNDER, ['founder']);
  await addTestUser(store, CANDIDATE, ['candidate']);
  await addTestUser(store, MODERATOR, ['moderator']);
  await addTestUser(store, DUAL, ['founder', 'candidate']);
  clock = { now: new Date('2026-10-17T10:00:00Z') };
  h = buildHarness({
    store,
    extraV1Routes: rbacRoutes,
    authOptions: { now: () => clock.now },
  });
});

const advance = (seconds: number) => {
  clock.now = new Date(clock.now.getTime() + seconds * 1000);
};

describe('password hashing (Section 22)', () => {
  it('uses Argon2id with 64 MiB, 3 iterations, parallelism 1 and a unique salt', async () => {
    const a = await hashPassword(TEST_PASSWORD);
    const b = await hashPassword(TEST_PASSWORD);
    expect(a).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
    expect(a).not.toBe(b);
    expect(await verifyPassword(a, TEST_PASSWORD)).toBe(true);
    expect(await verifyPassword(a, 'wrong-password-123')).toBe(false);
  });

  it('enforces 12-128 characters for provisioned passwords', () => {
    expect(() => assertPasswordPolicy('short')).toThrow();
    expect(() => assertPasswordPolicy('x'.repeat(129))).toThrow();
    expect(() => assertPasswordPolicy('x'.repeat(12))).not.toThrow();
  });

  it('treats a malformed stored hash as a failed check, not a crash', async () => {
    expect(await verifyPassword('not-a-hash', TEST_PASSWORD)).toBe(false);
  });
});

describe('GET /auth/csrf (anonymous bootstrap)', () => {
  it('creates a 15-minute HttpOnly SameSite=Lax session and returns a token', async () => {
    const res = await request(h.app).get('/api/v1/auth/csrf');
    expect(res.status).toBe(200);
    expect(res.body.data.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.headers['cache-control']).toBe('no-store');
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0] ?? '';
    expect(cookie).toMatch(/^cofoundry-dev=[A-Za-z0-9_-]{43}; /);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Max-Age=900');
    expect(cookie).not.toContain('Secure');
    expect(cookie).not.toContain('Domain');
  });

  it('stores only hashes of the session and CSRF tokens', async () => {
    const res = await request(h.app).get('/api/v1/auth/csrf');
    const token = sessionCookie(res) ?? '';
    const [session] = [...store.sessions.values()];
    expect(session?.tokenHash).toBe(sha256(token));
    expect(session?.csrfTokenHash).toBe(sha256(res.body.data.csrfToken));
    expect(JSON.stringify([...store.sessions.values()])).not.toContain(token);
    expect(session?.userId).toBeNull();
  });

  it('rotates the CSRF token on every fetch; the old one stops working', async () => {
    const client = new TestClient(h.app);
    const first = await client.refreshCsrf();
    const second = await client.refreshCsrf();
    expect(second).not.toBe(first);
    client.csrf = first;
    const res = await client.post('/auth/login', { email: FOUNDER, password: TEST_PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_INVALID');
  });

  it('expires the anonymous session after 15 minutes', async () => {
    const client = new TestClient(h.app);
    await client.refreshCsrf();
    advance(15 * 60 + 1);
    const res = await client.post('/auth/login', { email: FOUNDER, password: TEST_PASSWORD });
    expect(res.status).toBe(403);
    expect(store.sessions.size).toBe(0);
  });
});

describe('POST /auth/login', () => {
  it('signs in, returns only the own identity and rotates the session', async () => {
    const client = new TestClient(h.app);
    const boot = await client.agent.get('/api/v1/auth/csrf');
    client.csrf = boot.body.data.csrfToken;
    const anonToken = sessionCookie(boot);

    const res = await client.post('/auth/login', { email: FOUNDER, password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.data.user).toEqual({
      id: expect.stringMatching(/^[a-f0-9]{24}$/),
      email: FOUNDER,
      displayName: 'founder',
      roles: ['founder'],
      accountMode: 'demo',
      emailVerifiedAt: null,
    });
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|argon2|tokenHash/);

    const authedToken = sessionCookie(res);
    expect(authedToken).toBeDefined();
    expect(authedToken).not.toBe(anonToken);
    // Only the new, signed-in session remains; the bootstrap session was deleted.
    expect(store.sessions.size).toBe(1);
    expect([...store.sessions.values()][0]?.tokenHash).toBe(sha256(authedToken ?? ''));

    // The pre-login CSRF token is no longer valid; the client must fetch a new one.
    const stale = await client.post('/auth/logout');
    expect(stale.status).toBe(403);
    await client.refreshCsrf();
    expect((await client.post('/auth/logout')).status).toBe(204);
  });

  it('sets 8-hour cookies with __Host- prefix and Secure in production', async () => {
    const prod = buildHarness({
      store,
      config: { isProduction: true, appOrigin: 'https://app.example.com' },
    });
    const boot = await request(prod.app).get('/api/v1/auth/csrf');
    expect((boot.headers['set-cookie'] as unknown as string[])[0]).toMatch(
      /^__Host-cofoundry=.+; Path=\/; Max-Age=900; HttpOnly; SameSite=Lax; Secure$/,
    );
    // Secure cookies are not replayed over plain-HTTP test sockets, so send it explicitly.
    const res = await request(prod.app)
      .post('/api/v1/auth/login')
      .set('Cookie', `__Host-cofoundry=${sessionCookie(boot, '__Host-cofoundry')}`)
      .set('Origin', 'https://app.example.com')
      .set('X-CSRF-Token', boot.body.data.csrfToken)
      .send({ email: FOUNDER, password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0] ?? '';
    expect(cookie).toMatch(/^__Host-cofoundry=/);
    expect(cookie).toContain('Max-Age=28800');
    expect(cookie).toContain('Secure');
    expect(cookie).not.toContain('Domain');
  });

  it.each([
    ['wrong password', FOUNDER, 'wrong-password-1'],
    ['unknown account', 'nobody@test.example', TEST_PASSWORD],
  ])('gives the same generic 401 for %s', async (_label, email, password) => {
    const client = new TestClient(h.app);
    const res = await client.post('/auth/login', { email, password });
    expect(res.status).toBe(401);
    expect(res.body.error).toEqual({
      code: 'UNAUTHENTICATED',
      message: 'Email or password is incorrect.',
    });
    expect(sessionCookie(res)).toBeUndefined();
  });

  it('refuses suspended and deleted accounts with the same generic error', async () => {
    for (const status of ['suspended', 'deletion_pending', 'deleted'] as const) {
      const user = await store.findUserByEmail(CANDIDATE);
      if (user) user.status = status;
      const client = new TestClient(h.app);
      const res = await client.post('/auth/login', { email: CANDIDATE, password: TEST_PASSWORD });
      expect(res.status).toBe(401);
      expect(res.body.error.message).toBe('Email or password is incorrect.');
    }
  });

  it('normalises the email (case, spaces, NFKC)', async () => {
    const client = new TestClient(h.app);
    const res = await client.post('/auth/login', {
      email: '  FOUNDER@Test.Example ',
      password: TEST_PASSWORD,
    });
    expect(res.status).toBe(200);
  });

  it('requires CSRF and exact Origin even for login', async () => {
    const agent = request.agent(h.app);
    const boot = await agent.get('/api/v1/auth/csrf');
    const body = { email: FOUNDER, password: TEST_PASSWORD };
    const noToken = await agent.post('/api/v1/auth/login').set('Origin', TEST_ORIGIN).send(body);
    expect(noToken.status).toBe(403);
    const noOrigin = await agent
      .post('/api/v1/auth/login')
      .set('X-CSRF-Token', boot.body.data.csrfToken)
      .send(body);
    expect(noOrigin.status).toBe(403);
    const noSession = await request(h.app)
      .post('/api/v1/auth/login')
      .set('Origin', TEST_ORIGIN)
      .set('X-CSRF-Token', boot.body.data.csrfToken)
      .send(body);
    expect(noSession.status).toBe(403);
    expect(noSession.body.error.code).toBe('CSRF_INVALID');
  });

  it('rejects unknown body fields', async () => {
    const client = new TestClient(h.app);
    const res = await client.post('/auth/login', {
      email: FOUNDER,
      password: TEST_PASSWORD,
      roles: ['moderator'],
    });
    expect(res.status).toBe(422);
  });

  it('rotates again when an already signed-in user signs in', async () => {
    const client = new TestClient(h.app);
    const first = await client.login(FOUNDER);
    const second = await client.login(FOUNDER);
    expect(sessionCookie(second)).not.toBe(sessionCookie(first));
    expect(store.sessions.size).toBe(1);
  });
});

describe('login rate limits (Section 23)', () => {
  it('blocks an account after 5 failed attempts in 15 minutes, even with the right password', async () => {
    const client = new TestClient(h.app);
    for (let i = 0; i < 5; i += 1) {
      const res = await client.post('/auth/login', {
        email: FOUNDER,
        password: 'wrong-password-x',
      });
      expect(res.status).toBe(401);
    }
    const blocked = await client.post('/auth/login', { email: FOUNDER, password: TEST_PASSWORD });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    // Different-case spelling of the same account is the same key.
    const variant = await client.post('/auth/login', {
      email: 'Founder@Test.Example',
      password: TEST_PASSWORD,
    });
    expect(variant.status).toBe(429);
    // Other accounts are unaffected.
    expect(
      (await client.post('/auth/login', { email: CANDIDATE, password: TEST_PASSWORD })).status,
    ).toBe(200);
  });

  it('blocks a client IP after 20 failed attempts across accounts', async () => {
    const client = new TestClient(h.app);
    for (let i = 0; i < 20; i += 1) {
      await client.post('/auth/login', {
        email: `user${i}@test.example`,
        password: 'wrong-pass-1',
      });
    }
    const res = await client.post('/auth/login', { email: MODERATOR, password: TEST_PASSWORD });
    expect(res.status).toBe(429);
  });

  it('does not count successful sign-ins', async () => {
    const client = new TestClient(h.app);
    for (let i = 0; i < 7; i += 1) {
      expect((await client.login(FOUNDER)).status).toBe(200);
    }
  });
});

describe('sessions (Section 22)', () => {
  it('GET /me needs a session and returns only the own identity', async () => {
    expect((await request(h.app).get('/api/v1/me')).status).toBe(401);
    const client = new TestClient(h.app);
    await client.login(CANDIDATE);
    const res = await client.get('/me');
    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe(CANDIDATE);
    expect(res.body.data.profileSummaries).toEqual([]);
  });

  it('an anonymous bootstrap session is not a signed-in session', async () => {
    const client = new TestClient(h.app);
    await client.refreshCsrf();
    expect((await client.get('/me')).status).toBe(401);
  });

  it('expires after 30 idle minutes', async () => {
    const client = new TestClient(h.app);
    await client.login(FOUNDER);
    advance(29 * 60);
    expect((await client.get('/me')).status).toBe(200);
    advance(29 * 60); // activity above reset the idle clock
    expect((await client.get('/me')).status).toBe(200);
    advance(30 * 60 + 1);
    const res = await client.get('/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
    expect((res.headers['set-cookie'] as unknown as string[])[0]).toContain('Max-Age=0');
    expect(store.sessions.size).toBe(0);
  });

  it('expires 8 hours after sign-in even when active', async () => {
    const client = new TestClient(h.app);
    await client.login(FOUNDER);
    for (let i = 0; i < 19; i += 1) {
      advance(25 * 60); // 19 x 25 min = 7 h 55 min, never idle for 30 min
      expect((await client.get('/me')).status).toBe(200);
    }
    advance(25 * 60); // 8 h 20 min after sign-in
    expect((await client.get('/me')).status).toBe(401);
  });

  it('rejects a session whose authVersion is stale', async () => {
    const client = new TestClient(h.app);
    await client.login(FOUNDER);
    const user = await store.findUserByEmail(FOUNDER);
    if (user) user.authVersion += 1;
    expect((await client.get('/me')).status).toBe(401);
    expect(store.sessions.size).toBe(0);
  });

  it('rejects a session once the account is suspended', async () => {
    const client = new TestClient(h.app);
    await client.login(FOUNDER);
    const user = await store.findUserByEmail(FOUNDER);
    if (user) user.status = 'suspended';
    expect((await client.get('/me')).status).toBe(401);
  });

  it('revokeAllSessions signs a user out everywhere', async () => {
    const a = new TestClient(h.app);
    const b = new TestClient(h.app);
    await a.login(FOUNDER);
    await b.login(FOUNDER);
    const user = await store.findUserByEmail(FOUNDER);
    expect(await h.auth.revokeAllSessions(user?.id ?? '')).toBe(2);
    expect((await a.get('/me')).status).toBe(401);
    expect((await b.get('/me')).status).toBe(401);
  });

  it('ignores malformed or forged cookies', async () => {
    const forged = await request(h.app)
      .get('/api/v1/me')
      .set('Cookie', 'cofoundry-dev=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect(forged.status).toBe(401);
    const junk = await request(h.app).get('/api/v1/me').set('Cookie', 'cofoundry-dev=<script>');
    expect(junk.status).toBe(401);
  });
});

describe('POST /auth/logout', () => {
  it('revokes the session and clears the cookie; the old cookie stops working', async () => {
    const client = new TestClient(h.app);
    const login = await client.login(FOUNDER);
    const oldToken = sessionCookie(login) ?? '';
    const res = await client.post('/auth/logout');
    expect(res.status).toBe(204);
    expect((res.headers['set-cookie'] as unknown as string[])[0]).toMatch(
      /^cofoundry-dev=; Path=\/; Max-Age=0/,
    );
    expect(store.sessions.size).toBe(0);
    const replay = await request(h.app)
      .get('/api/v1/me')
      .set('Cookie', `cofoundry-dev=${oldToken}`);
    expect(replay.status).toBe(401);
  });

  it('requires CSRF', async () => {
    const client = new TestClient(h.app);
    await client.login(FOUNDER);
    const res = await client.agent.post('/api/v1/auth/logout').set('Origin', TEST_ORIGIN).send({});
    expect(res.status).toBe(403);
    expect((await client.get('/me')).status).toBe(200);
  });
});

describe('authorization (server-side RBAC and ownership)', () => {
  it('denies signed-out callers before any role check', async () => {
    const res = await request(h.app).get('/api/v1/__test/founder-only');
    expect(res.status).toBe(401);
  });

  it('isolates roles: 403 for a role the user lacks, 200 for one they hold', async () => {
    const candidate = new TestClient(h.app);
    await candidate.login(CANDIDATE);
    expect((await candidate.get('/__test/founder-only')).status).toBe(403);
    expect((await candidate.get('/__test/moderator-only')).status).toBe(403);

    const moderator = new TestClient(h.app);
    await moderator.login(MODERATOR);
    expect((await moderator.get('/__test/moderator-only')).status).toBe(200);
    expect((await moderator.get('/__test/founder-only')).status).toBe(403);

    const dual = new TestClient(h.app);
    await dual.login(DUAL);
    expect((await dual.get('/__test/founder-only')).status).toBe(200);
    expect((await dual.get('/__test/moderator-only')).status).toBe(403);
  });

  it('reports resources owned by someone else as not found', async () => {
    const founder = await store.findUserByEmail(FOUNDER);
    const candidate = await store.findUserByEmail(CANDIDATE);
    const client = new TestClient(h.app);
    await client.login(FOUNDER);
    expect((await client.get(`/__test/owned/${founder?.id}`)).status).toBe(200);
    const other = await client.get(`/__test/owned/${candidate?.id}`);
    expect(other.status).toBe(404);
    expect(other.body.error.code).toBe('NOT_FOUND');
  });

  it('takes identity from the session, never from the request', async () => {
    const client = new TestClient(h.app);
    await client.login(CANDIDATE);
    const res = await client.agent
      .get('/api/v1/__test/founder-only')
      .set('X-User-Id', 'admin')
      .query({ role: 'founder', userId: 'x' });
    expect(res.status).toBe(403);
  });
});

describe('session sweeper', () => {
  it('purges absolutely-expired and idle sessions but keeps live ones', async () => {
    const live = new TestClient(h.app);
    const idle = new TestClient(h.app);
    await idle.login(CANDIDATE);
    advance(20 * 60);
    await live.login(FOUNDER);
    await new TestClient(h.app).refreshCsrf(); // anonymous, 15-minute expiry
    advance(16 * 60); // idle session: 36 min unused; anonymous: expired; live: 16 min
    expect(await h.auth.purgeExpiredSessions()).toBe(2);
    expect(store.sessions.size).toBe(1);
    expect((await live.get('/me')).status).toBe(200);
  });
});
