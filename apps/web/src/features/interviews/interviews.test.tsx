import { describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  INTERVIEW_INTRO_TEXT,
  type InterviewReportView,
  type InterviewSessionView,
  type InterviewSummary,
} from '@cofoundry/shared';
import { renderRoute } from '../../test/render';
import { demoUser, installFakeApi } from '../../test/fake-api';

// Monaco cannot run in jsdom: make the lazy import fail so the plain-text editor is used.
vi.mock('./monaco-setup', () => {
  throw new Error('no monaco in tests');
});

const ID = 'a'.repeat(24);
const candidate = demoUser(['candidate'], { email: 'asha@demo.test', displayName: 'Asha' });
const founderUser = demoUser(['founder']);

const preview = {
  id: 'b'.repeat(24),
  status: 'open',
  version: 1,
  title: 'PayPilot payment reconciliation API',
  teaser: 'Reconcile payouts.',
  roleKey: 'backend-node-v1',
  opportunityType: 'contributor',
  workMode: 'remote',
  requiredSkills: [{ skillId: 'nodejs', level: 3, importance: 2, mandatory: true }],
  hoursRequiredPerWeek: 8,
  commitmentMonths: 3,
  compensation: { type: 'unpaid' },
  ipPolicyVersion: 'creator-owned-v3.0',
  trialCapHours: 10,
  founder: { displayName: 'Rohan', demoAccount: true, companyUrl: null, completedSprintCount: 0 },
  publishedAt: '2026-10-17T10:00:00.000Z',
} as unknown as InterviewSessionView['brief'];

function session(over: Partial<InterviewSessionView> = {}): InterviewSessionView {
  const now = Date.now();
  return {
    id: ID,
    briefId: 'b'.repeat(24),
    briefVersion: 1,
    briefTitle: 'PayPilot payment reconciliation API',
    status: 'invited',
    evaluationStatus: 'none',
    candidateUserId: 'c'.repeat(24),
    founderUserId: 'f'.repeat(24),
    candidate: { displayName: 'Asha', demoAccount: true },
    founder: { displayName: 'Rohan', demoAccount: true },
    invitedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 7 * 86400_000).toISOString(),
    submittedAt: null,
    allowedActions: ['acknowledge_brief', 'decline'],
    viewerRole: 'candidate',
    serverNow: new Date(now).toISOString(),
    brief: preview,
    fullBrief: null,
    briefAccessAcknowledgedAt: null,
    acceptedAt: null,
    startedAt: null,
    conversationDeadline: null,
    codingDeadline: null,
    globalDeadline: null,
    consent: null,
    cancellationReason: null,
    readiness: {
      resume: { ready: true, resumeVersion: 1 },
      questions: {
        status: 'ready',
        plannedCount: 7,
        basedOn: { projects: ['Payment reconciliation API'], technologies: ['Node.js', 'MongoDB'] },
        resumeVersion: 1,
        message: null,
      },
      speechToText: { available: true, message: null },
      textToSpeech: { available: false, message: 'Spoken questions are not available right now.' },
      interviewer: { available: true, message: null, providers: ['groq:llama-3.3-70b-versatile'] },
      codeExecution: { available: true, message: null },
      approximateMinutes: 40,
    },
    progress: {
      stage: 'not_started',
      questionsAsked: 0,
      questionsAnswered: 0,
      maxQuestions: 10,
      minQuestions: 6,
      topicsCovered: [],
    },
    turns: [],
    currentTurnIndex: null,
    generation: { status: 'idle', message: null },
    coding: null,
    activeElsewhere: false,
    currentProfileRevision: 3,
    reportAvailable: false,
    ...over,
  };
}

const ok = (data: unknown, status = 200) => ({ status, body: { data, requestId: 'r' } });

const NO_RESUME = {
  resume: null,
  currentVersion: 0,
  consent: false,
  policyVersion: 'resume-processing-v1',
};

function api(
  handler: (
    method: string,
    path: string,
    body: unknown,
    headers: Record<string, string>,
  ) => { status: number; body?: unknown } | undefined,
) {
  const calls: Array<{
    method: string;
    path: string;
    body: unknown;
    headers: Record<string, string>;
  }> = [];
  return {
    calls,
    routes: (method: string, path: string, body: unknown, headers: Record<string, string>) => {
      calls.push({ method, path, body, headers });
      return handler(method, path, body, headers);
    },
  };
}

describe('candidate invitation flow', () => {
  it('lists invitations in the inbox', async () => {
    const summary: InterviewSummary = {
      ...session(),
      allowedActions: ['acknowledge_brief', 'decline'],
    };
    installFakeApi({
      user: candidate,
      routes: api((_m, p) =>
        p === '/interviews'
          ? { status: 200, body: { data: [summary], nextCursor: null, requestId: 'r' } }
          : undefined,
      ).routes,
    });
    renderRoute('/candidate/inbox');
    const link = await screen.findByRole('link', { name: 'PayPilot payment reconciliation API' });
    expect(link).toHaveAttribute('href', `/candidate/inbox/${ID}`);
    expect(screen.getByText('Invited')).toBeInTheDocument();
  });

  it('acknowledges the brief, then accepts with the required consents only', async () => {
    let view = session();
    const a = api((m, p) => {
      if (p === `/interviews/${ID}` && m === 'GET') return ok(view);
      if (p === `/interviews/${ID}/brief-access`) {
        view = session({
          fullBrief: { problem: 'Payout mismatches', solution: 'Ledger API' } as never,
          allowedActions: ['view_brief', 'accept', 'decline'],
        });
        return ok(view);
      }
      if (p === `/interviews/${ID}/accept`) {
        view = session({
          status: 'accepted',
          allowedActions: ['view_brief', 'start', 'cancel', 'withdraw_consent'],
        });
        return ok(view);
      }
      return undefined;
    });
    installFakeApi({ user: candidate, routes: a.routes });
    renderRoute(`/candidate/inbox/${ID}`);
    await userEvent.click(await screen.findByRole('button', { name: /I acknowledge/ }));
    expect(await screen.findByText('Payout mismatches')).toBeInTheDocument();
    const accept = screen.getByRole('button', { name: 'Accept invitation' });
    expect(accept).toBeDisabled();
    await userEvent.click(screen.getByLabelText(/AI-assisted assessment/));
    expect(accept).toBeDisabled();
    await userEvent.click(screen.getByLabelText(/processed by the AI provider/));
    expect(screen.getByText('groq:llama-3.3-70b-versatile')).toBeInTheDocument();
    expect(screen.getAllByText(/never recorded/).length).toBeGreaterThan(0);
    await userEvent.click(accept);
    expect(await screen.findByRole('link', { name: 'Prepare and start' })).toBeInTheDocument();
    const sent = a.calls.find((c) => c.path.endsWith('/accept'))!.body;
    expect(sent).toEqual({
      briefVersion: 1,
      profileRevision: 3,
      consent: {
        policyVersion: 'interview-ai-v1',
        items: { assessment: true, external_ai_processing: true, speech_transcription: false },
      },
    });
  });
});

describe('readiness screen', () => {
  it('blocks start with an actionable message when the resume is missing', async () => {
    const view = session({
      status: 'accepted',
      allowedActions: ['start'],
      consent: {
        policyVersion: 'interview-ai-v1',
        items: { assessment: true, external_ai_processing: true, speech_transcription: true },
        grantedAt: '',
        disclosedProviders: [],
        withdrawnAt: null,
      },
      readiness: {
        ...session().readiness!,
        resume: {
          ready: false,
          reason: 'no_text',
          message: 'Your resume has no extractable text (it may be a scanned image).',
        },
        questions: {
          status: 'waiting_for_resume',
          plannedCount: 0,
          basedOn: null,
          resumeVersion: null,
          message: 'Add your resume first: the interview questions are prepared from it.',
        },
      },
    });
    installFakeApi({
      user: candidate,
      routes: api((_m, p) =>
        p === `/interviews/${ID}`
          ? ok(view)
          : p === '/candidate/resume'
            ? ok(NO_RESUME)
            : undefined,
      ).routes,
    });
    renderRoute(`/candidate/interviews/${ID}/prepare`);
    expect(await screen.findByText(/no extractable text/)).toBeInTheDocument();
    // The resume can be added right here, before the interview.
    expect(await screen.findByRole('button', { name: 'Upload resume' })).toBeInTheDocument();
    expect(screen.getByText(/Add your resume first/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start interview' })).toBeDisabled();
    expect(screen.getByText(/Add your resume \(step 1\)/)).toBeInTheDocument();
    expect(screen.getAllByText(/never recorded/).length).toBeGreaterThan(0);
  });

  it('prepares the questions from the resume automatically and enables Start when ready', async () => {
    const consent = {
      policyVersion: 'interview-ai-v1' as const,
      items: { assessment: true, external_ai_processing: true, speech_transcription: true },
      grantedAt: '',
      disclosedProviders: [],
      withdrawnAt: null,
    };
    const base = session({
      status: 'accepted',
      allowedActions: ['prepare', 'start', 'cancel'],
      consent,
    });
    const withQuestions = (
      questions: Partial<InterviewSessionView['readiness'] & object>['questions'],
    ) =>
      ({
        ...base,
        readiness: { ...base.readiness!, questions: questions! },
      }) as InterviewSessionView;
    let view = withQuestions({
      status: 'not_started',
      plannedCount: 0,
      basedOn: null,
      resumeVersion: null,
      message: 'The questions have not been prepared yet.',
    });
    const a = api((m, p) => {
      if (p === `/interviews/${ID}` && m === 'GET') return ok(view);
      if (p === `/interviews/${ID}/prepare`) {
        view = {
          ...withQuestions({
            status: 'preparing',
            plannedCount: 0,
            basedOn: null,
            resumeVersion: null,
            message: null,
          }),
          generation: { status: 'running', message: null },
        };
        return ok(view);
      }
      if (p === '/candidate/resume') return ok(NO_RESUME);
      return undefined;
    });
    installFakeApi({ user: candidate, routes: a.routes });
    renderRoute(`/candidate/interviews/${ID}/prepare`);
    expect(
      await screen.findByText(/preparing questions from your projects and tech stack/),
    ).toBeInTheDocument();
    await waitFor(() => expect(a.calls.filter((c) => c.path.endsWith('/prepare'))).toHaveLength(1));
    expect(screen.getByRole('button', { name: 'Start interview' })).toBeDisabled();
    expect(screen.getByText(/Wait until your questions are ready/)).toBeInTheDocument();

    view = withQuestions({
      status: 'ready',
      plannedCount: 7,
      basedOn: { projects: ['Payment reconciliation API'], technologies: ['Node.js', 'MongoDB'] },
      resumeVersion: 1,
      message: null,
    });
    expect(
      await screen.findByText(/7 interview questions are ready/, {}, { timeout: 4000 }),
    ).toBeInTheDocument();
    expect(screen.getByText('Payment reconciliation API')).toBeInTheDocument();
    expect(
      within(screen.getByRole('list', { name: 'Tech stack' })).getByText('MongoDB'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start interview' })).toBeEnabled();
    expect(a.calls.filter((c) => c.path.endsWith('/prepare'))).toHaveLength(1);
  });

  it('shows a failed preparation with a retry', async () => {
    const view = session({
      status: 'accepted',
      allowedActions: ['prepare', 'start'],
      readiness: {
        ...session().readiness!,
        questions: {
          status: 'failed',
          plannedCount: 0,
          basedOn: null,
          resumeVersion: null,
          message: 'The AI provider is busy right now. Retry in a minute.',
        },
      },
    });
    const a = api((_m, p) =>
      p === `/interviews/${ID}`
        ? ok(view)
        : p === `/interviews/${ID}/prepare`
          ? ok(view)
          : p === '/candidate/resume'
            ? ok(NO_RESUME)
            : undefined,
    );
    installFakeApi({ user: candidate, routes: a.routes });
    renderRoute(`/candidate/interviews/${ID}/prepare`);
    expect(await screen.findByText(/provider is busy/)).toBeInTheDocument();
    expect(a.calls.filter((c) => c.path.endsWith('/prepare'))).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(a.calls.filter((c) => c.path.endsWith('/prepare'))).toHaveLength(1));
    expect(screen.getByRole('button', { name: 'Start interview' })).toBeDisabled();
  });

  it('explains an insecure page instead of failing silently, and shows the camera only locally', async () => {
    const view = session({
      status: 'accepted',
      allowedActions: ['prepare', 'start'],
      consent: {
        policyVersion: 'interview-ai-v1',
        items: { assessment: true, external_ai_processing: true, speech_transcription: true },
        grantedAt: '',
        disclosedProviders: [],
        withdrawnAt: null,
      },
    });
    installFakeApi({
      user: candidate,
      routes: api((_m, p) =>
        p === `/interviews/${ID}`
          ? ok(view)
          : p === '/candidate/resume'
            ? ok(NO_RESUME)
            : undefined,
      ).routes,
    });
    const stopTrack = vi.fn();
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] }));
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
    try {
      renderRoute(`/candidate/interviews/${ID}/prepare`);
      await userEvent.click(await screen.findByRole('button', { name: 'Test microphone' }));
      expect(
        await screen.findByText('Microphone blocked by the browser on this address'),
      ).toBeInTheDocument();
      expect(screen.getByText(/http:\/\/localhost/)).toBeInTheDocument();
      expect(getUserMedia).not.toHaveBeenCalled();

      Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
      await userEvent.click(screen.getByRole('button', { name: 'Turn camera on' }));
      expect(await screen.findByLabelText('Your camera (only visible to you)')).toBeInTheDocument();
      expect(getUserMedia).toHaveBeenCalledWith(expect.objectContaining({ audio: false }));
      expect(screen.getAllByText(/never recorded, uploaded or analysed/).length).toBeGreaterThan(0);
      await userEvent.click(screen.getByRole('button', { name: 'Turn camera off' }));
      expect(stopTrack).toHaveBeenCalled();
      expect(screen.queryByLabelText('Your camera (only visible to you)')).not.toBeInTheDocument();
    } finally {
      Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
    }
  });

  it('starts with a per-tab client id and opens the room', async () => {
    const started = session({
      status: 'in_progress',
      turns: [
        {
          index: 0,
          kind: 'intro',
          questionType: null,
          topic: null,
          intent: null,
          difficulty: null,
          prompt: INTERVIEW_INTRO_TEXT,
          parentIndex: null,
          resumeEvidence: null,
          askedAt: '',
          answer: null,
          draft: null,
        },
      ],
      generation: { status: 'running', message: null },
      conversationDeadline: new Date(Date.now() + 1200_000).toISOString(),
    });
    let view = session({ status: 'accepted', allowedActions: ['start'] });
    const a = api((m, p) => {
      if (p === `/interviews/${ID}` && m === 'GET') return ok(view);
      if (p === `/interviews/${ID}/start`) {
        view = started;
        return ok(started);
      }
      return undefined;
    });
    installFakeApi({ user: candidate, routes: a.routes });
    renderRoute(`/candidate/interviews/${ID}/prepare`);
    await userEvent.click(await screen.findByRole('button', { name: 'Start interview' }));
    expect(
      await screen.findByRole('button', { name: 'Enter the interview room' }),
    ).toBeInTheDocument();
    expect(a.calls.find((c) => c.path.endsWith('/start'))!.headers['X-Interview-Client']).toMatch(
      /^[0-9a-f-]{36}$/,
    );
  });
});

const question = {
  index: 1,
  kind: 'question' as const,
  questionType: 'resume_project' as const,
  topic: 'reconciliation',
  intent: 'new_topic' as const,
  difficulty: 2,
  prompt: 'Walk me through the reconciliation API you built.',
  parentIndex: null,
  resumeEvidence: 'Built a payment reconciliation REST API',
  askedAt: '',
  answer: null,
  draft: null,
};

describe('interview room', () => {
  const live = (over: Partial<InterviewSessionView> = {}) =>
    session({
      status: 'in_progress',
      allowedActions: ['answer', 'cancel'],
      consent: {
        policyVersion: 'interview-ai-v1',
        items: { assessment: true, external_ai_processing: true, speech_transcription: false },
        grantedAt: '',
        disclosedProviders: [],
        withdrawnAt: null,
      },
      conversationDeadline: new Date(Date.now() + 600_000).toISOString(),
      turns: [
        {
          ...question,
          index: 0,
          kind: 'intro',
          questionType: null,
          topic: null,
          intent: null,
          difficulty: null,
          prompt: INTERVIEW_INTRO_TEXT,
          resumeEvidence: null,
        },
        question,
      ],
      currentTurnIndex: 1,
      progress: {
        stage: 'conversation',
        questionsAsked: 1,
        questionsAnswered: 0,
        maxQuestions: 10,
        minQuestions: 6,
        topicsCovered: [],
      },
      ...over,
    });

  it('shows the question, timer and transcript, and submits a typed answer to the right turn', async () => {
    const a = api((m, p) => {
      if (p === `/interviews/${ID}` && m === 'GET') return ok(live());
      if (p === `/interviews/${ID}/turns/1/answer`)
        return ok(
          live({ currentTurnIndex: null, generation: { status: 'running', message: null } }),
        );
      return undefined;
    });
    installFakeApi({ user: candidate, routes: a.routes });
    renderRoute(`/candidate/interviews/${ID}/room`);
    await userEvent.click(await screen.findByRole('button', { name: 'Enter the interview room' }));
    expect(screen.getByRole('heading', { level: 1, name: question.prompt })).toBeInTheDocument();
    expect(screen.getByLabelText('Time left in the conversation')).toHaveTextContent(
      /^(10:00|9:5\d)$/,
    );
    expect(screen.getByText('Question 1 of up to 10')).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'Transcript' })).getByText(INTERVIEW_INTRO_TEXT),
    ).toBeInTheDocument();
    await userEvent.type(
      screen.getByLabelText('Type your answer'),
      'I used idempotency keys because retries happen.',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Submit answer' }));
    const call = a.calls.find((c) => c.path === `/interviews/${ID}/turns/1/answer`)!;
    expect(call.body).toEqual({
      text: 'I used idempotency keys because retries happen.',
      inputMode: 'typed',
    });
    expect(call.headers['X-Interview-Client']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reads the intro and the question in order with the on-device browser voice when the server voice is off', async () => {
    const spoken: string[] = [];
    class Utterance {
      voice: unknown = null;
      lang = '';
      rate = 1;
      onend: (() => void) | null = null;
      onerror: ((e: { error: string }) => void) | null = null;
      constructor(public text: string) {}
    }
    vi.stubGlobal('SpeechSynthesisUtterance', Utterance);
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: {
        getVoices: () => [
          { lang: 'en-US', localService: false, default: true, name: 'Online voice' },
          { lang: 'en-US', localService: true, default: false, name: 'On-device voice' },
        ],
        speak: (u: Utterance) => {
          spoken.push(`${(u.voice as { name: string }).name}: ${u.text}`);
          setTimeout(() => u.onend?.(), 5);
        },
        cancel: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      },
    });
    try {
      installFakeApi({
        user: candidate,
        routes: api((m, p) => (p === `/interviews/${ID}` && m === 'GET' ? ok(live()) : undefined))
          .routes,
      });
      renderRoute(`/candidate/interviews/${ID}/room`);
      await userEvent.click(
        await screen.findByRole('button', { name: 'Enter the interview room' }),
      );
      await waitFor(() => expect(spoken).toHaveLength(2));
      expect(spoken).toEqual([
        `On-device voice: ${INTERVIEW_INTRO_TEXT}`,
        `On-device voice: ${question.prompt}`,
      ]);
      // The camera self-view is offered in the room too (off until the candidate turns it on).
      expect(screen.getByRole('button', { name: 'Turn camera on' })).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
      Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: undefined });
    }
  });

  it('stops queued speech when the candidate leaves the room', async () => {
    const spoken: string[] = [];
    let current: { onerror: ((e: { error: string }) => void) | null } | null = null;
    class Utterance {
      voice: unknown = null;
      lang = '';
      rate = 1;
      onend: (() => void) | null = null;
      onerror: ((e: { error: string }) => void) | null = null;
      constructor(public text: string) {}
    }
    vi.stubGlobal('SpeechSynthesisUtterance', Utterance);
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: {
        getVoices: () => [{ lang: 'en-US', localService: true, default: true, name: 'Local' }],
        // Never finishes on its own: the intro is still playing when the candidate leaves.
        speak: (u: Utterance) => {
          spoken.push(u.text);
          current = u;
        },
        cancel: () => {
          const u = current;
          current = null;
          u?.onerror?.({ error: 'canceled' });
        },
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      },
    });
    try {
      installFakeApi({
        user: candidate,
        routes: api((m, p) => (p === `/interviews/${ID}` && m === 'GET' ? ok(live()) : undefined))
          .routes,
      });
      const r = renderRoute(`/candidate/interviews/${ID}/room`);
      await userEvent.click(
        await screen.findByRole('button', { name: 'Enter the interview room' }),
      );
      await waitFor(() => expect(spoken).toEqual([INTERVIEW_INTRO_TEXT]));
      r.unmount();
      await new Promise((x) => setTimeout(x, 30));
      expect(spoken).toEqual([INTERVIEW_INTRO_TEXT]);
    } finally {
      vi.unstubAllGlobals();
      Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: undefined });
    }
  });

  it('offers to take over when the interview is open in another window', async () => {
    const a = api((m, p) => {
      if (p === `/interviews/${ID}` && m === 'GET')
        return ok(live({ activeElsewhere: true, allowedActions: ['resume'] }));
      if (p === `/interviews/${ID}/attach`) return ok(live());
      return undefined;
    });
    installFakeApi({ user: candidate, routes: a.routes });
    renderRoute(`/candidate/interviews/${ID}/room`);
    await userEvent.click(await screen.findByRole('button', { name: 'Continue here' }));
    expect(
      await screen.findByRole('button', { name: 'Enter the interview room' }),
    ).toBeInTheDocument();
  });

  const codingSession = (draft: NonNullable<InterviewSessionView['coding']>['draft'] = null) =>
    live({
      status: 'coding',
      currentTurnIndex: null,
      coding: {
        task: {
          taskId: 'dedupe-events',
          taskVersion: '1',
          title: 'Fix duplicate event removal',
          kind: 'fix_bug',
          prompt: 'Keep the first occurrence.',
          functionName: { javascript: 'dedupeEvents', python: 'dedupe_events' },
          starterCode: {
            javascript: 'function dedupeEvents(events) {}',
            python: 'def dedupe_events(events):\n    pass',
          },
          visibleTests: [{ name: 'keeps the first occurrence', input: '[[]]', expected: '[]' }],
          hiddenTestCount: 4,
          selectionReason: 'Matches the role skills.',
        },
        startedAt: new Date().toISOString(),
        deadline: new Date(Date.now() + 1200_000).toISOString(),
        draft,
        runs: [],
        runsRemaining: 30,
        execution: { available: true, message: null },
        submission: null,
      },
    });

  it('runs the coding round with visible tests only and confirms submission', async () => {
    const coding = codingSession();
    let view = coding;
    const a = api((m, p) => {
      if (p === `/interviews/${ID}` && m === 'GET') return ok(view);
      if (p === `/interviews/${ID}/coding/run`) {
        view = {
          ...coding,
          coding: {
            ...coding.coding!,
            runsRemaining: 29,
            runs: [
              {
                at: '',
                language: 'javascript',
                status: 'completed',
                passed: 0,
                total: 1,
                diagnostics: null,
                results: [
                  {
                    name: 'keeps the first occurrence',
                    outcome: 'failed',
                    expected: '[]',
                    actual: 'null',
                    message: null,
                  },
                ],
              },
            ],
          },
        };
        return ok(view);
      }
      if (p === `/interviews/${ID}/coding/submit`) {
        view = { ...coding, status: 'submitted', evaluationStatus: 'queued' };
        return ok(view);
      }
      return undefined;
    });
    installFakeApi({ user: candidate, routes: a.routes });
    renderRoute(`/candidate/interviews/${ID}/room`);
    expect(
      await screen.findByRole('heading', { name: 'Fix duplicate event removal' }),
    ).toBeInTheDocument();
    const editor = await screen.findByLabelText(/Code editor/);
    expect(editor).toHaveValue('function dedupeEvents(events) {}');
    expect(screen.getByText(/4 hidden checks run after you submit/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Run visible tests' }));
    expect(await screen.findByText('0 of 1 visible tests passed')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/Explain your approach/), 'Use a Set.');
    await userEvent.click(screen.getByRole('button', { name: 'Submit solution and finish' }));
    await userEvent.click(screen.getByRole('button', { name: 'Submit solution' }));
    expect(await screen.findByText(/Interview submitted/)).toBeInTheDocument();
    expect(a.calls.find((c) => c.path.endsWith('/coding/submit'))!.body).toEqual({
      language: 'javascript',
      code: 'function dedupeEvents(events) {}',
      explanation: 'Use a Set.',
      confirm: true,
    });
  });

  it('autosaves code and explanation every 10 seconds and restores them from the draft', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const view = codingSession({
        language: 'javascript',
        code: 'function dedupeEvents(events) { return events; }',
        explanation: 'Draft notes.',
        savedAt: '',
      });
      const a = api((m, p) =>
        (p === `/interviews/${ID}` && m === 'GET') || p.endsWith('/coding/draft')
          ? ok(view)
          : undefined,
      );
      installFakeApi({ user: candidate, routes: a.routes });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderRoute(`/candidate/interviews/${ID}/room`);
      const editor = await screen.findByLabelText(/Code editor/);
      expect(editor).toHaveValue('function dedupeEvents(events) { return events; }');
      const notes = screen.getByLabelText(/Explain your approach/);
      expect(notes).toHaveValue('Draft notes.');
      const drafts = () => a.calls.filter((c) => c.path.endsWith('/coding/draft'));
      // Advance second by second so the countdown re-renders between ticks, as in a browser.
      const wait = async (seconds: number) => {
        for (let i = 0; i < seconds; i++) await act(() => vi.advanceTimersByTimeAsync(1000));
      };
      // Nothing changed yet: no autosave even though the countdown re-renders every second.
      await wait(12);
      expect(drafts()).toHaveLength(0);
      await user.type(notes, ' More.');
      await wait(12);
      await waitFor(() => expect(drafts()).toHaveLength(1));
      expect(drafts()[0]!.method).toBe('PUT');
      expect(drafts()[0]!.body).toEqual({
        language: 'javascript',
        code: 'function dedupeEvents(events) { return events; }',
        explanation: 'Draft notes. More.',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

const report: InterviewReportView = {
  interviewId: ID,
  reportVersion: 1,
  rubricVersion: 'rubric-interview-v1',
  generatedAt: '',
  evaluationStatus: 'succeeded',
  retryAllowed: false,
  candidate: { displayName: 'Asha', demoAccount: true },
  briefTitle: 'PayPilot',
  briefVersion: 1,
  summary: 'Asha answered 7 of 8 questions.',
  overall: { score: 78.5, evidenceLevel: 'strong', basis: ['technical', 'coding'] },
  technical: {
    score: 70,
    asked: 8,
    assessed: 8,
    coverage: 1,
    byType: [{ questionType: 'resume_project', score: 75, count: 2 }],
    byDimension: [{ dimension: 'correctness', meanLevel: 3 }],
  },
  questions: [
    {
      index: 1,
      questionType: 'resume_project',
      topic: 't',
      intent: 'new_topic',
      difficulty: 2,
      prompt: 'Walk me through the API.',
      resumeEvidence: null,
      answer: {
        text: 'I built it with retries.',
        inputMode: 'voice',
        transcriptConfidence: 'low',
        uncertainSegments: 1,
        edited: true,
        editRatio: 0.1,
        skipped: false,
        skipReason: null,
      },
      status: 'evaluated',
      notAssessedReason: null,
      score: 75,
      dimensions: null,
      conceptsDemonstrated: [],
      conceptsMissing: [],
      incorrectStatements: [],
      strengths: [],
      gaps: [],
      uncertainty: null,
      transcriptionIssuesSuspected: false,
      provenance: null,
    },
  ],
  resumeUnderstanding: { projectQuestions: 2, meanScore: 75, notes: [] },
  strengths: [
    { point: 'Explains retries', evidence: 'I built it with retries.', questionIndex: 1 },
  ],
  knowledgeGaps: [
    { point: 'Did not discuss idempotency', kind: 'missing_evidence', questionIndex: 1 },
  ],
  communication: {
    status: 'evaluated',
    notAssessedReason: null,
    score: 62.5,
    dimensions: null,
    overallFeedback: 'Clear answers.',
    strengths: [],
    suggestions: [],
    provenance: null,
    notice: 'Communication feedback is separate and never changes technical or coding scores.',
  },
  coding: null,
  methodology: {
    technicalWeights: {
      correctness: 0.3,
      relevance: 0.1,
      reasoning: 0.2,
      practical_understanding: 0.15,
      specificity: 0.15,
      consistency: 0.1,
    },
    codingWeights: { functional: 0.6, efficiency: 0.15, quality: 0.25 },
    overallWeights: { technical: 0.6, coding: 0.4 },
    evidenceBands: { strong: 75, moderate: 50 },
    minCoverage: 0.6,
    explanation: ['Answer score = weighted mean x 25.'],
  },
  limitations: ['AI evaluations can be wrong.'],
  reviewRecommendations: ['Use this report as one input to a human decision.'],
  injectionFlags: [],
  notice: 'Experimental AI-assisted assessment.',
};

describe('founder interview page and report', () => {
  it('shows progress only before submission and requires a reason to cancel', async () => {
    const view = session({
      viewerRole: 'founder',
      status: 'in_progress',
      allowedActions: ['cancel', 'view_brief'],
      progress: { ...session().progress, stage: 'conversation', questionsAsked: 3 },
    });
    installFakeApi({
      user: founderUser,
      routes: api((_m, p) => (p === `/interviews/${ID}` ? ok(view) : undefined)).routes,
    });
    renderRoute(`/founder/interviews/${ID}`);
    expect(
      await screen.findByText(/visible to you only after the candidate submits/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel interview' })).toBeDisabled();
  });

  it('renders the report with separate dimensions, evidence and limitations', async () => {
    const view = session({
      viewerRole: 'founder',
      status: 'submitted',
      evaluationStatus: 'succeeded',
      allowedActions: ['view_report'],
    });
    installFakeApi({
      user: founderUser,
      routes: api((_m, p) =>
        p === `/interviews/${ID}`
          ? ok(view)
          : p === `/interviews/${ID}/report`
            ? ok({ state: 'ready', report })
            : undefined,
      ).routes,
    });
    renderRoute(`/founder/interviews/${ID}`);
    expect(await screen.findByText('Asha answered 7 of 8 questions.')).toBeInTheDocument();
    expect(screen.getByText('78.50')).toBeInTheDocument();
    expect(screen.getByText('Strong evidence of competency')).toBeInTheDocument();
    expect(screen.getByText('Never part of the technical assessment')).toBeInTheDocument();
    expect(screen.getByText(/no evidence given — not the same as wrong/)).toBeInTheDocument();
    expect(screen.getByText(/Low transcript confidence/)).toBeInTheDocument();
    expect(screen.getByText(/Transcript edited \(10% of words\)/)).toBeInTheDocument();
    expect(screen.getByText('AI evaluations can be wrong.')).toBeInTheDocument();
    expect(screen.getByText(/not a hiring decision/)).toBeInTheDocument();
  });

  it('shows a failed evaluation with retry', async () => {
    const view = session({
      viewerRole: 'founder',
      status: 'submitted',
      evaluationStatus: 'failed',
      allowedActions: ['view_report', 'retry_evaluation'],
    });
    const a = api((_m, p) => {
      if (p === `/interviews/${ID}`) return ok(view);
      if (p === `/interviews/${ID}/report`)
        return ok({
          state: 'pending',
          pending: {
            interviewId: ID,
            evaluationStatus: 'failed',
            retryAllowed: true,
            message: 'The evaluation could not be completed.',
          },
        });
      if (p === `/interviews/${ID}/evaluation/retry`)
        return ok({ evaluationStatus: 'queued' }, 202);
      return undefined;
    });
    installFakeApi({ user: founderUser, routes: a.routes });
    renderRoute(`/founder/interviews/${ID}`);
    await userEvent.click(await screen.findByRole('button', { name: 'Retry evaluation' }));
    expect(a.calls.some((c) => c.path.endsWith('/evaluation/retry') && c.method === 'POST')).toBe(
      true,
    );
  });
});
