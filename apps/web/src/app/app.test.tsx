import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockFetch, renderRoute } from '../test/render';
import { DEV_FIXTURE, ledgerTotal } from '../features/landing/FitLedger';
import { WORKSPACES } from '../features/workspace/nav';

function apiOnline() {
  vi.stubGlobal(
    'fetch',
    mockFetch((url) =>
      url === '/api/v1/health'
        ? { status: 200, body: { data: { status: 'ok' }, requestId: 'r' } }
        : { status: 404, body: { error: { code: 'NOT_FOUND', message: 'nf' }, requestId: 'r' } },
    ),
  );
}

describe('landing page', () => {
  it('renders the headline and calls the live health endpoint', async () => {
    apiOnline();
    renderRoute('/');
    expect(
      screen.getByRole('heading', { level: 1, name: 'Find the people your startup is missing.' }),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText('Service online').length).toBeGreaterThan(0));
  });

  it('shows the service as unreachable when the API is down', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    renderRoute('/');
    await waitFor(() =>
      expect(screen.getAllByText('Service unreachable').length).toBeGreaterThan(0),
    );
  });

  it('computes the fit ledger total from its factors (Section 26 Dev fixture = 73.39)', () => {
    expect(ledgerTotal(DEV_FIXTURE)).toBeCloseTo(73.392857, 5);
    apiOnline();
    renderRoute('/');
    const table = screen.getByRole('table');
    expect(within(table).getByText('73.39')).toBeInTheDocument();
    expect(screen.getByText('Seeded demo data')).toBeInTheDocument();
  });

  it('lists the five-step journey in order', () => {
    apiOnline();
    renderRoute('/');
    const journey = screen.getByRole('region', { name: 'From brief to trial sprint' });
    const headings = within(journey)
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent);
    expect(headings).toEqual([
      'Publish a brief',
      'Discover candidates',
      'Interview',
      'Request to collaborate',
      'Run a trial sprint',
    ]);
  });
});

describe('workspace layouts', () => {
  it.each(['founder', 'candidate', 'moderator'] as const)(
    'renders the %s shell with every nav item and a preview banner',
    (role) => {
      apiOnline();
      const def = WORKSPACES[role];
      renderRoute(def.basePath);
      const nav = screen.getAllByRole('navigation', { name: new RegExp(role, 'i') })[0]!;
      for (const item of def.nav) {
        expect(within(nav).getByRole('link', { name: item.label })).toBeInTheDocument();
      }
      expect(screen.getByRole('heading', { level: 1, name: def.title })).toBeInTheDocument();
      expect(screen.getByText(/Workspace preview\./)).toBeInTheDocument();
    },
  );

  it('marks the active nav item and shows an honest planned-screen state', () => {
    apiOnline();
    renderRoute('/founder/briefs');
    const nav = screen.getAllByRole('navigation', { name: /founder/i })[0]!;
    expect(within(nav).getByRole('link', { name: 'Briefs' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current');
    expect(screen.getByText('Not available yet')).toBeInTheDocument();
    // No dead action buttons on planned screens.
    expect(within(screen.getByRole('main')).queryAllByRole('button')).toHaveLength(0);
  });

  it('opens and closes the mobile navigation', async () => {
    apiOnline();
    renderRoute('/candidate');
    const toggle = screen.getByRole('button', { name: 'Open navigation' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Close navigation' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Open navigation' })).toBeInTheDocument();
  });
});

describe('theme', () => {
  it('applies and persists the chosen theme', async () => {
    apiOnline();
    renderRoute('/');
    await userEvent.click(screen.getByRole('radio', { name: 'Dark theme' }));
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(window.localStorage.getItem('cofoundry-theme')).toBe('dark');
    await userEvent.click(screen.getByRole('radio', { name: 'Match system theme' }));
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
    expect(window.localStorage.getItem('cofoundry-theme')).toBeNull();
  });

  it('still works when storage throws', async () => {
    apiOnline();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    renderRoute('/');
    await userEvent.click(screen.getByRole('radio', { name: 'Dark theme' }));
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
  });
});

describe('routing', () => {
  it('renders a not-found page for unknown paths', () => {
    apiOnline();
    renderRoute('/nope');
    expect(screen.getByText('This page doesn’t exist')).toBeInTheDocument();
  });

  it('renders the design system page', () => {
    apiOnline();
    renderRoute('/design-system');
    expect(screen.getByRole('heading', { level: 1, name: 'Design system' })).toBeInTheDocument();
  });
});
