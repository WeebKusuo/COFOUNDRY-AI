import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { RecommendationSearchResponse } from '@cofoundry/shared';
import { ApiError, api, newIdempotencyKey } from '../../lib/api/client';

export const recommendationKeys = {
  latest: (briefId: string) => ['recommendations', briefId] as const,
};

/** The latest usable batch, or the server's reason there is none (expired, stale, never run). */
export type RecommendationState =
  { kind: 'results'; data: RecommendationSearchResponse } | { kind: 'none'; message: string };

export function useRecommendations(briefId: string | null) {
  return useQuery({
    queryKey: recommendationKeys.latest(briefId ?? ''),
    enabled: briefId !== null,
    queryFn: async ({ signal }): Promise<RecommendationState> => {
      try {
        const data = await api.get<RecommendationSearchResponse>(
          `/startups/${encodeURIComponent(briefId!)}/recommendations`,
          { signal },
        );
        return { kind: 'results', data };
      } catch (err) {
        // 409 is an expected state, not a failure: there is no current, valid batch.
        if (err instanceof ApiError && err.code === 'STALE_RECOMMENDATION') {
          return { kind: 'none', message: err.message };
        }
        throw err;
      }
    },
  });
}

/** POST a new search; the server computes and stores the batch. */
export function useRunSearch(briefId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      (await api.send<RecommendationSearchResponse>(
        'POST',
        `/startups/${encodeURIComponent(briefId)}/recommendations`,
        {},
        { headers: { 'Idempotency-Key': newIdempotencyKey() } },
      )) as RecommendationSearchResponse,
    onSuccess: (data) => {
      const state: RecommendationState = { kind: 'results', data };
      queryClient.setQueryData(recommendationKeys.latest(briefId), state);
    },
  });
}
