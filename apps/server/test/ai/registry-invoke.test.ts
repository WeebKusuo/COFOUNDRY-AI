import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AI_CAPABILITIES,
  AiConfigError,
  AiProviderRegistry,
  OBSERVABLE_VIDEO_EVENTS,
  createAiRegistry,
  invokeCapability,
  type AiLogger,
  type CapabilityAdapter,
  type TechnicalEvaluationInput,
} from '../../src/ai/index.js';

function captureLogger() {
  const entries: Array<{ level: string; obj: Record<string, unknown>; msg: string }> = [];
  const logger: AiLogger = {
    info: (obj, msg) => entries.push({ level: 'info', obj, msg }),
    warn: (obj, msg) => entries.push({ level: 'warn', obj, msg }),
  };
  return { logger, entries };
}

const SECRET_ANSWER = 'my private answer text 4f9c';
const evalInput: TechnicalEvaluationInput = {
  questionId: 'A1',
  question: 'Design an API…',
  rubricVersion: 'rubric-v3.0',
  expectedPoints: ['idempotency'],
  answer: SECRET_ANSWER,
};
const scoreSchema = z.strictObject({ score: z.number().int().min(0).max(4) });

function fakeEvaluator(
  run: CapabilityAdapter<'technical_evaluation'>['run'],
): CapabilityAdapter<'technical_evaluation'> {
  return {
    descriptor: {
      capability: 'technical_evaluation',
      providerId: 'test-double',
      model: 'test-model-1',
      adapterVersion: '1',
    },
    run,
  };
}

describe('createAiRegistry', () => {
  it('defaults every capability to the disabled adapter', () => {
    const registry = createAiRegistry({ provider: 'disabled', model: null, apiKey: null });
    expect(registry.describe().map((d) => d.capability)).toEqual([...AI_CAPABILITIES]);
    for (const c of AI_CAPABILITIES) expect(registry.isEnabled(c)).toBe(false);
  });

  it('fails on an unknown provider label, naming the known ones', () => {
    expect(() => createAiRegistry({ provider: 'gpt-magic', model: 'x', apiKey: 'k' })).toThrow(
      AiConfigError,
    );
    expect(() => createAiRegistry({ provider: 'gpt-magic', model: 'x', apiKey: 'k' })).toThrow(
      /Known providers: disabled/,
    );
  });

  it('rejects an adapter registered under the wrong capability', () => {
    const wrong = fakeEvaluator(async () => ({ output: {} }));
    expect(
      () =>
        new AiProviderRegistry({
          language_evaluation: wrong as unknown as CapabilityAdapter<'language_evaluation'>,
        }),
    ).toThrow(AiConfigError);
  });

  it('describe() exposes no credentials', () => {
    const registry = createAiRegistry(
      { provider: 'custom', model: 'm', apiKey: 'sk-secret' },
      { custom: () => ({ technical_evaluation: fakeEvaluator(async () => ({ output: {} })) }) },
    );
    expect(JSON.stringify(registry.describe())).not.toContain('sk-secret');
    expect(registry.isEnabled('technical_evaluation')).toBe(true);
  });
});

describe('invokeCapability', () => {
  it('reports disabled providers as a typed failure, never a fabricated result', async () => {
    const registry = new AiProviderRegistry();
    const { logger } = captureLogger();
    const result = await invokeCapability(registry, 'technical_evaluation', evalInput, {
      timeoutMs: 1000,
      outputSchema: scoreSchema,
      logger,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('disabled');
  });

  it('returns validated output with model metadata and token usage', async () => {
    const registry = new AiProviderRegistry({
      technical_evaluation: fakeEvaluator(async () => ({
        output: { score: 3 },
        usage: { inputTokens: 120, outputTokens: 30 },
      })),
    });
    const { logger } = captureLogger();
    const result = await invokeCapability(registry, 'technical_evaluation', evalInput, {
      timeoutMs: 1000,
      outputSchema: scoreSchema,
      logger,
    });
    expect(result).toMatchObject({
      ok: true,
      value: { score: 3 },
      meta: {
        providerId: 'test-double',
        model: 'test-model-1',
        inputTokens: 120,
        outputTokens: 30,
      },
    });
  });

  it.each([
    [{ score: 5 }],
    [{ score: -1 }],
    [{ score: 2.5 }],
    [{ score: 3, extra: true }],
    ['nope'],
  ])('rejects invalid output %j without clamping', async (output) => {
    const registry = new AiProviderRegistry({
      technical_evaluation: fakeEvaluator(async () => ({ output })),
    });
    const { logger } = captureLogger();
    const result = await invokeCapability(registry, 'technical_evaluation', evalInput, {
      timeoutMs: 1000,
      outputSchema: scoreSchema,
      logger,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_output');
  });

  it('times out a slow provider even if it ignores the abort signal', async () => {
    const registry = new AiProviderRegistry({
      technical_evaluation: fakeEvaluator(
        () => new Promise((resolve) => setTimeout(() => resolve({ output: { score: 1 } }), 500)),
      ),
    });
    const { logger } = captureLogger();
    const result = await invokeCapability(registry, 'technical_evaluation', evalInput, {
      timeoutMs: 50,
      outputSchema: scoreSchema,
      logger,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('timeout');
    expect(result.meta.latencyMs).toBeLessThan(400);
  });

  it('cancels when the outer signal aborts (consent withdrawn mid-call)', async () => {
    const registry = new AiProviderRegistry({
      technical_evaluation: fakeEvaluator(
        (_input, ctx) =>
          new Promise((_resolve, reject) =>
            ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason)),
          ),
      ),
    });
    const outer = new AbortController();
    const { logger } = captureLogger();
    const pending = invokeCapability(registry, 'technical_evaluation', evalInput, {
      timeoutMs: 5000,
      outputSchema: scoreSchema,
      logger,
      signal: outer.signal,
    });
    outer.abort();
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('cancelled');
  });

  it('maps unexpected adapter exceptions to upstream_failed without leaking messages', async () => {
    const registry = new AiProviderRegistry({
      technical_evaluation: fakeEvaluator(async () => {
        throw new Error('401 invalid key sk-abc');
      }),
    });
    const { logger, entries } = captureLogger();
    const result = await invokeCapability(registry, 'technical_evaluation', evalInput, {
      timeoutMs: 1000,
      outputSchema: scoreSchema,
      logger,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('upstream_failed');
      expect(result.error.message).not.toContain('sk-abc');
    }
    expect(JSON.stringify(entries)).not.toContain('sk-abc');
  });

  it('logs metadata only — never the candidate answer', async () => {
    const registry = new AiProviderRegistry({
      technical_evaluation: fakeEvaluator(async (input) => ({
        output: { score: input.answer.length > 0 ? 2 : 0 },
      })),
    });
    const { logger, entries } = captureLogger();
    await invokeCapability(registry, 'technical_evaluation', evalInput, {
      timeoutMs: 1000,
      outputSchema: scoreSchema,
      logger,
    });
    expect(entries).toHaveLength(1);
    expect(JSON.stringify(entries)).not.toContain(SECRET_ANSWER);
    expect(entries[0]?.obj).toMatchObject({
      capability: 'technical_evaluation',
      providerId: 'test-double',
    });
  });
});

describe('media consent', () => {
  const audioAdapter: CapabilityAdapter<'speech_analysis'> = {
    descriptor: {
      capability: 'speech_analysis',
      providerId: 'test-stt',
      model: 'stt-1',
      adapterVersion: '1',
    },
    run: async () => ({ output: { text: 'hello' } }),
  };
  const input = { audio: { mimeType: 'audio/webm', durationMs: 1000, bytes: new Uint8Array(4) } };
  const schema = z.strictObject({ text: z.string() });

  it('refuses audio analysis without interview_audio consent and never calls the adapter', async () => {
    let called = false;
    const registry = new AiProviderRegistry({
      speech_analysis: {
        ...audioAdapter,
        run: async () => ((called = true), { output: { text: '' } }),
      },
    });
    const { logger } = captureLogger();
    const result = await invokeCapability(registry, 'speech_analysis', input, {
      timeoutMs: 1000,
      outputSchema: schema,
      logger,
      consent: { purpose: 'assessment', consentRecordId: 'c1', policyVersion: 'v' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('consent_missing');
    expect(called).toBe(false);
  });

  it('runs audio analysis with matching consent', async () => {
    const registry = new AiProviderRegistry({ speech_analysis: audioAdapter });
    const { logger } = captureLogger();
    const result = await invokeCapability(registry, 'speech_analysis', input, {
      timeoutMs: 1000,
      outputSchema: schema,
      logger,
      consent: { purpose: 'interview_audio', consentRecordId: 'c1', policyVersion: 'v' },
    });
    expect(result.ok).toBe(true);
  });

  it('limits video signals to observable events only', () => {
    for (const event of OBSERVABLE_VIDEO_EVENTS) {
      expect(event).not.toMatch(/cheat|confiden|nervous|emotion|honest|lie/);
    }
  });
});
