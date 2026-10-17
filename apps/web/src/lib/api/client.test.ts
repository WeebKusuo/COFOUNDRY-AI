import { describe, expect, it, vi } from 'vitest';
import { ApiError, api, buildUrl, setCsrfTokenProvider } from './client';
import { mockFetch } from '../../test/render';

describe('buildUrl', () => {
  it('always produces same-origin /api/v1 URLs', () => {
    expect(buildUrl('/health')).toBe('/api/v1/health');
    expect(buildUrl('/interviews', { role: 'founder', limit: 20, cursor: undefined })).toBe(
      '/api/v1/interviews?role=founder&limit=20',
    );
  });

  it('refuses absolute or protocol-relative paths', () => {
    expect(() => buildUrl('https://evil.example/x')).toThrow();
    expect(() => buildUrl('//evil.example/x')).toThrow();
  });
});

describe('api.get', () => {
  it('unwraps the data envelope and sends same-origin credentials', async () => {
    const fetchSpy = vi.fn(
      mockFetch(() => ({ status: 200, body: { data: { status: 'ok' }, requestId: 'r1' } })),
    );
    vi.stubGlobal('fetch', fetchSpy);
    await expect(api.get('/health')).resolves.toEqual({ status: 'ok' });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/health');
    expect(init.credentials).toBe('same-origin');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
  });

  it('maps the error envelope to ApiError with field errors and request id', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(() => ({
        status: 422,
        body: {
          error: {
            code: 'VALIDATION_FAILED',
            message: 'Some fields are invalid.',
            fieldErrors: { 'body.title': ['Required'] },
          },
          requestId: 'req-9',
        },
      })),
    );
    const err = await api.get('/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 422,
      code: 'VALIDATION_FAILED',
      fieldErrors: { 'body.title': ['Required'] },
      requestId: 'req-9',
      isRetryable: false,
    });
  });

  it('reads Retry-After on 429', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(() => ({
        status: 429,
        headers: { 'Retry-After': '17' },
        body: { error: { code: 'RATE_LIMITED', message: 'Too many requests.' }, requestId: 'r' },
      })),
    );
    const err = (await api.get('/x').catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.retryAfterSeconds).toBe(17);
    expect(err.isRetryable).toBe(true);
  });

  it('turns a network failure into NETWORK_ERROR', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    const err = (await api.get('/x').catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe('NETWORK_ERROR');
    expect(err.status).toBe(0);
  });

  it('turns an HTML proxy error page into INVALID_RESPONSE', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(() => ({ status: 502, body: '<html>Bad gateway</html>' })),
    );
    const err = (await api.get('/x').catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe('INVALID_RESPONSE');
    expect(err.isRetryable).toBe(true);
  });
});

describe('api.send', () => {
  it('sends JSON with an empty {} body by default and the CSRF token when registered', async () => {
    const fetchSpy = vi.fn(
      mockFetch(() => ({ status: 200, body: { data: { ok: true }, requestId: 'r' } })),
    );
    vi.stubGlobal('fetch', fetchSpy);
    setCsrfTokenProvider(() => 'csrf-123');
    await api.send('POST', '/startups/1/close');
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(init.body).toBe('{}');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-CSRF-Token']).toBe('csrf-123');
    setCsrfTokenProvider(() => null);
  });

  it('returns undefined for 204 No Content', async () => {
    vi.stubGlobal('fetch', async () => new Response(null, { status: 204 }));
    await expect(api.send('DELETE', '/blocks/abc')).resolves.toBeUndefined();
  });
});
