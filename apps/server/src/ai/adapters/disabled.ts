import { ProviderCallError } from '../errors.js';
import type { AiCapability, CapabilityAdapter } from '../types.js';

/**
 * The production-safe default. Every call fails with `disabled`, which callers surface as
 * "assessment unavailable" — never as a fabricated score or a seeded report (Section 01).
 */
export function createDisabledAdapter<C extends AiCapability>(capability: C): CapabilityAdapter<C> {
  return {
    descriptor: { capability, providerId: 'disabled', model: null, adapterVersion: '1' },
    run: async () => {
      throw new ProviderCallError('disabled', `No provider is configured for ${capability}.`);
    },
  };
}
