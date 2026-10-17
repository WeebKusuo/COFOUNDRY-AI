import { expect, test, type Page } from '@playwright/test';
import mongoose from 'mongoose';
import { ACCOUNTS, BASE_URL, E2E_PASSWORD } from '../shared';
import { userIdFor, withDb } from '../db';

async function signIn(page: Page, email: string) {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: false }).first().fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // Wait for the redirect so a following page.goto cannot abort the sign-in request.
  await expect(page).toHaveURL(/\/(founder|candidate|moderator)$/);
}

test('a candidate edits their profile, adds a linked project and the change persists', async ({
  page,
}) => {
  await signIn(page, ACCOUNTS.dev);
  await expect(page).toHaveURL(/\/candidate$/);
  await page.getByRole('link', { name: 'Edit profile' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Your profile' })).toBeVisible();
  await expect(page.getByText('Saved, revision 1')).toBeVisible();

  const headline = page.getByLabel('Headline');
  await headline.fill('API developer, Node.js and MongoDB');
  await page.getByRole('button', { name: 'Add project' }).click();
  const project = page.getByRole('listitem').filter({ hasText: 'Project 2' });
  await project.getByLabel(/^Title/).fill('Ledger export service');
  await project
    .getByLabel(/What you built/)
    .fill(
      'Wrote a small Node.js service that exports ledger entries as CSV with retries and tests.',
    );
  await project.getByText('Node.js', { exact: true }).click();
  await project.getByLabel(/Link/).fill('https://github.com/dev/ledger-export');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByText('Profile saved')).toBeVisible();
  await expect(page.getByText('Saved, revision 2')).toBeVisible();

  await page.reload();
  await expect(page.getByLabel('Headline')).toHaveValue('API developer, Node.js and MongoDB');
  await page.getByRole('button', { name: 'Show preview' }).click();
  const preview = page.getByRole('article', { name: 'Public profile of Dev' });
  await expect(preview.getByText('Ledger export service')).toBeVisible();
  await expect(preview.getByText('Link added, not verified')).toBeVisible();
  await expect(preview.getByRole('link')).toHaveCount(0);
  await preview.getByRole('button', { name: /Self-reported link: github.com/ }).click();
  await expect(preview.getByRole('link', { name: 'Open github.com' })).toHaveAttribute(
    'rel',
    'noopener noreferrer',
  );
});

test('client-side validation blocks an invalid project; nothing is saved', async ({ page }) => {
  await signIn(page, ACCOUNTS.nila);
  await page.goto('/candidate/profile');
  await page.getByRole('button', { name: 'Add project' }).click();
  const project = page.getByRole('listitem').filter({ hasText: 'Project 2' });
  await project.getByLabel(/^Title/).fill('Tiny');
  await project.getByLabel(/What you built/).fill('Too short');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByText('Fix the highlighted fields')).toBeVisible();
  await expect(project.getByText('Description needs 50-1500 characters.')).toBeVisible();
  const nilaId = new mongoose.Types.ObjectId(await userIdFor(ACCOUNTS.nila));
  const stored = await withDb((db) =>
    db.collection('candidate_profiles').findOne({ userId: nilaId }),
  );
  const revision = stored?.revision;
  expect(revision).toBe(1);
});

test('withdrawing consent hides the candidate from founders immediately', async ({
  page,
  browser,
}) => {
  const miraId = await userIdFor(ACCOUNTS.mira);
  const founder = await browser.newPage();
  await signIn(founder, ACCOUNTS.founder);
  await expect(founder).toHaveURL(/\/founder$/);
  expect((await founder.request.get(`/api/v1/profiles/${miraId}`)).status()).toBe(200);

  await signIn(page, ACCOUNTS.mira);
  await page.goto('/candidate/profile');
  await expect(page.getByText('Discoverable', { exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: /I agree to show my profile/ }).uncheck();
  await expect(page.getByRole('switch', { name: 'Discoverable by founders' })).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByText('Profile saved')).toBeVisible();
  await expect(page.getByText('Hidden from search')).toBeVisible();

  const hidden = await founder.request.get(`/api/v1/profiles/${miraId}`);
  expect(hidden.status()).toBe(404);
  const consent = await withDb((db) =>
    db
      .collection('consent_records')
      .findOne({ purpose: 'profile_discovery', withdrawnAt: { $ne: null } }),
  );
  expect(consent?.withdrawnAt).toBeTruthy();
  await founder.close();
});

test('profile privacy is enforced by the API, not the screens', async ({ page }) => {
  await signIn(page, ACCOUNTS.founder);
  await expect(page).toHaveURL(/\/founder$/);
  const ashaId = await userIdFor(ACCOUNTS.candidate);
  const hiddenId = await userIdFor(ACCOUNTS.hidden);

  const asha = await page.request.get(`/api/v1/profiles/${ashaId}`);
  expect(asha.status()).toBe(200);
  const body = await asha.text();
  expect(body).not.toContain('@demo.cofoundry.test');
  expect(body).not.toContain('revision');
  expect(body).not.toContain('discoveryConsent');

  expect((await page.request.get(`/api/v1/profiles/${hiddenId}`)).status()).toBe(404);
  expect((await page.request.get('/api/v1/profiles/not-an-id')).status()).toBe(404);
  expect((await page.request.get('/api/v1/candidate/profile')).status()).toBe(403);
  const csrf = (await (await page.request.get('/api/v1/auth/csrf')).json()).data.csrfToken;
  const write = await page.request.put('/api/v1/candidate/profile', {
    headers: { Origin: BASE_URL, 'X-CSRF-Token': csrf },
    data: {},
  });
  expect(write.status()).toBe(403);
});

test('a founder edits their profile with link validation', async ({ page }) => {
  await signIn(page, ACCOUNTS.founder);
  await page.getByRole('link', { name: 'Edit profile' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Founder profile' })).toBeVisible();
  const link = page.getByLabel(/Company link/);
  await link.fill('http://paypilot.example');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByText('Enter a public link starting with https://.')).toBeVisible();
  await link.fill('https://paypilot.example/about');
  await page.getByLabel('Bio').fill('Founder of PayPilot. We make payment reconciliation boring.');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByText('Profile saved')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Bio')).toHaveValue(
    'Founder of PayPilot. We make payment reconciliation boring.',
  );
  await expect(page.getByText('Saved, revision 2')).toBeVisible();
});
