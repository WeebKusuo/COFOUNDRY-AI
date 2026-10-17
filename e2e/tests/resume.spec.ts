import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { ACCOUNTS, E2E_PASSWORD } from '../shared';
import { userIdFor } from '../db';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(here, '../../apps/server/test/fixtures/resumes/resume-text.pdf');
const STORAGE = path.join(os.tmpdir(), 'cofoundry-e2e-resumes');
const storedFiles = () =>
  fs.existsSync(STORAGE) ? fs.readdirSync(STORAGE).filter((n) => n.endsWith('.pdf')) : [];

async function signIn(page: Page, email: string) {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: false }).first().fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/(founder|candidate|moderator)$/);
}

test('a candidate uploads, inspects, downloads and deletes a private resume', async ({
  page,
  browser,
}) => {
  await signIn(page, ACCOUNTS.nila);
  await page.goto('/candidate/profile');
  const resume = page.getByRole('region', { name: 'Resume' });
  await expect(resume.getByText(/No resume uploaded/)).toBeVisible();
  await expect(resume.getByRole('button', { name: 'Upload resume' })).toBeDisabled();
  await resume.getByLabel('I agree to the resume processing notice').check();
  await resume.getByLabel('Resume PDF').setInputFiles(FIXTURE);
  await resume.getByRole('button', { name: 'Upload resume' }).click();
  await expect(resume.getByText('Resume saved')).toBeVisible();
  await expect(resume.getByText('Text extracted')).toBeVisible();
  expect(storedFiles()).toHaveLength(1);

  await resume.getByRole('button', { name: 'View extracted text' }).click();
  await expect(resume.getByText(/Built a Node.js REST API/)).toBeVisible();
  await expect(resume.getByText('riya.demo@example.com')).toHaveCount(0);

  const download = await page.request.get('/api/v1/candidate/resume/file');
  expect(download.status()).toBe(200);
  expect(download.headers()['content-disposition']).toMatch(/^attachment;/);
  expect(Buffer.compare(await download.body(), fs.readFileSync(FIXTURE))).toBe(0);

  // Founders get nothing: no route, no projection.
  const founder = await browser.newPage();
  await signIn(founder, ACCOUNTS.founder);
  expect((await founder.request.get('/api/v1/candidate/resume/file')).status()).toBe(403);
  const nilaId = await userIdFor(ACCOUNTS.nila);
  const publicProfile = await founder.request.get(`/api/v1/profiles/${nilaId}`);
  expect(await publicProfile.text()).not.toMatch(/resume|Riya/i);
  await founder.close();

  await resume.getByRole('button', { name: 'Delete' }).click();
  await resume.getByRole('button', { name: 'Delete resume' }).click();
  await expect(resume.getByText('Resume deleted')).toBeVisible();
  expect(storedFiles()).toHaveLength(0);
  expect((await page.request.get('/api/v1/candidate/resume/file')).status()).toBe(404);
});
