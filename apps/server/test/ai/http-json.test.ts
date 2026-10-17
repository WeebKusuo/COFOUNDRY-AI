import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProviderCallError, createHttpJsonTransport } from '../../src/ai/index.js';

let server: http.Server;
let baseUrl: string;
const seen: Array<{ url: string; auth: string | undefined; body: string }> = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      seen.push({ url: req.url ?? '', auth: req.headers.authorization, body });
      switch (req.url) {
        case '/v1/ok':
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ question: 'Why?' }));
          return;
        case '/v1/fail':
          res.statusCode = 500;
          res.end('internal details');
          return;
        case '/v1/text':
          res.end('not json');
          return;
        case '/v1/redirect':
          res.statusCode = 302;
          res.setHeader('location', 'http://169.254.169.254/');
          res.end();
          return;
        case '/v1/huge':
          res.end(JSON.stringify({ blob: 'x'.repeat(5000) }));
          return;
        case '/v1/slow':
          setTimeout(() => res.end('{}'), 1000);
          return;
        default:
          res.statusCode = 404;
          res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

function transport(maxResponseBytes?: number) {
  return createHttpJsonTransport({
    baseUrl,
    apiKey: 'test-key',
    allowInsecureHttp: true,
    ...(maxResponseBytes ? { maxResponseBytes } : {}),
  });
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (err) {
    return err instanceof ProviderCallError ? err.code : `other:${String(err)}`;
  }
}

describe('createHttpJsonTransport', () => {
  it('posts JSON with a bearer key and parses the response', async () => {
    const out = await transport().postJson('ok', { a: 1 }, new AbortController().signal);
    expect(out).toEqual({ question: 'Why?' });
    const last = seen.at(-1);
    expect(last?.auth).toBe('Bearer test-key');
    expect(JSON.parse(last?.body ?? '')).toEqual({ a: 1 });
  });

  it('maps non-2xx to upstream_failed without exposing the body', async () => {
    const p = transport().postJson('fail', {}, new AbortController().signal);
    expect(await codeOf(p)).toBe('upstream_failed');
  });

  it('maps non-JSON to invalid_output', async () => {
    expect(await codeOf(transport().postJson('text', {}, new AbortController().signal))).toBe(
      'invalid_output',
    );
  });

  it('refuses to follow redirects', async () => {
    expect(await codeOf(transport().postJson('redirect', {}, new AbortController().signal))).toBe(
      'upstream_failed',
    );
  });

  it('caps response size', async () => {
    expect(await codeOf(transport(1000).postJson('huge', {}, new AbortController().signal))).toBe(
      'invalid_output',
    );
  });

  it('propagates the abort reason (timeout)', async () => {
    const controller = new AbortController();
    const p = transport().postJson('slow', {}, controller.signal);
    setTimeout(() => controller.abort(new ProviderCallError('timeout', 'timeout')), 50);
    expect(await codeOf(p)).toBe('timeout');
  });

  it('rejects plain http unless explicitly allowed, and credentials in URLs', () => {
    expect(() => createHttpJsonTransport({ baseUrl: 'http://models.example.com' })).toThrow(
      /https/,
    );
    expect(() => createHttpJsonTransport({ baseUrl: 'https://u:p@models.example.com' })).toThrow();
  });

  it('rejects path traversal or absolute endpoint paths', async () => {
    await expect(
      transport().postJson('../admin', {}, new AbortController().signal),
    ).rejects.toThrow(/Invalid endpoint/);
    await expect(
      transport().postJson('https://evil.example/x', {}, new AbortController().signal),
    ).rejects.toThrow(/Invalid endpoint/);
  });
});
