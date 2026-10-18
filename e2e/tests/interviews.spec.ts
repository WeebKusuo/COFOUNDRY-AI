import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { ACCOUNTS, E2E_PASSWORD } from '../shared';

/**
 * Phases 7-10 end to end in a real browser against the real server and MongoDB:
 * recommendation -> invitation -> acceptance -> resume readiness -> interview room (fake
 * microphone, MediaRecorder upload, transcription) -> adaptive follow-up -> coding round in the
 * Monaco editor under the production CSP -> sandbox run -> submission -> durable evaluation ->
 * report for both participants.
 *
 * AI, speech-to-text/text-to-speech and the code sandbox are the deterministic TEST DOUBLES
 * configured in e2e/start-server.ts (no real model, no code execution); the report states so.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const RESUME = path.resolve(here, '../../apps/server/test/fixtures/resumes/resume-text.pdf');

// The collaboration and safety tests below continue from this journey's evaluated interview.
test.describe.configure({ mode: 'serial' });

async function signIn(page: Page, email: string) {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: false }).first().fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/(founder|candidate|moderator)$/);
}

test('the full interview journey from recommendation to report', async ({ page, browser }) => {
  test.setTimeout(180_000);
  const cspErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && /Content Security Policy/i.test(m.text())) cspErrors.push(m.text());
  });
  // Content types of every request body the candidate's browser sends.
  const uploadTypes: string[] = [];
  page.on('request', (r) => {
    if (r.method() !== 'GET') uploadTypes.push(r.headers()['content-type'] ?? '');
  });

  // Founder invites Asha from a fresh search.
  const founder = await browser.newPage();
  await signIn(founder, ACCOUNTS.founder);
  await founder.goto('/founder/candidates');
  await founder.getByLabel('Brief').selectOption({ label: 'PayPilot payment reconciliation API' });
  await founder.getByRole('button', { name: /Find candidates|Run a new search/ }).click();
  const ashaCard = founder.getByRole('article', { name: /^Asha, score/ });
  await ashaCard.getByRole('button', { name: 'Invite to interview' }).click();
  await ashaCard.getByRole('button', { name: 'Send invitation' }).click();
  await expect(ashaCard.getByText('Invitation sent to Asha.')).toBeVisible();

  // Asha uploads her resume, then accepts with consents.
  await signIn(page, ACCOUNTS.candidate);
  await page.goto('/candidate/profile');
  const resume = page.getByRole('region', { name: 'Resume' });
  await resume.getByLabel('I agree to the resume processing notice').check();
  await resume.getByLabel('Resume PDF').setInputFiles(RESUME);
  await resume.getByRole('button', { name: /Upload resume|Replace resume/ }).click();
  await expect(resume.getByText('Resume saved')).toBeVisible();

  await page.goto('/candidate/inbox');
  await page.getByRole('link', { name: 'PayPilot payment reconciliation API' }).click();
  await page.getByRole('button', { name: /I acknowledge/ }).click();
  await expect(page.getByRole('heading', { name: 'Problem and solution' })).toBeVisible();
  await page.getByLabel(/AI-assisted assessment/).check();
  await page.getByLabel(/processed by the AI provider/).check();
  await page.getByLabel(/answer by voice/).check();
  await expect(page.getByText('mock:mock-deterministic-v1')).toBeVisible();
  await page.getByRole('button', { name: 'Accept invitation' }).click();
  await page.getByRole('link', { name: 'Prepare and start' }).click();

  // Readiness: the questions are prepared from the resume before Start is enabled; fake
  // microphone and a local camera self-view.
  await expect(page.getByRole('heading', { name: 'Prepare for your interview' })).toBeVisible();
  await expect(page.getByText(/7 interview questions are ready/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('list', { name: 'Tech stack' })).toContainText('MongoDB');
  await expect(page.getByRole('button', { name: 'Start interview' })).toBeEnabled();
  await page.getByRole('button', { name: 'Turn camera on' }).click();
  const selfView = page.getByLabel('Your camera (only visible to you)');
  await expect(selfView).toBeVisible();
  await expect
    .poll(() => selfView.evaluate((v) => (v as HTMLVideoElement).videoWidth), { timeout: 10_000 })
    .toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Test microphone' }).click();
  await expect(page.getByRole('meter', { name: 'Microphone input level' })).toBeVisible();
  await page.getByRole('button', { name: 'Start interview' }).click();

  // Interview room: the self-view continues (still local only).
  await page.getByRole('button', { name: 'Enter the interview room' }).click();
  await expect(page.getByLabel('Your camera (only visible to you)')).toBeVisible();
  const question = page.getByRole('heading', { level: 1 });
  await expect(question).toContainText('background', { timeout: 15_000 });
  await page.getByRole('button', { name: 'Start answering' }).click();
  await expect(page.getByText('Listening to your answer')).toBeVisible();
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: 'Done answering' }).click();
  const transcript = page.getByLabel('Transcript (you can correct it)');
  await expect(transcript).toHaveValue(/REST API in Node.js/, { timeout: 15_000 });
  await transcript.fill(`${await transcript.inputValue()} I also wrote integration tests.`);
  await page.getByRole('button', { name: 'Submit answer' }).click();

  // Adaptive follow-up on a strong answer, answered by typing this time.
  await expect(page.getByText('Going deeper')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Type instead' }).click();
  await page
    .getByLabel('Type your answer')
    .fill('I would weigh consistency against latency because payments must not be double counted.');
  await page.getByRole('button', { name: 'Submit answer' }).click();
  await expect(page.getByRole('region', { name: 'Transcript' })).toContainText(
    'consistency against latency',
  );

  // Founder sees progress only before submission.
  const progress = await founder.request.get(`/api/v1/interviews?role=founder`);
  const id = (
    (await progress.json()) as { data: Array<{ id: string; candidate: { displayName: string } }> }
  ).data.find((i) => i.candidate.displayName === 'Asha')!.id;
  const early = (await (await founder.request.get(`/api/v1/interviews/${id}`)).json()) as {
    data: { turns: unknown[] };
  };
  expect(early.data.turns).toEqual([]);

  await page.getByRole('button', { name: 'Finish conversation' }).click();
  await page.getByRole('button', { name: 'Yes, go to coding' }).click();

  // Coding round in Monaco under the strict CSP.
  await expect(page.getByRole('heading', { name: 'Coding task' })).toBeVisible({ timeout: 15_000 });
  const editor = page.locator('.monaco-editor');
  await expect(editor).toBeVisible({ timeout: 20_000 });
  const raw = await (await page.request.get(`/api/v1/interviews/${id}`)).text();
  expect(raw).not.toMatch(/hiddenTests|expectedConcepts|reference/);
  await editor.locator('.view-lines').click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('// MOCK_REFERENCE test double marker');
  await page.getByRole('button', { name: 'Run visible tests' }).click();
  await expect(page.getByText(/2 of 2 visible tests passed/)).toBeVisible({ timeout: 15_000 });
  await page
    .getByLabel(/Explain your approach/)
    .fill('Kept the first occurrence with a Set in linear time.');
  await page.getByRole('button', { name: 'Submit solution and finish' }).click();
  await page.getByRole('button', { name: 'Submit solution' }).click();
  await expect(page.getByRole('heading', { name: /Interview submitted/ })).toBeVisible();
  expect(cspErrors).toEqual([]);

  // Nothing from the camera was ever sent: only JSON and the answer audio were uploaded.
  expect(uploadTypes.filter((t) => /video|image/i.test(t))).toEqual([]);
  expect(uploadTypes.some((t) => t.startsWith('audio/'))).toBe(true);

  // Another candidate cannot see it.
  const dev = await browser.newPage();
  await signIn(dev, ACCOUNTS.dev);
  expect((await dev.request.get(`/api/v1/interviews/${id}`)).status()).toBe(404);
  await dev.close();

  // The founder reads the evaluated report.
  await founder.goto(`/founder/interviews/${id}`);
  await expect(founder.getByRole('heading', { name: 'Summary' })).toBeVisible({ timeout: 30_000 });
  await expect(
    founder.getByText(/TEST DATA: produced by the deterministic mock AI provider/),
  ).toBeVisible();
  await expect(founder.getByText('Never part of the technical assessment')).toBeVisible();
  await expect(founder.getByRole('heading', { name: /Coding task:/ })).toBeVisible();
  await expect(
    founder.getByRole('heading', { name: 'Question-by-question evaluation' }),
  ).toBeVisible();
  await expect(founder.getByText(/not a hiring decision/).first()).toBeVisible();

  // The candidate reads the same report.
  await page.goto(`/candidate/inbox/${id}`);
  await expect(page.getByRole('heading', { name: 'Scoring methodology' })).toBeVisible({
    timeout: 30_000,
  });
  await founder.close();

  // The interview keeps its frozen resume reference; deleting the resume afterwards is allowed
  // (and leaves other suites with a clean resume store).
  await page.goto('/candidate/profile');
  const after = page.getByRole('region', { name: 'Resume' });
  await after.getByRole('button', { name: 'Delete' }).click();
  await after.getByRole('button', { name: 'Delete resume' }).click();
  await expect(after.getByText('Resume deleted')).toBeVisible();
});

async function ashaInterviewId(page: Page): Promise<string> {
  const res = await page.request.get('/api/v1/interviews?role=candidate');
  const items = ((await res.json()) as { data: Array<{ id: string; status: string }> }).data;
  const submitted = items.find((i) => i.status === 'submitted');
  if (!submitted) throw new Error('the interview journey above must run first');
  return submitted.id;
}

test('collaboration request, match and a mutually approved trial sprint to completion', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const asha = await browser.newPage();
  await signIn(asha, ACCOUNTS.candidate);
  const interviewId = await ashaInterviewId(asha);

  // Phase 11: the founder sends a request from the completed report.
  const founder = await browser.newPage();
  await signIn(founder, ACCOUNTS.founder);
  await founder.goto(`/founder/interviews/${interviewId}`);
  const panel = founder.getByRole('region', { name: 'Invite Asha to collaborate' });
  await panel.getByLabel('Message (optional)').fill('Your reconciliation answers were great.');
  await panel.getByRole('button', { name: 'Send collaboration request' }).click();
  await expect(founder.getByText('Collaboration request: pending')).toBeVisible();

  // The candidate accepts it from the inbox's collaboration tab.
  await asha.goto('/candidate/inbox');
  await asha.getByRole('tab', { name: /Collaboration requests/ }).click();
  await asha.getByRole('link', { name: 'PayPilot payment reconciliation API' }).click();
  await expect(asha.getByText('Your reconciliation answers were great.')).toBeVisible();
  await asha.getByRole('button', { name: 'Accept and match' }).click();
  await asha.getByRole('link', { name: 'Open the match' }).click();
  await expect(asha.getByRole('heading', { level: 1 })).toContainText('Rohan (PayPilot)');
  const matchUrl = new URL(asha.url()).pathname.replace('/candidate', '');

  // Phase 12: the founder proposes and sends; the candidate approves the same version.
  await founder.goto(`/founder${matchUrl}`);
  await founder.getByRole('button', { name: 'Propose a trial sprint' }).click();
  await founder.getByLabel('Title').fill('Webhook ingestion endpoint');
  await founder
    .getByLabel('Scope')
    .fill(
      'Build one REST endpoint that ingests payout webhooks idempotently, with tests for retries.',
    );
  await founder
    .getByLabel('Deliverables (one per line)')
    .fill('POST /webhooks/payouts\nAutomated tests');
  await founder
    .getByLabel('Measurable acceptance criteria (one per line)')
    .fill('Duplicate deliveries are stored once\nTests cover retries');
  await founder.getByLabel('Expected effort (total hours)').fill('6');
  await founder.getByLabel('Amount (INR)').fill('2000');
  await founder.getByRole('button', { name: 'Save draft proposal' }).click();
  await expect(founder.getByText('Draft proposal')).toBeVisible();
  await founder.getByLabel(/I approve version 1 of these terms/).check();
  await founder.getByRole('button', { name: 'Send for approval' }).click();
  await expect(founder.getByText('Waiting for approval')).toBeVisible();

  await asha.reload();
  await expect(asha.getByText('Waiting for approval')).toBeVisible();
  await asha.getByLabel(/I approve version 1 of these terms/).check();
  await asha.getByRole('button', { name: 'Approve and start the sprint' }).click();
  await expect(asha.getByText('Active — work in progress')).toBeVisible();

  // Phase 13: submission, criterion review and both acknowledgements.
  await asha
    .getByLabel(/Link to your work/)
    .fill('https://github.com/asha-demo/payouts-webhook/pull/1');
  await asha.getByLabel(/The founder may view this link/).check();
  await asha.getByRole('button', { name: 'Submit work' }).click();
  await expect(asha.getByText('Submitted — waiting for review')).toBeVisible();

  await founder.reload();
  const groups = founder.getByRole('group', { name: /Criterion \d/ });
  await expect(groups).toHaveCount(2);
  for (let i = 0; i < 2; i += 1) {
    await groups
      .nth(i)
      .getByLabel('Outcome')
      .selectOption(i === 0 ? 'met' : 'partially_met');
    await groups
      .nth(i)
      .getByLabel('Evidence and feedback')
      .fill(`Checked criterion ${i + 1}`);
  }
  await founder.getByRole('button', { name: 'Record review' }).click();
  await expect(founder.getByText('Reviewed — waiting for acknowledgements')).toBeVisible();
  await founder.getByRole('button', { name: 'Acknowledge the outcome' }).click();

  await asha.reload();
  await asha
    .getByLabel('Disagreement note (optional)')
    .fill('The retry test is in tests/retry.test.ts.');
  await asha.getByRole('button', { name: 'Acknowledge the outcome' }).click();
  await expect(asha.getByText('Completed trial').first()).toBeVisible();
  await founder.reload();
  await expect(founder.getByText('Completed trial').first()).toBeVisible();

  // Exactly one match for the pair; another candidate cannot open it.
  const matches = (await (await founder.request.get('/api/v1/matches?role=founder')).json()) as {
    data: Array<{ id: string; status: string }>;
  };
  expect(matches.data.filter((m) => m.status === 'completed')).toHaveLength(1);
  const dev = await browser.newPage();
  await signIn(dev, ACCOUNTS.dev);
  expect((await dev.request.get(`/api/v1${matchUrl}`)).status()).toBe(404);
  await dev.close();
  await founder.close();
  await asha.close();
});

test('correction, moderation and blocking with audited, role-restricted access', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const asha = await browser.newPage();
  await signIn(asha, ACCOUNTS.candidate);
  const interviewId = await ashaInterviewId(asha);

  // The candidate requests a correction of her own report.
  await asha.goto(`/candidate/inbox/${interviewId}`);
  await asha.getByRole('button', { name: 'Request a correction' }).click();
  await asha
    .getByLabel('What is incorrect, and what should it say?')
    .fill('Question 2: my answer did describe retries with exponential backoff.');
  await asha.getByRole('button', { name: 'Send correction request' }).click();
  await expect(asha.getByRole('alert').getByText('Correction requested')).toBeVisible();

  // Founders cannot reach moderation; the moderator claims, reads evidence and resolves.
  const founder = await browser.newPage();
  await signIn(founder, ACCOUNTS.founder);
  expect((await founder.request.get('/api/v1/admin/cases')).status()).toBe(403);
  const mod = await browser.newPage();
  await signIn(mod, ACCOUNTS.moderator);
  await mod.goto('/moderator/cases');
  await mod
    .getByRole('link', { name: /Correction · Interview report/ })
    .first()
    .click();
  await mod.getByRole('button', { name: 'Claim case' }).click();
  await expect(mod.getByText('Question 2: my answer did describe retries')).toBeVisible();
  await expect(mod.getByRole('heading', { name: 'Minimum evidence' })).toBeVisible();
  await mod
    .getByLabel(/Resolution \(the reporter sees this\)/)
    .fill('Upheld: the answer covers retries.');
  await mod
    .getByLabel(/Display correction/)
    .fill('Q2: the candidate described retries with backoff.');
  await mod.getByRole('button', { name: 'Record decision' }).click();
  await expect(mod.getByText('Case resolved')).toBeVisible();
  await mod.close();

  // Both report participants see the attributed correction; the source answers are unchanged.
  await founder.goto(`/founder/interviews/${interviewId}`);
  await expect(founder.getByRole('heading', { name: 'Moderator corrections' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    founder.getByText('Q2: the candidate described retries with backoff.'),
  ).toBeVisible();

  // The candidate blocks the founder from the match page; the founder sees no reason.
  const matches = (await (await asha.request.get('/api/v1/matches?role=candidate')).json()) as {
    data: Array<{ id: string }>;
  };
  const matchId = matches.data[0]!.id;
  await asha.goto(`/candidate/matches/${matchId}`);
  await asha.getByRole('button', { name: 'Block Rohan (PayPilot)' }).click();
  await asha.getByRole('button', { name: 'Block Rohan (PayPilot)' }).click();
  // The page refreshes into the unavailable state (block controls are no longer offered).
  await expect(asha.getByText('This collaboration is no longer available').first()).toBeVisible();
  await founder.goto(`/founder/matches/${matchId}`);
  await expect(founder.getByText('This collaboration is no longer available')).toBeVisible();
  expect(await founder.content()).not.toMatch(/blocked/i);
  await founder.goto(`/founder/interviews/${interviewId}`);
  await expect(founder.getByText('Report unavailable')).toBeVisible();

  // Unblocking removes only the block; nothing ended by it is revived.
  await asha.goto('/candidate/account');
  await asha.getByRole('button', { name: 'Unblock Rohan (PayPilot)' }).click();
  await expect(asha.getByText('You have not blocked anyone.')).toBeVisible();
  await founder.close();
  await asha.close();
});
