import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryRouter, type RouteObject } from 'react-router';
import { ThemeProvider } from '../lib/theme';
import { AuthProvider } from '../lib/auth';
import { resetCsrfToken } from '../lib/api/client';
import { routes as appRoutes } from '../app/routes';

export function testQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/** Renders the real route table at a path, with fresh providers. */
export function renderRoute(path: string, routes: RouteObject[] = appRoutes) {
  resetCsrfToken();
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  return render(
    <ThemeProvider>
      <QueryClientProvider client={testQueryClient()}>
        <AuthProvider>
          <RouterProvider router={router} />
        </AuthProvider>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

/** Renders a single element inside providers and a router (for components using Link). */
export function renderWithProviders(ui: ReactElement) {
  return renderRoute('/', [{ path: '/', element: ui }]);
}

/** Stubs fetch with a JSON response factory per URL. */
export function mockFetch(
  handler: (
    url: string,
    init?: RequestInit,
  ) => { status: number; body?: unknown; headers?: Record<string, string> },
) {
  const fn = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const { status, body, headers } = handler(url, init);
    return new Response(
      body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body),
      {
        status,
        headers: { 'content-type': 'application/json', ...headers },
      },
    );
  };
  return fn;
}
