import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  INTERVIEW_CONSENT_ITEMS,
  INTERVIEW_CONSENT_POLICY_VERSION,
  INTERVIEW_INTRO_TEXT,
  type InterviewSessionView,
  type InterviewSummary,
} from '@cofoundry/shared';
import { AiProviderRegistry } from '../src/ai/index.js';
import { buildInterviewFixture, type InterviewFixture } from './support/interview-fixture.js';
import { addTestUser } from './support/harness.js';

let f: InterviewFixture;

beforeEach(async () => {
  f = await buildInterviewFixture();
});

const later = (ms: number) => {
  f.clock.now = new Date(f.clock.now.getTime() + ms);
};

describe('Phase 7 — invitations', () => {
  it('a founder invites a recommended candidate from a fresh batch; the candidate sees it', async () => {
    const founder = await f.as('founder');
    const view = await f.invite(founder, 'asha');
    expect(view).toMatchObject({
      status: 'invited',
      viewerRole: 'founder',
      candidate: { displayName: 'Asha' },
      turns: [],
      fullBrief: expect.any(Object),
    });
    expect(new Date(view.expiresAt).getTime() - new Date(view.invitedAt).getTime()).toBe(
      7 * 24 * 3600_000,
    );
    expect(view.allowedActions).toContain('cancel');

    const asha = await f.as('asha');
    const list = await asha.get('/interviews?role=candidate');
    expect(list.status).toBe(200);
    const items = list.body.data as InterviewSummary[];
    expect(items).toHaveLength(1);
    expect(items[0]!.allowedActions).toEqual(['acknowledge_brief', 'decline']);
    const mine = await f.get(asha, view.id);
    expect(mine.fullBrief).toBeNull();
    expect(JSON.stringify(mine.brief)).not.toMatch(/"problem"|"solution"/);
  });

  it('enforces fresh batches, listed candidates, ownership and uniqueness', async () => {
    const founder = await f.as('founder');
    const batch = await f.search(founder);
    const body = (local: string, batchId = batch.batchId) => ({
      briefId: f.briefId,
      candidateUserId: f.users[local]!.id,
      batchId,
    });
    const key = () => ({ 'Idempotency-Key': randomUUID() });

    // Kabir fails a hard gate, so he is not in the batch.
    expect((await founder.post('/interviews', body('kabir'), key())).body.error.code).toBe(
      'STALE_RECOMMENDATION',
    );
    // Idempotent replay returns the same invitation.
    const k = key();
    const first = await founder.post('/interviews', body('asha'), k);
    const again = await founder.post('/interviews', body('asha'), k);
    expect(first.status).toBe(201);
    expect(again.body.data.id).toBe(first.body.data.id);
    // One interview per brief/candidate pair.
    const dup = await founder.post('/interviews', body('asha'), key());
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE_PAIR');
    // Another founder cannot probe someone else's brief: 404 whether or not a pair exists.
    f.users.rival = await addTestUser(f.ids, 'rival@demo.test', ['founder'], {
      displayName: 'Rival',
      cohortId: 'demo-v3.0',
    });
    const rival = await f.as('rival');
    for (const local of ['asha', 'dev']) {
      const probe = await rival.post('/interviews', body(local), key());
      expect(probe.status).toBe(404);
    }
    // Batches expire after 15 minutes.
    later(16 * 60_000);
    expect((await founder.post('/interviews', body('dev'), key())).body.error.code).toBe(
      'STALE_RECOMMENDATION',
    );
  });

  it('revalidates the candidate profile revision before inviting', async () => {
    const founder = await f.as('founder');
    const batch = await f.search(founder);
    const p = f.pstore.candidates.get(f.users.dev!.id)!;
    f.pstore.candidates.set(p.userId, { ...p, revision: p.revision + 1 });
    const res = await founder.post(
      '/interviews',
      { briefId: f.briefId, candidateUserId: f.users.dev!.id, batchId: batch.batchId },
      { 'Idempotency-Key': randomUUID() },
    );
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('STALE_RECOMMENDATION');
  });

  it('only founders invite, at most 20 per day', async () => {
    const asha = await f.as('asha');
    expect(
      (
        await asha.post(
          '/interviews',
          { briefId: f.briefId, candidateUserId: f.users.dev!.id, batchId: f.briefId },
          { 'Idempotency-Key': randomUUID() },
        )
      ).status,
    ).toBe(403);
    const founder = await f.as('founder');
    const seeded = await f.invite(founder, 'asha');
    const template = (await f.h.interviewStore.findById(seeded.id))!;
    for (let i = 0; i < 19; i += 1) {
      const id = randomUUID().replace(/-/g, '').slice(0, 24);
      f.h.interviewStore.records.set(id, { ...template, id, candidateUserId: id });
    }
    const res = await founder.post(
      '/interviews',
      {
        briefId: f.briefId,
        candidateUserId: f.users.dev!.id,
        batchId: (await f.search(founder)).batchId,
      },
      { 'Idempotency-Key': randomUUID() },
    );
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('hides interviews from everyone except the two participants', async () => {
    const founder = await f.as('founder');
    const view = await f.invite(founder, 'asha');
    const dev = await f.as('dev');
    expect((await dev.get(`/interviews/${view.id}`)).status).toBe(404);
    expect((await dev.post(`/interviews/${view.id}/decline`, {})).status).toBe(404);
    f.users['other-founder'] = await addTestUser(f.ids, 'other-founder@example.com', ['founder'], {
      cohortId: 'demo-v3.0',
    });
    const other = await f.as('other-founder');
    expect((await other.get(`/interviews/${view.id}`)).status).toBe(404);
    expect((await other.post(`/interviews/${view.id}/cancel`, { reason: 'x' })).status).toBe(404);
    expect((await dev.get('/interviews/not-an-id')).status).toBe(404);
  });
});

describe('Phase 7 — acceptance and consent', () => {
  let founder: Awaited<ReturnType<InterviewFixture['as']>>;
  let asha: Awaited<ReturnType<InterviewFixture['as']>>;
  let id: string;

  beforeEach(async () => {
    founder = await f.as('founder');
    id = (await f.invite(founder, 'asha')).id;
    asha = await f.as('asha');
  });

  it('releases the full brief only after the confidentiality acknowledgement', async () => {
    expect((await asha.post(`/interviews/${id}/accept`, {})).status).toBe(422);
    const view = await f.acknowledge(asha, id);
    expect(view.fullBrief).toMatchObject({ id: f.briefId });
    expect(view.allowedActions).toContain('accept');
  });

  it('requires assessment and external-AI consent; speech transcription is optional', async () => {
    await f.acknowledge(asha, id);
    const view = await f.get(asha, id);
    const res = await asha.post(`/interviews/${id}/accept`, {
      briefVersion: view.briefVersion,
      profileRevision: view.currentProfileRevision,
      consent: {
        policyVersion: INTERVIEW_CONSENT_POLICY_VERSION,
        items: { assessment: true, external_ai_processing: false, speech_transcription: false },
      },
    });
    expect(res.status).toBe(422);
    expect(Object.keys(res.body.error.fieldErrors)).toEqual([
      'consent.items.external_ai_processing',
    ]);
    const accepted = await f.accept(asha, id, { speech_transcription: false });
    expect(accepted.status).toBe('accepted');
    expect(accepted.consent).toMatchObject({
      policyVersion: 'interview-ai-v1',
      items: { speech_transcription: false },
      disclosedProviders: ['mock:mock-deterministic-v1'],
      withdrawnAt: null,
    });
    expect(
      await f.pstore.hasActiveConsent({
        userId: f.users.asha!.id,
        purpose: 'assessment',
        targetId: id,
      }),
    ).toBe(true);
  });

  it('never asks for webcam access or video analysis', () => {
    expect(INTERVIEW_CONSENT_ITEMS.join(' ')).not.toMatch(/webcam|camera|video/);
  });

  it('rejects a stale profile revision and a profile that no longer passes the gates', async () => {
    await f.acknowledge(asha, id);
    const view = await f.get(asha, id);
    const consent = {
      policyVersion: INTERVIEW_CONSENT_POLICY_VERSION,
      items: { assessment: true, external_ai_processing: true, speech_transcription: true },
    };
    const stale = await asha.post(`/interviews/${id}/accept`, {
      briefVersion: 1,
      profileRevision: view.currentProfileRevision! - 1,
      consent,
    });
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    const p = f.pstore.candidates.get(f.users.asha!.id)!;
    f.pstore.candidates.set(p.userId, {
      ...p,
      revision: p.revision + 1,
      skills: p.skills.map((s) => ({ ...s, level: 1 })),
    });
    const gated = await asha.post(`/interviews/${id}/accept`, {
      briefVersion: 1,
      profileRevision: p.revision + 1,
      consent,
    });
    expect(gated.status).toBe(409);
    expect(gated.body.error.code).toBe('GATE_CHANGED');
  });

  it('refuses acceptance when no AI provider is configured', async () => {
    const off = await buildInterviewFixture({ ai: new AiProviderRegistry() });
    const fo = await off.as('founder');
    const iid = (await off.invite(fo, 'asha')).id;
    const c = await off.as('asha');
    await off.acknowledge(c, iid);
    const v = await off.get(c, iid);
    expect(v.readiness?.interviewer.available).toBe(false);
    const res = await c.post(`/interviews/${iid}/accept`, {
      briefVersion: 1,
      profileRevision: v.currentProfileRevision,
      consent: {
        policyVersion: INTERVIEW_CONSENT_POLICY_VERSION,
        items: { assessment: true, external_ai_processing: true, speech_transcription: true },
      },
    });
    expect(res.status).toBe(503);
  });

  it('declines are terminal; expired invitations cannot be accepted', async () => {
    expect(
      (await asha.post(`/interviews/${id}/decline`, { reason: 'Not now' })).body.data.status,
    ).toBe('declined');
    expect(
      (
        await asha.post(`/interviews/${id}/brief-access`, {
          confidentialityAcknowledged: true,
          noticeVersion: 'conf-v3.0',
        })
      ).status,
    ).toBe(409);

    const dev = await f.as('dev');
    const devId = (await f.invite(founder, 'dev')).id;
    await f.acknowledge(dev, devId);
    later(7 * 24 * 3600_000 + 1000);
    const expired = await f.get(dev, devId);
    expect(expired.status).toBe('expired');
    expect(expired.allowedActions).toEqual([]);
  });

  it('founder or candidate can cancel before submission; closing the brief cancels too', async () => {
    await f.acknowledge(asha, id);
    await f.accept(asha, id);
    const cancelled = await founder.post(`/interviews/${id}/cancel`, { reason: 'Role filled' });
    expect(cancelled.body.data).toMatchObject({
      status: 'cancelled',
      cancellationReason: 'founder_cancelled',
    });
    expect(
      (await asha.post(`/interviews/${id}/start`, {}, { 'X-Interview-Client': randomUUID() }))
        .status,
    ).toBe(409);

    const dev = await f.as('dev');
    const devId = (await f.invite(founder, 'dev')).id;
    const close = await founder.post(
      `/startups/${f.briefId}/close`,
      { reason: 'Hired' },
      { 'Idempotency-Key': randomUUID() },
    );
    expect(close.status).toBe(200);
    expect((await f.get(dev, devId)).cancellationReason).toBe('brief_closed');
  });

  it('withdrawing consent before the interview cancels it', async () => {
    await f.acknowledge(asha, id);
    await f.accept(asha, id);
    const res = await asha.post(`/interviews/${id}/consent/withdraw`, {});
    expect(res.body.data).toMatchObject({
      status: 'cancelled',
      cancellationReason: 'consent_withdrawn',
    });
    expect(
      await f.pstore.hasActiveConsent({
        userId: f.users.asha!.id,
        purpose: 'assessment',
        targetId: id,
      }),
    ).toBe(false);
  });
});

describe('Phase 7 — resume readiness and session start', () => {
  let asha: Awaited<ReturnType<InterviewFixture['as']>>;
  let id: string;

  beforeEach(async () => {
    const founder = await f.as('founder');
    id = (await f.invite(founder, 'asha')).id;
    asha = await f.as('asha');
    await f.acknowledge(asha, id);
    await f.accept(asha, id);
  });

  it('blocks start without a usable resume, with an actionable message and no generic fallback', async () => {
    const view = await f.get(asha, id);
    expect(view.readiness?.resume).toMatchObject({ ready: false, reason: 'no_resume' });
    const res = await asha.post(
      `/interviews/${id}/start`,
      {},
      { 'X-Interview-Client': randomUUID() },
    );
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('RESUME_REQUIRED');
    expect(res.body.error.message).toMatch(/Upload your English resume/);

    await f.seedResume('asha', '');
    const noText = await f.get(asha, id);
    expect(noText.readiness?.resume).toMatchObject({ ready: false, reason: 'no_text' });
    expect((noText.readiness?.resume as { message: string }).message).toMatch(/scanned/);
    expect(
      (await asha.post(`/interviews/${id}/start`, {}, { 'X-Interview-Client': randomUUID() }))
        .status,
    ).toBe(409);
  });

  it('reports microphone/voice/AI/execution readiness without any camera requirement', async () => {
    await f.seedResume('asha');
    const r = (await f.get(asha, id)).readiness!;
    expect(r).toMatchObject({
      resume: { ready: true },
      speechToText: { available: true },
      textToSpeech: { available: true },
      interviewer: { available: true },
      codeExecution: { available: true },
      approximateMinutes: 40,
    });
    expect(JSON.stringify(r)).not.toMatch(/camera|webcam|video/i);
  });

  it('starts with the fixed spoken introduction and prepares the first question', async () => {
    await f.seedResume('asha');
    const { view } = await f.start(asha, id);
    expect(view.status).toBe('in_progress');
    expect(view.turns[0]).toMatchObject({ index: 0, kind: 'intro', prompt: INTERVIEW_INTRO_TEXT });
    expect(view.turns[1]).toMatchObject({
      kind: 'question',
      questionType: 'background',
      intent: 'new_topic',
    });
    expect(view.currentTurnIndex).toBe(1);
    expect(view.generation.status).toBe('idle');
    const started = new Date(view.startedAt!).getTime();
    expect(new Date(view.conversationDeadline!).getTime() - started).toBe(20 * 60_000);
    expect(new Date(view.globalDeadline!).getTime() - started).toBe(45 * 60_000);
    // Hidden fields never leave the server.
    expect(JSON.stringify(view)).not.toMatch(
      /expectedConcepts|resumeTextForAi|resumeContext|activeClientId/,
    );
    // The founder sees progress only.
    const founderView = await f.get(await f.as('founder'), id);
    expect(founderView.turns).toEqual([]);
    expect(founderView.progress.questionsAsked).toBe(1);
  });

  it('prevents duplicate live sessions: a second window takes over and the first is told', async () => {
    await f.seedResume('asha');
    const { clientId: first } = await f.start(asha, id);
    const second = randomUUID();
    const seenBySecond: InterviewSessionView = await f.get(asha, id, second);
    expect(seenBySecond.activeElsewhere).toBe(true);
    expect(seenBySecond.allowedActions).toContain('resume');
    expect(
      (await asha.post(`/interviews/${id}/attach`, {}, { 'X-Interview-Client': second })).status,
    ).toBe(200);
    const stale = await asha.post(
      `/interviews/${id}/turns/1/answer`,
      { text: 'hello', inputMode: 'typed' },
      { 'X-Interview-Client': first },
    );
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('ACTIVE_ELSEWHERE');
    // Starting again is idempotent (attach), never a second session.
    const restart = await asha.post(
      `/interviews/${id}/start`,
      {},
      { 'X-Interview-Client': second },
    );
    expect(restart.body.data.turns).toHaveLength(2);
  });

  it('reconnect keeps the same question and deadlines; disconnect time is not added back', async () => {
    await f.seedResume('asha');
    const { view, clientId } = await f.start(asha, id);
    later(5 * 60_000);
    const back = await f.get(asha, id, clientId);
    expect(back.currentTurnIndex).toBe(view.currentTurnIndex);
    expect(back.conversationDeadline).toBe(view.conversationDeadline);
    expect(back.activeElsewhere).toBe(false);
  });

  it('minimises declined/expired/cancelled sessions after 30 days', async () => {
    await asha.post(`/interviews/${id}/consent/withdraw`, {});
    later(31 * 24 * 3600_000);
    await f.h.interviews.purgeRetention();
    const rec = (await f.h.interviewStore.findById(id))!;
    expect(rec.minimizedAt).not.toBeNull();
    expect(rec.profileSnapshot).toBeNull();
    expect(rec.status).toBe('cancelled');
  });
});
