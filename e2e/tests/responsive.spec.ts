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
