import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  CandidateProfileData,
  CandidateProfileUpdate,
  FounderProfileData,
} from '@cofoundry/shared';
import { renderRoute } from '../../test/render';
import { demoUser, installFakeApi } from '../../test/fake-api';
import { draftDiscoveryGaps, draftFromProfile, draftToUpdate, validateDraft } from './draft';

const DESCRIPTION = 'Built a REST API in Node.js with request validation, tests and retries.';

function blankCandidate(overrides: Partial<CandidateProfileData> = {}): CandidateProfileData {
  return {
    userId: '65f0c0ffee0000000000000a',
    revision: 0,
    headline: '',
    bio: '',
    skills: [],
    industryTags: [],
    missionTags: [],
    availableHoursPerWeek: null,
    commitmentMonths: null,
    opportunityTypes: [],
    projects: [],
    discoveryEnabled: false,
    discoveryConsent: false,
    updatedAt: null,
    ...overrides,
  };
}

const ashaLike = (revision = 1): CandidateProfileData =>
  blankCandidate({
    revision,
    headline: 'Backend developer',
    skills: [{ skillId: 'nodejs', level: 4 }],
    industryTags: ['fintech'],
    missionTags: ['reliability'],
    availableHoursPerWeek: 10,
    commitmentMonths: 3,
    opportunityTypes: ['contributor'],
    projects: [
      {
        id: 'p'.repeat(24),
        title: 'Payments API',
        description: DESCRIPTION,
        skillTags: ['nodejs'],
        url: null,
        evidenceStatus: 'self_reported',
      },
    ],
    discoveryEnabled: true,
    discoveryConsent: true,
    updatedAt: '2026-10-17T10:00:00.000Z',
  });

/** A small stateful candidate-profile backend mirroring the server's revision rules. */
function candidateBackend(
  initial: CandidateProfileData,
  options: { conflictOnSave?: boolean; invalid?: Record<string, string[]> } = {},
) {
  let profile = initial;
  const puts: CandidateProfileUpdate[] = [];
  const routes = (method: string, path: string, body: unknown) => {
    if (path === '/candidate/profile' && method === 'GET')
      return { status: 200, body: { data: profile, requestId: 'r' } };
    if (path === '/candidate/profile' && method === 'PUT') {
      const update = body as CandidateProfileUpdate;
      puts.push(update);
      if (options.invalid) {
        return {
          status: 422,
          body: {
            error: {
              code: 'VALIDATION_FAILED',
              message: 'Some fields are invalid.',
              fieldErrors: options.invalid,
            },
            requestId: 'r',
          },
        };
      }
      if (options.conflictOnSave || update.expectedRevision !== profile.revision) {
        return {
          status: 409,
          body: { error: { code: 'VERSION_CONFLICT', message: 'changed' }, requestId: 'r' },
        };
      }
      profile = {
        ...profile,
        ...update,
        skills: update.skills as CandidateProfileData['skills'],
        industryTags: update.industryTags as CandidateProfileData['industryTags'],
        missionTags: update.missionTags as CandidateProfileData['missionTags'],
        opportunityTypes: update.opportunityTypes as CandidateProfileData['opportunityTypes'],
        projects: update.projects.map((p, i) => ({
          id: p.id ?? String(i).padStart(24, 'n'),
          title: p.title,
          description: p.description,
          skillTags: p.skillTags as CandidateProfileData['projects'][number]['skillTags'],
          url: p.url,
          evidenceStatus: p.url ? 'project_linked' : 'self_reported',
        })),
        revision: profile.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      return { status: 200, body: { data: profile, requestId: 'r' } };
    }
    if (path.startsWith('/profiles/')) {
      return {
        status: 200,
        body: {
          data: {
            userId: profile.userId,
            displayName: 'Asha',
            demoAccount: true,
            founder: null,
            candidate: { ...profile },
          },
          requestId: 'r',
        },
      };
    }
    return undefined;
  };
  return { routes, puts, current: () => profile };
}

describe('draft model', () => {
  it('round-trips a saved profile into the PUT body, keeping project ids', () => {
    const update = draftToUpdate(draftFromProfile(ashaLike()), 1);
    expect(update).toMatchObject({
      expectedRevision: 1,
      skills: [{ skillId: 'nodejs', level: 4 }],
      availableHoursPerWeek: 10,
      opportunityTypes: ['contributor'],
      projects: [{ id: 'p'.repeat(24), url: null }],
    });
  });

  it('turns empty numbers into null and empty links into null', () => {
    const draft = { ...draftFromProfile(blankCandidate()), hours: '', months: ' 4 ' };
    expect(draftToUpdate(draft, 0)).toMatchObject({
      availableHoursPerWeek: null,
      commitmentMonths: 4,
    });
  });

  it('flags limits with the same keys the server uses', () => {
    const draft = draftFromProfile(blankCandidate());
    draft.hours = '41';
    draft.months = '2.5';
    draft.headline = 'x'.repeat(161);
    draft.projects = [
      { key: 'a', title: '', description: 'short', skillTags: [], url: 'http://x.example' },
    ];
    expect(Object.keys(validateDraft(draft)).sort()).toEqual([
      'body.availableHoursPerWeek',
      'body.commitmentMonths',
      'body.headline',
      'body.projects.0.description',
      'body.projects.0.skillTags',
      'body.projects.0.title',
      'body.projects.0.url',
    ]);
  });

  it('reports discovery gaps, including consent', () => {
    expect(draftDiscoveryGaps(draftFromProfile(blankCandidate()))).toEqual([
      'skills',
      'industryTags',
      'missionTags',
      'availableHoursPerWeek',
      'commitmentMonths',
      'opportunityTypes',
      'discoveryConsent',
    ]);
    expect(draftDiscoveryGaps(draftFromProfile(ashaLike()))).toEqual([]);
  });
});

describe('candidate profile page', () => {
  it('loads the saved profile and shows its status', async () => {
    const backend = candidateBackend(ashaLike(3));
    installFakeApi({ user: demoUser(['candidate']), routes: backend.routes });
    renderRoute('/candidate/profile');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Your profile' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Headline')).toHaveValue('Backend developer');
    expect(screen.getByText('Discoverable')).toBeInTheDocument();
    expect(screen.getByText('Saved, revision 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save profile' })).toBeDisabled();
  });

  it('creates a first profile with expectedRevision 0 and CSRF, then reports it saved', async () => {
    const backend = candidateBackend(blankCandidate());
    const { state } = installFakeApi({ user: demoUser(['candidate']), routes: backend.routes });
    renderRoute('/candidate/profile');
    await userEvent.type(await screen.findByLabelText('Headline'), 'Node developer');
    await userEvent.click(screen.getByRole('button', { name: 'Add skill' }));
    await userEvent.selectOptions(screen.getByLabelText('Skill 1'), 'mongodb');
    await userEvent.click(screen.getByRole('radio', { name: '4 — Strong' }));
    await userEvent.type(screen.getByLabelText('Hours per week'), '12');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Fintech' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    expect(await screen.findByText('Profile saved')).toBeInTheDocument();
    expect(backend.puts[0]).toMatchObject({
      expectedRevision: 0,
      headline: 'Node developer',
      skills: [{ skillId: 'mongodb', level: 4 }],
      availableHoursPerWeek: 12,
      commitmentMonths: null,
      industryTags: ['fintech'],
      discoveryEnabled: false,
    });
    expect(state.calls.find((c) => c.method === 'PUT')?.csrf).toMatch(/^csrf-/);
    expect(screen.getByText('Saved, revision 1')).toBeInTheDocument();
  });

  it('keeps discovery off until the profile is complete and lists what is missing', async () => {
    const backend = candidateBackend(blankCandidate({ revision: 1 }));
    installFakeApi({ user: demoUser(['candidate']), routes: backend.routes });
    renderRoute('/candidate/profile');
    const discovery = await screen.findByRole('switch', { name: 'Discoverable by founders' });
    expect(discovery).toBeDisabled();
    expect(screen.getByText('Add at least one skill.')).toBeInTheDocument();
    expect(screen.getByText('Agree to the profile disclosure notice.')).toBeInTheDocument();
  });

  it('withdrawing consent switches discovery off before saving', async () => {
    const backend = candidateBackend(ashaLike(2));
    installFakeApi({ user: demoUser(['candidate']), routes: backend.routes });
    renderRoute('/candidate/profile');
    const consent = await screen.findByRole('checkbox', { name: /I agree to show my profile/ });
    await userEvent.click(consent);
    expect(screen.getByRole('switch', { name: 'Discoverable by founders' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    expect(await screen.findByText('Profile saved')).toBeInTheDocument();
    expect(backend.puts[0]).toMatchObject({ discoveryEnabled: false, discoveryConsent: false });
    expect(screen.getByText('Hidden from search')).toBeInTheDocument();
  });

  it('blocks saving invalid projects on the client and shows field messages', async () => {
    const backend = candidateBackend(ashaLike(1));
    installFakeApi({ user: demoUser(['candidate']), routes: backend.routes });
    renderRoute('/candidate/profile');
    await userEvent.click(await screen.findByRole('button', { name: 'Add project' }));
    const projects = screen
      .getAllByRole('listitem')
      .filter((li) => within(li).queryByText(/^Project \d$/));
    const newProject = projects.at(-1)!;
    await userEvent.type(within(newProject).getByLabelText(/^Title/), 'Short one');
    await userEvent.type(within(newProject).getByLabelText(/What you built/), 'Too short');
    await userEvent.type(within(newProject).getByLabelText(/Link/), 'http://insecure.example');
    await userEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    expect(await screen.findByText('Fix the highlighted fields')).toBeInTheDocument();
    expect(
      within(newProject).getByText('Description needs 50-1500 characters.'),
    ).toBeInTheDocument();
    expect(within(newProject).getByText('Tag at least one skill.')).toBeInTheDocument();
    expect(
      within(newProject).getByText('Enter a public link starting with https://.'),
    ).toBeInTheDocument();
    expect(backend.puts).toHaveLength(0);
  });

  it('caps projects at five and skills at twelve', async () => {
    const full = ashaLike(1);
    full.projects = Array.from({ length: 5 }, (_, i) => ({
      ...full.projects[0]!,
      id: String(i).padStart(24, 'a'),
    }));
    const backend = candidateBackend(full);
    installFakeApi({ user: demoUser(['candidate']), routes: backend.routes });
    renderRoute('/candidate/profile');
    expect(await screen.findByRole('button', { name: 'Add project' })).toBeDisabled();
    const addSkill = screen.getByRole('button', { name: 'Add skill' });
    for (let i = 0; i < 11; i += 1) await userEvent.click(addSkill);
    expect(addSkill).toBeDisabled();
  });

  it('shows server field errors next to the right field', async () => {
    const backend = candidateBackend(ashaLike(1), {
      invalid: { 'body.skills.0.skillId': ['Unknown skill. Choose one of: nodejs.'] },
    });
    installFakeApi({ user: demoUser(['candidate']), routes: backend.routes });
    renderRoute('/candidate/profile');
    await userEvent.type(await screen.findByLabelText('Bio'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    expect(await screen.findByText('Unknown skill. Choose one of: nodejs.')).toBeInTheDocument();
    expect(screen.getByLabelText('Skill 1')).toHaveAttribute('aria-invalid', 'true');
  });

  it('explains a revision conflict and reloads the latest version on request', async () => {
    const backend = candidateBackend(ashaLike(1), { conflictOnSave: true });
    installFakeApi({ user: demoUser(['candidate']), routes: backend.routes });
    renderRoute('/candidate/profile');
    await userEvent.type(await screen.findByLabelText('Bio'), 'Edited');
    await userEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    expect(await screen.findByText('Your profile changed somewhere else')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Load the latest version' }));
    expect(await screen.findByLabelText('Bio')).toHaveValue('');
  });

  it('discards unsaved changes', async () => {
    const backend = candidateBackend(ashaLike(1));
    installFakeApi({ user: demoUser(['candidate']), routes: backend.routes });
    renderRoute('/candidate/profile');
    const headline = await screen.findByLabelText('Headline');
    await userEvent.clear(headline);
    await userEvent.type(headline, 'Changed');
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(headline).toHaveValue('Backend developer');
  });

  it('previews the public projection with self-reported labels and a guarded link', async () => {
    const profile = ashaLike(1);
    profile.projects[0] = {
      ...profile.projects[0]!,
      url: 'https://github.com/asha/pay',
      evidenceStatus: 'project_linked',
    };
    const backend = candidateBackend(profile);
    installFakeApi({ user: demoUser(['candidate']), routes: backend.routes });
    renderRoute('/candidate/profile');
    await userEvent.click(await screen.findByRole('button', { name: 'Show preview' }));
    const preview = await screen.findByRole('article', { name: 'Public profile of Asha' });
    expect(within(preview).getByText('Link added, not verified')).toBeInTheDocument();
    expect(within(preview).getByText('Demo account')).toBeInTheDocument();
    expect(within(preview).queryByRole('link')).not.toBeInTheDocument();
    await userEvent.click(
      within(preview).getByRole('button', { name: /Self-reported link: github.com/ }),
    );
    const link = within(preview).getByRole('link', { name: 'Open github.com' });
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('is not reachable for founders', async () => {
    installFakeApi({ user: demoUser(['founder']) });
    renderRoute('/candidate/profile');
    expect(await screen.findByText('This is the candidate workspace')).toBeInTheDocument();
  });
});

describe('founder profile page', () => {
  function founderBackend(initial: FounderProfileData) {
    let profile = initial;
    const puts: unknown[] = [];
    return {
      puts,
      routes: (method: string, path: string, body: unknown) => {
        if (path !== '/founder/profile') return undefined;
        if (method === 'GET') return { status: 200, body: { data: profile, requestId: 'r' } };
        puts.push(body);
        const b = body as { bio: string; companyUrl: string | null };
        profile = {
          ...profile,
          bio: b.bio,
          companyUrl: b.companyUrl,
          revision: profile.revision + 1,
        };
        return { status: 200, body: { data: profile, requestId: 'r' } };
      },
    };
  }

  it('edits bio and company link with HTTPS validation', async () => {
    const backend = founderBackend({
      userId: 'x',
      revision: 0,
      bio: '',
      companyUrl: null,
      updatedAt: null,
    });
    installFakeApi({ user: demoUser(['founder']), routes: backend.routes });
    renderRoute('/founder/profile');
    await userEvent.type(await screen.findByLabelText('Bio'), 'Building PayPilot.');
    const link = screen.getByLabelText(/Company link/);
    await userEvent.type(link, 'http://paypilot.example');
    await userEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    expect(screen.getByText('Enter a public link starting with https://.')).toBeInTheDocument();
    expect(backend.puts).toHaveLength(0);
    await userEvent.clear(link);
    await userEvent.type(link, 'https://paypilot.example');
    await userEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    expect(await screen.findByText('Profile saved')).toBeInTheDocument();
    expect(backend.puts[0]).toEqual({
      expectedRevision: 0,
      bio: 'Building PayPilot.',
      companyUrl: 'https://paypilot.example',
    });
  });

  it('appears in the founder navigation', async () => {
    installFakeApi({
      user: demoUser(['founder']),
      routes: founderBackend({
        userId: 'x',
        revision: 1,
        bio: 'Hi',
        companyUrl: null,
        updatedAt: null,
      }).routes,
    });
    renderRoute('/founder');
    const nav = (await screen.findAllByRole('navigation', { name: /founder/i }))[0]!;
    await userEvent.click(within(nav).getByRole('link', { name: 'Profile' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Founder profile' }),
    ).toBeInTheDocument();
  });
});
