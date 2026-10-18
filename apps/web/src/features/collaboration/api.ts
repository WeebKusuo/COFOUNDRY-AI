import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateMatchRequestBody,
  MatchRequestStatus,
  MatchRequestView,
  MatchView,
  SprintAcknowledgeBody,
  SprintApproveBody,
  SprintPatchBody,
  SprintProposalInput,
  SprintRejectBody,
  SprintReviewBody,
  SprintSendBody,
  SprintSubmitBody,
  SprintView,
} from '@cofoundry/shared';
import { api, newIdempotencyKey } from '../../lib/api/client';

/** Collaboration API hooks (Phases 11-13). The server is authoritative for every rule. */

export const collabKeys = {
  all: ['collab'] as const,
  requests: (box: 'inbox' | 'sent', status?: MatchRequestStatus) =>
    ['collab', 'requests', box, status ?? 'all'] as const,
  request: (id: string) => ['collab', 'request', id] as const,
  matches: (role: 'founder' | 'candidate') => ['collab', 'matches', role] as const,
  match: (id: string) => ['collab', 'match', id] as const,
  sprint: (id: string) => ['collab', 'sprint', id] as const,
};

const enc = encodeURIComponent;
const idem = () => ({ headers: { 'Idempotency-Key': newIdempotencyKey() } });

export function useRequests(box: 'inbox' | 'sent', enabled = true) {
  return useQuery({
    queryKey: collabKeys.requests(box),
    enabled,
    queryFn: async ({ signal }) =>
      (await api.list<MatchRequestView>('/match-requests', { signal, query: { box, limit: 50 } }))
        .data,
  });
}

/** The founder's request (if any) for one interview — one per brief/candidate pair. */
export function useRequestForInterview(interviewId: string) {
  return useQuery({
    queryKey: ['collab', 'requests', 'sent', 'interview', interviewId] as const,
    queryFn: async ({ signal }) =>
      (
        await api.list<MatchRequestView>('/match-requests', {
          signal,
          query: { box: 'sent', interviewId, limit: 1 },
        })
      ).data[0] ?? null,
  });
}

export function useRequest(id: string) {
  return useQuery({
    queryKey: collabKeys.request(id),
    queryFn: ({ signal }) => api.get<MatchRequestView>(`/match-requests/${enc(id)}`, { signal }),
  });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: collabKeys.all });
}

export function useSendRequest() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: CreateMatchRequestBody) =>
      api.send<MatchRequestView>('POST', '/match-requests', body, idem()),
    onSuccess: () => void invalidate(),
  });
}

export function useRequestActions(id: string) {
  const invalidate = useInvalidate();
  const qc = useQueryClient();
  const set = (v: MatchRequestView | undefined) => {
    if (v) qc.setQueryData(collabKeys.request(id), v);
    void invalidate();
  };
  return {
    accept: useMutation({
      mutationFn: () =>
        api.send<{ request: MatchRequestView; match: MatchView }>(
          'POST',
          `/match-requests/${enc(id)}/accept`,
          {},
          idem(),
        ),
      onSuccess: (d) => set(d?.request),
    }),
    decline: useMutation({
      mutationFn: (reason: string) =>
        api.send<MatchRequestView>(
          'POST',
          `/match-requests/${enc(id)}/decline`,
          reason ? { reason } : {},
          idem(),
        ),
      onSuccess: set,
    }),
    withdraw: useMutation({
      mutationFn: (reason: string) =>
        api.send<MatchRequestView>(
          'POST',
          `/match-requests/${enc(id)}/withdraw`,
          reason ? { reason } : {},
          idem(),
        ),
      onSuccess: set,
    }),
  };
}

export function useMatches(role: 'founder' | 'candidate') {
  return useQuery({
    queryKey: collabKeys.matches(role),
    queryFn: async ({ signal }) =>
      (await api.list<MatchView>('/matches', { signal, query: { role, limit: 50 } })).data,
  });
}

export function useMatch(id: string) {
  return useQuery({
    queryKey: collabKeys.match(id),
    queryFn: ({ signal }) => api.get<MatchView>(`/matches/${enc(id)}`, { signal }),
  });
}

export function useEndMatch(id: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (reason: string) =>
      api.send<MatchView>('POST', `/matches/${enc(id)}/end`, { reason }, idem()),
    onSuccess: () => void invalidate(),
  });
}

export function useSprint(id: string | null) {
  return useQuery({
    queryKey: collabKeys.sprint(id ?? 'none'),
    enabled: !!id,
    queryFn: ({ signal }) => api.get<SprintView>(`/sprints/${enc(id!)}`, { signal }),
  });
}

export function useProposeSprint(matchId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: SprintProposalInput) =>
      api.send<SprintView>('POST', `/matches/${enc(matchId)}/sprints`, input, idem()),
    onSuccess: () => void invalidate(),
  });
}

export function useSprintActions(id: string) {
  const qc = useQueryClient();
  const invalidate = useInvalidate();
  const done = (v: SprintView | undefined) => {
    if (v) qc.setQueryData(collabKeys.sprint(id), v);
    void invalidate();
  };
  const useAction = <B>(path: string) =>
    useMutation({
      mutationFn: (body: B) =>
        api.send<SprintView>('POST', `/sprints/${enc(id)}/${path}`, body, idem()),
      onSuccess: done,
    });
  return {
    patch: useMutation({
      mutationFn: (body: SprintPatchBody) =>
        api.send<SprintView>('PATCH', `/sprints/${enc(id)}`, body),
      onSuccess: done,
    }),
    send: useAction<SprintSendBody>('send'),
    approve: useAction<SprintApproveBody>('approve'),
    reject: useAction<SprintRejectBody>('reject'),
    cancel: useAction<{ reason: string }>('cancel'),
    submit: useAction<SprintSubmitBody>('submit'),
    review: useAction<SprintReviewBody>('review'),
    acknowledge: useAction<SprintAcknowledgeBody>('acknowledge'),
  };
}
