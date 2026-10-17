import { createDisabledAdapter } from './adapters/disabled.js';
import { AiConfigError } from './errors.js';
import {
  AI_CAPABILITIES,
  type AiCapability,
  type AiProviderSettings,
  type CapabilityAdapter,
  type ProviderDescriptor,
} from './types.js';

/**
 * A factory builds adapters for a provider label from server-side configuration. Each phase that
 * introduces a real model registers its factory in PROVIDER_FACTORIES (one file per provider in
 * src/ai/adapters/), with tests, a recorded model identifier and calibration notes.
 */
export type ProviderFactory = (
  settings: AiProviderSettings,
) => Partial<{ [C in AiCapability]: CapabilityAdapter<C> }>;

export const PROVIDER_FACTORIES: Readonly<Record<string, ProviderFactory>> = Object.freeze({
  disabled: () => ({}),
});

export class AiProviderRegistry {
  private readonly adapters = new Map<AiCapability, CapabilityAdapter>();

  constructor(initial: Partial<{ [C in AiCapability]: CapabilityAdapter<C> }> = {}) {
    for (const capability of AI_CAPABILITIES) {
      const adapter = initial[capability] ?? createDisabledAdapter(capability);
      if (adapter.descriptor.capability !== capability) {
        throw new AiConfigError(
          `Adapter ${adapter.descriptor.providerId} declares ${adapter.descriptor.capability} ` +
            `but was registered for ${capability}.`,
        );
      }
      this.adapters.set(capability, adapter);
    }
  }

  get<C extends AiCapability>(capability: C): CapabilityAdapter<C> {
    return this.adapters.get(capability) as CapabilityAdapter<C>;
  }

  isEnabled(capability: AiCapability): boolean {
    return this.get(capability).descriptor.providerId !== 'disabled';
  }

  /** Safe summary for logs and release notes; contains no credentials. */
  describe(): ProviderDescriptor[] {
    return AI_CAPABILITIES.map((c) => ({ ...this.get(c).descriptor }));
  }
}

export function createAiRegistry(
  config: AiProviderSettings,
  factories: Readonly<Record<string, ProviderFactory>> = PROVIDER_FACTORIES,
): AiProviderRegistry {
  const factory = factories[config.provider];
  if (!factory) {
    throw new AiConfigError(
      `Unknown LLM_PROVIDER "${config.provider}". Known providers: ` +
        `${Object.keys(factories).sort().join(', ')}.`,
    );
  }
  return new AiProviderRegistry(factory(config));
}
