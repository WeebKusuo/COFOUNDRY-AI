import { expect, test } from '@playwright/test';
import { ACCOUNTS, E2E_PASSWORD } from '../shared';

test('sign-in and the workspace fit a phone screen and work from the mobile menu', async ({
  page,
}) => {
  await page.goto('/sign-in');
  const overflow = () =>
    page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
  expect(await overflow()).toBe(0);

  await page.getByLabel('Email').fill(ACCOUNTS.founder);
  await page.getByLabel('Password', { exact: false }).first().fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Founder workspace' })).toBeVisible();
  expect(await overflow()).toBe(0);

  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByText('You signed out')).toBeVisible();
});

test('the candidate profile editor works on a phone', async ({ page }) => {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(ACCOUNTS.candidate);
  await page.getByLabel('Password', { exact: false }).first().fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Candidate workspace' })).toBeVisible();
  await page.getByRole('link', { name: 'Edit profile' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Your profile' })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBe(0);

  await page.getByRole('button', { name: 'Add skill' }).click();
  await page.getByLabel('Skill 3', { exact: true }).selectOption('testing');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByText('Profile saved')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Skill 3', { exact: true })).toHaveValue('testing');
});

test('the brief editor and resume section fit a phone screen', async ({ page }) => {
  const overflow = () =>
    page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(ACCOUNTS.founder);
  await page.getByLabel('Password', { exact: false }).first().fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Founder workspace' })).toBeVisible();
  await page.goto('/founder/briefs');
  await page.getByRole('button', { name: 'New brief' }).click();
  await page.getByLabel(/Brief title/).fill('Phone draft');
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Phone draft' })).toBeVisible();
  expect(await overflow()).toBe(0);
  await page.getByLabel('Teaser').fill('Typed on a phone.');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByText('You signed out')).toBeVisible();

  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(ACCOUNTS.candidate);
  await page.getByLabel('Password', { exact: false }).first().fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Candidate workspace' })).toBeVisible();
  await page.goto('/candidate/profile');
  await expect(
    page.getByRole('region', { name: 'Resume' }).getByText(/No resume uploaded/),
  ).toBeVisible();
  expect(await overflow()).toBe(0);
});
