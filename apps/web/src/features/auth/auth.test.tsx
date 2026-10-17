import { describe, expect, it } from 'vitest';
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderRoute } from '../../test/render';
import { demoUser, installFakeApi } from '../../test/fake-api';
import { homePathFor, safeRedirect } from '../../lib/auth';
import { api } from '../../lib/api/client';

const EMAIL = 'founder@demo.cofoundry.test';

async function fillAndSubmit(email: string, password: string) {
  await userEvent.type(await screen.findByLabelText(/Email/), email);
  await userEvent.type(screen.getByLabelText(/^Password/), password);
  await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('route protection', () => {
  it('sends signed-out visitors to sign-in and remembers where they were going', async () => {
    installFakeApi();
    renderRoute('/founder/briefs');
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    const { fetchFn } = installFakeApi({ password: 'right-password' });
    await fillAndSubmit(EMAIL, 'right-password');
    expect(await screen.findByRole('heading', { level: 1, name: 'Briefs' })).toBeInTheDocument();
    expect(fetchFn).toHaveBeenCalled();
  });

  it('shows an access-denied state for a workspace the user has no role for', async () => {
    installFakeApi({ user: demoUser(['candidate']) });
    renderRoute('/moderator/cases');
    expect(await screen.findByText('This is the moderator workspace')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to your workspace' })).toHaveAttribute(
      'href',
      '/candidate',
    );
    expect(screen.queryByText('Case queue')).not.toBeInTheDocument();
  });

  it('shows a retryable error when the session check itself fails', async () => {
    installFakeApi({ healthy: false });
    // /me answers normally in the fake; simulate an outage by failing every request.
    const { fetchFn } = installFakeApi();
    fetchFn.mockImplementation(async () => {
      throw new TypeError('Failed to fetch');
    });
    renderRoute('/founder');
    expect(
      await screen.findByText('Can’t reach CoFoundry', {}, { timeout: 4000 }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

describe('sign-in page', () => {
  it('signs in with CSRF: fetches a token, posts credentials, lands in the workspace', async () => {
    const { state } = installFakeApi({ password: 'right-password' });
    renderRoute('/sign-in');
    await fillAndSubmit(EMAIL, 'right-password');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Founder workspace' }),
    ).toBeInTheDocument();
    const login = state.calls.find((c) => c.path === '/auth/login');
    expect(login?.csrf).toMatch(/^csrf-\d+$/);
    const csrfIndex = state.calls.findIndex((c) => c.path === '/auth/csrf');
    expect(csrfIndex).toBeLessThan(state.calls.findIndex((c) => c.path === '/auth/login'));
  });

  it('shows one generic message for wrong credentials and clears the password', async () => {
    installFakeApi({ password: 'right-password' });
    renderRoute('/sign-in');
    await fillAndSubmit(EMAIL, 'wrong-password');
    expect(await screen.findByRole('alert')).toHaveTextContent('Email or password is incorrect.');
    expect(screen.getByLabelText(/^Password/)).toHaveValue('');
  });

  it('explains rate limiting with the wait time', async () => {
    installFakeApi({
      loginError: { status: 429, code: 'RATE_LIMITED', message: 'Too many', retryAfter: 600 },
    });
    renderRoute('/sign-in');
    await fillAndSubmit(EMAIL, 'whatever-password');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many sign-in attempts. Try again in 10 minutes.',
    );
  });

  it('validates empty fields without calling the API', async () => {
    const { state } = installFakeApi();
    renderRoute('/sign-in');
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    expect(screen.getByLabelText(/Email/)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Enter your password.')).toBeInTheDocument();
    expect(state.calls.some((c) => c.path === '/auth/login')).toBe(false);
  });

  it('toggles password visibility', async () => {
    installFakeApi();
    renderRoute('/sign-in');
    const password = await screen.findByLabelText(/^Password/);
    expect(password).toHaveAttribute('type', 'password');
    await userEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(password).toHaveAttribute('type', 'text');
  });

  it('states that demo accounts are shared and that there is no sign-up', async () => {
    installFakeApi();
    renderRoute('/sign-in');
    expect(await screen.findByText(/Demo accounts are shared/)).toBeInTheDocument();
    expect(screen.getByText(/no sign-up or password reset/)).toBeInTheDocument();
  });

  it('sends an already signed-in user straight to their workspace', async () => {
    installFakeApi({ user: demoUser(['moderator']) });
    renderRoute('/sign-in');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Moderator workspace' }),
    ).toBeInTheDocument();
  });
});

describe('sign out and expiry', () => {
  it('signs out, revokes the session on the server and returns to sign-in', async () => {
    const { state } = installFakeApi({ user: demoUser(['founder']) });
    renderRoute('/founder');
    await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText('You signed out')).toBeInTheDocument();
    expect(state.user).toBeNull();
    expect(state.calls.find((c) => c.path === '/auth/logout')?.csrf).toMatch(/^csrf-/);
  });

  it('returns to sign-in with an explanation when the session expires', async () => {
    const { state } = installFakeApi({ user: demoUser(['founder']) });
    const { container } = renderRoute('/founder/requests');
    expect(await screen.findByRole('heading', { level: 1, name: 'Requests' })).toBeInTheDocument();
    state.expire();
    // Any API call now answers 401 (the periodic /me check, or any screen's request).
    await act(async () => {
      await api.get('/me').catch(() => undefined);
    });
    expect(await screen.findByText('Your session ended')).toBeInTheDocument();
    expect(container.textContent).not.toContain('Collaboration requests you sent');
    // After signing in again the user returns to the page they were on.
    const fake = installFakeApi({ password: 'right-password' });
    await fillAndSubmit(EMAIL, 'right-password');
    expect(await screen.findByRole('heading', { level: 1, name: 'Requests' })).toBeInTheDocument();
    expect(fake.state.user).not.toBeNull();
  });
});

describe('redirect safety', () => {
  const founder = demoUser(['founder']);
  it.each([
    [null, '/founder'],
    ['/founder/briefs', '/founder/briefs'],
    ['/moderator/cases', '/founder'],
    ['https://evil.example/founder', '/founder'],
    ['//evil.example/founder', '/founder'],
    ['/\\evil.example', '/founder'],
    ['/founderx', '/founder'],
  ])('next=%s goes to %s', (next, expected) => {
    expect(safeRedirect(next, founder)).toBe(expected);
  });

  it('picks the home workspace in founder, candidate, moderator order', () => {
    expect(homePathFor(demoUser(['moderator', 'candidate']))).toBe('/candidate');
  });
});
