import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CandidateProfileData, CandidateResumeData, ResumeMetadata } from '@cofoundry/shared';
import { renderRoute } from '../../test/render';
import { demoUser, installFakeApi } from '../../test/fake-api';

const profile: CandidateProfileData = {
  userId: '65f0c0ffee0000000000000a',
  revision: 1,
  headline: 'Backend developer',
  bio: '',
  skills: [{ skillId: 'nodejs', level: 4 }],
  industryTags: ['fintech'],
  missionTags: ['reliability'],
  availableHoursPerWeek: 10,
  commitmentMonths: 3,
  opportunityTypes: ['contributor'],
  projects: [],
  discoveryEnabled: false,
  discoveryConsent: false,
  updatedAt: '2026-10-17T10:00:00.000Z',
};

const meta = (overrides: Partial<ResumeMetadata['extraction']> = {}): ResumeMetadata => ({
  version: 1,
  filename: 'cv.pdf',
  sizeBytes: 2048,
  fileSha256: 'a'.repeat(64),
  uploadedAt: '2026-10-17T10:00:00.000Z',
  extraction: {
    status: 'succeeded',
    extractorVersion: 'pdfjs-6.3.289/text-v1',
    pageCount: 1,
    pagesProcessed: 1,
    textChars: 330,
    truncated: false,
    textSha256: 'b'.repeat(64),
    extractedAt: '2026-10-17T10:00:00.000Z',
    ...overrides,
  },
});

function backend(initial: CandidateResumeData, uploadResult?: { status: number; body: unknown }) {
  let state = initial;
  const calls: Array<{
    method: string;
    path: string;
    headers: Record<string, string>;
    body: unknown;
  }> = [];
  const routes = (method: string, path: string, body: unknown, headers: Record<string, string>) => {
    calls.push({ method, path, headers, body });
    if (path === '/candidate/profile')
      return { status: 200, body: { data: profile, requestId: 'r' } };
    if (path === '/candidate/resume' && method === 'GET')
      return { status: 200, body: { data: state, requestId: 'r' } };
    if (path === '/candidate/resume' && method === 'PUT') {
      if (uploadResult) return uploadResult;
      state = { ...state, resume: meta(), currentVersion: state.currentVersion + 1, consent: true };
      return { status: 200, body: { data: state, requestId: 'r' } };
    }
    if (path === '/candidate/resume' && method === 'DELETE') {
      state = { ...state, resume: null, consent: false };
      return { status: 204 };
    }
    if (path === '/candidate/resume/text') {
      return {
        status: 200,
        body: {
          data: {
            version: 1,
            status: 'succeeded',
            redactedText: 'Built a Node.js API. Email: [email removed]',
            redactions: { emails: 1, phones: 0, urls: 0 },
            truncated: false,
          },
          requestId: 'r',
        },
      };
    }
    return undefined;
  };
  return { routes, calls };
}

const empty: CandidateResumeData = {
  resume: null,
  currentVersion: 0,
  consent: false,
  policyVersion: 'resume-processing-v1',
};

const pdf = (name = 'cv.pdf', size = 1000) =>
  new File([new Uint8Array(size)], name, {
    type: name.endsWith('.pdf') ? 'application/pdf' : 'text/plain',
  });

/** The resume region once its data has loaded. */
async function resumeRegion() {
  const region = await screen.findByRole('region', { name: 'Resume' });
  await within(region).findByText(/Download|No resume uploaded/);
  return region;
}

describe('resume section on the candidate profile', () => {
  it('requires consent, uploads the raw PDF with policy, version and filename headers', async () => {
    const api = backend(empty);
    installFakeApi({ user: demoUser(['candidate']), routes: api.routes });
    renderRoute('/candidate/profile');
    const region = await resumeRegion();
    expect(await within(region).findByText(/founders never receive the file/i)).toBeInTheDocument();
    await userEvent.upload(within(region).getByLabelText('Resume PDF'), pdf('My CV.pdf'));
    const button = within(region).getByRole('button', { name: 'Upload resume' });
    expect(button).toBeDisabled();
    await userEvent.click(within(region).getByLabelText('I agree to the resume processing notice'));
    await userEvent.click(button);
    expect(await within(region).findByText('Resume saved')).toBeInTheDocument();
    const put = api.calls.find((c) => c.method === 'PUT')!;
    expect(put.body).toBeInstanceOf(Blob);
    expect(put.headers['Content-Type']).toBe('application/pdf');
    expect(put.headers['X-Resume-Consent']).toBe('resume-processing-v1');
    expect(put.headers['X-Expected-Version']).toBe('0');
    expect(put.headers['X-Filename']).toBe('My%20CV.pdf');
    expect(put.headers['X-CSRF-Token']).toBeTruthy();
    expect(within(region).getByText('cv.pdf')).toBeInTheDocument();
    expect(within(region).getByText('Text extracted')).toBeInTheDocument();
    expect(within(region).getByRole('link', { name: /Download/ })).toHaveAttribute(
      'href',
      '/api/v1/candidate/resume/file',
    );
  });

  it('rejects non-PDF and oversized files before uploading', async () => {
    const api = backend(empty);
    installFakeApi({ user: demoUser(['candidate']), routes: api.routes });
    renderRoute('/candidate/profile');
    const region = await resumeRegion();
    await userEvent.click(within(region).getByLabelText('I agree to the resume processing notice'));
    const input = within(region).getByLabelText('Resume PDF');
    await userEvent.upload(input, pdf('huge.pdf', 5 * 1024 * 1024 + 1));
    await userEvent.click(within(region).getByRole('button', { name: 'Upload resume' }));
    expect(await within(region).findByText('Resumes can be at most 5 MB.')).toBeInTheDocument();
    expect(api.calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('shows the server’s reason when a PDF cannot be read', async () => {
    const api = backend(empty, {
      status: 422,
      body: {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'This PDF is password-protected.',
          fieldErrors: {
            file: ['This PDF is password-protected. Upload a version without a password.'],
          },
        },
        requestId: 'r',
      },
    });
    installFakeApi({ user: demoUser(['candidate']), routes: api.routes });
    renderRoute('/candidate/profile');
    const region = await resumeRegion();
    await userEvent.click(within(region).getByLabelText('I agree to the resume processing notice'));
    await userEvent.upload(within(region).getByLabelText('Resume PDF'), pdf());
    await userEvent.click(within(region).getByRole('button', { name: 'Upload resume' }));
    expect(
      await within(region).findByText(
        'This PDF is password-protected. Upload a version without a password.',
      ),
    ).toBeInTheDocument();
  });

  it('warns when the PDF has no text and shows the redacted text on request', async () => {
    const api = backend({
      ...empty,
      resume: meta({ status: 'no_text', textChars: 0 }),
      currentVersion: 1,
      consent: true,
    });
    installFakeApi({ user: demoUser(['candidate']), routes: api.routes });
    renderRoute('/candidate/profile');
    const region = await resumeRegion();
    expect(await within(region).findByText('This PDF has no readable text')).toBeInTheDocument();
    await userEvent.click(within(region).getByRole('button', { name: 'View extracted text' }));
    expect(await within(region).findByText(/Built a Node.js API/)).toBeInTheDocument();
    expect(within(region).getByText(/after removing 1 email/)).toBeInTheDocument();
  });

  it('deletes after confirmation', async () => {
    const api = backend({ ...empty, resume: meta(), currentVersion: 1, consent: true });
    installFakeApi({ user: demoUser(['candidate']), routes: api.routes });
    renderRoute('/candidate/profile');
    const region = await resumeRegion();
    await userEvent.click(await within(region).findByRole('button', { name: 'Delete' }));
    await userEvent.click(within(region).getByRole('button', { name: 'Delete resume' }));
    expect(await within(region).findByText('Resume deleted')).toBeInTheDocument();
    expect(api.calls.some((c) => c.method === 'DELETE')).toBe(true);
    expect(await within(region).findByText(/No resume uploaded/)).toBeInTheDocument();
  });

  it('replaces with the current version and keeps the profile form untouched', async () => {
    const api = backend({ ...empty, resume: meta(), currentVersion: 4, consent: true });
    installFakeApi({ user: demoUser(['candidate']), routes: api.routes });
    renderRoute('/candidate/profile');
    const region = await resumeRegion();
    await userEvent.click(await within(region).findByRole('button', { name: 'Replace' }));
    await userEvent.click(within(region).getByLabelText('I agree to the resume processing notice'));
    await userEvent.upload(within(region).getByLabelText('Replacement PDF'), pdf());
    await userEvent.click(within(region).getByRole('button', { name: 'Replace resume' }));
    expect(await within(region).findByText('Resume saved')).toBeInTheDocument();
    expect(api.calls.find((c) => c.method === 'PUT')!.headers['X-Expected-Version']).toBe('4');
    expect(api.calls.some((c) => c.path === '/candidate/profile' && c.method === 'PUT')).toBe(
      false,
    );
  });
});
