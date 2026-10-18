import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ArrowLeft, Copy, Lock, Plus, Send, Trash2, XCircle } from 'lucide-react';
import {
  BRIEF_LIMITS as L,
  COMPENSATION_TYPES,
  COMPENSATION_TYPE_LABELS,
  EXTERNAL_PAYMENT_NOTICE,
  INDUSTRY_LABELS,
  INDUSTRY_TAGS,
  IP_POLICY_NOTICE,
  MISSION_LABELS,
  MISSION_TAGS,
  NO_MONETARY_PAYMENT_NOTICE,
  NO_SKILL_GAP_MESSAGE,
  SKILL_IDS,
  SKILL_LABELS,
  SKILL_LEVEL_LABELS,
  formatInr,
  teamLevelFor,
  type BriefView,
  type CompensationType,
  type SkillId,
  type StartupBriefData,
} from '@cofoundry/shared';
import { ApiError } from '../../lib/api/client';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  CheckboxField,
  ChipGroup,
  EmptyState,
  ErrorState,
  LoadingState,
  SegmentedChoice,
  SelectField,
  TextAreaField,
  TextField,
} from '../../components/ui';
import { useBrief, useCloneBrief, useCloseBrief, usePublishBrief, useSaveBriefDraft } from './api';
import { BriefPreviewCard } from './BriefPreviewCard';
import {
  changedFields,
  errorFor,
  fieldsFromForm,
  formFromBrief,
  newRequiredSkill,
  publishReadiness,
  validateForm,
  type BriefForm,
  type RequiredSkillDraft,
} from './draft';
import { BriefStatusBadge, formatDate } from './status';

const SKILL_OPTIONS = SKILL_IDS.map((id) => ({ value: id, label: SKILL_LABELS[id] }));
const INDUSTRY_OPTIONS = INDUSTRY_TAGS.map((t) => ({ value: t, label: INDUSTRY_LABELS[t] }));
const MISSION_OPTIONS = MISSION_TAGS.map((t) => ({ value: t, label: MISSION_LABELS[t] }));
const LEVEL_OPTIONS = [1, 2, 3, 4, 5].map((v) => ({
  value: v,
  label: SKILL_LEVEL_LABELS[v] ?? '',
}));
const IMPORTANCE_OPTIONS = [1, 2, 3, 4, 5].map((v) => ({ value: v, label: String(v) }));
const TEAM_LEVEL_LABELS = ['None', ...LEVEL_OPTIONS.map((o) => o.label)];

/** Readable names for publish checklist entries. */
const FIELD_LABELS: Record<string, string> = {
  title: 'Title',
  teaser: 'Teaser',
  problem: 'Problem',
  solution: 'Solution',
  industryTags: 'Industries',
  missionTags: 'Missions',
  requiredSkills: 'Required skills',
  hoursRequiredPerWeek: 'Weekly hours',
  commitmentMonths: 'Commitment',
  'compensation.amountMinor': 'Payment amount',
  'compensation.paymentDueDays': 'Payment due',
  'compensation.methodNote': 'Payment method',
  'compensation.benefitDescription': 'Credit or reference',
};

type Errors = Record<string, string[]>;
const chars = (s: string) => Array.from(s).length;

export function BriefEditorPage() {
  const { briefId = '' } = useParams();
  const query = useBrief(briefId);
  const [generation, setGeneration] = useState(0);
  const [flash, setFlash] = useState<'published' | 'cloned' | 'closed' | null>(null);

  if (query.isPending) return <LoadingState label="Loading the brief" />;
  if (query.isError) {
    if (query.error instanceof ApiError && query.error.code === 'NOT_FOUND') {
      return (
        <EmptyState
          icon={<XCircle className="size-5" aria-hidden="true" />}
          title="Brief not found"
          action={
            <Link
              to="/founder/briefs"
              className="font-medium text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink"
            >
              Back to your briefs
            </Link>
          }
        >
          It doesn’t exist or isn’t yours.
        </EmptyState>
      );
    }
    return (
      <ErrorState
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }

  const view = query.data;
  const reload = async () => {
    await query.refetch();
    setGeneration((g) => g + 1);
  };

  return (
    <div className="flex flex-col gap-6">
      <Link
        to="/founder/briefs"
        className="inline-flex w-fit items-center gap-1.5 rounded text-sm font-medium text-ink-muted hover:text-ink"
      >
        <ArrowLeft className="size-4" aria-hidden="true" /> All briefs
      </Link>
      {view.access !== 'owner' ? (
        <Card>
          <BriefPreviewCard preview={view.preview} />
        </Card>
      ) : view.brief.status === 'draft' ? (
        <DraftEditor
          key={`${view.brief.id}:${generation}`}
          view={view}
          onReload={() => void reload()}
          onPublished={() => setFlash('published')}
          flash={flash === 'cloned' ? 'cloned' : null}
        />
      ) : (
        <PublishedBrief
          key={view.brief.id}
          view={view}
          flash={flash === 'published' || flash === 'closed' ? flash : null}
          onFlash={setFlash}
        />
      )}
    </div>
  );
}

function Section({
  title,
  description,
  badge,
  children,
}: {
  title: string;
  description?: ReactNode;
  badge?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card as="section" aria-label={title}>
      <CardHeader title={title} description={description} action={badge} />
      <div className="flex flex-col gap-5">{children}</div>
    </Card>
  );
}

function ConfidentialBadge() {
  return (
    <Badge tone="info" icon={<Lock className="size-3.5" aria-hidden="true" />}>
      Confidential
    </Badge>
  );
}

function DraftEditor({
  view,
  onReload,
  onPublished,
  flash,
}: {
  view: Extract<BriefView, { access: 'owner' }>;
  onReload: () => void;
  onPublished: () => void;
  flash: 'cloned' | null;
}) {
  const [saved, setSaved] = useState<StartupBriefData>(view.brief);
  const save = useSaveBriefDraft(saved.id);
  const publish = usePublishBrief(saved.id);
  const [form, setForm] = useState<BriefForm>(() => formFromBrief(view.brief));
  const [serverErrors, setServerErrors] = useState<Errors>({});
  const [attempted, setAttempted] = useState(false);
  const [status, setStatus] = useState<
    'idle' | 'saved' | 'conflict' | 'invalid' | 'failed' | 'publish-invalid' | 'no-gap'
  >('idle');
  const [failure, setFailure] = useState<string | null>(null);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const alertRef = useRef<HTMLDivElement>(null);

  const savedFields = useMemo(() => fieldsFromForm(formFromBrief(saved)), [saved]);
  const currentFields = fieldsFromForm(form);
  const changes = changedFields(savedFields, currentFields);
  const dirty = Object.keys(changes).length > 0;
  const clientErrors = useMemo(() => validateForm(form), [form]);
  const errors: Errors = attempted ? { ...serverErrors, ...clientErrors } : serverErrors;
  const readiness = publishReadiness(currentFields);
  const ready = readiness.gaps.length === 0 && readiness.skillGap;

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  const update = (patch: Partial<BriefForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    if (status !== 'conflict') setStatus('idle');
    setConfirmPublish(false);
  };
  const updateSkill = (key: string, patch: Partial<RequiredSkillDraft>) =>
    update({
      requiredSkills: form.requiredSkills.map((s) => (s.key === key ? { ...s, ...patch } : s)),
    });

  const fail = (err: unknown) => {
    if (err instanceof ApiError && err.code === 'VERSION_CONFLICT') setStatus('conflict');
    else {
      setFailure(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
      setStatus('failed');
    }
  };

  const onSave = async (event: FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    setFailure(null);
    if (Object.keys(clientErrors).length > 0) {
      setStatus('invalid');
      alertRef.current?.focus();
      return;
    }
    if (!dirty) return;
    try {
      const next = await save.mutateAsync({ expectedVersion: saved.version, changes });
      setSaved(next);
      setForm(formFromBrief(next));
      setServerErrors({});
      setAttempted(false);
      setStatus('saved');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'VALIDATION_FAILED') {
        setServerErrors(err.fieldErrors ?? {});
        setStatus('invalid');
      } else fail(err);
    }
    alertRef.current?.focus();
  };

  const onPublish = async () => {
    setFailure(null);
    try {
      await publish.mutateAsync({ expectedVersion: saved.version });
      onPublished();
    } catch (err) {
      setConfirmPublish(false);
      if (err instanceof ApiError && err.code === 'VALIDATION_FAILED') {
        setServerErrors(err.fieldErrors ?? {});
        setStatus('publish-invalid');
      } else if (err instanceof ApiError && err.code === 'NO_SKILL_GAP') {
        setServerErrors(err.fieldErrors ?? {});
        setStatus('no-gap');
      } else fail(err);
      alertRef.current?.focus();
    }
  };

  const comp = form.compensationType;

  return (
    <form noValidate onSubmit={onSave} className="flex flex-col gap-6 pb-28">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <div className="mb-2">
            <BriefStatusBadge status="draft" version={saved.version} />
          </div>
          <h1 className="text-2xl font-bold text-balance text-ink sm:text-3xl">
            {saved.title || 'Untitled brief'}
          </h1>
          <p className="mt-2 text-ink-muted">
            Only you can see drafts. Publishing fixes the terms as version 1; after that the brief
            can be closed or cloned, but not edited.
          </p>
        </div>
      </div>

      <div ref={alertRef} tabIndex={-1} className="flex flex-col gap-3 outline-none">
        {flash === 'cloned' && status === 'idle' ? (
          <Alert tone="success" title="New draft created from a copy" live>
            Edit the terms and publish when ready. The original brief is unchanged.
          </Alert>
        ) : null}
        {status === 'saved' ? <Alert tone="success" title="Draft saved" live /> : null}
        {status === 'invalid' ? (
          <Alert tone="danger" title="Fix the highlighted fields" live>
            Your draft was not saved.
          </Alert>
        ) : null}
        {status === 'publish-invalid' ? (
          <Alert tone="danger" title="Complete the highlighted fields before publishing" live />
        ) : null}
        {status === 'no-gap' ? (
          <Alert tone="danger" title="No skill gap" live>
            {NO_SKILL_GAP_MESSAGE}
          </Alert>
        ) : null}
        {status === 'conflict' ? (
          <Alert
            tone="caution"
            title="This brief changed somewhere else"
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

      <Section
        title="Basics"
        description="The title and teaser are what candidates in your cohort see first."
      >
        <TextField
          label="Title"
          required
          value={form.title}
          counter={`${chars(form.title)}/${L.titleMax}`}
          error={errorFor(errors, 'title')}
          onChange={(e) => update({ title: e.target.value })}
        />
        <TextAreaField
          label="Teaser"
          value={form.teaser}
          counter={`${chars(form.teaser)}/${L.teaserMax}`}
          hint={`${L.teaserMin}-${L.teaserMax} characters to publish. Describe the work without revealing your idea’s details.`}
          error={errorFor(errors, 'teaser')}
          onChange={(e) => update({ teaser: e.target.value })}
        />
      </Section>

      <Section
        title="Your idea"
        badge={<ConfidentialBadge />}
        description="Only you can read this. It is never part of the preview; a candidate sees it only after acknowledging a confidentiality notice, which is not a signed NDA."
      >
        <TextAreaField
          label="Problem"
          value={form.problem}
          rows={5}
          counter={`${chars(form.problem)}/${L.problemMax.toLocaleString('en-IN')}`}
          hint={`${L.problemMin}-${L.problemMax.toLocaleString('en-IN')} characters to publish.`}
          error={errorFor(errors, 'problem')}
          onChange={(e) => update({ problem: e.target.value })}
        />
        <TextAreaField
          label="Solution"
          value={form.solution}
          rows={5}
          counter={`${chars(form.solution)}/${L.solutionMax.toLocaleString('en-IN')}`}
          hint={`${L.solutionMin}-${L.solutionMax.toLocaleString('en-IN')} characters to publish.`}
          error={errorFor(errors, 'solution')}
          onChange={(e) => update({ solution: e.target.value })}
        />
      </Section>

      <Section title="Industry and mission" description="Used for interest overlap in matching.">
        <ChipGroup
          legend="Industries"
          name="brief-industries"
          options={INDUSTRY_OPTIONS}
          value={form.industryTags}
          max={L.interestTagsMax}
          hint={`Choose ${L.interestTagsMin}-${L.interestTagsMax}.`}
          error={errorFor(errors, 'industryTags')}
          onChange={(industryTags) => update({ industryTags })}
        />
        <ChipGroup
          legend="Missions"
          name="brief-missions"
          options={MISSION_OPTIONS}
          value={form.missionTags}
          max={L.interestTagsMax}
          hint={`Choose ${L.interestTagsMin}-${L.interestTagsMax}.`}
          error={errorFor(errors, 'missionTags')}
          onChange={(missionTags) => update({ missionTags })}
        />
      </Section>

      <Section
        title="Skills"
        description={`Up to ${L.requiredSkillsMax} required skills. At least one must be above your team’s current level.`}
      >
        {form.requiredSkills.length === 0 ? (
          <p className="text-sm text-ink-muted">No required skills yet.</p>
        ) : (
          <ol className="flex flex-col gap-4">
            {form.requiredSkills.map((skill, i) => {
              const taken = new Set(
                form.requiredSkills.filter((s) => s.key !== skill.key).map((s) => s.skillId),
              );
              const team = skill.skillId ? form.teamLevels[skill.skillId] : 0;
              const gap = skill.level - team;
              return (
                <li key={skill.key} className="rounded-xl border border-line p-4 sm:p-5">
                  <div className="flex flex-wrap items-end gap-4">
                    <div className="min-w-48 flex-1">
                      <SelectField
                        label={`Required skill ${i + 1}`}
                        value={skill.skillId}
                        error={errorFor(errors, `requiredSkills.${i}.skillId`)}
                        onChange={(e) =>
                          updateSkill(skill.key, { skillId: e.target.value as SkillId })
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
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<Trash2 className="size-4" aria-hidden="true" />}
                      aria-label={`Remove required skill ${i + 1}`}
                      onClick={() =>
                        update({
                          requiredSkills: form.requiredSkills.filter((s) => s.key !== skill.key),
                        })
                      }
                    >
                      Remove
                    </Button>
                  </div>
                  <div className="mt-4 grid gap-4 xl:grid-cols-2">
                    <SegmentedChoice
                      legend={`Level needed for required skill ${i + 1}`}
                      name={`req-level-${skill.key}`}
                      options={LEVEL_OPTIONS}
                      value={skill.level}
                      onChange={(level) => updateSkill(skill.key, { level })}
                    />
                    <SegmentedChoice
                      legend={`Importance of required skill ${i + 1} (1-5)`}
                      name={`req-importance-${skill.key}`}
                      options={IMPORTANCE_OPTIONS}
                      value={skill.importance}
                      onChange={(importance) => updateSkill(skill.key, { importance })}
                    />
                  </div>
                  <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                    <CheckboxField
                      label="Mandatory"
                      hint="Candidates below this level are excluded. Unticked means preferred."
                      checked={skill.mandatory}
                      onChange={(e) => updateSkill(skill.key, { mandatory: e.target.checked })}
                    />
                    {skill.skillId ? (
                      <Badge tone={gap > 0 ? 'brand' : 'caution'}>
                        {gap > 0
                          ? `Gap: needs ${skill.level}, team has ${team}`
                          : `No gap: team has ${team}`}
                      </Badge>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
        {errorFor(errors, 'requiredSkills') ? (
          <p className="text-sm font-medium text-danger">{errorFor(errors, 'requiredSkills')}</p>
        ) : null}
        <div>
          <Button
            variant="secondary"
            size="sm"
            icon={<Plus className="size-4" aria-hidden="true" />}
            disabled={form.requiredSkills.length >= L.requiredSkillsMax}
            onClick={() => update({ requiredSkills: [...form.requiredSkills, newRequiredSkill()] })}
          >
            Add required skill
          </Button>
        </div>

        <fieldset className="mt-2 rounded-xl border border-line p-4 sm:p-5">
          <legend className="px-1 text-sm font-semibold text-ink">Your team today</legend>
          <p className="mb-4 text-sm text-ink-muted">
            One level per skill for the team as a whole, as you judge it. Leave “None” where nobody
            covers it.
          </p>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {SKILL_IDS.map((id) => (
              <SelectField
                key={id}
                label={`Team: ${SKILL_LABELS[id]}`}
                value={String(form.teamLevels[id])}
                onChange={(e) =>
                  update({ teamLevels: { ...form.teamLevels, [id]: Number(e.target.value) } })
                }
              >
                {TEAM_LEVEL_LABELS.map((label, level) => (
                  <option key={label} value={level}>
                    {level} — {label}
                  </option>
                ))}
              </SelectField>
            ))}
          </div>
        </fieldset>
      </Section>

      <Section title="Time" description="Remote work only. Shown to candidates as stated.">
        <div className="grid gap-5 sm:grid-cols-2">
          <TextField
            label="Hours per week"
            type="number"
            inputMode="numeric"
            min={L.hoursMin}
            max={L.hoursMax}
            value={form.hours}
            hint={`${L.hoursMin}-${L.hoursMax} hours`}
            error={errorFor(errors, 'hoursRequiredPerWeek')}
            onChange={(e) => update({ hours: e.target.value })}
          />
          <TextField
            label="Commitment in months"
            type="number"
            inputMode="numeric"
            min={L.monthsMin}
            max={L.monthsMax}
            value={form.months}
            hint={`${L.monthsMin}-${L.monthsMax} months`}
            error={errorFor(errors, 'commitmentMonths')}
            onChange={(e) => update({ months: e.target.value })}
          />
        </div>
        <CheckboxField
          label="Weekly hours are mandatory"
          hint="Candidates offering fewer hours are excluded from matching."
          checked={form.mandatoryAvailability}
          onChange={(e) => update({ mandatoryAvailability: e.target.checked })}
        />
        <CheckboxField
          label="Commitment is mandatory"
          hint="Candidates offering fewer months are excluded from matching."
          checked={form.mandatoryCommitment}
          onChange={(e) => update({ mandatoryCommitment: e.target.checked })}
        />
      </Section>

      <Section
        title="Compensation"
        description="The minimum you promise for the trial sprint. A sprint can keep or improve these terms, never lower them."
      >
        <fieldset>
          <legend className="mb-2 text-sm font-semibold text-ink">Type</legend>
          <div className="grid gap-3 sm:grid-cols-3">
            {COMPENSATION_TYPES.map((type) => (
              <label
                key={type}
                className="flex cursor-pointer items-center gap-3 rounded-lg border border-line-strong px-4 py-3 text-sm font-medium text-ink has-checked:border-ink has-checked:bg-brand-soft has-focus-visible:ring-2 has-focus-visible:ring-focus"
              >
                <input
                  type="radio"
                  name="compensation-type"
                  value={type}
                  checked={comp === type}
                  onChange={() => update({ compensationType: type as CompensationType })}
                  className="size-4 accent-brand"
                />
                {COMPENSATION_TYPE_LABELS[type]}
              </label>
            ))}
          </div>
        </fieldset>
        {comp === 'paid' ? (
          <div className="grid gap-5 sm:grid-cols-2">
            <TextField
              label="Amount (₹, INR)"
              inputMode="decimal"
              value={form.amountRupees}
              hint="Whole rupees or rupees and paise, e.g. 2000 or 2000.50."
              error={errorFor(errors, 'compensation.amountMinor')}
              onChange={(e) => update({ amountRupees: e.target.value })}
            />
            <TextField
              label="Payment due (days after submission)"
              type="number"
              inputMode="numeric"
              min={L.paymentDueDaysMin}
              max={L.paymentDueDaysMax}
              value={form.paymentDueDays}
              hint={`${L.paymentDueDaysMin}-${L.paymentDueDaysMax} days`}
              error={errorFor(errors, 'compensation.paymentDueDays')}
              onChange={(e) => update({ paymentDueDays: e.target.value })}
            />
            <div className="sm:col-span-2">
              <TextField
                label="How you will pay"
                value={form.methodNote}
                counter={`${chars(form.methodNote)}/${L.methodNoteMax}`}
                placeholder="e.g. External bank/UPI transfer agreed directly."
                error={errorFor(errors, 'compensation.methodNote')}
                onChange={(e) => update({ methodNote: e.target.value })}
              />
            </div>
          </div>
        ) : comp === 'credit_reference' ? (
          <>
            <Alert tone="caution" title={NO_MONETARY_PAYMENT_NOTICE} />
            <TextAreaField
              label="Credit or reference you offer"
              value={form.benefitDescription}
              counter={`${chars(form.benefitDescription)}/${L.benefitDescriptionMax}`}
              hint={`${L.benefitDescriptionMin}-${L.benefitDescriptionMax} characters to publish.`}
              error={errorFor(errors, 'compensation.benefitDescription')}
              onChange={(e) => update({ benefitDescription: e.target.value })}
            />
          </>
        ) : (
          <Alert tone="caution" title={NO_MONETARY_PAYMENT_NOTICE}>
            Candidates see this before they accept an interview.
          </Alert>
        )}
        <p className="text-sm text-ink-muted">{EXTERNAL_PAYMENT_NOTICE}</p>
      </Section>

      <Section
        title="Intellectual property"
        description="Fixed for every brief in this version; there is no custom IP field."
      >
        <p className="max-w-prose rounded-lg bg-surface-sunk p-4 text-sm text-ink">
          {IP_POLICY_NOTICE}
        </p>
      </Section>

      <Section title="Publish" description="Checks the same rules the server applies.">
        {ready ? (
          <p className="text-sm font-medium text-ink">Everything required is filled in.</p>
        ) : (
          <div className="rounded-lg bg-surface-sunk p-4">
            <p className="text-sm font-semibold text-ink">Before you can publish:</p>
            <ul className="mt-2 list-disc pl-5 text-sm text-ink-muted">
              {readiness.gaps.map((g) => (
                <li key={g.field}>
                  <span className="font-medium text-ink">{FIELD_LABELS[g.field] ?? g.field}:</span>{' '}
                  {g.message}
                </li>
              ))}
              {readiness.gaps.length === 0 && !readiness.skillGap ? (
                <li>{NO_SKILL_GAP_MESSAGE}</li>
              ) : null}
            </ul>
          </div>
        )}
        {confirmPublish ? (
          <Alert
            tone="caution"
            title="Publish this brief?"
            action={
              <div className="flex flex-wrap gap-2">
                <Button size="sm" loading={publish.isPending} onClick={() => void onPublish()}>
                  Publish now
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmPublish(false)}>
                  Cancel
                </Button>
              </div>
            }
          >
            The terms become permanent as version 1 and the teaser becomes visible to candidates in
            your cohort. To change anything later, clone it into a new draft.
          </Alert>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Button
              icon={<Send className="size-4" aria-hidden="true" />}
              disabled={dirty || !ready}
              onClick={() => setConfirmPublish(true)}
            >
              Publish
            </Button>
            {dirty ? <p className="text-sm text-ink-muted">Save your changes first.</p> : null}
          </div>
        )}
      </Section>

      <Section
        title="Preview"
        description="What candidates will see, from your last saved draft. Problem and solution are not part of it."
      >
        {showPreview ? (
          <div className="rounded-xl border border-line bg-canvas p-5">
            <BriefPreviewCard preview={view.preview} />
          </div>
        ) : (
          <div>
            <Button variant="secondary" onClick={() => setShowPreview(true)}>
              Show preview
            </Button>
          </div>
        )}
      </Section>

      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-surface/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1400px] items-center justify-end gap-2 px-4 py-3 sm:gap-3 sm:px-8 lg:pl-72">
          <span
            role="status"
            className="mr-auto min-w-0 truncate text-xs text-ink-muted sm:text-sm"
          >
            {dirty ? 'Unsaved changes' : `Draft saved · version ${saved.version}`}
          </span>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Discard changes"
            disabled={!dirty || save.isPending}
            onClick={() => {
              setForm(formFromBrief(saved));
              setServerErrors({});
              setAttempted(false);
              setStatus('idle');
            }}
          >
            Discard<span className="max-sm:hidden"> changes</span>
          </Button>
          <Button type="submit" size="sm" loading={save.isPending} disabled={!dirty}>
            Save draft
          </Button>
        </div>
      </div>
    </form>
  );
}

function PublishedBrief({
  view,
  flash,
  onFlash,
}: {
  view: Extract<BriefView, { access: 'owner' }>;
  flash: 'published' | 'closed' | null;
  onFlash: (f: 'cloned' | 'closed') => void;
}) {
  const b = view.brief;
  const navigate = useNavigate();
  const clone = useCloneBrief(b.id);
  const close = useCloseBrief(b.id);
  const [closing, setClosing] = useState(false);
  const [reason, setReason] = useState('');
  const [failure, setFailure] = useState<string | null>(null);

  const onClone = async () => {
    setFailure(null);
    try {
      const copy = await clone.mutateAsync(undefined);
      onFlash('cloned');
      void navigate(`/founder/briefs/${copy.id}`);
    } catch (err) {
      setFailure(err instanceof ApiError ? err.message : 'Cloning failed. Try again.');
    }
  };

  const onClose = async (event: FormEvent) => {
    event.preventDefault();
    setFailure(null);
    if (chars(reason.trim()) > L.closeReasonMax) {
      return setFailure(`Use at most ${L.closeReasonMax} characters for the reason.`);
    }
    try {
      await close.mutateAsync({ reason: reason.trim() });
      setClosing(false);
      onFlash('closed');
    } catch (err) {
      setFailure(err instanceof ApiError ? err.message : 'Closing failed. Try again.');
    }
  };

  const c = b.compensation;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <div className="mb-2 flex flex-wrap gap-2">
            <BriefStatusBadge status={b.status} version={b.version} />
            {b.clonedFromId ? (
              <Link
                to={`/founder/briefs/${b.clonedFromId}`}
                className="text-sm text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink"
              >
                Cloned from an earlier brief
              </Link>
            ) : null}
          </div>
          <h1 className="text-2xl font-bold text-balance text-ink sm:text-3xl">{b.title}</h1>
          <p className="mt-2 text-sm text-ink-muted">
            Published {formatDate(b.publishedAt)}
            {b.closedAt ? ` · closed ${formatDate(b.closedAt)}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            icon={<Copy className="size-4" aria-hidden="true" />}
            loading={clone.isPending}
            onClick={() => void onClone()}
          >
            Clone to new draft
          </Button>
          {b.status === 'open' && !closing ? (
            <Button
              variant="danger"
              icon={<XCircle className="size-4" aria-hidden="true" />}
              onClick={() => setClosing(true)}
            >
              Close brief
            </Button>
          ) : null}
        </div>
      </div>

      {flash === 'published' && b.status === 'open' ? (
        <Alert tone="success" title="Brief published" live>
          Candidates in your cohort can now see its teaser. The terms are fixed as version 1.
        </Alert>
      ) : null}
      {flash === 'closed' && b.status === 'closed' ? (
        <Alert tone="success" title="Brief closed" live>
          It no longer appears to candidates and can’t receive new invitations or requests.
        </Alert>
      ) : null}
      {failure ? <Alert tone="danger" title={failure} live /> : null}

      {closing ? (
        <Card as="section" aria-label="Close brief">
          <form noValidate onSubmit={onClose} className="flex flex-col gap-4">
            <TextAreaField
              label="Reason (optional)"
              value={reason}
              counter={`${chars(reason)}/${L.closeReasonMax}`}
              hint="Stored with the brief. Closing stops new searches, invitations and requests and can’t be undone."
              onChange={(e) => setReason(e.target.value)}
            />
            <div className="flex flex-wrap gap-3">
              <Button type="submit" variant="danger" loading={close.isPending}>
                Close permanently
              </Button>
              <Button variant="ghost" onClick={() => setClosing(false)}>
                Keep open
              </Button>
            </div>
          </form>
        </Card>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card as="section" aria-label="Brief details">
          <CardHeader
            title="Brief details"
            description="Your published version, including confidential fields."
          />
          <dl className="flex flex-col gap-5">
            <ReadOnly label="Teaser">{b.teaser}</ReadOnly>
            <ReadOnly
              label={
                <span className="inline-flex items-center gap-2">
                  Problem <ConfidentialBadge />
                </span>
              }
            >
              {b.problem}
            </ReadOnly>
            <ReadOnly
              label={
                <span className="inline-flex items-center gap-2">
                  Solution <ConfidentialBadge />
                </span>
              }
            >
              {b.solution}
            </ReadOnly>
            <ReadOnly label="Industries and missions">
              {[
                ...b.industryTags.map((t) => INDUSTRY_LABELS[t]),
                ...b.missionTags.map((t) => MISSION_LABELS[t]),
              ].join(', ')}
            </ReadOnly>
            <ReadOnly label="Skills">
              <ul className="flex flex-col gap-1">
                {b.requiredSkills.map((s) => (
                  <li key={s.skillId}>
                    {SKILL_LABELS[s.skillId]}: needs {s.level}, team{' '}
                    {teamLevelFor(b.teamSkills, s.skillId)}, importance {s.importance}/5 ·{' '}
                    {s.mandatory ? 'mandatory' : 'preferred'}
                  </li>
                ))}
              </ul>
            </ReadOnly>
            <ReadOnly label="Time">
              {b.hoursRequiredPerWeek} h/week{b.mandatoryAvailability ? ' (mandatory)' : ''} for{' '}
              {b.commitmentMonths} months{b.mandatoryCommitment ? ' (mandatory)' : ''}
            </ReadOnly>
            <ReadOnly label="Compensation">
              {c.type === 'paid'
                ? `Paid ${formatInr(c.amountMinor ?? 0)} within ${c.paymentDueDays} days of submission. ${c.methodNote}`
                : c.type === 'credit_reference'
                  ? `${NO_MONETARY_PAYMENT_NOTICE}. Credit or reference: ${c.benefitDescription}`
                  : `Unpaid. ${NO_MONETARY_PAYMENT_NOTICE}.`}
            </ReadOnly>
            {b.closeReason ? <ReadOnly label="Close reason">{b.closeReason}</ReadOnly> : null}
          </dl>
        </Card>
        <Card as="section" aria-label="What candidates see">
          <CardHeader
            title="What candidates see"
            description={
              b.status === 'open'
                ? 'Shown to candidates in your cohort.'
                : 'Closed briefs are no longer shown to candidates.'
            }
          />
          <BriefPreviewCard preview={view.preview} />
        </Card>
      </div>
    </div>
  );
}

function ReadOnly({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div>
      <dt className="text-sm font-semibold text-ink">{label}</dt>
      <dd className="mt-1 whitespace-pre-line text-ink-muted">{children || '—'}</dd>
    </div>
  );
}
