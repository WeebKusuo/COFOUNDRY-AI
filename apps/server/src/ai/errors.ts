import type { ProviderErrorCode } from './types.js';

/** Thrown by adapters/transports; mapped to a ProviderResult error by invokeCapability. */
export class ProviderCallError extends Error {
  readonly code: ProviderErrorCode;
  constructor(code: ProviderErrorCode, message: string) {
    super(message);
    this.name = 'ProviderCallError';
    this.code = code;
  }
}

export class AiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiConfigError';
  }
}
