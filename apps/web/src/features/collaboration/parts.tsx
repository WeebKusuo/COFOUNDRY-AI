import type { ReactNode } from 'react';
import {
  EXTERNAL_PAYMENT_NOTICE,
  IP_POLICY_NOTICE,
  MATCH_REQUEST_STATUS_LABELS,
  MATCH_STATUS_LABELS,
  SPRINT_STATUS_LABELS,
  compensationSummary,
  type CompensationTerms,
  type MatchRequestStatus,
  type MatchStatus,
  type SprintStatus,
  type TermsSnapshot,
  type TimelineEntry,
} from '@cofoundry/shared';
import { Alert, Badge, type BadgeTone } from '../../components/ui';
import { ApiError } from '../../lib/api/client';
import { formatDate } from '../briefs/status';

/** Shared presentation pieces for requests, matches and sprints (text always carries meaning). */

const REQUEST_TONE: Record<MatchRequestStatus, BadgeTone> = {
  pending: 'info',
  accepted: 'brand',
  declined: 'neutral',
  withdrawn: 'neutral',
  expired: 'caution',
};
export function RequestStatusBadge({ status }: { status: MatchRequestStatus }) {
  return <Badge tone={REQUEST_TONE[status]}>{MATCH_REQUEST_STATUS_LABELS[status]}</Badge>;
}

const MATCH_TONE: Record<MatchStatus, BadgeTone> = {
  active: 'brand',
  completed: 'info',
  ended: 'neutral',
};
export function MatchStatusBadge({ status }: { status: MatchStatus }) {
  return <Badge tone={MATCH_TONE[status]}>{MATCH_STATUS_LABELS[status]}</Badge>;
}

const SPRINT_TONE: Record<SprintStatus, BadgeTone> = {
  proposed: 'caution',
  awaiting_approval: 'info',
  active: 'brand',
  submitted: 'info',
  reviewed: 'info',
  completed: 'brand',
  rejected: 'neutral',
  cancelled: 'neutral',
};
export function SprintStatusBadge({ status }: { status: SprintStatus }) {
  return <Badge tone={SPRINT_TONE[status]}>{SPRINT_STATUS_LABELS[status]}</Badge>;
}

export function CompensationText({ terms }: { terms: CompensationTerms }) {
  return (
    <span>
      {compensationSummary(terms)}
      {terms.type === 'paid' ? ` · ${terms.methodNote}` : ''}
      {terms.type === 'credit_reference' ? ` · ${terms.benefitDescription}` : ''}
    </span>
  );
}

/** Agreed brief terms as frozen on the request/match. */
export function TermsList({ terms }: { terms: TermsSnapshot }) {
  return (
    <dl className="grid gap-3 text-sm sm:grid-cols-2">
      <Row label="Weekly hours">{terms.hoursRequiredPerWeek} hours per week</Row>
      <Row label="Intended commitment">{terms.commitmentMonths} months</Row>
      <Row label="Compensation">
        <CompensationText terms={terms.compensation} />
      </Row>
      <Row label="Trial cap">At most {terms.trialCapHours} hours in total</Row>
      <Row label="Intellectual property" wide>
        {IP_POLICY_NOTICE}
      </Row>
      <Row label="Payments" wide>
        {EXTERNAL_PAYMENT_NOTICE}
      </Row>
    </dl>
  );
}

export function Row({
  label,
  children,
  wide,
}: {
  label: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={wide ? 'sm:col-span-2' : undefined}>
      <dt className="text-ink-muted">{label}</dt>
      <dd className="text-ink">{children}</dd>
    </div>
  );
}

export function Timeline({ entries }: { entries: TimelineEntry[] }) {
  return (
    <ol className="flex flex-col gap-2 border-l border-line pl-4 text-sm">
      {entries.map((e, i) => (
        <li key={`${e.at}-${i}`}>
          <p className="text-ink">{e.event}</p>
          <p className="text-xs text-ink-muted">
            {formatDate(e.at)} · {e.actor === 'system' ? 'automatic' : e.actor}
          </p>
        </li>
      ))}
    </ol>
  );
}

/** One error line for a failed mutation (409/422 messages come from the server). */
export function MutationError({
  error,
  title = 'That did not work',
}: {
  error: unknown;
  title?: string;
}) {
  if (!(error instanceof ApiError)) return null;
  return (
    <Alert tone="danger" title={title} live>
      {error.message}
    </Alert>
  );
}

/** Field-level message from a 422 response, matching by suffix (body.x / x / changes.x). */
export function fieldError(error: unknown, field: string): string | undefined {
  if (!(error instanceof ApiError) || !error.fieldErrors) return undefined;
  for (const [k, v] of Object.entries(error.fieldErrors)) {
    if (k === field || k.endsWith(`.${field}`)) return v.join(' ');
  }
  return undefined;
}

export function UnavailableNotice() {
  return (
    <Alert tone="caution" title="This collaboration is no longer available">
      Earlier records stay readable for your reference. No further actions are possible.
    </Alert>
  );
}
