import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BlockView,
  CaseContextView,
  CaseReporterView,
  CaseStatus,
  CaseSummaryView,
  CreateCorrectionBody,
  CreateReportBody,
  ResolveCaseBody,
} from '@cofoundry/shared';
import { api, newIdempotencyKey } from '../../lib/api/client';

/** Safety and moderation API hooks (Phase 14). */

export const safetyKeys = {
  blocks: ['safety', 'blocks'] as const,
  cases: ['safety', 'cases'] as const,
  myCase: (id: string) => ['safety', 'case', id] as const,
  admin: (status: CaseStatus | 'all') => ['moderation', 'cases', status] as const,
  context: (id: string) => ['moderation', 'context', id] as const,
};

const idem = () => ({ headers: { 'Idempotency-Key': newIdempotencyKey() } });

export function useBlocks() {
  return useQuery({
    queryKey: safetyKeys.blocks,
    queryFn: ({ signal }) => api.get<BlockView[]>('/blocks', { signal }),
  });
}

export function useBlock() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (targetUserId: string) =>
      api.send<BlockView>('POST', '/blocks', { targetUserId }, idem()),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['safety'] });
      void qc.invalidateQueries({ queryKey: ['collab'] });
      void qc.invalidateQueries({ queryKey: ['interviews'] });
      void qc.invalidateQueries({ queryKey: ['interview'] });
    },
  });
}

export function useUnblock() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (targetUserId: string) =>
      api.send<undefined>('DELETE', `/blocks/${encodeURIComponent(targetUserId)}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: safetyKeys.blocks }),
  });
}

export function useMyCases() {
  return useQuery({
    queryKey: safetyKeys.cases,
    queryFn: async ({ signal }) =>
      (await api.list<CaseReporterView>('/cases', { signal, query: { limit: 50 } })).data,
  });
}

export function useOpenReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateReportBody) =>
      api.send<CaseReporterView>('POST', '/reports', body, idem()),
    onSuccess: () => void qc.invalidateQueries({ queryKey: safetyKeys.cases }),
  });
}

export function useOpenCorrection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateCorrectionBody) =>
      api.send<CaseReporterView>('POST', '/corrections', body, idem()),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: safetyKeys.cases });
      void qc.invalidateQueries({ queryKey: ['interview'] });
    },
  });
}

// --- Moderation ------------------------------------------------------------------------------------

export function useAdminCases(status: CaseStatus | 'all') {
  return useQuery({
    queryKey: safetyKeys.admin(status),
    queryFn: async ({ signal }) =>
      (
        await api.list<CaseSummaryView>('/admin/cases', {
          signal,
          query: { limit: 50, ...(status === 'all' ? {} : { status }) },
        })
      ).data,
  });
}

export function useCaseSummary(id: string) {
  return useQuery({
    queryKey: ['moderation', 'case', id] as const,
    queryFn: ({ signal }) =>
      api.get<CaseSummaryView>(`/admin/cases/${encodeURIComponent(id)}`, { signal }),
  });
}

export function useCaseContext(id: string, enabled: boolean) {
  return useQuery({
    queryKey: safetyKeys.context(id),
    enabled,
    retry: false,
    queryFn: ({ signal }) =>
      api.get<CaseContextView>(`/admin/cases/${encodeURIComponent(id)}/context`, { signal }),
  });
}

export function useModeration(id: string) {
  const qc = useQueryClient();
  const refresh = (data?: CaseContextView) => {
    if (data) qc.setQueryData(safetyKeys.context(id), data);
    void qc.invalidateQueries({ queryKey: ['moderation'] });
  };
  return {
    claim: useMutation({
      mutationFn: () =>
        api.send<CaseSummaryView>('POST', `/admin/cases/${encodeURIComponent(id)}/claim`, {}),
      onSuccess: () => refresh(),
    }),
    note: useMutation({
      mutationFn: (text: string) =>
        api.send<CaseContextView>('POST', `/admin/cases/${encodeURIComponent(id)}/notes`, { text }),
      onSuccess: refresh,
    }),
    resolve: useMutation({
      mutationFn: (body: ResolveCaseBody) =>
        api.send<CaseContextView>(
          'POST',
          `/admin/cases/${encodeURIComponent(id)}/resolve`,
          body,
          idem(),
        ),
      onSuccess: refresh,
    }),
  };
}
