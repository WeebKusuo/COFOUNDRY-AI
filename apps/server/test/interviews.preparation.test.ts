import { describe, expect, it } from 'vitest';
import type { InterviewSessionView } from '@cofoundry/shared';
import {
  AI_CAPABILITIES,
  AiProviderRegistry,
  ProviderCallError,
  createMockAdapters,
  type AiCapability,
  type CapabilityAdapter,
  type QuestionPlanInput,
} from '../src/ai/index.js';
import { PLANNED_TOPICS } from '../src/interviews/policy.js';
import {
  RESUME_TEXT,
  buildInterviewFixture,
  type InterviewFixture,
} from './support/interview-fixture.js';
import type { TestClient } from './support/harness.js';

/**
 * Resume-first preparation: after acceptance the server parses the resume and prepares the
 * opening question of every planned topic; Start is enabled only when that plan is ready for the
 * current resume version, and the interview asks the prepared questions.
 */

function spyRegistry(overrides: Partial<Record<AiCapability, CapabilityAdapter['run']>> = {}) {
  const base = createMockAdapters();
  const inputs: Array<{ capability: AiCapability; input: unknown }> = [];
  const adapters = Object.fromEntries(
    AI_CAPABILITIES.map((c) => [
      c,
      {
        descriptor: base[c].descriptor,
        run: async (input: never, ctx: never) => {
          inputs.push({ capability: c, input });
          const o = overrides[c];
          return o ? o(input, ctx) : base[c].run(input, ctx);
        },
      },
    ]),
  );
  return { registry: new AiProviderRegistry(adapters as never), inputs, base };
}

let f: InterviewFixture;
let asha: TestClient;
let id: string;

async function invited(options: Parameters<typeof buildInterviewFixture>[0] = {}) {
  f = await buildInterviewFixture(options);
  const founder = await f.as('founder');
  id = (await f.invite(founder, 'asha')).id;
  asha = await f.as('asha');
  await f.acknowledge(asha, id);
  return founder;
}

const view = () => f.get(asha, id);
const prepare = () => asha.post(`/interviews/${id}/prepare`, {});
const start = (client = crypto.randomUUID()) =>
  asha.post(`/interviews/${id}/start`, {}, { 'X-Interview-Client': client });

describe('Interview preparation — resume first, questions ready before Start', () => {
  it('prepares the question plan on acceptance and enables Start only when it is ready', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const spy = spyRegistry({
      question_plan: async (input, ctx) => {
        await gate;
        return createMockAdapters().question_plan.run(input as never, ctx);
      },
    });
    await invited({ ai: spy.registry });
    await f.seedResume('asha');
    const accepted = await f.accept(asha, id);
    expect(accepted.readiness!.questions.status).toBe('preparing');
    expect(accepted.allowedActions).toContain('prepare');

    // Start is refused while the questions are being prepared.
    const early = await start();
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('PREPARATION_REQUIRED');
    // A second prepare call while running does not start another run.
    expect((await prepare()).status).toBe(200);

    release();
    await f.h.interviews.idle();
    const v = await view();
    expect(v.status).toBe('accepted');
    expect(v.readiness!.questions).toMatchObject({
      status: 'ready',
      plannedCount: PLANNED_TOPICS,
      resumeVersion: 1,
      message: null,
    });
    expect(v.readiness!.questions.basedOn!.projects.length).toBeGreaterThan(0);
    expect(v.readiness!.questions.basedOn!.technologies).toContain('MongoDB');
    // One resume parse and one plan call, even with the extra prepare request.
    expect(spy.inputs.filter((i) => i.capability === 'resume_context')).toHaveLength(1);
    expect(spy.inputs.filter((i) => i.capability === 'question_plan')).toHaveLength(1);
    // The prepared prompts are not sent to the client before the interview.
    const rec = (await f.h.interviewStore.findById(id))!;
    expect(rec.questionPlan).toHaveLength(PLANNED_TOPICS);
    expect(JSON.stringify(v)).not.toContain(rec.questionPlan![1]!.prompt);

    expect((await start()).status).toBe(200);
  });

  it('builds the plan from the redacted resume context: projects, tech stack and role skills', async () => {
    const spy = spyRegistry();
    await invited({ ai: spy.registry });
    await f.seedResume('asha');
    await f.accept(asha, id);
    await f.h.interviews.idle();
    const plan = spy.inputs.find((i) => i.capability === 'question_plan')!
      .input as QuestionPlanInput;
    expect(plan.slots.map((s) => s.type)).toEqual([
      'background',
      'resume_project',
      'fundamentals',
      'resume_project',
      'architecture',
      'problem_solving',
      'scenario',
    ]);
    expect(plan.candidate.resumeContext.projects.length).toBeGreaterThan(0);
    expect(plan.role.requiredSkills.length).toBeGreaterThan(0);
    const sent = JSON.stringify(spy.inputs.map((i) => i.input));
    expect(sent).not.toContain('asha.rao@example.com');
    expect(sent).not.toContain('98765');
    expect(sent).not.toContain('Asha Rao');
    // Resume-project questions quote the resume.
    const rec = (await f.h.interviewStore.findById(id))!;
    for (const q of rec.questionPlan!.filter((q) => q.type === 'resume_project')) {
      expect(RESUME_TEXT).toContain(q.resumeEvidence!);
    }
    expect(rec.questionPlan![0]!.generatedBy).toMatchObject({
      provider: 'mock',
      promptVersion: 'question-plan-v1',
    });
  });

  it('prepares distinct questions from a resume with a single project', async () => {
    await invited();
    await f.seedResume(
      'asha',
      [
        'Riya Demo - Backend Developer',
        'Built a Node.js REST API for invoice reconciliation with MongoDB and Jest tests.',
        'Added JWT authentication and rate limiting to an Express service.',
        'Skills: Node.js, TypeScript, MongoDB, Docker, Git',
      ].join('\n'),
    );
    await f.accept(asha, id);
    await f.h.interviews.idle();
    expect((await view()).readiness!.questions.status).toBe('ready');
    const plan = (await f.h.interviewStore.findById(id))!.questionPlan!;
    expect(new Set(plan.map((q) => q.prompt)).size).toBe(plan.length);
  });

  it('waits for the resume: no plan, no prepare and no start without one', async () => {
    await invited();
    const v = await f.accept(asha, id);
    expect(v.readiness!.questions.status).toBe('waiting_for_resume');
    const p = await prepare();
    expect(p.status).toBe(409);
    expect(p.body.error.code).toBe('RESUME_REQUIRED');
    expect((await start()).status).toBe(409);

    // Adding the resume on the readiness screen, then preparing, enables Start.
    await f.seedResume('asha');
    expect((await view()).readiness!.questions.status).toBe('not_started');
    expect((await prepare()).status).toBe(200);
    await f.h.interviews.idle();
    expect((await view()).readiness!.questions.status).toBe('ready');
  });

  it('a failed or invalid plan is retryable and never replaced by generic questions', async () => {
    let mode: 'fail' | 'invent' | 'ok' = 'fail';
    const spy = spyRegistry({
      question_plan: async (input, ctx) => {
        if (mode === 'fail') throw new ProviderCallError('upstream_failed', '503');
        const out = (await createMockAdapters().question_plan.run(input as never, ctx)) as {
          output: { questions: Array<{ resumeEvidence: string | null }> };
        };
        if (mode === 'invent') {
          out.output.questions[1]!.resumeEvidence = 'Led a team of 40 engineers at a FAANG company';
        }
        return out;
      },
    });
    await invited({ ai: spy.registry });
    await f.seedResume('asha');
    await f.accept(asha, id);
    await f.h.interviews.idle();
    let v = await view();
    expect(v.readiness!.questions.status).toBe('failed');
    expect(v.readiness!.questions.message).toMatch(/could not be prepared/);
    expect((await f.h.interviewStore.findById(id))!.questionPlan ?? null).toBeNull();
    expect((await start()).status).toBe(409);

    mode = 'invent';
    expect((await prepare()).status).toBe(200);
    await f.h.interviews.idle();
    v = await view();
    expect(v.readiness!.questions.status).toBe('failed');
    expect(v.readiness!.questions.message).toMatch(/did not pass our checks/);

    mode = 'ok';
    expect((await prepare()).status).toBe(200);
    await f.h.interviews.idle();
    expect((await view()).readiness!.questions.status).toBe('ready');
  });

  it('a replaced resume makes the plan stale until it is prepared again', async () => {
    await invited();
    await f.seedResume('asha');
    await f.accept(asha, id);
    await f.h.interviews.idle();
    expect((await view()).readiness!.questions.status).toBe('ready');

    await f.seedResume(
      'asha',
      `${RESUME_TEXT}\nBuilt a GraphQL gateway in Node.js that aggregates five internal services.`,
    );
    const stale = await view();
    expect(stale.readiness!.questions.status).toBe('stale');
    expect(stale.readiness!.resume).toMatchObject({ ready: true, resumeVersion: 2 });
    expect((await start()).body.error.code).toBe('PREPARATION_REQUIRED');

    expect((await prepare()).status).toBe(200);
    await f.h.interviews.idle();
    expect((await view()).readiness!.questions).toMatchObject({
      status: 'ready',
      resumeVersion: 2,
    });
    const rec = (await f.h.interviewStore.findById(id))!;
    expect(rec.resumeRef!.resumeVersion).toBe(2);
  });

  it('asks the prepared questions: the first one with no model call, later topics from the plan', async () => {
    const spy = spyRegistry();
    await invited({ ai: spy.registry });
    await f.seedResume('asha');
    await f.accept(asha, id);
    const { clientId } = await f.start(asha, id);
    const plan = (await f.h.interviewStore.findById(id))!.questionPlan!;
    let v = await f.get(asha, id, clientId);
    expect(v.currentTurnIndex).toBe(1);
    expect(v.turns[1]).toMatchObject({ prompt: plan[0]!.prompt, intent: 'new_topic' });
    expect(spy.inputs.filter((i) => i.capability === 'interview_turn')).toHaveLength(0);

    const answer = async (turn: number, text: string, extra = {}) => {
      const res = await asha.post(
        `/interviews/${id}/turns/${turn}/answer`,
        { text, inputMode: 'typed', ...extra },
        { 'X-Interview-Client': clientId },
      );
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await f.h.interviews.idle();
      return f.get(asha, id, clientId);
    };
    // A skipped answer must change topic: the next prepared question, again without a model call.
    v = await answer(1, '', { skip: true });
    expect(v.turns[2]).toMatchObject({ prompt: plan[1]!.prompt, questionType: 'resume_project' });
    expect(spy.inputs.filter((i) => i.capability === 'interview_turn')).toHaveLength(0);
    // A real answer goes to the live interviewer, which may follow up (adaptive)...
    v = await answer(
      2,
      'I built the reconciliation API because the ledger had drift; for example I added a trade-off between batch size and latency.',
    );
    expect(v.turns[3]).toMatchObject({ parentIndex: 2 });
    const turnInput = spy.inputs.filter((i) => i.capability === 'interview_turn').at(-1)!.input as {
      plannedNext: { prompt: string } | null;
    };
    expect(turnInput.plannedNext!.prompt).toBe(plan[2]!.prompt);
    // ...and when it opens a new topic, the prepared question is asked.
    v = await answer(3, 'Okay.');
    v = await answer(4, '', { skip: true });
    const opened = v.turns.filter((t) => t.kind === 'question' && t.parentIndex === null);
    expect(opened.map((t) => t.prompt)).toEqual(plan.slice(0, opened.length).map((p) => p.prompt));
    const stored = (await f.h.interviewStore.findById(id))!;
    expect(stored.turns[1]!.expectedConcepts).toEqual(plan[0]!.expectedConcepts);
    expect(stored.turns[1]!.generatedBy!.promptVersion).toBe('question-plan-v1');
  });

  it('an interrupted preparation becomes a retryable failure when its lease expires', async () => {
    const spy = spyRegistry({ question_plan: () => new Promise(() => undefined) });
    await invited({ ai: spy.registry });
    await f.seedResume('asha');
    await f.accept(asha, id);
    expect((await view()).readiness!.questions.status).toBe('preparing');
    f.clock.now = new Date(f.clock.now.getTime() + 60 * 60_000);
    const v = await view();
    expect(v.readiness!.questions.status).toBe('failed');
    expect(v.readiness!.questions.message).toMatch(/took too long/);
  });

  it('withdrawing consent during preparation cancels the interview and keeps no plan', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const spy = spyRegistry({
      question_plan: async (input, ctx) => {
        await gate;
        return createMockAdapters().question_plan.run(input as never, ctx);
      },
    });
    await invited({ ai: spy.registry });
    await f.seedResume('asha');
    await f.accept(asha, id);
    expect((await asha.post(`/interviews/${id}/consent/withdraw`, {})).status).toBe(200);
    release();
    await f.h.interviews.idle();
    const rec = (await f.h.interviewStore.findById(id))!;
    expect(rec.status).toBe('cancelled');
    expect(rec.questionPlan ?? null).toBeNull();
    expect((await prepare()).status).toBe(409);
  });

  it('deleting the resume drops prepared material and discards a running preparation', async () => {
    let release!: () => void;
    let gate = new Promise<void>((r) => (release = r));
    const spy = spyRegistry({
      resume_context: async (input, ctx) => {
        await gate;
        return createMockAdapters().resume_context.run(input as never, ctx);
      },
    });
    await invited({ ai: spy.registry });
    await f.seedResume('asha');
    await f.accept(asha, id);
    // Deleted while the resume is being read: the result is discarded, no plan call follows.
    expect((await asha.delete('/candidate/resume')).status).toBe(204);
    release();
    await f.h.interviews.idle();
    let rec = (await f.h.interviewStore.findById(id))!;
    expect(spy.inputs.filter((i) => i.capability === 'question_plan')).toHaveLength(0);
    expect(rec.resumeTextForAi).toBeNull();
    expect(rec.questionPlan ?? null).toBeNull();
    expect((await view()).readiness!.questions.status).toBe('waiting_for_resume');

    // Prepared, then deleted: resume text, context and plan are removed from the interview.
    gate = Promise.resolve();
    await f.seedResume('asha');
    expect((await prepare()).status).toBe(200);
    await f.h.interviews.idle();
    expect((await view()).readiness!.questions.status).toBe('ready');
    expect((await asha.delete('/candidate/resume')).status).toBe(204);
    rec = (await f.h.interviewStore.findById(id))!;
    expect(rec).toMatchObject({
      resumeTextForAi: null,
      resumeContext: null,
      questionPlan: null,
      resumeRef: null,
    });
    expect((await start()).status).toBe(409);
  });

  it('withdrawing consent after the resume is read stops before the plan call', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const spy = spyRegistry({
      resume_context: async (input, ctx) => {
        await gate;
        return createMockAdapters().resume_context.run(input as never, ctx);
      },
    });
    await invited({ ai: spy.registry });
    await f.seedResume('asha');
    await f.accept(asha, id);
    expect((await asha.post(`/interviews/${id}/consent/withdraw`, {})).status).toBe(200);
    release();
    await f.h.interviews.idle();
    expect(spy.inputs.map((i) => i.capability)).toEqual(['resume_context']);
  });

  it('pauses preparation after repeated failures, then allows it again an hour later', async () => {
    const spy = spyRegistry({
      question_plan: async () => {
        throw new ProviderCallError('upstream_failed', '503');
      },
    });
    await invited({ ai: spy.registry });
    await f.seedResume('asha');
    await f.accept(asha, id);
    await f.h.interviews.idle();
    for (let i = 1; i < 10; i += 1) {
      expect((await prepare()).status).toBe(200);
      await f.h.interviews.idle();
    }
    expect((await f.h.interviewStore.findById(id))!.generation.failures).toBe(10);
    const paused = await prepare();
    expect(paused.status).toBe(429);
    expect(paused.body.error.message).toMatch(/about an hour/);
    f.clock.now = new Date(f.clock.now.getTime() + 61 * 60_000);
    expect((await prepare()).status).toBe(200);
    await f.h.interviews.idle();
    expect((await f.h.interviewStore.findById(id))!.generation.failures).toBe(1);
  });

  it('skips a prepared question that would repeat one already asked', async () => {
    await invited();
    await f.seedResume('asha');
    await f.accept(asha, id);
    await f.h.interviews.idle();
    const stored = (await f.h.interviewStore.findById(id))!;
    const plan = stored.questionPlan!;
    // Corrupt the plan so the second topic repeats the first question.
    f.h.interviewStore.records.set(id, {
      ...stored,
      questionPlan: plan.map((q, i) => (i === 1 ? { ...q, prompt: plan[0]!.prompt } : q)),
    });
    const { clientId } = await f.start(asha, id);
    const res = await asha.post(
      `/interviews/${id}/turns/1/answer`,
      { text: '', inputMode: 'typed', skip: true },
      { 'X-Interview-Client': clientId },
    );
    expect(res.status).toBe(200);
    await f.h.interviews.idle();
    const v = await f.get(asha, id, clientId);
    expect(v.turns[2]!.prompt).not.toBe(plan[0]!.prompt);
    expect(v.turns[2]).toMatchObject({ questionType: 'resume_project', parentIndex: null });
  });

  it('the founder never sees preparation details or prepared questions', async () => {
    const founder = await invited();
    await f.seedResume('asha');
    await f.accept(asha, id);
    await f.h.interviews.idle();
    const res = await founder.get(`/interviews/${id}`);
    expect(res.status).toBe(200);
    const v = res.body.data as InterviewSessionView;
    expect(v.readiness).toBeNull();
    expect(v.turns).toEqual([]);
    expect(v.generation.status).toBe('idle');
    const plan = (await f.h.interviewStore.findById(id))!.questionPlan!;
    expect(JSON.stringify(v)).not.toContain(plan[0]!.prompt);
    expect((await founder.post(`/interviews/${id}/prepare`, {})).status).toBe(403);
  });
});
