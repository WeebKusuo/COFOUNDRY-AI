import type { z } from 'zod';
import { ProviderCallError } from './errors.js';
import type { AiProviderRegistry } from './registry.js';
import type {
  AiCapability,
  AiLogger,
  CallMeta,
  CapabilityInputs,
  ConsentProof,
  ProviderErrorCode,
  ProviderResult,
} from './types.js';

export interface RetryPolicy {
  /** Total attempts including the first (1 = no retry). */
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const NO_RETRY: RetryPolicy = { attempts: 1, baseDelayMs: 0, maxDelayMs: 0 };

export interface InvokeOptions<T> {
  /** Hard per-attempt timeout. */
  timeoutMs: number;
  /** Strict schema for the provider output. Failures are never clamped or repaired. */
  outputSchema: z.ZodType<T>;
  logger: AiLogger;
  /** Interview consent; checked before any adapter is called. */
  consent: ConsentProof | null;
  /** Outer cancellation, e.g. consent withdrawn while a job runs. */
  signal?: AbortSignal;
  /**
   * Semantic checks after the schema (evidence quotes, policy rules). Return a short reason to
   * reject the output as invalid_output (retried like any invalid output), or null to accept.
   */
  validate?: (value: T) => string | null;
  retry?: RetryPolicy;
  /** Injected for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const RETRYABLE: ReadonlySet<ProviderErrorCode> = new Set([
  'timeout',
  'upstream_failed',
  'rate_limited',
  'invalid_output',
]);

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ProviderCallError('cancelled', 'cancelled'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ProviderCallError('cancelled', 'cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Exponential backoff; a provider Retry-After wins when it is longer. */
export function backoffDelay(policy: RetryPolicy, attempt: number, retryAfterMs?: number): number {
  const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  return retryAfterMs !== undefined ? Math.max(exp, retryAfterMs) : exp;
}

/**
 * Longest time one invokeCapability call can take under `policy`: every attempt timing out plus
 * every backoff (Retry-After beyond maxDelayMs ends retrying, so delays are capped). Leases on
 * work that makes AI calls are derived from this, so a slow-but-alive call is never mistaken
 * for a crashed one.
 */
export function worstCaseCallMs(timeoutMs: number, policy: RetryPolicy): number {
  const attempts = Math.max(1, policy.attempts);
  let total = attempts * timeoutMs;
  for (let a = 1; a < attempts; a += 1) total += backoffDelay(policy, a);
  return total;
}

/**
 * The single path through which business code calls any AI capability. It applies, uniformly:
 * consent checks, per-attempt timeouts, cancellation, strict output validation, bounded retries
 * with backoff (respecting rate-limit Retry-After) and metadata-only logging.
 */
export async function invokeCapability<C extends AiCapability, T>(
  registry: AiProviderRegistry,
  capability: C,
  input: CapabilityInputs[C],
  options: InvokeOptions<T>,
): Promise<ProviderResult<T>> {
  const adapter = registry.get(capability);
  const { providerId, model, promptVersion } = adapter.descriptor;
  const policy = options.retry ?? NO_RETRY;
  const sleep = options.sleep ?? defaultSleep;
  const started = performance.now();
  let attempts = 0;
  const meta = (extra: Partial<CallMeta> = {}): CallMeta => ({
    providerId,
    model,
    promptVersion,
    latencyMs: Math.round(performance.now() - started),
    attempts,
    ...extra,
  });
  const fail = (code: ProviderErrorCode, message: string, m: CallMeta) => {
    options.logger.warn(
      { capability, providerId, model, latencyMs: m.latencyMs, attempts: m.attempts, code },
      'ai call failed',
    );
    return { ok: false as const, error: { code, message }, meta: m };
  };

  if (!options.consent || options.consent.purpose !== 'assessment') {
    return fail('consent_missing', 'Interview consent is required before AI processing.', meta());
  }

  let last: { code: ProviderErrorCode; message: string; retryAfterMs?: number } = {
    code: 'upstream_failed',
    message: 'The provider call failed.',
  };
  while (attempts < Math.max(1, policy.attempts)) {
    attempts += 1;
    const outcome = await attempt(adapter, input, options);
    if (outcome.ok) {
      const m = meta(outcome.usage);
      options.logger.info(
        {
          capability,
          providerId,
          model,
          promptVersion,
          latencyMs: m.latencyMs,
          attempts,
          inputTokens: m.inputTokens,
          outputTokens: m.outputTokens,
        },
        'ai call succeeded',
      );
      return { ok: true, value: outcome.value, meta: m };
    }
    last = outcome.error;
    if (!RETRYABLE.has(last.code) || attempts >= policy.attempts) break;
    const delay = backoffDelay(policy, attempts, last.retryAfterMs);
    if (last.retryAfterMs !== undefined && last.retryAfterMs > policy.maxDelayMs) break;
    options.logger.warn(
      { capability, providerId, model, attempts, code: last.code, retryInMs: delay },
      'ai call retrying',
    );
    try {
      await sleep(delay, options.signal);
    } catch {
      return fail('cancelled', 'Cancelled.', meta());
    }
  }
  return fail(last.code, last.message, meta());
}

type AttemptResult<T> =
  | { ok: true; value: T; usage: { inputTokens?: number; outputTokens?: number } }
  | { ok: false; error: { code: ProviderErrorCode; message: string; retryAfterMs?: number } };

async function attempt<C extends AiCapability, T>(
  adapter: ReturnType<AiProviderRegistry['get']>,
  input: CapabilityInputs[C],
  options: InvokeOptions<T>,
): Promise<AttemptResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(
    () =>
      controller.abort(new ProviderCallError('timeout', 'The provider did not answer in time.')),
    options.timeoutMs,
  );
  const onOuterAbort = () => controller.abort(new ProviderCallError('cancelled', 'Cancelled.'));
  if (options.signal?.aborted) onOuterAbort();
  options.signal?.addEventListener('abort', onOuterAbort, { once: true });
  try {
    const abortPromise = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
        once: true,
      });
      if (controller.signal.aborted) reject(controller.signal.reason);
    });
    const raw = await Promise.race([
      adapter.run(input as never, { signal: controller.signal, consent: options.consent! }),
      abortPromise,
    ]);
    const usage = {
      ...(raw.usage?.inputTokens !== undefined ? { inputTokens: raw.usage.inputTokens } : {}),
      ...(raw.usage?.outputTokens !== undefined ? { outputTokens: raw.usage.outputTokens } : {}),
    };
    const parsed = options.outputSchema.safeParse(raw.output);
    if (!parsed.success) {
      options.logger.warn(
        {
          capability: adapter.descriptor.capability,
          providerId: adapter.descriptor.providerId,
          model: adapter.descriptor.model,
          validation: 'schema',
          issueCodes: parsed.error.issues.map((issue) => issue.code),
          issuePaths: parsed.error.issues.map((issue) => issue.path.join('.')).slice(0, 12),
        },
        'ai output rejected',
      );
      return {
        ok: false,
        error: {
          code: 'invalid_output',
          message: 'The provider returned output that failed validation.',
        },
      };
    }
    const reason = options.validate?.(parsed.data) ?? null;
    if (reason) {
      options.logger.warn(
        {
          capability: adapter.descriptor.capability,
          providerId: adapter.descriptor.providerId,
          model: adapter.descriptor.model,
          validation: 'semantic',
          reason,
        },
        'ai output rejected',
      );
      return { ok: false, error: { code: 'invalid_output', message: reason } };
    }
    return { ok: true, value: parsed.data, usage };
  } catch (err) {
    if (err instanceof ProviderCallError) {
      return {
        ok: false,
        error: {
          code: err.code,
          message: err.message,
          ...(err.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {}),
        },
      };
    }
    return { ok: false, error: { code: 'upstream_failed', message: 'The provider call failed.' } };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onOuterAbort);
  }
}
