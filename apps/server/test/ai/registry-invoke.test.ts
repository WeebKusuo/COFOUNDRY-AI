import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AI_CAPABILITIES,
  AiConfigError,
  AiProviderRegistry,
  ProviderCallError,
  backoffDelay,
  worstCaseCallMs,
  createAiRegistry,
  invokeCapability,
  type AiLogger,
  type CapabilityAdapter,
  type CodeReviewInput,
  type ConsentProof,
} from '../../src/ai/index.js';

function captureLogger() {
  const entries: Array<{ level: string; obj: Record<string, unknown>; msg: string }> = [];
  const logger: AiLogger = {
    info: (obj, msg) => entries.push({ level: 'info', obj, msg }),
    warn: (obj, msg) => entries.push({ level: 'warn', obj, msg }),
  };
  return { logger, entries };
}

const SECRET_CODE = 'function secret() { return "4f9c-private"; }';
const consent: ConsentProof = {
  purpose: 'assessment',
  consentRecordId: 'c1',
  policyVersion: 'interview-ai-v1',
};
const reviewInput = {
  code: SECRET_CODE,
} as unknown as CodeReviewInput;
const scoreSchema = z.strictObject({ score: z.number().int().min(0).max(4) });
const noSleep = async () => undefined;

function fakeReviewer(
  run: CapabilityAdapter<'code_review'>['run'],
): CapabilityAdapter<'code_review'> {
  return {
    descriptor: {
      capability: 'code_review',
      providerId: 'test-double',
      model: 'test-model-1',
      adapterVersion: '1',
      promptVersion: 'code-review-v1',
    },
    run,
  };
}

const call = (
  registry: AiProviderRegistry,
  opts: Partial<Parameters<typeof invokeCapability>[3]> = {},
) =>
  invokeCapability(registry, 'code_review', reviewInput, {
    timeoutMs: 1000,
    outputSchema: scoreSchema,
    logger: captureLogger().logger,
    consent,
    sleep: noSleep,
    ...opts,
  } as Parameters<typeof invokeCapability>[3]);

describe('createAiRegistry', () => {
  const settings = {
    provider: 'disabled',
    interviewerModel: null,
    evaluatorModel: null,
    apiKey: null,
    baseUrl: null,
  };

  it('defaults every capability to the disabled adapter', () => {
    const registry = createAiRegistry(settings);
    expect(registry.describe().map((d) => d.capability)).toEqual([...AI_CAPABILITIES]);
    for (const c of AI_CAPABILITIES) expect(registry.isEnabled(c)).toBe(false);
    expect(registry.allEnabled()).toBe(false);
  });

  it('has no video, emotion or audio-characteristics capability', () => {
    for (const c of AI_CAPABILITIES)
      expect(c).not.toMatch(/video|emotion|confiden|nervous|cheat|face|gaze/);
  });

  it('fails on an unknown provider label, naming the known ones', () => {
    expect(() => createAiRegistry({ ...settings, provider: 'gpt-magic' })).toThrow(AiConfigError);
    expect(() => createAiRegistry({ ...settings, provider: 'gpt-magic' })).toThrow(
      /Known providers: disabled, groq, mock, openai-compatible/,
    );
  });

  it('builds Groq adapters with separately configured interviewer and evaluator models', () => {
    const registry = createAiRegistry({
      ...settings,
      provider: 'groq',
      interviewerModel: 'llama-3.3-70b-versatile',
      evaluatorModel: 'openai/gpt-oss-120b',
      apiKey: 'gsk_secret',
    });
    expect(registry.get('interview_turn').descriptor).toMatchObject({
      providerId: 'groq',
      model: 'llama-3.3-70b-versatile',
    });
    expect(registry.get('answer_evaluation').descriptor).toMatchObject({
      providerId: 'groq',
      model: 'openai/gpt-oss-120b',
    });
    expect(registry.disclosedProviders()).toEqual([
      'groq:llama-3.3-70b-versatile',
      'groq:openai/gpt-oss-120b',
    ]);
    expect(JSON.stringify(registry.describe())).not.toContain('gsk_secret');
  });

  it('refuses a real provider without key or models, and plain http to a remote host', () => {
    expect(() => createAiRegistry({ ...settings, provider: 'groq' })).toThrow(AiConfigError);
    expect(() =>
      createAiRegistry({
        ...settings,
        provider: 'openai-compatible',
        baseUrl: 'http://10.0.0.5:8000/v1',
        apiKey: 'k',
        interviewerModel: 'm',
        evaluatorModel: 'm',
        allowInsecureHttp: true,
      }),
    ).toThrow(/https/);
  });

  it('rejects an adapter registered under the wrong capability', () => {
    const wrong = fakeReviewer(async () => ({ output: {} }));
    expect(
      () =>
        new AiProviderRegistry({
          answer_evaluation: wrong as unknown as CapabilityAdapter<'answer_evaluation'>,
        }),
    ).toThrow(AiConfigError);
  });
});

describe('invokeCapability', () => {
  it('requires interview consent and never calls the adapter without it', async () => {
    let called = false;
    const registry = new AiProviderRegistry({
      code_review: fakeReviewer(async () => ((called = true), { output: { score: 1 } })),
    });
    const result = await call(registry, { consent: null });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('consent_missing');
    expect(called).toBe(false);
  });

  it('reports disabled providers as a typed failure, never a fabricated result', async () => {
    const result = await call(new AiProviderRegistry());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('disabled');
  });

  it('returns validated output with model, prompt version, attempts and token usage', async () => {
    const registry = new AiProviderRegistry({
      code_review: fakeReviewer(async () => ({
        output: { score: 3 },
        usage: { inputTokens: 120, outputTokens: 30 },
      })),
    });
    expect(await call(registry)).toMatchObject({
      ok: true,
      value: { score: 3 },
      meta: {
        providerId: 'test-double',
        model: 'test-model-1',
        promptVersion: 'code-review-v1',
        attempts: 1,
        inputTokens: 120,
        outputTokens: 30,
      },
    });
  });

  it.each([
    [{ score: 5 }],
    [{ score: -1 }],
    [{ score: 2.5 }],
    [{ score: 3, overallScore: 100 }],
    ['nope'],
  ])(
    'rejects invalid output %j without clamping (the model cannot add an aggregate)',
    async (output) => {
      const registry = new AiProviderRegistry({
        code_review: fakeReviewer(async () => ({ output })),
      });
      const result = await call(registry);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('invalid_output');
    },
  );

  it('retries transient failures with backoff and succeeds', async () => {
    let n = 0;
    const delays: number[] = [];
    const registry = new AiProviderRegistry({
      code_review: fakeReviewer(async () => {
        n += 1;
        if (n === 1) throw new ProviderCallError('upstream_failed', '503');
        if (n === 2) throw new ProviderCallError('rate_limited', '429', { retryAfterMs: 1500 });
        return { output: { score: 2 } };
      }),
    });
    const result = await call(registry, {
      retry: { attempts: 3, baseDelayMs: 100, maxDelayMs: 5000 },
      sleep: async (ms: number) => void delays.push(ms),
    });
    expect(result.ok).toBe(true);
    expect(result.meta.attempts).toBe(3);
    // 100 ms backoff, then the provider's Retry-After (1.5 s) wins over 200 ms.
    expect(delays).toEqual([100, 1500]);
  });

  it('stops retrying when Retry-After exceeds the maximum delay', async () => {
    const registry = new AiProviderRegistry({
      code_review: fakeReviewer(async () => {
        throw new ProviderCallError('rate_limited', '429', { retryAfterMs: 60_000 });
      }),
    });
    const result = await call(registry, {
      retry: { attempts: 3, baseDelayMs: 100, maxDelayMs: 5000 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('rate_limited');
    expect(result.meta.attempts).toBe(1);
  });

  it('does not retry non-transient failures', async () => {
    let n = 0;
    const registry = new AiProviderRegistry({
      code_review: fakeReviewer(async () => {
        n += 1;
        throw new ProviderCallError('disabled', 'off');
      }),
    });
    await call(registry, { retry: { attempts: 3, baseDelayMs: 1, maxDelayMs: 1 } });
    expect(n).toBe(1);
  });

  it('treats a failed semantic validation as invalid output and retries it', async () => {
    let n = 0;
    const registry = new AiProviderRegistry({
      code_review: fakeReviewer(async () => ({ output: { score: (n += 1) } })),
    });
    const result = await call(registry, {
      validate: (v: unknown) => ((v as { score: number }).score < 2 ? 'too_low' : null),
      retry: { attempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
    });
    expect(result).toMatchObject({ ok: true, value: { score: 2 }, meta: { attempts: 2 } });
  });

  it('computes exponential backoff', () => {
    const p = { attempts: 5, baseDelayMs: 100, maxDelayMs: 1000 };
    expect([1, 2, 3, 4, 5].map((a) => backoffDelay(p, a))).toEqual([100, 200, 400, 800, 1000]);
  });

  it('times out a slow provider even if it ignores the abort signal', async () => {
    const registry = new AiProviderRegistry({
      code_review: fakeReviewer(
        () => new Promise((resolve) => setTimeout(() => resolve({ output: { score: 1 } }), 500)),
      ),
    });
    const result = await call(registry, { timeoutMs: 50 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('timeout');
    expect(result.meta.latencyMs).toBeLessThan(400);
  });

  it('cancels when the outer signal aborts (consent withdrawn mid-call)', async () => {
    const registry = new AiProviderRegistry({
      code_review: fakeReviewer(
        (_input, ctx) =>
          new Promise((_resolve, reject) =>
            ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason)),
          ),
      ),
    });
    const outer = new AbortController();
    const pending = call(registry, { timeoutMs: 5000, signal: outer.signal });
    outer.abort();
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('cancelled');
  });

  it('maps unexpected adapter exceptions to upstream_failed without leaking messages', async () => {
    const registry = new AiProviderRegistry({
      code_review: fakeReviewer(async () => {
        throw new Error('401 invalid key sk-abc');
      }),
    });
    const { logger, entries } = captureLogger();
    const result = await call(registry, { logger });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('upstream_failed');
      expect(result.error.message).not.toContain('sk-abc');
    }
    expect(JSON.stringify(entries)).not.toContain('sk-abc');
  });

  it('logs metadata only — never candidate code or answers', async () => {
    const registry = new AiProviderRegistry({
      code_review: fakeReviewer(async () => ({ output: { score: 2 } })),
    });
    const { logger, entries } = captureLogger();
    await call(registry, { logger });
    expect(entries).toHaveLength(1);
    expect(JSON.stringify(entries)).not.toContain('4f9c-private');
    expect(entries[0]?.obj).toMatchObject({ capability: 'code_review', providerId: 'test-double' });
  });
});

describe('worstCaseCallMs', () => {
  it('adds every attempt timeout and every capped backoff', () => {
    expect(worstCaseCallMs(20_000, { attempts: 3, baseDelayMs: 1_000, maxDelayMs: 20_000 })).toBe(
      3 * 20_000 + 1_000 + 2_000,
    );
    expect(worstCaseCallMs(10_000, { attempts: 4, baseDelayMs: 5_000, maxDelayMs: 8_000 })).toBe(
      4 * 10_000 + 5_000 + 8_000 + 8_000,
    );
    expect(worstCaseCallMs(5_000, { attempts: 1, baseDelayMs: 1_000, maxDelayMs: 1_000 })).toBe(
      5_000,
    );
  });
});
