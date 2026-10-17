import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildHarness } from './support/harness.js';

describe('default rate limits (Section 23)', () => {
  it('limits CSRF bootstrap to 30 requests per minute per IP', async () => {
    const { app } = buildHarness();
    for (let i = 0; i < 30; i += 1) {
      expect((await request(app).get('/api/v1/auth/csrf')).status).toBe(200);
    }
    const limited = await request(app).get('/api/v1/auth/csrf');
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });
});
