import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type {
  InterviewSessionView,
  MatchRequestView,
  MatchView,
  SprintProposalInput,
  SprintView,
} from '@cofoundry/shared';
import { buildInterviewFixture, type InterviewFixture } from './interview-fixture.js';
import type { TestClient } from './harness.js';

/**
 * Phase 11-14 fixture: the Phase 7-10 cohort with a completed, evaluated interview for a
 * candidate (deterministic mock AI and the reference mock judge), plus helpers for requests,
 * matches and sprints. Every POST sends a fresh Idempotency-Key unless one is given.
 */

const STRONG =
  'I would store an idempotency key in MongoDB because retries must not double charge, for example when a webhook is delivered twice.';
const SOLVED =
  '// MOCK_REFERENCE (mock judge returns the trusted reference outputs)\nfunction solution() { return 1; }';

export const key = () => ({ 'Idempotency-Key': randomUUID() });

export interface CollaborationFixture extends InterviewFixture {
  founder: TestClient;
  /** Runs an interview to an evaluated report for `local`; returns its id. */
  evaluatedInterview: (local: string) => Promise<string>;
  sendRequest: (
    interviewId: string,
    local: string,
    message?: string,
  ) => Promise<{ status: number; body: { data: MatchRequestView; error?: { code: string } } }>;
  matched: (local?: string) => Promise<{
    candidate: TestClient;
    request: MatchRequestView;
    match: MatchView;
    interviewId: string;
  }>;
  proposal: (over?: Partial<SprintProposalInput>) => SprintProposalInput;
  later: (ms: number) => void;
}

export async function buildCollaborationFixture(): Promise<CollaborationFixture> {
  const f = await buildInterviewFixture();
  const founder = await f.as('founder');

  const evaluatedInterview = async (local: string) => {
    const id = (await f.invite(founder, local)).id;
    const c = await f.as(local);
    await f.acknowledge(c, id);
    await f.accept(c, id);
    await f.seedResume(local);
    const { clientId } = await f.start(c, id);
    let v = await f.get(c, id, clientId);
    for (let i = 0; i < 6 && v.status === 'in_progress'; i += 1) {
      await c.post(
        `/interviews/${id}/turns/${v.currentTurnIndex}/answer`,
        { text: STRONG, inputMode: 'typed' },
        { 'X-Interview-Client': clientId },
      );
      await f.h.interviews.idle();
      v = await f.get(c, id, clientId);
    }
    if (v.status === 'in_progress') {
      await c.post(
        `/interviews/${id}/conversation/finish`,
        { confirm: true },
        { 'X-Interview-Client': clientId },
      );
      await f.h.interviews.idle();
    }
    const sub = await c.post(
      `/interviews/${id}/coding/submit`,
      {
        language: 'javascript',
        code: SOLVED,
        explanation: 'Linear time with a Set.',
        confirm: true,
      },
      { 'X-Interview-Client': clientId },
    );
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    while (await f.h.worker.runOnce()) {
      /* drain */
    }
    const after = (await founder.get(`/interviews/${id}`)).body.data as InterviewSessionView;
    expect(after.evaluationStatus).toBe('succeeded');
    return id;
  };

  const sendRequest: CollaborationFixture['sendRequest'] = async (
    interviewId,
    local,
    message = 'Would you like to collaborate?',
  ) =>
    (await founder.post(
      '/match-requests',
      { briefId: f.briefId, interviewId, candidateUserId: f.users[local]!.id, message },
      key(),
    )) as unknown as Awaited<ReturnType<CollaborationFixture['sendRequest']>>;

  const matched = async (local = 'asha') => {
    const interviewId = await evaluatedInterview(local);
    const sent = await sendRequest(interviewId, local);
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    const candidate = await f.as(local);
    const res = await candidate.post(`/match-requests/${sent.body.data.id}/accept`, {}, key());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const data = res.body.data as { request: MatchRequestView; match: MatchView };
    return { candidate, ...data, interviewId };
  };

  const proposal = (over: Partial<SprintProposalInput> = {}): SprintProposalInput => ({
    title: 'Webhook ingestion endpoint',
    scope:
      'Build one REST endpoint that ingests payout webhooks idempotently, with tests for retries and duplicates.',
    deliverables: ['POST /webhooks/payouts endpoint', 'Automated tests'],
    criteria: ['Duplicate deliveries are stored once', 'Tests cover retry and duplicate cases'],
    expectedHours: 6,
    deadline: new Date(f.clock.now.getTime() + 7 * 24 * 3600_000).toISOString(),
    compensation: {
      type: 'paid',
      amountMinor: 200000,
      currency: 'INR',
      payer: 'founder',
      paymentDueDays: 7,
      methodNote: 'External bank/UPI transfer agreed directly.',
    },
    ...over,
  });

  const later = (ms: number) => {
    f.clock.now = new Date(f.clock.now.getTime() + ms);
  };

  return { ...f, founder, evaluatedInterview, sendRequest, matched, proposal, later };
}

export type { SprintView };
