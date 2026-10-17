import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BriefCreateRequest,
  BriefDraftFields,
  BriefOwnerSummary,
  BriefView,
  StartupBriefData,
} from '@cofoundry/shared';
import { api, newIdempotencyKey } from '../../lib/api/client';

export const briefKeys = {
  mine: ['briefs', 'mine'] as const,
  detail: (id: string) => ['briefs', 'detail', id] as const,
};

/** Owner list, newest first, paged by opaque cursor (Section 17). */
export function useMyBriefs() {
  return useInfiniteQuery({
    queryKey: briefKeys.mine,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      api.list<BriefOwnerSummary>('/startups', {
        query: { scope: 'mine', limit: 20, cursor: pageParam ?? undefined },
        signal,
      }),
    getNextPageParam: (last) => last.nextCursor,
  });
}

export function useBrief(id: string) {
  return useQuery({
    queryKey: briefKeys.detail(id),
    queryFn: ({ signal }) => api.get<BriefView>(`/startups/${encodeURIComponent(id)}`, { signal }),
  });
}

function useBriefMutation<TVars>(run: (vars: TVars) => Promise<StartupBriefData>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: (brief) => {
      // Show the new state at once; the refetch brings the matching preview projection.
      queryClient.setQueryData<BriefView>(briefKeys.detail(brief.id), (old) =>
        old?.access === 'owner' ? { ...old, brief } : old,
      );
      void queryClient.invalidateQueries({ queryKey: briefKeys.mine });
      void queryClient.invalidateQueries({ queryKey: briefKeys.detail(brief.id) });
    },
  });
}

const post = async (path: string, body: object) =>
  (await api.send<StartupBriefData>('POST', path, body, {
    headers: { 'Idempotency-Key': newIdempotencyKey() },
  })) as StartupBriefData;

export function useCreateBrief() {
  return useBriefMutation((body: BriefCreateRequest) => post('/startups', body));
}

export function useSaveBriefDraft(id: string) {
  return useBriefMutation(
    async (vars: { expectedVersion: number; changes: Partial<BriefDraftFields> }) =>
      (await api.send<StartupBriefData>(
        'PATCH',
        `/startups/${encodeURIComponent(id)}`,
        vars,
      )) as StartupBriefData,
  );
}

export function usePublishBrief(id: string) {
  return useBriefMutation((vars: { expectedVersion: number }) =>
    post(`/startups/${encodeURIComponent(id)}/publish`, vars),
  );
}

export function useCloseBrief(id: string) {
  return useBriefMutation((vars: { reason: string }) =>
    post(`/startups/${encodeURIComponent(id)}/close`, vars),
  );
}

export function useCloneBrief(id: string) {
  return useBriefMutation(() => post(`/startups/${encodeURIComponent(id)}/clone`, {}));
}
