import { createDisabledAdapter } from './adapters/disabled.js';
import { createMockAdapters } from './adapters/mock.js';
import { createOpenAiCompatibleAdapters } from './adapters/openai-compatible.js';
import { AiConfigError } from './errors.js';
import {
  AI_CAPABILITIES,
  type AiCapability,
  type AiProviderSettings,
  type CapabilityAdapter,
  type ProviderDescriptor,
} from './types.js';

/**
 * A factory builds adapters for a provider label from server-side configuration. Each provider
 * lives in src/ai/adapters/ with tests and documented licence/hosting terms
 * (docs/architecture/AI_PROVIDER_ARCHITECTURE.md).
 */
export type ProviderFactory = (
  settings: AiProviderSettings,
) => Partial<{ [C in AiCapability]: CapabilityAdapter<C> }>;

export const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

function openAiCompatible(providerId: string, defaultBaseUrl: string | null): ProviderFactory {
  return (settings) => {
    const baseUrl = settings.baseUrl ?? defaultBaseUrl;
    if (!baseUrl)
      throw new AiConfigError(`LLM_BASE_URL is required for LLM_PROVIDER=${providerId}.`);
    if (!settings.apiKey || !settings.interviewerModel || !settings.evaluatorModel) {
      throw new AiConfigError(
        `LLM_API_KEY, LLM_INTERVIEWER_MODEL and LLM_EVALUATOR_MODEL are required for ${providerId}.`,
      );
    }
    try {
      return createOpenAiCompatibleAdapters({
        providerId,
        baseUrl,
        apiKey: settings.apiKey,
        interviewerModel: settings.interviewerModel,
        evaluatorModel: settings.evaluatorModel,
        allowInsecureHttp: settings.allowInsecureHttp ?? false,
      });
    } catch (err) {
      throw new AiConfigError(err instanceof Error ? err.message : String(err));
    }
  };
}

export const PROVIDER_FACTORIES: Readonly<Record<string, ProviderFactory>> = Object.freeze({
  disabled: () => ({}),
  /** Groq's hosted OpenAI-compatible API serving open-weight models (free tier available). */
  groq: openAiCompatible('groq', GROQ_BASE_URL),
  /** Any self-hosted OpenAI-compatible server (vLLM, llama.cpp server, Ollama /v1). */
  'openai-compatible': openAiCompatible('openai-compatible', null),
  /** Deterministic test double; refused in production by config/env.ts. */
  mock: () => createMockAdapters(),
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

  /** True when every capability has a provider (the interview needs all of them). */
  allEnabled(): boolean {
    return AI_CAPABILITIES.every((c) => this.isEnabled(c));
  }

  /** Provider labels disclosed to candidates at consent, e.g. "groq:llama-3.3-70b-versatile". */
  disclosedProviders(): string[] {
    const labels = new Set<string>();
    for (const c of AI_CAPABILITIES) {
      const d = this.get(c).descriptor;
      if (d.providerId !== 'disabled') labels.add(`${d.providerId}:${d.model ?? 'unknown'}`);
    }
    return [...labels].sort();
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
