import fs from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import mongoose from 'mongoose';
import { ACCOUNTS, BASE_URL, E2E_PASSWORD, STATE_FILE } from '../shared';

async function signIn(page: Page, email: string, password = E2E_PASSWORD) {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: false }).first().fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function sessionCookie(page: Page) {
  const cookies = await page.context().cookies(BASE_URL);
  return cookies.find((c) => c.name === 'cofoundry-dev');
}

test('founder signs in, survives a reload, signs out, and is locked out again', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Sign in' }).first().click();
  await expect(page).toHaveURL(/\/sign-in$/);

  await signIn(page, ACCOUNTS.founder);
  await expect(page).toHaveURL(/\/founder$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Founder workspace' })).toBeVisible();
  await expect(page.getByText('Rohan (PayPilot)')).toBeVisible();
  await expect(page.getByText('Demo account', { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Founder workspace' })).toBeVisible();

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByText('You signed out')).toBeVisible();
  expect(await sessionCookie(page)).toBeUndefined();

  await page.goto('/founder/briefs');
  await expect(page).toHaveURL(/\/sign-in\?next=%2Ffounder%2Fbriefs$/);
});

test('wrong password shows one generic error and creates no signed-in session', async ({
  page,
}) => {
  await signIn(page, ACCOUNTS.founder, 'not-the-right-password');
  await expect(page.getByRole('alert')).toHaveText(/Email or password is incorrect\./);
  const me = await page.request.get('/api/v1/me');
  expect(me.status()).toBe(401);
});

test('session cookie is HttpOnly + SameSite=Lax and rotates at sign-in', async ({ page }) => {
  await page.goto('/sign-in');
  await page.request.get('/api/v1/auth/csrf');
  const before = await sessionCookie(page);
  expect(before?.httpOnly).toBe(true);
  expect(before?.sameSite).toBe('Lax');
  expect(before?.path).toBe('/');

  await signIn(page, ACCOUNTS.candidate);
  await expect(page).toHaveURL(/\/candidate$/);
  const after = await sessionCookie(page);
  expect(after?.value).toBeTruthy();
  expect(after?.value).not.toBe(before?.value);
  // The token is not readable by page scripts.
  expect(await page.evaluate(() => document.cookie)).not.toContain(after?.value ?? '');
});

test('a candidate cannot open the moderator workspace', async ({ page }) => {
  await signIn(page, ACCOUNTS.candidate);
  await expect(page).toHaveURL(/\/candidate$/);
  await page.goto('/moderator/cases');
  await expect(page.getByText('This is the moderator workspace')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Case queue' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Go to your workspace' }).click();
  await expect(page).toHaveURL(/\/candidate$/);
});

test('mutations without a CSRF token or from another origin are refused', async ({ page }) => {
  await signIn(page, ACCOUNTS.moderator);
  await expect(page).toHaveURL(/\/moderator$/);

  const noToken = await page.request.post('/api/v1/auth/logout', {
    data: {},
    headers: { Origin: BASE_URL },
  });
  expect(noToken.status()).toBe(403);
  expect((await noToken.json()).error.code).toBe('CSRF_INVALID');

  const csrf = (await (await page.request.get('/api/v1/auth/csrf')).json()).data.csrfToken;
  const foreign = await page.request.post('/api/v1/auth/logout', {
    data: {},
    headers: { Origin: 'https://evil.example', 'X-CSRF-Token': csrf },
  });
  expect(foreign.status()).toBe(403);

  // Still signed in after both attempts.
  expect((await page.request.get('/api/v1/me')).status()).toBe(200);
});

test('an expired session sends the user to sign-in with an explanation, then back', async ({
  page,
}) => {
  await page.clock.install();
  await signIn(page, ACCOUNTS.founder);
  await page.getByRole('link', { name: 'Requests', exact: true }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Requests' })).toBeVisible();

  // End the session on the server, as idle or absolute expiry would.
  const { mongodbUri } = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as { mongodbUri: string };
  const conn = await mongoose.createConnection(mongodbUri).asPromise();
  await conn.db!.collection('sessions').deleteMany({ userId: { $ne: null } });
  await conn.close();

  // The app re-checks the session every 60 seconds.
  await page.clock.fastForward('01:05');
  await expect(page.getByText('Your session ended')).toBeVisible();
  await expect(page).toHaveURL(/reason=expired/);

  await page.getByLabel('Email').fill(ACCOUNTS.founder);
  await page.getByLabel('Password', { exact: false }).first().fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/founder\/requests$/);
});
