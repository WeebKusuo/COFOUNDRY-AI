import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderRoute } from '../test/render';
import { DEV_FIXTURE, ledgerTotal } from '../features/landing/FitLedger';
import { WORKSPACES } from '../features/workspace/nav';
import { demoUser, installFakeApi } from '../test/fake-api';

/** Healthy API with nobody signed in. */
function apiOnline() {
  installFakeApi();
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

describe('workspace layouts (signed in)', () => {
  it.each(['founder', 'candidate', 'moderator'] as const)(
    'renders the %s shell with every nav item, the user and a demo-account banner',
    async (role) => {
      installFakeApi({ user: demoUser([role], { displayName: `Demo ${role}` }) });
      const def = WORKSPACES[role];
      renderRoute(def.basePath);
      const nav = (await screen.findAllByRole('navigation', { name: new RegExp(role, 'i') }))[0]!;
      for (const item of def.nav) {
        expect(within(nav).getByRole('link', { name: item.label })).toBeInTheDocument();
      }
      expect(screen.getByRole('heading', { level: 1, name: def.title })).toBeInTheDocument();
      expect(screen.getByText(`Demo ${role}`)).toBeInTheDocument();
      expect(screen.getByText('Demo account')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    },
  );

  it('lists only workspaces the user holds a role for', async () => {
    installFakeApi({ user: demoUser(['founder', 'candidate']) });
    renderRoute('/founder');
    const nav = (await screen.findAllByRole('navigation', { name: /founder/i }))[0]!;
    expect(within(nav).getByRole('link', { name: 'Candidate' })).toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'Moderator' })).not.toBeInTheDocument();
  });

  it('marks the active nav item; every nav destination is a built screen', async () => {
    installFakeApi({
      user: demoUser(['founder']),
      routes: (m, p) =>
        m === 'GET' && p === '/match-requests'
          ? { status: 200, body: { data: [], nextCursor: null, requestId: 'r' } }
          : undefined,
    });
    renderRoute('/founder/requests');
    const nav = (await screen.findAllByRole('navigation', { name: /founder/i }))[0]!;
    expect(within(nav).getByRole('link', { name: 'Requests' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current');
    expect(await screen.findByText('No collaboration requests yet')).toBeInTheDocument();
    expect(screen.queryByText('Not available yet')).not.toBeInTheDocument();
  });

  it('opens and closes the mobile navigation', async () => {
    installFakeApi({ user: demoUser(['candidate']) });
    renderRoute('/candidate');
    const toggle = await screen.findByRole('button', { name: 'Open navigation' });
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
