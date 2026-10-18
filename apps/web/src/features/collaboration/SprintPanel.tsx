import { useState } from 'react';
import { CheckCircle2, Send } from 'lucide-react';
import {
  ACKNOWLEDGEMENT_NOTICE,
  CRITERION_OUTCOMES,
  CRITERION_OUTCOME_LABELS,
  IP_POLICY_NOTICE,
  NO_MONETARY_PAYMENT_NOTICE,
  SPRINT_HOUR_CAP_NOTICE,
  SPRINT_LIMITS as L,
  SPRINT_TERMINAL_REASON_LABELS,
  SUBMISSION_ATTESTATION,
  checkSubmissionUrl,
  compensationSummary,
  isNonMonetary,
  type CriterionOutcome,
  type SprintAction,
  type SprintTerms,
  type SprintView,
} from '@cofoundry/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  CheckboxField,
  ExternalLink,
  QueryState,
  SelectField,
  TextAreaField,
  TextField,
} from '../../components/ui';
import { formatDate } from '../briefs/status';
import { ReportControl } from '../safety/SafetyActions';
import { useSprint, useSprintActions } from './api';
import {
  CompensationText,
  MutationError,
  Row,
  SprintStatusBadge,
  Timeline,
  fieldError,
} from './parts';
import { SprintForm } from './SprintForm';

const short = (hash: string) => `${hash.slice(0, 8)}…`;

/** Field-by-field comparison of two term versions (only changed fields are listed). */
export function VersionDiff({ from, to }: { from: SprintTerms; to: SprintTerms }) {
  const fields: Array<[string, (t: SprintTerms) => string]> = [
    ['Title', (t) => t.title],
    ['Scope', (t) => t.scope],
    ['Deliverables', (t) => t.deliverables.join('\n')],
    ['Acceptance criteria', (t) => t.criteria.map((c) => c.text).join('\n')],
    ['Expected hours', (t) => `${t.expectedHours} hours`],
    ['Deadline', (t) => formatDate(t.deadline)],
    ['Compensation', (t) => compensationSummary(t.compensation)],
  ];
  const changed = fields.filter(([, get]) => get(from) !== get(to));
  if (changed.length === 0) return <p className="text-sm text-ink-muted">No term changes.</p>;
  return (
    <table className="w-full text-left text-sm">
      <caption className="sr-only">Changed terms</caption>
      <thead>
        <tr className="text-ink-muted">
          <th scope="col" className="py-1 pr-3 font-medium">
            Term
          </th>
          <th scope="col" className="py-1 pr-3 font-medium">
            Before
          </th>
          <th scope="col" className="py-1 font-medium">
            Now
          </th>
        </tr>
      </thead>
      <tbody>
        {changed.map(([label, get]) => (
          <tr key={label} className="border-t border-line align-top">
            <th scope="row" className="py-1.5 pr-3 font-medium text-ink">
              {label}
            </th>
            <td className="whitespace-pre-wrap py-1.5 pr-3 text-ink-muted line-through decoration-1">
              {get(from)}
            </td>
            <td className="whitespace-pre-wrap py-1.5 text-ink">{get(to)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TermsView({ s }: { s: SprintView }) {
  const t = s.terms;
  return (
    <div className="flex flex-col gap-4">
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <Row label="Title" wide>
          {t.title}
        </Row>
        <Row label="Scope" wide>
          <span className="whitespace-pre-wrap">{t.scope}</span>
        </Row>
        <Row label="Deliverables">
          <ul className="list-disc pl-5">
            {t.deliverables.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        </Row>
        <Row label="Acceptance criteria">
          <ol className="list-decimal pl-5">
            {t.criteria.map((c) => (
              <li key={c.id}>{c.text}</li>
            ))}
          </ol>
        </Row>
        <Row label="Expected effort">{t.expectedHours} hours in total</Row>
        <Row label="Deadline">{formatDate(t.deadline)}</Row>
        <Row label="Compensation" wide>
          <CompensationText terms={t.compensation} />
        </Row>
        <Row label="Intellectual property" wide>
          {IP_POLICY_NOTICE}
        </Row>
      </dl>
      <p className="text-sm text-ink-muted">{SPRINT_HOUR_CAP_NOTICE}</p>
      {isNonMonetary(t.compensation) ? (
        <Alert tone="caution" title={NO_MONETARY_PAYMENT_NOTICE}>
          These terms promise no payment. Approving requires acknowledging that explicitly.
        </Alert>
      ) : null}
    </div>
  );
}

function Approvals({ s }: { s: SprintView }) {
  return (
    <ul className="flex flex-col gap-1 text-sm">
      {(['founder', 'candidate'] as const).map((role) => {
        const a = s.approvals.find((x) => x.role === role);
        const current = a && a.version === s.version && a.termsHash === s.termsHash;
        return (
          <li key={role} className="flex flex-wrap items-center gap-2">
            {current ? (
              <CheckCircle2 className="size-4 text-success" aria-hidden="true" />
            ) : (
              <span
                className="inline-block size-4 rounded-full border border-line-strong"
                aria-hidden="true"
              />
            )}
            <span className="text-ink">
              {role === 'founder' ? s.founder.displayName : s.candidate.displayName}
            </span>
            <span className="text-ink-muted">
              {current
                ? `approved version ${a.version} (${short(a.termsHash)}) on ${formatDate(a.approvedAt)}`
                : 'has not approved the current version'}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function ReasonAction({
  label,
  button,
  danger,
  pending,
  onRun,
}: {
  label: string;
  button: string;
  danger?: boolean;
  pending: boolean;
  onRun: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  return (
    <div className="flex flex-wrap items-end gap-3">
      <TextField
        label={label}
        value={reason}
        maxLength={500}
        onChange={(e) => setReason(e.target.value)}
      />
      <Button
        variant={danger ? 'danger' : 'secondary'}
        disabled={reason.trim().length === 0}
        loading={pending}
        onClick={() => onRun(reason.trim())}
      >
        {button}
      </Button>
    </div>
  );
}

function ApprovalControls({ s, can }: { s: SprintView; can: (a: SprintAction) => boolean }) {
  const actions = useSprintActions(s.id);
  const [agree, setAgree] = useState(false);
  const [ackUnpaid, setAckUnpaid] = useState(false);
  const unpaid = isNonMonetary(s.terms.compensation);
  const sending = can('send');
  const mutation = sending ? actions.send : actions.approve;
  return (
    <div className="flex flex-col gap-3">
      <CheckboxField
        label={`I approve version ${s.version} of these terms exactly as shown (${short(s.termsHash)})`}
        hint={
          sending
            ? 'Sending records your approval; the other participant then approves the same version.'
            : 'The sprint starts only when both of you approved this same version.'
        }
        checked={agree}
        onChange={(e) => setAgree(e.target.checked)}
      />
      {unpaid ? (
        <CheckboxField
          label={`I understand: ${NO_MONETARY_PAYMENT_NOTICE}`}
          checked={ackUnpaid}
          onChange={(e) => setAckUnpaid(e.target.checked)}
        />
      ) : null}
      <Button
        className="self-start"
        icon={<Send className="size-4" aria-hidden="true" />}
        disabled={!agree || (unpaid && !ackUnpaid)}
        loading={mutation.isPending}
        onClick={() =>
          sending
            ? actions.send.mutate({
                expectedVersion: s.version,
                ...(unpaid ? { acknowledgeUnpaid: true } : {}),
              })
            : actions.approve.mutate({
                expectedVersion: s.version,
                termsHash: s.termsHash,
                ...(unpaid ? { acknowledgeUnpaid: true } : {}),
              })
        }
      >
        {sending ? 'Send for approval' : 'Approve and start the sprint'}
      </Button>
      <MutationError error={mutation.error} />
    </div>
  );
}

function SubmissionForm({ s }: { s: SprintView }) {
  const actions = useSprintActions(s.id);
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  const [attest, setAttest] = useState(false);
  const check = url ? checkSubmissionUrl(url) : null;
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        actions.submit.mutate({
          url: url.trim(),
          ...(note.trim() ? { note: note.trim() } : {}),
          sharePermissionAcknowledged: true,
        });
      }}
    >
      <TextField
        label="Link to your work (https)"
        hint="One link. CoFoundry never opens, fetches or runs it. Submission is final."
        value={url}
        inputMode="url"
        error={
          (check && !check.ok ? check.message : undefined) ??
          fieldError(actions.submit.error, 'url')
        }
        onChange={(e) => setUrl(e.target.value)}
      />
      <TextAreaField
        label="Note for the founder (optional)"
        value={note}
        maxLength={L.noteMax}
        counter={`${note.length}/${L.noteMax}`}
        onChange={(e) => setNote(e.target.value)}
      />
      <CheckboxField
        label={SUBMISSION_ATTESTATION}
        checked={attest}
        onChange={(e) => setAttest(e.target.checked)}
      />
      <Button
        type="submit"
        className="self-start"
        disabled={!attest || !check?.ok}
        loading={actions.submit.isPending}
      >
        Submit work
      </Button>
      <MutationError error={actions.submit.error} title="Not submitted" />
    </form>
  );
}

function ReviewForm({ s }: { s: SprintView }) {
  const actions = useSprintActions(s.id);
  const [rows, setRows] = useState(
    s.terms.criteria.map((c) => ({
      criterionId: c.id,
      outcome: '' as CriterionOutcome | '',
      reason: '',
    })),
  );
  const [summary, setSummary] = useState('');
  const ready = rows.every((r) => r.outcome && r.reason.trim());
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        actions.review.mutate({
          criteriaResults: rows.map((r) => ({
            criterionId: r.criterionId,
            outcome: r.outcome as CriterionOutcome,
            reason: r.reason.trim(),
          })),
          ...(summary.trim() ? { summary: summary.trim() } : {}),
        });
      }}
    >
      <p className="text-sm text-ink-muted">
        Review every agreed criterion against the submission. The review is final; there is no
        automatic score.
      </p>
      {s.terms.criteria.map((c, i) => (
        <fieldset key={c.id} className="flex flex-col gap-2 rounded-lg border border-line p-3">
          <legend className="px-1 text-sm font-semibold text-ink">
            Criterion {i + 1}: {c.text}
          </legend>
          <SelectField
            label="Outcome"
            value={rows[i]!.outcome}
            onChange={(e) =>
              setRows((p) =>
                p.map((r, j) =>
                  j === i ? { ...r, outcome: e.target.value as CriterionOutcome } : r,
                ),
              )
            }
          >
            <option value="">Choose…</option>
            {CRITERION_OUTCOMES.map((o) => (
              <option key={o} value={o}>
                {CRITERION_OUTCOME_LABELS[o]}
              </option>
            ))}
          </SelectField>
          <TextField
            label="Evidence and feedback"
            value={rows[i]!.reason}
            maxLength={L.reviewReasonMax}
            onChange={(e) =>
              setRows((p) => p.map((r, j) => (j === i ? { ...r, reason: e.target.value } : r)))
            }
          />
        </fieldset>
      ))}
      <TextAreaField
        label="Overall feedback (optional)"
        value={summary}
        maxLength={L.reviewSummaryMax}
        onChange={(e) => setSummary(e.target.value)}
      />
      <Button
        type="submit"
        className="self-start"
        disabled={!ready}
        loading={actions.review.isPending}
      >
        Record review
      </Button>
      <MutationError error={actions.review.error} title="Review not saved" />
    </form>
  );
}

function AcknowledgeForm({ s }: { s: SprintView }) {
  const actions = useSprintActions(s.id);
  const [note, setNote] = useState('');
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-ink-muted">{ACKNOWLEDGEMENT_NOTICE}</p>
      <TextAreaField
        label="Disagreement note (optional)"
        value={note}
        maxLength={L.disagreementMax}
        onChange={(e) => setNote(e.target.value)}
      />
      <Button
        className="self-start"
        loading={actions.acknowledge.isPending}
        onClick={() =>
          actions.acknowledge.mutate({
            reviewVersion: s.review?.version ?? 1,
            ...(note.trim() ? { disagreementNote: note.trim() } : {}),
          })
        }
      >
        Acknowledge the outcome
      </Button>
      <MutationError error={actions.acknowledge.error} />
    </div>
  );
}

function Body({ s }: { s: SprintView }) {
  const actions = useSprintActions(s.id);
  const [editing, setEditing] = useState(false);
  const [compare, setCompare] = useState<number | null>(null);
  const can = (a: SprintAction) => s.allowedActions.includes(a);
  const earlier = s.history.filter((h) => h.version < s.version);
  const compareTo = earlier.find(
    (h) => h.version === (compare ?? earlier[earlier.length - 1]?.version),
  );
  const terminal = ['completed', 'rejected', 'cancelled'].includes(s.status);

  return (
    <div className="flex flex-col gap-6">
      <Card as="section" aria-labelledby="sprint-heading">
        <CardHeader
          title={<span id="sprint-heading">Trial sprint</span>}
          description={`Version ${s.version} · proposed by the ${s.proposerRole}`}
          action={<SprintStatusBadge status={s.status} />}
        />
        {s.terminalReason && s.status !== 'completed' ? (
          <Alert tone="caution" title={SPRINT_TERMINAL_REASON_LABELS[s.terminalReason]}>
            {s.terminalNote
              ? `Note: ${s.terminalNote}`
              : 'The record below is kept for both of you.'}
          </Alert>
        ) : null}
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
          <Row label="Work deadline">{formatDate(s.terms.deadline)}</Row>
          {s.reviewDueAt && s.status === 'submitted' ? (
            <Row label="Review due">{formatDate(s.reviewDueAt)}</Row>
          ) : null}
          {s.acknowledgementDueAt && s.status === 'reviewed' ? (
            <Row label="Acknowledgements due">{formatDate(s.acknowledgementDueAt)}</Row>
          ) : null}
        </dl>
      </Card>

      {s.status === 'completed' ? (
        <Alert tone="success" title="Completed trial">
          Outcome: {s.review ? CRITERION_OUTCOME_LABELS[s.review.overallOutcome] : '—'} · completed{' '}
          {formatDate(s.completedAt)}. Both of you acknowledged the review. This counts as a
          completed trial, not a hiring decision; any further work is arranged outside CoFoundry.
        </Alert>
      ) : null}

      <Card as="section" aria-labelledby="terms-heading">
        <CardHeader
          title={<span id="terms-heading">Terms</span>}
          description={`Terms fingerprint ${short(s.termsHash)}`}
          action={
            can('edit') && !editing ? (
              <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
                Edit terms
              </Button>
            ) : null
          }
        />
        {editing ? (
          <SprintForm
            initial={{
              title: s.terms.title,
              scope: s.terms.scope,
              deliverables: s.terms.deliverables,
              criteria: s.terms.criteria.map((c) => c.text),
              expectedHours: s.terms.expectedHours,
              deadline: s.terms.deadline,
              compensation: s.terms.compensation,
            }}
            minimum={s.minimumCompensation}
            submitLabel="Save as a new version"
            pending={actions.patch.isPending}
            error={actions.patch.error}
            onCancel={() => setEditing(false)}
            onSubmit={(changes) =>
              actions.patch.mutate(
                { expectedVersion: s.version, changes },
                { onSuccess: () => setEditing(false) },
              )
            }
          />
        ) : (
          <TermsView s={s} />
        )}
        {earlier.length > 0 && !editing ? (
          <section aria-labelledby="diff-heading" className="mt-5 border-t border-line pt-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <h3 id="diff-heading" className="font-semibold text-ink">
                Changes since an earlier version
              </h3>
              <SelectField
                label="Compare with"
                value={String(compareTo?.version ?? '')}
                onChange={(e) => setCompare(Number(e.target.value))}
              >
                {earlier.map((h) => (
                  <option key={h.version} value={h.version}>
                    Version {h.version} ({formatDate(h.changedAt)})
                  </option>
                ))}
              </SelectField>
            </div>
            <p className="mb-2 mt-1 text-sm text-ink-muted">
              Any change creates a new version and clears earlier approvals.
            </p>
            {compareTo ? <VersionDiff from={compareTo.terms} to={s.terms} /> : null}
          </section>
        ) : null}
      </Card>

      <Card as="section" aria-labelledby="approvals-heading" className="flex flex-col gap-4">
        <CardHeader title={<span id="approvals-heading">Approvals</span>} />
        <Approvals s={s} />
        {can('send') || can('approve') ? (
          <ApprovalControls key={`${s.version}:${s.termsHash}`} s={s} can={can} />
        ) : null}
        {s.status === 'awaiting_approval' && !can('approve') && !terminal ? (
          <p className="text-sm text-ink-muted">
            Waiting for the other participant to approve version {s.version}.
          </p>
        ) : null}
        {can('reject') ? (
          <ReasonAction
            label="Reason for rejecting"
            button="Reject proposal"
            pending={actions.reject.isPending}
            onRun={(reason) => actions.reject.mutate({ expectedVersion: s.version, reason })}
          />
        ) : null}
        <MutationError error={actions.reject.error} />
      </Card>

      {s.status === 'active' || s.submission ? (
        <Card as="section" aria-labelledby="submission-heading" className="flex flex-col gap-3">
          <CardHeader title={<span id="submission-heading">Submission</span>} />
          {s.submission ? (
            <div className="flex flex-col gap-2 text-sm">
              <ExternalLink url={s.submission.url} label="Submitted link" />
              {s.submission.note ? (
                <p className="whitespace-pre-wrap text-ink">{s.submission.note}</p>
              ) : null}
              <p className="text-ink-muted">Submitted {formatDate(s.submission.submittedAt)}</p>
            </div>
          ) : can('submit') ? (
            <SubmissionForm s={s} />
          ) : (
            <p className="text-sm text-ink-muted">The candidate has not submitted yet.</p>
          )}
        </Card>
      ) : null}

      {s.status === 'submitted' || s.review ? (
        <Card as="section" aria-labelledby="review-heading" className="flex flex-col gap-3">
          <CardHeader title={<span id="review-heading">Review</span>} />
          {s.review ? (
            <div className="flex flex-col gap-3 text-sm">
              <p className="text-ink">
                Overall:{' '}
                <Badge tone="info">{CRITERION_OUTCOME_LABELS[s.review.overallOutcome]}</Badge>{' '}
                <span className="text-ink-muted">· reviewed {formatDate(s.review.reviewedAt)}</span>
              </p>
              <ul className="flex flex-col gap-2">
                {s.review.criteriaResults.map((r) => (
                  <li key={r.criterionId} className="rounded-lg bg-surface-sunk p-3">
                    <p className="font-medium text-ink">
                      {s.terms.criteria.find((c) => c.id === r.criterionId)?.text}:{' '}
                      {CRITERION_OUTCOME_LABELS[r.outcome]}
                    </p>
                    <p className="text-ink-muted">{r.reason}</p>
                  </li>
                ))}
              </ul>
              {s.review.summary ? (
                <p className="whitespace-pre-wrap text-ink">{s.review.summary}</p>
              ) : null}
            </div>
          ) : can('review') ? (
            <ReviewForm s={s} />
          ) : (
            <p className="text-sm text-ink-muted">Waiting for the founder’s review.</p>
          )}
        </Card>
      ) : null}

      {s.review ? (
        <Card as="section" aria-labelledby="ack-heading" className="flex flex-col gap-3">
          <CardHeader title={<span id="ack-heading">Acknowledgements</span>} />
          <ul className="flex flex-col gap-1 text-sm">
            {(['founder', 'candidate'] as const).map((role) => {
              const a = s.acknowledgements.find((x) => x.role === role);
              return (
                <li key={role} className="text-ink">
                  {role === 'founder' ? s.founder.displayName : s.candidate.displayName}:{' '}
                  {a
                    ? `acknowledged ${formatDate(a.at)}${a.disagreementNote ? ` — “${a.disagreementNote}”` : ''}`
                    : 'not yet'}
                </li>
              );
            })}
          </ul>
          {can('acknowledge') ? <AcknowledgeForm s={s} /> : null}
        </Card>
      ) : null}

      {can('cancel') ? (
        <Card as="section" aria-labelledby="cancel-heading" className="flex flex-col gap-3">
          <CardHeader
            title={<span id="cancel-heading">Cancel the sprint</span>}
            description="Either of you can cancel until it is completed, including for a scope dispute. Cancelling ends the match; the record is kept."
          />
          <ReasonAction
            label="Reason for cancelling"
            button="Cancel sprint"
            danger
            pending={actions.cancel.isPending}
            onRun={(reason) => actions.cancel.mutate({ reason })}
          />
          <MutationError error={actions.cancel.error} />
        </Card>
      ) : null}

      <Card as="section" aria-labelledby="sprint-timeline">
        <CardHeader title={<span id="sprint-timeline">Sprint history</span>} />
        <Timeline entries={s.timeline} />
        <div className="mt-4">
          <ReportControl
            targetType="sprint"
            targetId={s.id}
            label="Report a problem with this sprint"
            defaultCategory="sprint_dispute"
          />
        </div>
      </Card>
    </div>
  );
}

export function SprintPanel({ sprintId }: { sprintId: string }) {
  const query = useSprint(sprintId);
  return <QueryState query={query}>{(s) => <Body s={s} />}</QueryState>;
}
