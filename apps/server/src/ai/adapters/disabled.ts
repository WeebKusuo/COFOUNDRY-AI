import { ProviderCallError } from '../errors.js';
import { PROMPT_VERSIONS } from '../prompts.js';
import type { AiCapability, CapabilityAdapter } from '../types.js';

/**
 * The production-safe default. Every call fails with `disabled`, which callers surface as
 * "AI interviewer unavailable" — never as a fabricated question, score or report.
 */
export function createDisabledAdapter<C extends AiCapability>(capability: C): CapabilityAdapter<C> {
  return {
    descriptor: {
      capability,
      providerId: 'disabled',
      model: null,
      adapterVersion: '1',
      promptVersion: PROMPT_VERSIONS[capability],
    },
    run: async () => {
      throw new ProviderCallError('disabled', `No provider is configured for ${capability}.`);
    },
  };
}
