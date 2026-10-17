import { ProviderCallError } from '../errors.js';

/**
 * Minimal JSON-over-HTTP transport for model services (e.g. the AI team's fine-tuned APIs).
 *
 * Endpoints come ONLY from server configuration — never from user input (Section 23: the backend
 * does not fetch user-supplied URLs). Redirects are refused, responses are size-capped, and the
 * API key is sent as a bearer token from the backend only.
 */

export interface HttpJsonTransportOptions {
  /** Base URL from server configuration, e.g. https://qgen.internal.example/v1 */
  baseUrl: string;
  apiKey?: string | null;
  /** Allow plain http (local development model servers only). */
  allowInsecureHttp?: boolean;
  maxResponseBytes?: number;
  fetchImpl?: typeof fetch;
}

export interface HttpJsonTransport {
  postJson(path: string, body: unknown, signal: AbortSignal): Promise<unknown>;
}

export function createHttpJsonTransport(options: HttpJsonTransportOptions): HttpJsonTransport {
  const base = new URL(options.baseUrl);
  if (base.protocol !== 'https:' && !(options.allowInsecureHttp && base.protocol === 'http:')) {
    throw new Error('Model service base URL must use https.');
  }
  if (base.username || base.password) throw new Error('Put credentials in apiKey, not the URL.');
  const maxBytes = options.maxResponseBytes ?? 1_048_576;
  const doFetch = options.fetchImpl ?? fetch;
  const basePath = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;

  return {
    async postJson(path, body, signal) {
      if (!/^[a-z0-9][a-z0-9/_-]*$/i.test(path)) throw new Error('Invalid endpoint path.');
      const url = new URL(basePath + path, base.origin);

      let response: Response;
      try {
        response = await doFetch(url, {
          method: 'POST',
          redirect: 'error',
          signal,
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
          },
          body: JSON.stringify(body),
        });
      } catch {
        if (signal.aborted) {
          const reason: unknown = signal.reason;
          throw reason instanceof ProviderCallError
            ? reason
            : new ProviderCallError('cancelled', 'Request cancelled.');
        }
        throw new ProviderCallError('upstream_failed', 'Model service unreachable.');
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new ProviderCallError(
          'upstream_failed',
          `Model service returned ${response.status}.`,
        );
      }

      const text = await readCapped(response, maxBytes);
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new ProviderCallError('invalid_output', 'Model service returned non-JSON output.');
      }
    },
  };
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProviderCallError('invalid_output', 'Model service response is too large.');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ProviderCallError('invalid_output', 'Model service response is too large.');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
