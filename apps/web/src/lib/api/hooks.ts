import { useQuery } from '@tanstack/react-query';
import type { HealthData } from '@cofoundry/shared';
import { api } from './client';

export const queryKeys = {
  health: ['health'] as const,
};

/** Liveness of the API; polls gently so the status indicator recovers after a restart. */
export function useHealth() {
  return useQuery({
    queryKey: queryKeys.health,
    queryFn: ({ signal }) => api.get<HealthData>('/health', { signal }),
    refetchInterval: 30_000,
    retry: false,
  });
}
