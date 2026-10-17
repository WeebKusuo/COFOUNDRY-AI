import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { ACCOUNTS, BASE_URL, E2E_PASSWORD } from '../shared';

const LONG = 'Merchants reconcile UPI payments by hand and miss partial payments every week.';

async function signIn(page: Page, email: string) {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: false }).first().fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/(founder|candidate|moderator)$/);
}

test('a founder writes, publishes, clones and closes a brief; candidates see only the teaser', async ({
  page,
  browser,
}) => {
  await signIn(page, ACCOUNTS.founder);
  await page.getByRole('link', { name: 'Manage briefs' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Briefs' })).toBeVisible();
  await page.getByRole('button', { name: 'New brief' }).click();
  await page.getByLabel(/Brief title/).fill('Ledger export worker');
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Ledger export worker' })).toBeVisible();
  await expect(page.getByText('Draft · version 0')).toBeVisible();

  await page
    .getByLabel('Teaser')
    .fill('Help us build a reliable ledger export worker for small merchants.');
  await page.getByLabel('Problem').fill(`CONFIDENTIAL-PROBLEM ${LONG}`);
  await page.getByLabel('Solution').fill(`CONFIDENTIAL-SOLUTION ${LONG}`);
  await page
    .getByRole('group', { name: /Industries/ })
    .getByText('Fintech', { exact: true })
    .click();
  await page
    .getByRole('group', { name: /Missions/ })
    .getByText('Reliability', { exact: true })
    .click();
  await page.getByRole('button', { name: 'Add required skill' }).click();
  await page.getByLabel('Required skill 1', { exact: true }).selectOption('nodejs');
  await expect(page.getByText('Gap: needs 3, team has 0')).toBeVisible();
  await page.getByLabel('Hours per week').fill('8');
  await page.getByLabel('Commitment in months').fill('3');
  await page.getByLabel('Amount (₹, INR)').fill('2000');
  await page.getByLabel('Payment due (days after submission)').fill('7');
  await page.getByLabel('How you will pay').fill('Bank transfer agreed directly.');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved', { exact: true })).toBeVisible();
  await expect(page.getByText('Everything required is filled in.')).toBeVisible();

  await page.reload();
  await expect(page.getByLabel('Teaser')).toHaveValue(
    'Help us build a reliable ledger export worker for small merchants.',
  );
  await page
    .getByRole('region', { name: 'Publish' })
    .getByRole('button', { name: 'Publish' })
    .click();
  await page.getByRole('button', { name: 'Publish now' }).click();
  await expect(page.getByText('Brief published')).toBeVisible();
  await expect(page.getByText('Open · version 1')).toBeVisible();
  const briefId = page.url().split('/').pop()!;

  // Published terms are immutable on the server, not only in the UI.
  const csrf = (await (await page.request.get('/api/v1/auth/csrf')).json()).data.csrfToken;
  const edit = await page.request.patch(`/api/v1/startups/${briefId}`, {
    headers: { Origin: BASE_URL, 'X-CSRF-Token': csrf },
    data: { expectedVersion: 1, changes: { title: 'Changed' } },
  });
  expect(edit.status()).toBe(409);

  // A candidate in the cohort sees the teaser, never the confidential problem/solution.
  const candidate = await browser.newPage();
  await signIn(candidate, ACCOUNTS.candidate);
  const discover = await candidate.request.get('/api/v1/startups?scope=discover');
  expect(discover.status()).toBe(200);
  const discoverBody = await discover.text();
  expect(discoverBody).toContain('Ledger export worker');
  expect(discoverBody).not.toContain('CONFIDENTIAL-');
  const preview = await candidate.request.get(`/api/v1/startups/${briefId}`);
  expect((await preview.json()).data.access).toBe('preview');
  expect(await preview.text()).not.toContain('CONFIDENTIAL-');

  await page.getByRole('button', { name: 'Clone to new draft' }).click();
  await expect(page.getByText('New draft created from a copy')).toBeVisible();
  await expect(page.getByLabel('Problem')).toHaveValue(`CONFIDENTIAL-PROBLEM ${LONG}`);
  await page.goto(`/founder/briefs/${briefId}`);
  await page.getByRole('button', { name: 'Close brief' }).click();
  await page.getByLabel(/Reason/).fill('Hired through the trial');
  await page.getByRole('button', { name: 'Close permanently' }).click();
  await expect(page.getByText('Brief closed')).toBeVisible();

  expect((await candidate.request.get(`/api/v1/startups/${briefId}`)).status()).toBe(404);
  await candidate.close();
});

test('brief mutations are idempotent and private across founders', async ({ page }) => {
  await signIn(page, ACCOUNTS.founder);
  const csrf = (await (await page.request.get('/api/v1/auth/csrf')).json()).data.csrfToken;
  const headers = { Origin: BASE_URL, 'X-CSRF-Token': csrf, 'Idempotency-Key': randomUUID() };
  const first = await page.request.post('/api/v1/startups', {
    headers,
    data: { title: 'Retry me' },
  });
  const second = await page.request.post('/api/v1/startups', {
    headers,
    data: { title: 'Retry me' },
  });
  expect(first.status()).toBe(201);
  expect(second.status()).toBe(201);
  expect((await second.json()).data.id).toBe((await first.json()).data.id);
  const conflict = await page.request.post('/api/v1/startups', {
    headers,
    data: { title: 'Other' },
  });
  expect(conflict.status()).toBe(409);
  const noKey = await page.request.post('/api/v1/startups', {
    headers: { Origin: BASE_URL, 'X-CSRF-Token': csrf },
    data: { title: 'No key' },
  });
  expect(noKey.status()).toBe(400);

  // A candidate cannot create or list a founder's briefs.
  const draftId = (await first.json()).data.id as string;
  const cand = await page.context().browser()!.newPage();
  await signIn(cand, ACCOUNTS.dev);
  expect((await cand.request.get('/api/v1/startups?scope=mine')).status()).toBe(403);
  expect((await cand.request.get(`/api/v1/startups/${draftId}`)).status()).toBe(404);
  await cand.close();
});
