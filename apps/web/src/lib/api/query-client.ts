import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './client';

/**
 * Server state lives in TanStack Query. Client-side errors (4xx) are not retried blindly; the
 * server stays authoritative and screens offer an explicit retry instead.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) =>
          failureCount < 2 && (!(error instanceof ApiError) || error.isRetryable),
      },
      mutations: { retry: false },
    },
  });
}
