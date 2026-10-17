import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import {
  INDUSTRY_LABELS,
  INDUSTRY_TAGS,
  MISSION_LABELS,
  MISSION_TAGS,
  PROFILE_DISCLOSURE_NOTICE,
  PROFILE_LIMITS as L,
  SKILL_IDS,
  SKILL_LABELS,
  SKILL_LEVEL_LABELS,
  discoveryRequirementMessage,
  type CandidateProfileData,
  type SkillId,
} from '@cofoundry/shared';
import { ApiError } from '../../lib/api/client';
import { useAuth } from '../../lib/auth';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  CheckboxField,
  ChipGroup,
  ErrorState,
  LoadingState,
  SegmentedChoice,
  SelectField,
  Switch,
  TextAreaField,
  TextField,
} from '../../components/ui';
import { useCandidateProfile, usePublicProfile, useSaveCandidateProfile } from './api';
import {
  draftDiscoveryGaps,
  draftFromProfile,
  draftSignature,
  draftToUpdate,
  newKey,
  newProjectDraft,
  validateDraft,
  type CandidateDraft,
  type ProjectDraft,
} from './draft';
import { ProfilePreview } from './ProfilePreview';

const SKILL_OPTIONS = SKILL_IDS.map((id) => ({ value: id, label: SKILL_LABELS[id] }));
const INDUSTRY_OPTIONS = INDUSTRY_TAGS.map((t) => ({ value: t, label: INDUSTRY_LABELS[t] }));
const MISSION_OPTIONS = MISSION_TAGS.map((t) => ({ value: t, label: MISSION_LABELS[t] }));
const LEVEL_OPTIONS = [1, 2, 3, 4, 5].map((v) => ({
  value: v,
  label: SKILL_LEVEL_LABELS[v] ?? '',
}));

type Errors = Record<string, string[]>;
const first = (errors: Errors, key: string) => errors[`body.${key}`]?.[0];
const count = (s: string) => Array.from(s).length;

export function CandidateProfilePage() {
  const [generation, setGeneration] = useState(0);
  const query = useCandidateProfile();
  if (query.isPending) return <LoadingState label="Loading your profile" />;
  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }
  // Re-key only on an explicit reload, so a successful save keeps its confirmation on screen.
  const reload = async () => {
    await query.refetch();
    setGeneration((g) => g + 1);
  };
  return (
    <CandidateProfileEditor key={generation} profile={query.data} onReload={() => void reload()} />
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card as="section" aria-label={title}>
      <CardHeader title={title} description={description} />
      <div className="flex flex-col gap-5">{children}</div>
    </Card>
  );
}

function CandidateProfileEditor({
  profile,
  onReload,
}: {
  profile: CandidateProfileData;
  onReload: () => void;
}) {
  const { user } = useAuth();
  const save = useSaveCandidateProfile();
  const [draft, setDraft] = useState<CandidateDraft>(() => draftFromProfile(profile));
  const [baseline, setBaseline] = useState(() => draftSignature(draftFromProfile(profile)));
  const [serverErrors, setServerErrors] = useState<Errors>({});
  const [attempted, setAttempted] = useState(false);
  const [status, setStatus] = useState<'idle' | 'saved' | 'conflict' | 'invalid' | 'failed'>(
    'idle',
  );
  const [failure, setFailure] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const alertRef = useRef<HTMLDivElement>(null);

  const dirty = draftSignature(draft) !== baseline;
  const clientErrors = useMemo(() => validateDraft(draft), [draft]);
  const errors: Errors = attempted ? { ...serverErrors, ...clientErrors } : serverErrors;
  const gaps = draftDiscoveryGaps(draft);
  const gapsExceptConsent = gaps.filter((g) => g !== 'discoveryConsent');

  // Warn before leaving the page with unsaved edits.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  const update = (patch: Partial<CandidateDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setServerErrors({});
    if (status !== 'conflict') setStatus('idle');
  };
  const updateProject = (key: string, patch: Partial<ProjectDraft>) =>
    update({ projects: draft.projects.map((p) => (p.key === key ? { ...p, ...patch } : p)) });

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    setFailure(null);
    if (Object.keys(clientErrors).length > 0) {
      setStatus('invalid');
      alertRef.current?.focus();
      return;
    }
    try {
      const saved = await save.mutateAsync(draftToUpdate(draft, profile.revision));
      const next = draftFromProfile(saved);
      setDraft(next);
      setBaseline(draftSignature(next));
      setAttempted(false);
      setStatus('saved');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'VALIDATION_FAILED') {
        setServerErrors(err.fieldErrors ?? {});
        setStatus('invalid');
      } else if (err instanceof ApiError && err.code === 'VERSION_CONFLICT') {
        setStatus('conflict');
      } else {
        setFailure(err instanceof ApiError ? err.message : 'Saving failed. Try again.');
        setStatus('failed');
      }
      alertRef.current?.focus();
    }
  };

  const discoverable = profile.discoveryEnabled;

  return (
    <form noValidate onSubmit={onSubmit} className="flex flex-col gap-6 pb-28">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <h1 className="text-2xl font-bold text-ink sm:text-3xl">Your profile</h1>
          <p className="mt-2 text-ink-muted">
            Founders in your cohort see this when your profile is discoverable. Everything here is
            self-reported; nothing is verified by CoFoundry.
          </p>
        </div>
        <Badge tone={discoverable ? 'brand' : 'neutral'}>
          {discoverable ? 'Discoverable' : 'Hidden from search'}
        </Badge>
      </div>

      <div ref={alertRef} tabIndex={-1} className="flex flex-col gap-3 outline-none">
        {status === 'saved' ? <Alert tone="success" title="Profile saved" live /> : null}
        {status === 'invalid' ? (
          <Alert tone="danger" title="Fix the highlighted fields" live>
            Your profile was not saved.
          </Alert>
        ) : null}
        {status === 'conflict' ? (
          <Alert
            tone="caution"
            title="Your profile changed somewhere else"
            live
            action={
              <Button variant="secondary" size="sm" onClick={onReload}>
                Load the latest version
              </Button>
            }
          >
            It was saved from another tab or device. Loading the latest version discards the edits
            on this page.
          </Alert>
        ) : null}
        {status === 'failed' && failure ? <Alert tone="danger" title={failure} live /> : null}
      </div>

      <Section title="About you" description="A short headline and an optional bio.">
        <TextField
          label="Headline"
          value={draft.headline}
          maxLength={L.headlineMax + 20}
          counter={`${count(draft.headline)}/${L.headlineMax}`}
          error={first(errors, 'headline')}
          onChange={(e) => update({ headline: e.target.value })}
          placeholder="Backend developer focused on Node.js APIs"
        />
        <TextAreaField
          label="Bio"
          value={draft.bio}
          counter={`${count(draft.bio)}/${L.bioMax}`}
          error={first(errors, 'bio')}
          onChange={(e) => update({ bio: e.target.value })}
        />
      </Section>

      <Section
        title="Skills"
        description={`Up to ${L.skillsMax} skills, each rated 1 (beginner) to 5 (expert) by you.`}
      >
        {draft.skills.length === 0 ? (
          <p className="text-sm text-ink-muted">No skills added yet.</p>
        ) : (
          <ul className="flex flex-col gap-4">
            {draft.skills.map((skill, i) => {
              const taken = new Set(
                draft.skills.filter((s) => s.key !== skill.key).map((s) => s.skillId),
              );
              return (
                <li
                  key={skill.key}
                  className="flex flex-wrap items-end gap-4 border-b border-line pb-4 last:border-0 last:pb-0"
                >
                  <div className="min-w-48 flex-1">
                    <SelectField
                      label={`Skill ${i + 1}`}
                      value={skill.skillId}
                      error={first(errors, `skills.${i}.skillId`)}
                      onChange={(e) =>
                        update({
                          skills: draft.skills.map((s) =>
                            s.key === skill.key ? { ...s, skillId: e.target.value as SkillId } : s,
                          ),
                        })
                      }
                    >
                      <option value="">Choose a skill</option>
                      {SKILL_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value} disabled={taken.has(o.value)}>
                          {o.label}
                        </option>
                      ))}
                    </SelectField>
                  </div>
                  <SegmentedChoice
                    legend={`Level for skill ${i + 1}`}
                    hideLegend
                    name={`level-${skill.key}`}
                    options={LEVEL_OPTIONS}
                    value={skill.level}
                    onChange={(level) =>
                      update({
                        skills: draft.skills.map((s) =>
                          s.key === skill.key ? { ...s, level } : s,
                        ),
                      })
                    }
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Trash2 className="size-4" aria-hidden="true" />}
                    onClick={() =>
                      update({ skills: draft.skills.filter((s) => s.key !== skill.key) })
                    }
                    aria-label={`Remove skill ${i + 1}`}
                  >
                    Remove
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
        {first(errors, 'skills') ? (
          <p className="text-sm font-medium text-danger">{first(errors, 'skills')}</p>
        ) : null}
        <div>
          <Button
            variant="secondary"
            size="sm"
            icon={<Plus className="size-4" aria-hidden="true" />}
            disabled={draft.skills.length >= L.skillsMax}
            onClick={() =>
              update({ skills: [...draft.skills, { key: newKey(), skillId: '', level: 3 }] })
            }
          >
            Add skill
          </Button>
        </div>
      </Section>

      <Section
        title="Availability"
        description="Remote work only. Founders see these numbers as stated."
      >
        <div className="grid gap-5 sm:grid-cols-2">
          <TextField
            label="Hours per week"
            type="number"
            inputMode="numeric"
            min={L.hoursMin}
            max={L.hoursMax}
            step={1}
            value={draft.hours}
            hint={`${L.hoursMin}-${L.hoursMax} hours`}
            error={first(errors, 'availableHoursPerWeek')}
            onChange={(e) => update({ hours: e.target.value })}
          />
          <TextField
            label="Months you can commit"
            type="number"
            inputMode="numeric"
            min={L.monthsMin}
            max={L.monthsMax}
            step={1}
            value={draft.months}
            hint={`${L.monthsMin}-${L.monthsMax} months`}
            error={first(errors, 'commitmentMonths')}
            onChange={(e) => update({ months: e.target.value })}
          />
        </div>
        <CheckboxField
          label="I’m open to contributor roles"
          hint="Contributor is the only opportunity type in this version: a bounded trial sprint, not employment or equity."
          checked={draft.contributor}
          error={first(errors, 'opportunityTypes')}
          onChange={(e) => update({ contributor: e.target.checked })}
        />
      </Section>

      <Section
        title="Interests"
        description="Matched against the industry and mission tags founders choose."
      >
        <ChipGroup
          legend="Industries"
          name="industryTags"
          options={INDUSTRY_OPTIONS}
          value={draft.industryTags}
          max={L.interestTagsMax}
          error={first(errors, 'industryTags')}
          onChange={(industryTags) => update({ industryTags })}
        />
        <ChipGroup
          legend="Missions"
          name="missionTags"
          options={MISSION_OPTIONS}
          value={draft.missionTags}
          max={L.interestTagsMax}
          error={first(errors, 'missionTags')}
          onChange={(missionTags) => update({ missionTags })}
        />
      </Section>

      <Section
        title="Projects"
        description={`Up to ${L.projectsMax} projects. Skill tags you choose here are what matching uses; descriptions and links are for people to read.`}
      >
        {draft.projects.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line-strong p-4 text-sm text-ink-muted">
            No project evidence supplied. You can still become discoverable; your match score is
            then shown as provisional.
          </p>
        ) : (
          <ol className="flex flex-col gap-5">
            {draft.projects.map((project, i) => (
              <li key={project.key} className="rounded-xl border border-line p-4 sm:p-5">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <h3 className="font-semibold text-ink">Project {i + 1}</h3>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Trash2 className="size-4" aria-hidden="true" />}
                    onClick={() =>
                      update({ projects: draft.projects.filter((p) => p.key !== project.key) })
                    }
                    aria-label={`Remove project ${i + 1}`}
                  >
                    Remove
                  </Button>
                </div>
                <div className="flex flex-col gap-4">
                  <TextField
                    label="Title"
                    required
                    value={project.title}
                    counter={`${count(project.title)}/${L.projectTitleMax}`}
                    error={first(errors, `projects.${i}.title`)}
                    onChange={(e) => updateProject(project.key, { title: e.target.value })}
                  />
                  <TextAreaField
                    label="What you built and your part in it"
                    required
                    value={project.description}
                    counter={`${count(project.description)}/${L.projectDescriptionMax}`}
                    hint={`At least ${L.projectDescriptionMin} characters.`}
                    error={first(errors, `projects.${i}.description`)}
                    onChange={(e) => updateProject(project.key, { description: e.target.value })}
                  />
                  <ChipGroup
                    legend="Skills used"
                    name={`project-${project.key}-skills`}
                    options={SKILL_OPTIONS}
                    value={project.skillTags}
                    max={L.projectSkillTagsMax}
                    error={first(errors, `projects.${i}.skillTags`)}
                    onChange={(skillTags) => updateProject(project.key, { skillTags })}
                  />
                  <TextField
                    label="Link (optional)"
                    type="url"
                    inputMode="url"
                    placeholder="https://"
                    value={project.url}
                    hint="Shown as a self-reported link. CoFoundry never opens or checks it."
                    error={first(errors, `projects.${i}.url`) ?? first(errors, `projects.${i}.id`)}
                    onChange={(e) => updateProject(project.key, { url: e.target.value })}
                  />
                </div>
              </li>
            ))}
          </ol>
        )}
        {first(errors, 'projects') ? (
          <p className="text-sm font-medium text-danger">{first(errors, 'projects')}</p>
        ) : null}
        <div>
          <Button
            variant="secondary"
            size="sm"
            icon={<Plus className="size-4" aria-hidden="true" />}
            disabled={draft.projects.length >= L.projectsMax}
            onClick={() => update({ projects: [...draft.projects, newProjectDraft()] })}
          >
            Add project
          </Button>
        </div>
      </Section>

      <Section
        title="Discovery and consent"
        description="You decide whether founders can find you."
      >
        <CheckboxField
          label="I agree to show my profile to founders in my cohort"
          hint={PROFILE_DISCLOSURE_NOTICE}
          checked={draft.discoveryConsent}
          error={first(errors, 'discoveryConsent')}
          onChange={(e) =>
            update({
              discoveryConsent: e.target.checked,
              // Withdrawing consent always turns discovery off.
              discoveryEnabled: e.target.checked ? draft.discoveryEnabled : false,
            })
          }
        />
        <Switch
          checked={draft.discoveryEnabled}
          onChange={(discoveryEnabled) => update({ discoveryEnabled })}
          disabled={!draft.discoveryEnabled && gaps.length > 0}
          label="Discoverable by founders"
          description="Turning this off hides you from new searches straight away. Existing invitations and requests stay."
        />
        {!draft.discoveryEnabled && gaps.length > 0 ? (
          <div className="rounded-lg bg-surface-sunk p-4">
            <p className="text-sm font-semibold text-ink">To turn on discovery:</p>
            <ul className="mt-2 list-disc pl-5 text-sm text-ink-muted">
              {gaps.map((g) => (
                <li key={g}>{discoveryRequirementMessage(g)}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {draft.discoveryEnabled && gapsExceptConsent.length > 0 ? (
          <Alert tone="caution" title="Discovery needs a complete profile">
            {gapsExceptConsent.map((g) => discoveryRequirementMessage(g)).join(' ')}
          </Alert>
        ) : null}
      </Section>

      <Section
        title="Preview"
        description="Exactly what other signed-in users can see, from your last saved version."
      >
        {showPreview && user ? (
          <PreviewPanel userId={user.id} discoverable={discoverable} />
        ) : (
          <div>
            <Button
              variant="secondary"
              onClick={() => setShowPreview(true)}
              disabled={profile.revision === 0}
            >
              Show preview
            </Button>
            {profile.revision === 0 ? (
              <p className="mt-2 text-sm text-ink-muted">Save your profile first.</p>
            ) : null}
          </div>
        )}
      </Section>

      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-surface/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1400px] items-center justify-end gap-2 px-4 py-3 sm:gap-3 sm:px-8 lg:pl-72">
          <span
            role="status"
            className="mr-auto min-w-0 truncate text-xs text-ink-muted sm:text-sm"
          >
            {dirty
              ? 'Unsaved changes'
              : profile.revision === 0
                ? 'Not saved yet'
                : `Saved, revision ${profile.revision}`}
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={!dirty || save.isPending}
            aria-label="Discard changes"
            onClick={() => {
              setDraft(draftFromProfile(profile));
              setServerErrors({});
              setAttempted(false);
              setStatus('idle');
            }}
          >
            Discard<span className="max-sm:hidden"> changes</span>
          </Button>
          <Button
            type="submit"
            size="sm"
            loading={save.isPending}
            disabled={!dirty && profile.revision > 0}
          >
            Save profile
          </Button>
        </div>
      </div>
    </form>
  );
}

function PreviewPanel({ userId, discoverable }: { userId: string; discoverable: boolean }) {
  const preview = usePublicProfile(userId);
  if (preview.isPending) return <LoadingState label="Loading preview" />;
  if (preview.isError)
    return <ErrorState error={preview.error} onRetry={() => void preview.refetch()} />;
  return (
    <div className="flex flex-col gap-4">
      {!discoverable ? (
        <Alert title="Founders can’t see this yet">
          Turn on discovery and save to appear in searches.
        </Alert>
      ) : null}
      <div className="rounded-xl border border-line bg-canvas p-5">
        <ProfilePreview profile={preview.data} />
      </div>
    </div>
  );
}
