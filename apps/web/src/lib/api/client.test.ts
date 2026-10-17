import { describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  api,
  buildUrl,
  currentCsrfToken,
  onUnauthenticated,
  resetCsrfToken,
} from './client';
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

describe('api.send and CSRF', () => {
  const ok = (data: unknown) => ({ status: 200, body: { data, requestId: 'r' } });

  it('fetches a CSRF token first, then sends JSON with X-CSRF-Token', async () => {
    resetCsrfToken();
    const fetchSpy = vi.fn(
      mockFetch((url) =>
        url === '/api/v1/auth/csrf' ? ok({ csrfToken: 'tok-1' }) : ok({ ok: true }),
      ),
    );
    vi.stubGlobal('fetch', fetchSpy);
    await api.send('POST', '/startups/1/close');
    expect(fetchSpy.mock.calls.map((c) => c[0])).toEqual([
      '/api/v1/auth/csrf',
      '/api/v1/startups/1/close',
    ]);
    const init = fetchSpy.mock.calls[1]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(init.body).toBe('{}');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-CSRF-Token']).toBe('tok-1');
    expect(currentCsrfToken()).toBe('tok-1');
  });

  it('reuses the cached token and never sends it on GET', async () => {
    const fetchSpy = vi.fn(mockFetch(() => ok({ ok: true })));
    vi.stubGlobal('fetch', fetchSpy);
    await api.get('/me');
    await api.send('PUT', '/x', { a: 1 });
    expect(fetchSpy.mock.calls.map((c) => c[0])).toEqual(['/api/v1/me', '/api/v1/x']);
    const getHeaders = (fetchSpy.mock.calls[0]?.[1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(getHeaders['X-CSRF-Token']).toBeUndefined();
  });

  it('refetches the token once and retries when the server rejects it as stale', async () => {
    resetCsrfToken();
    let csrfCalls = 0;
    let postCalls = 0;
    const fetchSpy = vi.fn(
      mockFetch((url, init) => {
        if (url === '/api/v1/auth/csrf') {
          csrfCalls += 1;
          return ok({ csrfToken: `tok-${csrfCalls}` });
        }
        postCalls += 1;
        const token = (init?.headers as Record<string, string>)['X-CSRF-Token'];
        return token === 'tok-2'
          ? ok({ done: true })
          : {
              status: 403,
              body: { error: { code: 'CSRF_INVALID', message: 'stale' }, requestId: 'r' },
            };
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    await expect(api.send('POST', '/thing')).resolves.toEqual({ done: true });
    expect(csrfCalls).toBe(2);
    expect(postCalls).toBe(2);
  });

  it('does not loop when the retry is also rejected', async () => {
    resetCsrfToken();
    const fetchSpy = vi.fn(
      mockFetch((url) =>
        url === '/api/v1/auth/csrf'
          ? ok({ csrfToken: 'tok' })
          : {
              status: 403,
              body: { error: { code: 'CSRF_INVALID', message: 'no' }, requestId: 'r' },
            },
      ),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const err = (await api.send('POST', '/thing').catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe('CSRF_INVALID');
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it('returns undefined for 204 No Content', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) =>
      String(input).endsWith('/auth/csrf')
        ? new Response(JSON.stringify({ data: { csrfToken: 't' }, requestId: 'r' }), {
            status: 200,
          })
        : new Response(null, { status: 204 }),
    );
    await expect(api.send('DELETE', '/blocks/abc')).resolves.toBeUndefined();
  });
});

describe('unauthenticated notifications', () => {
  it('notifies listeners on 401 except for the sign-in call itself', async () => {
    resetCsrfToken();
    const seen: string[] = [];
    const off = onUnauthenticated((path) => seen.push(path));
    vi.stubGlobal(
      'fetch',
      mockFetch((url) =>
        url === '/api/v1/auth/csrf'
          ? { status: 200, body: { data: { csrfToken: 't' }, requestId: 'r' } }
          : {
              status: 401,
              body: { error: { code: 'UNAUTHENTICATED', message: 'x' }, requestId: 'r' },
            },
      ),
    );
    await api.get('/me').catch(() => undefined);
    await api.send('POST', '/auth/login', { email: 'a', password: 'b' }).catch(() => undefined);
    off();
    expect(seen).toEqual(['/me']);
  });
});
