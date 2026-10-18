import { useState, type FormEvent } from 'react';
import {
  BRIEF_LIMITS,
  COMPENSATION_TYPE_LABELS,
  CURRENCY,
  SPRINT_LIMITS as L,
  compensationSummary,
  type CompensationTerms,
  type CompensationType,
  type SprintProposalInput,
} from '@cofoundry/shared';
import { Button, SelectField, TextAreaField, TextField } from '../../components/ui';
import { MutationError, fieldError } from './parts';

/** Local datetime-input value (no seconds) for an ISO instant, in the viewer's timezone. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const lines = (s: string) =>
  s
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * Proposal editor (create and edit). Policy limits are shown up front; the server re-validates
 * everything, including the compensation floor from the brief and the 14-day deadline window.
 */
export function SprintForm({
  initial,
  minimum,
  submitLabel,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  initial: SprintProposalInput | null;
  minimum: CompensationTerms;
  submitLabel: string;
  pending: boolean;
  error: unknown;
  onSubmit: (input: SprintProposalInput) => void;
  onCancel?: () => void;
}) {
  const start = initial ?? {
    title: '',
    scope: '',
    deliverables: [],
    criteria: [],
    expectedHours: 6,
    deadline: new Date(Date.now() + 7 * 24 * 3600_000).toISOString(),
    compensation: minimum,
  };
  const [title, setTitle] = useState(start.title);
  const [scope, setScope] = useState(start.scope);
  const [deliverables, setDeliverables] = useState(start.deliverables.join('\n'));
  const [criteria, setCriteria] = useState(start.criteria.join('\n'));
  const [hours, setHours] = useState(String(start.expectedHours));
  const [deadline, setDeadline] = useState(toLocalInput(start.deadline));
  const c0 = start.compensation;
  const [compType, setCompType] = useState<CompensationType>(c0.type);
  const [amount, setAmount] = useState(c0.type === 'paid' ? String(c0.amountMinor / 100) : '');
  const [dueDays, setDueDays] = useState(c0.type === 'paid' ? String(c0.paymentDueDays) : '7');
  const [method, setMethod] = useState(c0.type === 'paid' ? c0.methodNote : '');
  const [benefit, setBenefit] = useState(
    c0.type === 'credit_reference' ? c0.benefitDescription : '',
  );

  const compensation = (): CompensationTerms =>
    compType === 'paid'
      ? {
          type: 'paid',
          amountMinor: Math.round(Number(amount) * 100),
          currency: CURRENCY,
          payer: 'founder',
          paymentDueDays: Number(dueDays),
          methodNote: minimum.type === 'paid' ? minimum.methodNote : method.trim(),
        }
      : compType === 'credit_reference'
        ? { type: 'credit_reference', benefitDescription: benefit.trim() }
        : { type: 'unpaid' };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const at = new Date(deadline);
    onSubmit({
      title: title.trim(),
      scope: scope.trim(),
      deliverables: lines(deliverables),
      criteria: lines(criteria),
      expectedHours: Number(hours),
      deadline: Number.isNaN(at.getTime()) ? deadline : at.toISOString(),
      compensation: compensation(),
    });
  };

  return (
    <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <TextField
        label="Title"
        value={title}
        maxLength={L.titleMax}
        error={fieldError(error, 'title')}
        onChange={(e) => setTitle(e.target.value)}
      />
      <TextAreaField
        label="Scope"
        hint={`${L.scopeMin}-${L.scopeMax} characters: what is in and out of this trial.`}
        value={scope}
        maxLength={L.scopeMax}
        counter={`${scope.length}/${L.scopeMax}`}
        error={fieldError(error, 'scope')}
        onChange={(e) => setScope(e.target.value)}
      />
      <TextAreaField
        label="Deliverables (one per line)"
        hint={`${L.itemsMin}-${L.itemsMax} items, up to ${L.itemMax} characters each.`}
        value={deliverables}
        error={fieldError(error, 'deliverables')}
        onChange={(e) => setDeliverables(e.target.value)}
      />
      <TextAreaField
        label="Measurable acceptance criteria (one per line)"
        hint="The founder reviews each criterion as met, partially met or not met."
        value={criteria}
        error={fieldError(error, 'criteria')}
        onChange={(e) => setCriteria(e.target.value)}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Expected effort (total hours)"
          hint={`Whole hours, ${L.hoursMin}-${L.hoursMax}. The cap is fixed by policy.`}
          type="number"
          min={L.hoursMin}
          max={L.hoursMax}
          step={1}
          value={hours}
          error={fieldError(error, 'expectedHours')}
          onChange={(e) => setHours(e.target.value)}
        />
        <TextField
          label="Deadline (your local time)"
          hint="Within 14 days. Approval does not extend it."
          type="datetime-local"
          value={deadline}
          error={fieldError(error, 'deadline')}
          onChange={(e) => setDeadline(e.target.value)}
        />
      </div>
      <fieldset className="flex flex-col gap-3 rounded-lg border border-line p-4">
        <legend className="px-1 text-sm font-semibold text-ink">Compensation</legend>
        <p className="text-sm text-ink-muted">
          The brief promised: {compensationSummary(minimum)}. The sprint can keep these terms or
          improve them, never lower them.
        </p>
        <SelectField
          label="Type"
          value={compType}
          error={fieldError(error, 'compensation.type')}
          onChange={(e) => setCompType(e.target.value as CompensationType)}
        >
          {(['paid', 'credit_reference', 'unpaid'] as const).map((t) => (
            <option key={t} value={t}>
              {COMPENSATION_TYPE_LABELS[t]}
            </option>
          ))}
        </SelectField>
        {compType === 'paid' ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField
              label="Amount (INR)"
              type="number"
              min={1}
              value={amount}
              error={fieldError(error, 'compensation.amountMinor')}
              onChange={(e) => setAmount(e.target.value)}
            />
            <TextField
              label="Payment due (days after submission)"
              type="number"
              min={BRIEF_LIMITS.paymentDueDaysMin}
              max={BRIEF_LIMITS.paymentDueDaysMax}
              value={dueDays}
              error={fieldError(error, 'compensation.paymentDueDays')}
              onChange={(e) => setDueDays(e.target.value)}
            />
            <TextField
              label="How you will pay"
              hint={
                minimum.type === 'paid'
                  ? 'Fixed by the brief; other paid-term changes need a new brief.'
                  : undefined
              }
              value={minimum.type === 'paid' ? minimum.methodNote : method}
              readOnly={minimum.type === 'paid'}
              maxLength={BRIEF_LIMITS.methodNoteMax}
              error={fieldError(error, 'compensation.methodNote')}
              onChange={(e) => setMethod(e.target.value)}
            />
          </div>
        ) : null}
        {compType === 'credit_reference' ? (
          <TextAreaField
            label="Credit or reference offered"
            value={benefit}
            maxLength={BRIEF_LIMITS.benefitDescriptionMax}
            error={fieldError(error, 'compensation.benefitDescription')}
            onChange={(e) => setBenefit(e.target.value)}
          />
        ) : null}
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={pending}>
          {submitLabel}
        </Button>
        {onCancel ? (
          <Button variant="ghost" onClick={onCancel}>
            Discard changes
          </Button>
        ) : null}
      </div>
      <MutationError error={error} title="The proposal was not saved" />
    </form>
  );
}
