import type { z } from 'zod';
import { ProviderCallError } from './errors.js';
import type { AiProviderRegistry } from './registry.js';
import {
  MEDIA_CAPABILITIES,
  type AiCapability,
  type AiLogger,
  type CallMeta,
  type CapabilityInputs,
  type ConsentProof,
  type ProviderResult,
} from './types.js';

export interface InvokeOptions<T> {
  /** Hard per-call timeout (Section 10: 30 s evaluation, 10 s follow-up). */
  timeoutMs: number;
  /** Strict schema for the provider output. Failures are never clamped or repaired. */
  outputSchema: z.ZodType<T>;
  logger: AiLogger;
  /** Required for audio/video capabilities. */
  consent?: ConsentProof;
  /** Outer cancellation, e.g. consent withdrawn while a job runs (Section 24). */
  signal?: AbortSignal;
}

const CONSENT_PURPOSE: Partial<Record<AiCapability, ConsentProof['purpose']>> = {
  speech_analysis: 'interview_audio',
  video_signals: 'interview_video',
};

/**
 * The single path through which business code calls any AI capability. It applies, uniformly:
 * consent checks, timeouts, cancellation, strict output validation and metadata-only logging.
 * Callers decide retries and budgets (Section 10); this function performs exactly one attempt.
 */
export async function invokeCapability<C extends AiCapability, T>(
  registry: AiProviderRegistry,
  capability: C,
  input: CapabilityInputs[C],
  options: InvokeOptions<T>,
): Promise<ProviderResult<T>> {
  const adapter = registry.get(capability);
  const { providerId, model } = adapter.descriptor;
  const started = performance.now();
  const meta = (extra: Partial<CallMeta> = {}): CallMeta => ({
    providerId,
    model,
    latencyMs: Math.round(performance.now() - started),
    ...extra,
  });
  const fail = (code: ProviderCallError['code'], message: string, m: CallMeta) => {
    options.logger.warn(
      { capability, providerId, model, latencyMs: m.latencyMs, code },
      'ai call failed',
    );
    return { ok: false as const, error: { code, message }, meta: m };
  };

  if (MEDIA_CAPABILITIES.has(capability)) {
    const purpose = CONSENT_PURPOSE[capability];
    if (!options.consent || options.consent.purpose !== purpose) {
      return fail('consent_missing', `Explicit ${purpose} consent is required.`, meta());
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new ProviderCallError('timeout', 'timeout')),
    options.timeoutMs,
  );
  const onOuterAbort = () => controller.abort(new ProviderCallError('cancelled', 'cancelled'));
  if (options.signal?.aborted) onOuterAbort();
  options.signal?.addEventListener('abort', onOuterAbort, { once: true });

  try {
    const abortPromise = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
        once: true,
      });
      if (controller.signal.aborted) reject(controller.signal.reason);
    });
    const ctx = options.consent
      ? { signal: controller.signal, consent: options.consent }
      : { signal: controller.signal };
    const raw = await Promise.race([adapter.run(input, ctx), abortPromise]);
    const usage = raw.usage ?? {};
    const m = meta({
      ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
      ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
    });
    const parsed = options.outputSchema.safeParse(raw.output);
    if (!parsed.success) {
      return fail('invalid_output', 'The provider returned output that failed validation.', m);
    }
    options.logger.info(
      {
        capability,
        providerId,
        model,
        latencyMs: m.latencyMs,
        inputTokens: m.inputTokens,
        outputTokens: m.outputTokens,
      },
      'ai call succeeded',
    );
    return { ok: true, value: parsed.data, meta: m };
  } catch (err) {
    if (err instanceof ProviderCallError) return fail(err.code, err.message, meta());
    return fail('upstream_failed', 'The provider call failed.', meta());
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onOuterAbort);
  }
}
