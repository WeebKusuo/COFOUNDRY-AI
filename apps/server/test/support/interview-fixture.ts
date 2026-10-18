import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import {
  INTERVIEW_CONSENT_POLICY_VERSION,
  PROFILE_DISCLOSURE_POLICY_VERSION,
  RESUME_POLICY_VERSION,
  VERSIONS,
  type InterviewSessionView,
  type RecommendationSearchResponse,
} from '@cofoundry/shared';
import { DEMO_ACCOUNTS, DEMO_BRIEFS, DEMO_CANDIDATE_PROFILES } from '../../src/db/demo-accounts.js';
import type { UserRecord } from '../../src/auth/store.js';
import { AiProviderRegistry, createMockAdapters } from '../../src/ai/index.js';
import { createReferenceMockJudge } from '../../src/coding/grading.js';
import type { CodeJudge } from '../../src/coding/judge.js';
import { createMockSpeechServices } from '../../src/speech/services.js';
import { sha256Hex } from '../../src/lib/canonical-json.js';
import { MemoryIdentityStore } from './memory-store.js';
import { MemoryProfileStore } from './memory-profile-store.js';
import { MemoryBriefStore } from './memory-brief-store.js';
import { MemoryResumeStore } from './memory-resume-store.js';
import { TestClient, addTestUser, buildHarness, type Harness } from './harness.js';
import type { SpeechServices } from '../../src/speech/types.js';

/**
 * Shared Phase 7-10 fixture: the Section 26 demo cohort and PayPilot brief, a fresh
 * recommendation batch, resume text for candidates, and helpers that walk an invitation to a
 * live interview. AI, speech and code execution use the deterministic test doubles unless a test
 * passes its own.
 */

export const RESUME_TEXT = [
  'Asha Rao',
  'asha.rao@example.com | +91 98765 43210 | linkedin.com/in/asha-rao',
  'Backend engineer with 4 years of Node.js and TypeScript experience.',
  'Built a payment reconciliation REST API in Node.js and MongoDB that processes 2 million ledger rows a day.',
  'Implemented idempotent webhook handling with retries and exponential backoff for a payments team.',
  'Designed JWT authentication with refresh tokens and role-based access control.',
  'Skills: Node.js, TypeScript, MongoDB, REST APIs, Docker, testing with Vitest.',
].join('\n');

export interface InterviewFixture {
  h: Harness;
  ids: MemoryIdentityStore;
  pstore: MemoryProfileStore;
  briefStore: MemoryBriefStore;
  resumeStore: MemoryResumeStore;
  users: Record<string, UserRecord>;
  briefId: string;
  clock: { now: Date };
  speech: SpeechServices & { script: unknown[]; synthesized: string[] };
  judge: CodeJudge;
  as: (local: string) => Promise<TestClient>;
  search: (founder: TestClient) => Promise<RecommendationSearchResponse>;
  seedResume: (local: string, text?: string) => Promise<void>;
  invite: (
    founder: TestClient,
    local: string,
    batch?: RecommendationSearchResponse,
  ) => Promise<InterviewSessionView>;
  acknowledge: (c: TestClient, id: string) => Promise<InterviewSessionView>;
  accept: (
    c: TestClient,
    id: string,
    items?: Partial<
      Record<'assessment' | 'external_ai_processing' | 'speech_transcription', boolean>
    >,
  ) => Promise<InterviewSessionView>;
  prepare: (c: TestClient, id: string) => Promise<InterviewSessionView>;
  start: (
    c: TestClient,
    id: string,
    clientId?: string,
  ) => Promise<{ view: InterviewSessionView; clientId: string }>;
  get: (c: TestClient, id: string, clientId?: string) => Promise<InterviewSessionView>;
}

export async function buildInterviewFixture(
  options: {
    ai?: AiProviderRegistry;
    speech?: SpeechServices & { script: unknown[]; synthesized: string[] };
    judge?: CodeJudge;
    aiCall?: { timeoutMs: number; maxAttempts: number };
  } = {},
): Promise<InterviewFixture> {
  const ids = new MemoryIdentityStore();
  const pstore = new MemoryProfileStore();
  const briefStore = new MemoryBriefStore();
  const resumeStore = new MemoryResumeStore();
  const clock = { now: new Date('2026-10-17T10:00:00.000Z') };
  const users: Record<string, UserRecord> = {};
  for (const account of DEMO_ACCOUNTS) {
    const local = account.email.split('@')[0]!;
    users[local] = await addTestUser(ids, account.email, account.roles, {
      displayName: account.displayName,
      cohortId: 'demo-v3.0',
    });
    const fixture = DEMO_CANDIDATE_PROFILES[account.seedKey];
    if (!fixture) continue;
    const u = users[local]!;
    pstore.candidates.set(u.id, {
      userId: u.id,
      revision: 1,
      headline: fixture.headline,
      bio: fixture.bio,
      skills: fixture.skills,
      industryTags: fixture.industryTags,
      missionTags: fixture.missionTags,
      availableHoursPerWeek: fixture.availableHoursPerWeek,
      commitmentMonths: fixture.commitmentMonths,
      opportunityTypes: ['contributor'],
      projects: fixture.projects.map((p, i) => ({
        id: `${u.id.slice(0, 22)}${String(i).padStart(2, '0')}`,
        ...p,
        evidenceStatus: p.url ? 'project_linked' : 'self_reported',
      })),
      discoveryEnabled: fixture.discoverable,
      updatedAt: new Date(),
    });
    if (fixture.discoverable) {
      await pstore.grantConsent(
        { userId: u.id, purpose: 'profile_discovery', targetId: u.id },
        PROFILE_DISCLOSURE_POLICY_VERSION,
        new Date(),
      );
    }
  }
  const founder = users.founder!;
  const { record } = await briefStore.insertDraft({
    id: MemoryBriefStore.newId(),
    founderUserId: founder.id,
    fields: DEMO_BRIEFS[0]!.fields,
    clonedFromId: null,
  });
  await briefStore.publish(
    record.id,
    founder.id,
    0,
    { compensation: record.compensation },
    new Date(),
  );

  const speech = options.speech ?? createMockSpeechServices();
  const judge = options.judge ?? createReferenceMockJudge();
  const h = buildHarness({
    store: ids,
    profileStore: pstore,
    briefStore,
    resumeStore,
    now: () => clock.now,
    ai: options.ai ?? new AiProviderRegistry(createMockAdapters()),
    speech,
    judge,
    ...(options.aiCall ? { aiCall: options.aiCall } : {}),
  });

  const as = async (local: string) => {
    const client = new TestClient(h.app);
    expect((await client.login(users[local]!.emailLower)).status).toBe(200);
    return client;
  };
  const search = async (f: TestClient) => {
    const res = await f.post(
      `/startups/${record.id}/recommendations`,
      {},
      { 'Idempotency-Key': randomUUID() },
    );
    expect(res.status).toBe(201);
    return res.body.data as RecommendationSearchResponse;
  };
  const seedResume = async (local: string, text = RESUME_TEXT) => {
    const u = users[local]!;
    const at = new Date();
    await pstore.grantConsent(
      { userId: u.id, purpose: 'resume_processing', targetId: u.id },
      RESUME_POLICY_VERSION,
      at,
    );
    const existing = await resumeStore.find(u.id);
    await resumeStore.save(
      u.id,
      existing?.version ?? 0,
      {
        storageKey: `k-${u.id}`,
        filename: 'resume.pdf',
        sizeBytes: 1000,
        fileSha256: sha256Hex(text),
        uploadedAt: at,
        extraction: {
          status: text.length > 0 ? 'succeeded' : 'no_text',
          extractorVersion: 'pdfjs-6.3.289-v1',
          pageCount: 1,
          pagesProcessed: 1,
          textChars: text.length,
          truncated: false,
          textSha256: sha256Hex(text),
          extractedAt: at,
        },
      },
      text,
    );
  };
  const invite = async (f: TestClient, local: string, batch?: RecommendationSearchResponse) => {
    const b = batch ?? (await search(f));
    const res = await f.post(
      '/interviews',
      { briefId: record.id, candidateUserId: users[local]!.id, batchId: b.batchId },
      { 'Idempotency-Key': randomUUID() },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.data as InterviewSessionView;
  };
  const acknowledge = async (c: TestClient, id: string) => {
    const res = await c.post(`/interviews/${id}/brief-access`, {
      confidentialityAcknowledged: true,
      noticeVersion: VERSIONS.confidentialityNotice,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.data as InterviewSessionView;
  };
  const accept = async (
    c: TestClient,
    id: string,
    items: Partial<
      Record<'assessment' | 'external_ai_processing' | 'speech_transcription', boolean>
    > = {},
  ) => {
    const view = (await c.get(`/interviews/${id}`)).body.data as InterviewSessionView;
    const res = await c.post(`/interviews/${id}/accept`, {
      briefVersion: view.briefVersion,
      profileRevision: view.currentProfileRevision,
      consent: {
        policyVersion: INTERVIEW_CONSENT_POLICY_VERSION,
        items: {
          assessment: true,
          external_ai_processing: true,
          speech_transcription: true,
          ...items,
        },
      },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.data as InterviewSessionView;
  };
  /** Prepares the question plan (started automatically on accept) and waits for it. */
  const prepare = async (c: TestClient, id: string) => {
    await h.interviews.idle();
    const res = await c.post(`/interviews/${id}/prepare`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await h.interviews.idle();
    return get(c, id);
  };
  const start = async (c: TestClient, id: string, clientId: string = randomUUID()) => {
    const pre = await get(c, id);
    if (pre.status === 'accepted') await prepare(c, id);
    const res = await c.post(`/interviews/${id}/start`, {}, { 'X-Interview-Client': clientId });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await h.interviews.idle();
    return { view: await get(c, id, clientId), clientId };
  };
  const get = async (c: TestClient, id: string, clientId?: string) => {
    let req = c.agent.get(`/api/v1/interviews/${id}`);
    if (clientId) req = req.set('X-Interview-Client', clientId);
    const res = await req;
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.data as InterviewSessionView;
  };

  return {
    h,
    ids,
    pstore,
    briefStore,
    resumeStore,
    users,
    briefId: record.id,
    clock,
    speech,
    judge,
    as,
    search,
    seedResume,
    invite,
    acknowledge,
    accept,
    prepare,
    start,
    get,
  };
}
