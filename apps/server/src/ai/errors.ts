import type { ProviderErrorCode } from './types.js';

/** Thrown by adapters/transports; mapped to a ProviderResult error by invokeCapability. */
export class ProviderCallError extends Error {
  readonly code: ProviderErrorCode;
  /** Provider-suggested wait before retrying (429 Retry-After), when known. */
  readonly retryAfterMs: number | undefined;
  constructor(code: ProviderErrorCode, message: string, options: { retryAfterMs?: number } = {}) {
    super(message);
    this.name = 'ProviderCallError';
    this.code = code;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export class AiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiConfigError';
  }
}
