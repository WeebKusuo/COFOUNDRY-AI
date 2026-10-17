import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { z } from 'zod';
import { createApp } from '../src/http/app.js';
import { createRateLimiter } from '../src/http/middleware/rate-limit.js';
import { AppError } from '../src/http/errors.js';
import { withValidation } from '../src/http/validation.js';
import { sendData } from '../src/http/respond.js';
import { TEST_ORIGIN, silentLogger, testConfig } from './helpers.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function buildApp(extra?: Parameters<typeof createApp>[0]['extraV1Routes']) {
  return createApp({ config: testConfig(), logger: silentLogger, extraV1Routes: extra });
}

/** Test-only routes that exercise the shared middleware without inventing product endpoints. */
const testRoutes: Parameters<typeof createApp>[0]['extraV1Routes'] = (router) => {
  router.post(
    '/__test/echo',
    withValidation(
      {
        body: z.strictObject({
          title: z.string().min(1).max(100),
          hours: z.number().int().min(1).max(40),
        }),
      },
      ({ body }, _req, res) => sendData(res, body, 201),
    ),
  );
  router.get('/__test/boom', () => {
    throw new Error('database password is hunter2');
  });
  router.get('/__test/conflict', () => {
    throw new AppError('VERSION_CONFLICT', 'The record changed. Refresh and try again.');
  });
};

describe('GET /api/v1/health', () => {
  it('returns liveness in the standard envelope with a server requestId', async () => {
    const res = await request(buildApp()).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { status: 'ok' }, requestId: expect.stringMatching(UUID) });
    expect(res.headers['x-request-id']).toBe(res.body.requestId);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('ignores client-supplied request ids', async () => {
    const res = await request(buildApp()).get('/api/v1/health').set('X-Request-Id', 'spoofed');
    expect(res.body.requestId).not.toBe('spoofed');
  });

  it('reveals no internals', async () => {
    const res = await request(buildApp()).get('/api/v1/health');
    expect(Object.keys(res.body.data)).toEqual(['status']);
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('security headers', () => {
  it('sends a strict same-origin CSP without unsafe-eval', async () => {
    const res = await request(buildApp()).get('/api/v1/health');
    const csp = res.headers['content-security-policy'] as string;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toContain('unsafe-inline');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('enables HSTS only in production', async () => {
    const dev = await request(buildApp()).get('/api/v1/health');
    expect(dev.headers['strict-transport-security']).toBeUndefined();
    const prodApp = createApp({
      config: testConfig({ isProduction: true, appOrigin: 'https://app.example.com' }),
      logger: silentLogger,
    });
    const prod = await request(prodApp).get('/api/v1/health');
    expect(prod.headers['strict-transport-security']).toContain('max-age=31536000');
  });
});

describe('error envelope', () => {
  it('returns 404 NOT_FOUND JSON for unknown API routes', async () => {
    const res = await request(buildApp()).get('/api/v1/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: { code: 'NOT_FOUND', message: expect.any(String) },
      requestId: expect.stringMatching(UUID),
    });
  });

  it('maps AppError to its stable code and status', async () => {
    const res = await request(buildApp(testRoutes)).get('/api/v1/__test/conflict');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('VERSION_CONFLICT');
  });

  it('hides unexpected error details and stack traces', async () => {
    const res = await request(buildApp(testRoutes)).get('/api/v1/__test/boom');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
    expect(JSON.stringify(res.body)).not.toContain('at ');
  });
});

describe('mutation guards', () => {
  const app = buildApp(testRoutes);
  const valid = { title: 'Task API', hours: 8 };

  it('rejects a mutation without Origin', async () => {
    const res = await request(app).post('/api/v1/__test/echo').send(valid);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_INVALID');
  });

  it('rejects a mutation from another origin', async () => {
    const res = await request(app)
      .post('/api/v1/__test/echo')
      .set('Origin', 'https://evil.example')
      .send(valid);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_INVALID');
  });

  it('accepts a same-origin JSON mutation', async () => {
    const res = await request(app)
      .post('/api/v1/__test/echo')
      .set('Origin', TEST_ORIGIN)
      .send(valid);
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual(valid);
  });

  it('rejects multipart uploads', async () => {
    const res = await request(app)
      .post('/api/v1/__test/echo')
      .set('Origin', TEST_ORIGIN)
      .attach('file', Buffer.from('x'), 'x.txt');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('rejects non-JSON bodies', async () => {
    const res = await request(app)
      .post('/api/v1/__test/echo')
      .set('Origin', TEST_ORIGIN)
      .set('Content-Type', 'text/plain')
      .send('title=x');
    expect(res.status).toBe(400);
  });

  it('rejects malformed JSON with 400', async () => {
    const res = await request(app)
      .post('/api/v1/__test/echo')
      .set('Origin', TEST_ORIGIN)
      .set('Content-Type', 'application/json')
      .send('{"title":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('rejects bodies over 128 KiB with 413 BODY_TOO_LARGE', async () => {
    const res = await request(app)
      .post('/api/v1/__test/echo')
      .set('Origin', TEST_ORIGIN)
      .send({ title: 'x'.repeat(130 * 1024), hours: 1 });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('BODY_TOO_LARGE');
  });
});

describe('validation', () => {
  const app = buildApp(testRoutes);

  it('rejects unknown fields instead of dropping them', async () => {
    const res = await request(app)
      .post('/api/v1/__test/echo')
      .set('Origin', TEST_ORIGIN)
      .send({ title: 'ok', hours: 3, role: 'admin' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.fieldErrors).toEqual({ 'body.role': ['Unknown field.'] });
  });

  it('reports every invalid field', async () => {
    const res = await request(app)
      .post('/api/v1/__test/echo')
      .set('Origin', TEST_ORIGIN)
      .send({ title: '', hours: 2.5 });
    expect(res.status).toBe(422);
    expect(Object.keys(res.body.error.fieldErrors).sort()).toEqual(['body.hours', 'body.title']);
  });
});

describe('rate limiting', () => {
  it('answers 429 RATE_LIMITED with Retry-After once the limit is exceeded', async () => {
    const app = createApp({
      config: testConfig(),
      logger: silentLogger,
      apiRateLimiter: createRateLimiter({ windowMs: 60_000, limit: 2 }),
    });
    await request(app).get('/api/v1/nope');
    await request(app).get('/api/v1/nope');
    const res = await request(app).get('/api/v1/nope');
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('never limits the health endpoint', async () => {
    const app = buildApp();
    for (let i = 0; i < 125; i += 1) {
      const res = await request(app).get('/api/v1/health');
      expect(res.status).toBe(200);
    }
  });
});
