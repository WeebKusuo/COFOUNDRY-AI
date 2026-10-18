import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  API_PREFIX,
  INTERVIEW_CLIENT_HEADER,
  INTERVIEW_CONSENT_POLICY_VERSION,
  VERSIONS,
  type AnswerSubmitRequest,
  type CodeLanguage,
  type InterviewConsentItem,
  type InterviewSessionView,
  type InterviewSummary,
  type ReportResponse,
} from '@cofoundry/shared';
import { api, newIdempotencyKey } from '../../lib/api/client';

export const interviewKeys = {
  list: (role: 'founder' | 'candidate', briefId?: string) =>
    ['interviews', role, briefId ?? 'all'] as const,
  one: (id: string) => ['interview', id] as const,
  report: (id: string) => ['interview', id, 'report'] as const,
};

/**
 * Per-tab live-room client id (sessionStorage). Reloading the same tab keeps it, so a reconnect
 * is not treated as a second window; a new tab gets a new id and must take over explicitly.
 */
export function roomClientId(interviewId: string): string {
  const key = `cofoundry-room-${interviewId}`;
  try {
    const existing = window.sessionStorage.getItem(key);
    if (existing) return existing;
    const id = crypto.randomUUID();
    window.sessionStorage.setItem(key, id);
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

const clientHeaders = (clientId?: string): Record<string, string> =>
  clientId ? { [INTERVIEW_CLIENT_HEADER]: clientId } : {};

export function useInterviews(role: 'founder' | 'candidate', briefId?: string) {
  return useQuery({
    queryKey: interviewKeys.list(role, briefId),
    queryFn: async ({ signal }) =>
      (
        await api.list<InterviewSummary>('/interviews', {
          signal,
          query: { role, ...(briefId ? { briefId } : {}), limit: 50 },
        })
      ).data,
  });
}

/** Session state. Polls while the server is preparing a question or evaluating. */
export function useInterview(id: string, options: { clientId?: string; poll?: boolean } = {}) {
  return useQuery({
    queryKey: interviewKeys.one(id),
    queryFn: ({ signal }) =>
      api.get<InterviewSessionView>(`/interviews/${encodeURIComponent(id)}`, {
        signal,
        headers: clientHeaders(options.clientId),
      }),
    refetchInterval: (q) => {
      const d = q.state.data;
      if (!d) return false;
      if (d.generation.status === 'running') return 1_500;
      if (d.status === 'coding' && !d.coding) return 1_500;
      if (d.status === 'submitted' && ['queued', 'running'].includes(d.evaluationStatus))
        return 5_000;
      return options.poll ? 15_000 : false;
    },
  });
}

function useSessionMutation<V>(
  id: string,
  fn: (vars: V) => Promise<InterviewSessionView | undefined>,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (data) => {
      if (data) qc.setQueryData(interviewKeys.one(id), data);
      void qc.invalidateQueries({ queryKey: ['interviews'] });
    },
  });
}

const path = (id: string, rest: string) => `/interviews/${encodeURIComponent(id)}${rest}`;

export function useInvite(briefId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { candidateUserId: string; batchId: string }) =>
      api.send<InterviewSessionView>(
        'POST',
        '/interviews',
        { briefId, ...vars },
        { headers: { 'Idempotency-Key': newIdempotencyKey() } },
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['interviews'] }),
  });
}

export function useInterviewActions(id: string, clientId?: string) {
  const h = { headers: clientHeaders(clientId) };
  const send = (rest: string, body: unknown = {}) =>
    api.send<InterviewSessionView>('POST', path(id, rest), body, h);
  return {
    acknowledge: useSessionMutation(id, () =>
      send('/brief-access', {
        confidentialityAcknowledged: true,
        noticeVersion: VERSIONS.confidentialityNotice,
      }),
    ),
    accept: useSessionMutation(
      id,
      (v: {
        briefVersion: number;
        profileRevision: number;
        items: Record<InterviewConsentItem, boolean>;
      }) =>
        send('/accept', {
          briefVersion: v.briefVersion,
          profileRevision: v.profileRevision,
          consent: { policyVersion: INTERVIEW_CONSENT_POLICY_VERSION, items: v.items },
        }),
    ),
    decline: useSessionMutation(id, (reason: string) => send('/decline', reason ? { reason } : {})),
    cancel: useSessionMutation(id, (reason: string) => send('/cancel', { reason })),
    withdraw: useSessionMutation(id, () => send('/consent/withdraw')),
    prepare: useSessionMutation(id, () => send('/prepare')),
    start: useSessionMutation(id, () => send('/start')),
    attach: useSessionMutation(id, () => send('/attach')),
    nextQuestion: useSessionMutation(id, () => send('/next-question')),
    finish: useSessionMutation(id, () => send('/conversation/finish', { confirm: true })),
    answer: useSessionMutation(id, (v: AnswerSubmitRequest & { turn: number }) =>
      send(`/turns/${v.turn}/answer`, {
        text: v.text,
        inputMode: v.inputMode,
        ...(v.skip ? { skip: true } : {}),
      }),
    ),
    upload: useSessionMutation(id, (v: { turn: number; audio: Blob }) =>
      api.upload<InterviewSessionView>(
        path(id, `/turns/${v.turn}/audio`),
        v.audio,
        v.audio.type || 'audio/webm',
        clientHeaders(clientId),
        'POST',
      ),
    ),
    saveCode: useSessionMutation(
      id,
      (v: { language: CodeLanguage; code: string; explanation: string }) =>
        api.send<InterviewSessionView>('PUT', path(id, '/coding/draft'), v, h),
    ),
    runCode: useSessionMutation(id, (v: { language: CodeLanguage; code: string }) =>
      send('/coding/run', v),
    ),
    submitCode: useSessionMutation(
      id,
      (v: { language: CodeLanguage; code: string; explanation: string }) =>
        send('/coding/submit', { ...v, confirm: true }),
    ),
  };
}

export function useHeartbeat() {
  return (id: string, clientId: string) =>
    api.send<{ serverNow: string; activeElsewhere: boolean }>(
      'POST',
      path(id, '/heartbeat'),
      {},
      { headers: clientHeaders(clientId) },
    );
}

export function useReport(id: string, enabled: boolean) {
  return useQuery({
    queryKey: interviewKeys.report(id),
    enabled,
    queryFn: ({ signal }) => api.get<ReportResponse>(path(id, '/report'), { signal }),
    refetchInterval: (q) => (q.state.data?.state === 'pending' ? 5_000 : false),
  });
}

export function useRetryEvaluation(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.send('POST', path(id, '/evaluation/retry'), {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: interviewKeys.report(id) });
      void qc.invalidateQueries({ queryKey: interviewKeys.one(id) });
    },
  });
}

/** Same-origin audio for a turn (or the voice check); the session cookie authorises it. */
export async function fetchSpeech(id: string, turn: number | 'voice-test'): Promise<ArrayBuffer> {
  const url =
    turn === 'voice-test'
      ? `${API_PREFIX}${path(id, '/voice-test')}`
      : `${API_PREFIX}${path(id, `/turns/${turn}/speech`)}`;
  const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
  if (!res.ok) throw new Error('Speech unavailable');
  return res.arrayBuffer();
}
