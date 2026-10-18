import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { ACCOUNTS, BASE_URL, E2E_PASSWORD } from '../shared';

async function signIn(page: Page, email: string) {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: false }).first().fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/(founder|candidate|moderator)$/);
}

const card = (page: Page, name: string) =>
  page.getByRole('article', { name: new RegExp(`^${name}, score`) });

test('a founder runs a real match-v3.0 search and reads the explained results', async ({
  page,
  browser,
}) => {
  await signIn(page, ACCOUNTS.founder);
  await page.getByRole('navigation').first().getByRole('link', { name: 'Candidates' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Candidates' })).toBeVisible();
  await page.getByLabel('Brief').selectOption({ label: 'PayPilot payment reconciliation API' });
  await page.getByRole('button', { name: 'Find candidates' }).click();

  const recommended = page.getByRole('region', { name: 'Recommended' });
  const provisional = page.getByRole('region', { name: 'Provisional' });
  const near = page.getByRole('region', { name: 'Near matches' });
  // Section 26 groups (Dev's exact score depends on profile edits made by earlier E2E tests).
  await expect(card(page, 'Asha')).toContainText('100.00');
  await expect(recommended.getByRole('heading', { name: 'Dev' })).toBeVisible();
  await expect(provisional.getByRole('heading', { name: 'Isha' })).toBeVisible();
  await expect(provisional.getByText('No projects', { exact: true })).toBeVisible();
  await expect(near.getByRole('heading', { name: 'Nila' })).toBeVisible();
  await expect(card(page, 'Nila')).toContainText('96.67');
  await expect(card(page, 'Nila')).toContainText(
    'Offers 2 months; the brief asks for 3 (not mandatory).',
  );
  await expect(page.getByText(/did not meet a hard requirement/)).toContainText(
    'fewer weekly hours than required (1)',
  );
  for (const absent of ['Kabir', 'Mira', 'Hidden']) {
    await expect(page.getByRole('heading', { name: absent })).toHaveCount(0);
  }

  const asha = card(page, 'Asha');
  await asha.getByRole('button', { name: 'View details' }).click();
  await expect(asha.getByRole('table')).toContainText('REST APIs');
  await expect(
    card(page, 'Dev').getByRole('button', { name: 'Invite to interview' }),
  ).toBeEnabled();

  // The API is the source of truth: no email, consent or resume data in the response.
  const latest = await page.request.get(
    `/api/v1/startups/${(await (await page.request.get('/api/v1/startups?scope=mine')).json()).data.find((b: { title: string }) => b.title === 'PayPilot payment reconciliation API').id}/recommendations`,
  );
  expect(latest.status()).toBe(200);
  const body = await latest.text();
  expect(body).not.toContain('@demo.cofoundry.test');
  expect(body).not.toMatch(/resume|discoveryConsent|passwordHash/);

  // Isha turns discovery off: the next read withholds her without refilling the list.
  const isha = await browser.newPage();
  await signIn(isha, 'isha@demo.cofoundry.test');
  await isha.goto('/candidate/profile');
  await isha.getByRole('checkbox', { name: /I agree to show my profile/ }).uncheck();
  await isha.getByRole('button', { name: 'Save profile' }).click();
  await expect(isha.getByText('Profile saved')).toBeVisible();
  await isha.close();

  await page.reload();
  await expect(
    provisional.getByText('No candidates scored 50 or more in this group.'),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Isha' })).toHaveCount(0);
});

test('recommendation routes are founder-owner only and idempotent', async ({ page, browser }) => {
  await signIn(page, ACCOUNTS.founder);
  const mine = await (await page.request.get('/api/v1/startups?scope=mine')).json();
  const briefId = mine.data.find((b: { status: string; title: string }) => b.status === 'open')
    .id as string;
  const csrf = (await (await page.request.get('/api/v1/auth/csrf')).json()).data.csrfToken;
  const headers = { Origin: BASE_URL, 'X-CSRF-Token': csrf, 'Idempotency-Key': randomUUID() };
  const a = await page.request.post(`/api/v1/startups/${briefId}/recommendations`, {
    headers,
    data: {},
  });
  const b = await page.request.post(`/api/v1/startups/${briefId}/recommendations`, {
    headers,
    data: {},
  });
  expect(a.status()).toBe(201);
  expect((await b.json()).data.batchId).toBe((await a.json()).data.batchId);

  const candidate = await browser.newPage();
  await signIn(candidate, ACCOUNTS.dev);
  expect(
    (await candidate.request.get(`/api/v1/startups/${briefId}/recommendations`)).status(),
  ).toBe(403);
  await candidate.close();
});
