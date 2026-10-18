import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildHarness } from './support/harness.js';

let dist: string;

beforeAll(() => {
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'cofoundry-web-'));
  fs.mkdirSync(path.join(dist, 'assets'));
  fs.writeFileSync(
    path.join(dist, 'index.html'),
    '<!doctype html><html><head><title>CoFoundry AI</title></head><body></body></html>',
  );
  fs.writeFileSync(path.join(dist, 'assets', 'app-abc123.js'), 'console.log(1)');
});

afterAll(() => fs.rmSync(dist, { recursive: true, force: true }));

function app() {
  return buildHarness({ config: { serveWeb: true, webDistDir: dist } }).app;
}

describe('same-origin SPA hosting', () => {
  it('serves index.html at / without caching', async () => {
    const res = await request(app()).get('/').set('Accept', 'text/html');
    expect(res.status).toBe(200);
    expect(res.text).toContain('CoFoundry AI');
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('injects a per-response CSP nonce matching the style-src header', async () => {
    const a = await request(app()).get('/').set('Accept', 'text/html');
    const b = await request(app()).get('/').set('Accept', 'text/html');
    const nonce = /<meta name="csp-nonce" nonce="([^"]+)"/.exec(a.text)?.[1];
    expect(nonce).toBeTruthy();
    expect(a.headers['content-security-policy']).toContain(`'nonce-${nonce}'`);
    expect(b.text).not.toContain(nonce!);
  });

  it('falls back to index.html for client routes', async () => {
    const res = await request(app()).get('/founder/briefs').set('Accept', 'text/html');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('caches hashed assets immutably', async () => {
    const res = await request(app()).get('/assets/app-abc123.js');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('immutable');
  });

  it('returns a plain 404 for a missing asset instead of the SPA shell', async () => {
    const res = await request(app()).get('/assets/missing.js');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).not.toContain('text/html');
  });

  it('never applies the SPA fallback to /api', async () => {
    const res = await request(app()).get('/api/v2/unknown').set('Accept', 'text/html');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body.error.code).toBe('NOT_FOUND');
    const v1 = await request(app()).get('/api/v1/unknown').set('Accept', 'text/html');
    expect(v1.headers['content-type']).toContain('application/json');
  });
});
