import { describe, expect, it } from 'vitest';
import {
  AI_CAPABILITIES,
  AiProviderRegistry,
  followUpOutputSchema,
  invokeCapability,
  questionGenerationOutputSchema,
} from '../../src/ai/index.js';
import { silentLogger } from '../helpers.js';

describe('interview AI contracts (Phase 4 integration points)', () => {
  it('registers question generation and adaptive follow-up as separate, disabled capabilities', () => {
    expect(AI_CAPABILITIES).toEqual(
      expect.arrayContaining(['question_generation', 'follow_up_generation']),
    );
    const registry = new AiProviderRegistry();
    expect(registry.isEnabled('question_generation')).toBe(false);
    expect(registry.isEnabled('follow_up_generation')).toBe(false);
  });

  it('reports a disabled follow-up provider instead of inventing output', async () => {
    const result = await invokeCapability(
      new AiProviderRegistry(),
      'follow_up_generation',
      {
        contractVersion: 'ai-interview-contract-v1',
        roleKey: 'backend-node-v1',
        language: 'en',
        question: {
          id: 'Q1',
          prompt: 'How do you make webhooks idempotent?',
          targetSkills: ['rest-api'],
        },
        answerText: 'I store the event id with a unique index.',
        resumeEvidence: null,
      },
      { timeoutMs: 1000, outputSchema: followUpOutputSchema, logger: silentLogger },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('disabled');
  });

  it('validates provider output strictly', () => {
    expect(followUpOutputSchema.safeParse({ followUp: null }).success).toBe(true);
    expect(
      followUpOutputSchema.safeParse({
        followUp: { prompt: 'Why that index?', targetSkills: ['mongodb'] },
      }).success,
    ).toBe(true);
    expect(
      followUpOutputSchema.safeParse({ followUp: { prompt: 'Why?', targetSkills: [] } }).success,
    ).toBe(false);
    expect(
      followUpOutputSchema.safeParse({
        followUp: { prompt: 'Why that index?', targetSkills: ['mongodb'], verdict: 'nervous' },
      }).success,
    ).toBe(false);
    expect(
      questionGenerationOutputSchema.safeParse({
        questions: Array.from({ length: 11 }, (_, i) => ({
          id: `Q${i}`,
          prompt: 'Explain your API design.',
          targetSkills: ['rest-api'],
          resumeEvidence: 'Designed the REST API layer',
          difficulty: 3,
        })),
      }).success,
    ).toBe(false);
  });
});
