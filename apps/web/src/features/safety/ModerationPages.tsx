import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { ArrowLeft, ShieldCheck } from 'lucide-react';
import {
  CASE_STATUSES,
  CASE_STATUS_LABELS,
  CASE_TARGET_TYPE_LABELS,
  REPORT_CATEGORY_LABELS,
  SAFETY_LIMITS,
  type CaseContextView,
  type CaseStatus,
  type CaseSummaryView,
} from '@cofoundry/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  CheckboxField,
  EmptyState,
  QueryState,
  SelectField,
  TextAreaField,
} from '../../components/ui';
import { ApiError } from '../../lib/api/client';
import { formatDate } from '../briefs/status';
import { MutationError, Row, fieldError } from '../collaboration/parts';
import { useAdminCases, useCaseContext, useCaseSummary, useModeration } from './api';

function caseTitle(c: CaseSummaryView) {
  return `${c.kind === 'correction' ? 'Correction' : 'Report'} · ${CASE_TARGET_TYPE_LABELS[c.targetType]}${
    c.category ? ` · ${REPORT_CATEGORY_LABELS[c.category]}` : ''
  }`;
}

/** Moderator queue: summaries only (no case text or evidence in the list). */
export function CaseQueuePage() {
  const [status, setStatus] = useState<CaseStatus | 'all'>('open');
  const query = useAdminCases(status);
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-ink sm:text-3xl">Case queue</h1>
        <p className="mt-1 text-ink-muted">
          Claim a case to read its minimum evidence. Every evidence read and decision is audited.
          Report counts never imply guilt.
        </p>
      </div>
      <SelectField
        label="Status"
        value={status}
        onChange={(e) => setStatus(e.target.value as CaseStatus | 'all')}
      >
        <option value="all">All</option>
        {CASE_STATUSES.map((s) => (
          <option key={s} value={s}>
            {CASE_STATUS_LABELS[s]}
          </option>
        ))}
      </SelectField>
      <QueryState
        query={query}
        isEmpty={(d) => d.length === 0}
        empty={
          <EmptyState icon={<ShieldCheck className="size-6" aria-hidden="true" />} title="No cases">
            Nothing in this view.
          </EmptyState>
        }
      >
        {(items) => (
          <ul className="flex flex-col gap-3">
            {items.map((c) => (
              <li key={c.id}>
                <Card className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="text-base font-semibold text-ink">
                      <Link to={`/moderator/cases/${c.id}`} className="hover:underline">
                        {caseTitle(c)}
                      </Link>
                    </h2>
                    <p className="text-sm text-ink-muted">Opened {formatDate(c.openedAt)}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Badge tone={c.status === 'open' ? 'info' : 'neutral'}>
                      {CASE_STATUS_LABELS[c.status]}
                    </Badge>
                    {c.assignedToMe ? (
                      <Badge tone="brand">Assigned to you</Badge>
                    ) : c.assigned ? (
                      <Badge>Assigned</Badge>
                    ) : null}
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </QueryState>
    </div>
  );
}

function ResolveForm({ ctx }: { ctx: CaseContextView }) {
  const mod = useModeration(ctx.case.id);
  const [decision, setDecision] = useState<'resolved' | 'dismissed'>('resolved');
  const [text, setText] = useState('');
  const [correction, setCorrection] = useState('');
  const [quarantine, setQuarantine] = useState(false);
  const [suspend, setSuspend] = useState(false);
  const report = ctx.case.targetType === 'report';
  const sanction = decision === 'resolved';
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        mod.resolve.mutate({
          decision,
          resolutionText: text.trim(),
          ...(report && sanction && correction.trim()
            ? { displayCorrection: correction.trim() }
            : {}),
          quarantineReport: sanction && quarantine,
          suspendTarget: sanction && suspend,
        });
      }}
    >
      <SelectField
        label="Decision"
        value={decision}
        onChange={(e) => setDecision(e.target.value as 'resolved' | 'dismissed')}
      >
        <option value="resolved">Resolve (upheld or acted on)</option>
        <option value="dismissed">Dismiss (not upheld)</option>
      </SelectField>
      <TextAreaField
        label="Resolution (the reporter sees this)"
        value={text}
        maxLength={SAFETY_LIMITS.resolutionMax}
        error={fieldError(mod.resolve.error, 'resolutionText')}
        onChange={(e) => setText(e.target.value)}
      />
      {report && sanction ? (
        <TextAreaField
          label="Display correction on the report (optional)"
          hint="Shown to both report participants, attributed to a CoFoundry moderator. Answers and scores are never changed."
          value={correction}
          maxLength={SAFETY_LIMITS.correctionMax}
          onChange={(e) => setCorrection(e.target.value)}
        />
      ) : null}
      {report && sanction ? (
        <CheckboxField
          label="Quarantine the report"
          hint="No new collaboration requests can use it; the AI narrative is hidden. Source answers stay visible."
          checked={quarantine}
          onChange={(e) => setQuarantine(e.target.checked)}
        />
      ) : null}
      {ctx.case.targetUserId && sanction ? (
        <CheckboxField
          label="Suspend the target account"
          hint="Revokes their sessions and ends their pending requests, matches and sprints. Records are kept. Requires an explicit resolution reason."
          checked={suspend}
          onChange={(e) => setSuspend(e.target.checked)}
        />
      ) : null}
      <Button
        type="submit"
        className="self-start"
        disabled={!text.trim()}
        loading={mod.resolve.isPending}
      >
        Record decision
      </Button>
      <MutationError error={mod.resolve.error} title="Decision not recorded" />
    </form>
  );
}

function Context({ ctx }: { ctx: CaseContextView }) {
  const mod = useModeration(ctx.case.id);
  const [note, setNote] = useState('');
  const c = ctx.case;
  return (
    <div className="flex flex-col gap-6">
      <Card as="section" aria-labelledby="case-claim">
        <CardHeader
          title={<span id="case-claim">Reporter’s claim</span>}
          description="A user-submitted claim, not a verified finding."
          action={<Badge>{CASE_STATUS_LABELS[c.status]}</Badge>}
        />
        <p className="whitespace-pre-wrap text-ink">{c.text}</p>
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
          <Row label="Target">
            {CASE_TARGET_TYPE_LABELS[c.targetType]} · {c.targetId}
          </Row>
          <Row label="Related open cases">{ctx.relatedOpenCases}</Row>
          {c.hold ? (
            <Row label="Evidence hold" wide>
              {c.hold.reason} Set {formatDate(c.hold.setAt)}; review by{' '}
              {formatDate(c.hold.reviewAt)}
              {c.hold.releasedAt ? `; released ${formatDate(c.hold.releasedAt)}` : ''}.
            </Row>
          ) : null}
        </dl>
      </Card>
      <Card as="section" aria-labelledby="case-people">
        <CardHeader title={<span id="case-people">Participants</span>} />
        <ul className="flex flex-col gap-1 text-sm">
          {ctx.participants.map((p) => (
            <li key={p.userId} className="text-ink">
              {p.displayName}{' '}
              <span className="text-ink-muted">
                · {p.role} · {p.status} · {p.userId}
              </span>
            </li>
          ))}
        </ul>
      </Card>
      <Card as="section" aria-labelledby="case-evidence">
        <CardHeader
          title={<span id="case-evidence">Minimum evidence</span>}
          description="Read-only. Moderators cannot edit answers, scores or consent history."
        />
        <dl className="flex flex-col gap-3 text-sm">
          {ctx.evidence.map((e, i) => (
            <div key={`${e.label}-${i}`}>
              <dt className="font-medium text-ink">{e.label}</dt>
              <dd className="whitespace-pre-wrap text-ink-muted">{e.value}</dd>
            </div>
          ))}
        </dl>
      </Card>
      <Card as="section" aria-labelledby="case-notes" className="flex flex-col gap-3">
        <CardHeader
          title={<span id="case-notes">Internal notes</span>}
          description="Visible to moderators only."
        />
        <ul className="flex flex-col gap-2 text-sm">
          {c.notes.map((n, i) => (
            <li key={i} className="rounded-lg bg-surface-sunk p-3 text-ink">
              {n.text} <span className="block text-xs text-ink-muted">{formatDate(n.at)}</span>
            </li>
          ))}
        </ul>
        {c.status === 'in_review' ? (
          <div className="flex flex-col gap-2">
            <TextAreaField
              label="Add a note"
              value={note}
              maxLength={SAFETY_LIMITS.noteMax}
              onChange={(e) => setNote(e.target.value)}
            />
            <Button
              variant="secondary"
              className="self-start"
              disabled={!note.trim()}
              loading={mod.note.isPending}
              onClick={() => mod.note.mutate(note.trim(), { onSuccess: () => setNote('') })}
            >
              Save note
            </Button>
            <MutationError error={mod.note.error} />
          </div>
        ) : null}
      </Card>
      {c.status === 'in_review' ? (
        <Card as="section" aria-labelledby="case-resolve">
          <CardHeader title={<span id="case-resolve">Decision</span>} />
          <ResolveForm ctx={ctx} />
        </Card>
      ) : (
        <Alert tone="info" title={`Case ${CASE_STATUS_LABELS[c.status].toLowerCase()}`}>
          {c.resolutionText}
          {c.displayCorrection ? ` Display correction: ${c.displayCorrection}` : ''}
          {c.quarantinedReport ? ' The report was quarantined.' : ''}
          {c.suspendedTarget ? ' The target account was suspended.' : ''}
        </Alert>
      )}
    </div>
  );
}

export function CaseDetailPage() {
  const { caseId = '' } = useParams();
  const list = useCaseSummary(caseId);
  const summary = list.data;
  const mod = useModeration(caseId);
  const ctx = useCaseContext(caseId, !!summary?.assignedToMe);
  return (
    <div className="flex flex-col gap-6">
      <Link
        to="/moderator/cases"
        className="flex items-center gap-1 text-sm text-ink-muted hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden="true" /> Case queue
      </Link>
      <QueryState
        query={list}
        isEmpty={() => !summary}
        empty={<EmptyState title="Case not found" />}
      >
        {() =>
          summary ? (
            <>
              <h1 className="text-2xl font-bold text-ink sm:text-3xl">{caseTitle(summary)}</h1>
              {!summary.assignedToMe ? (
                summary.assigned ? (
                  <Alert tone="caution" title="Assigned to another moderator">
                    Only the assigned moderator can read this case’s evidence.
                  </Alert>
                ) : (
                  <Card className="flex flex-col gap-3">
                    <p className="text-ink">
                      Claim this case to read its evidence and record a decision.
                    </p>
                    <Button
                      className="self-start"
                      loading={mod.claim.isPending}
                      onClick={() => mod.claim.mutate()}
                    >
                      Claim case
                    </Button>
                    <MutationError error={mod.claim.error} />
                  </Card>
                )
              ) : ctx.isPending ? (
                <p className="text-ink-muted">Loading evidence…</p>
              ) : ctx.error instanceof ApiError ? (
                <Alert tone="danger" title="Evidence unavailable">
                  {ctx.error.message}
                </Alert>
              ) : ctx.data ? (
                <Context ctx={ctx.data} />
              ) : null}
            </>
          ) : null
        }
      </QueryState>
    </div>
  );
}
