import {
  API_PREFIX,
  isApiErrorBody,
  type ApiList,
  type ApiSuccess,
  type ErrorCode,
  type FieldErrors,
} from '@cofoundry/shared';

/**
 * Typed API client (Section 17/22). Always same-origin relative URLs; the session cookie travels
 * automatically, tokens never touch localStorage. Every failure becomes an ApiError with a stable
 * code so screens can render validation, forbidden/not-found and retry states consistently.
 */

export type ClientErrorCode = ErrorCode | 'NETWORK_ERROR' | 'INVALID_RESPONSE';

export class ApiError extends Error {
  readonly status: number;
  readonly code: ClientErrorCode;
  readonly fieldErrors: FieldErrors | undefined;
  readonly requestId: string | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(init: {
    status: number;
    code: ClientErrorCode;
    message: string;
    fieldErrors?: FieldErrors | undefined;
    requestId?: string | undefined;
    retryAfterSeconds?: number | undefined;
  }) {
    super(init.message);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.fieldErrors = init.fieldErrors;
    this.requestId = init.requestId;
    this.retryAfterSeconds = init.retryAfterSeconds;
  }

  /** 4xx errors other than rate limiting will not succeed on a blind retry. */
  get isRetryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

type CsrfProvider = () => string | null;
let csrfProvider: CsrfProvider = () => null;

/** Phase 2 registers the session CSRF token source here; mutations then send X-CSRF-Token. */
export function setCsrfTokenProvider(provider: CsrfProvider): void {
  csrfProvider = provider;
}

export function buildUrl(path: string, query?: RequestOptions['query']): string {
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new Error('API paths must be relative to /api/v1 and start with a single "/".');
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) params.set(key, String(value));
  }
  const qs = params.toString();
  return `${API_PREFIX}${path}${qs ? `?${qs}` : ''}`;
}

async function request(path: string, options: RequestOptions = {}): Promise<unknown> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json', ...options.headers };
  let body: string | undefined;
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body ?? {});
    const csrf = csrfProvider();
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), {
      method,
      headers,
      body,
      credentials: 'same-origin',
      cache: 'no-store',
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError({
      status: 0,
      code: 'NETWORK_ERROR',
      message: 'Could not reach the server. Check your connection and try again.',
    });
  }

  if (response.status === 204) return undefined;

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError({
      status: response.status,
      code: 'INVALID_RESPONSE',
      message: 'The server sent an unexpected response. Try again.',
    });
  }

  if (!response.ok) {
    const retryAfter = Number(response.headers.get('Retry-After'));
    if (isApiErrorBody(payload)) {
      throw new ApiError({
        status: response.status,
        code: payload.error.code,
        message: payload.error.message,
        fieldErrors: payload.error.fieldErrors,
        requestId: payload.requestId,
        retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
      });
    }
    throw new ApiError({
      status: response.status,
      code: 'INVALID_RESPONSE',
      message: 'The server sent an unexpected response. Try again.',
    });
  }
  return payload;
}

function assertEnvelope(payload: unknown): void {
  if (typeof payload !== 'object' || payload === null || !('data' in payload)) {
    throw new ApiError({
      status: 200,
      code: 'INVALID_RESPONSE',
      message: 'The server sent an unexpected response. Try again.',
    });
  }
}

export const api = {
  /** Returns `data` from a {data, requestId} envelope. */
  async get<T>(path: string, options: Omit<RequestOptions, 'method' | 'body'> = {}): Promise<T> {
    const payload = await request(path, { ...options, method: 'GET' });
    assertEnvelope(payload);
    return (payload as ApiSuccess<T>).data;
  },
  /** Returns the full list envelope including nextCursor. */
  async list<T>(path: string, options: Omit<RequestOptions, 'method' | 'body'> = {}) {
    const payload = await request(path, { ...options, method: 'GET' });
    assertEnvelope(payload);
    return payload as ApiList<T>;
  },
  async send<T>(
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body: unknown = {},
    options: Omit<RequestOptions, 'method' | 'body'> = {},
  ): Promise<T | undefined> {
    const payload = await request(path, { ...options, method, body });
    if (payload === undefined) return undefined;
    assertEnvelope(payload);
    return (payload as ApiSuccess<T>).data;
  },
};
