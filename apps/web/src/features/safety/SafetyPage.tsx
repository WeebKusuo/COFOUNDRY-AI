import { ShieldCheck } from 'lucide-react';
import {
  CASE_STATUS_LABELS,
  CASE_TARGET_TYPE_LABELS,
  REPORT_CATEGORY_LABELS,
  type CaseReporterView,
} from '@cofoundry/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  QueryState,
} from '../../components/ui';
import { formatDate } from '../briefs/status';
import { MutationError } from '../collaboration/parts';
import { useBlocks, useMyCases, useUnblock } from './api';

function Blocks() {
  const query = useBlocks();
  const unblock = useUnblock();
  return (
    <Card as="section" aria-labelledby="blocks-heading">
      <CardHeader
        title={<span id="blocks-heading">People you blocked</span>}
        description="Blocking stops new interaction in both directions. Unblocking removes only your block and does not restore anything that ended."
      />
      <QueryState
        query={query}
        isEmpty={(d) => d.length === 0}
        empty={<p className="text-sm text-ink-muted">You have not blocked anyone.</p>}
      >
        {(items) => (
          <ul className="flex flex-col gap-2">
            {items.map((b) => (
              <li
                key={b.targetUserId}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-surface-sunk p-3"
              >
                <span className="text-ink">
                  {b.displayName}
                  <span className="ml-2 text-sm text-ink-muted">
                    since {formatDate(b.createdAt)}
                  </span>
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  loading={unblock.isPending && unblock.variables === b.targetUserId}
                  onClick={() => unblock.mutate(b.targetUserId)}
                >
                  Unblock {b.displayName}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </QueryState>
      <MutationError error={unblock.error} title="Could not unblock" />
    </Card>
  );
}

function CaseItem({ c }: { c: CaseReporterView }) {
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-line p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          tone={c.status === 'resolved' ? 'brand' : c.status === 'dismissed' ? 'neutral' : 'info'}
        >
          {CASE_STATUS_LABELS[c.status]}
        </Badge>
        <span className="text-sm font-medium text-ink">
          {c.kind === 'correction' ? 'Correction request' : 'Report'} ·{' '}
          {CASE_TARGET_TYPE_LABELS[c.targetType]}
          {c.category ? ` · ${REPORT_CATEGORY_LABELS[c.category]}` : ''}
        </span>
        <span className="text-sm text-ink-muted">opened {formatDate(c.openedAt)}</span>
      </div>
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
          Your claim (not a verified finding)
        </p>
        <p className="whitespace-pre-wrap text-ink">{c.text}</p>
      </div>
      {c.resolutionText ? (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
            Moderator decision · {formatDate(c.resolvedAt)}
          </p>
          <p className="whitespace-pre-wrap text-ink">{c.resolutionText}</p>
          {c.displayCorrection ? (
            <p className="mt-1 text-sm text-ink">
              Correction shown on the report: {c.displayCorrection}
            </p>
          ) : null}
        </div>
      ) : null}
      {c.hold ? (
        <p className="text-sm text-ink-muted">
          Evidence on hold (
          {CASE_TARGET_TYPE_LABELS[c.hold.scope as keyof typeof CASE_TARGET_TYPE_LABELS] ??
            c.hold.scope}
          ): {c.hold.reason} Next review by {formatDate(c.hold.reviewAt)}.
        </p>
      ) : null}
    </li>
  );
}

function Cases() {
  const query = useMyCases();
  return (
    <Card as="section" aria-labelledby="cases-heading">
      <CardHeader
        title={<span id="cases-heading">Your reports and correction requests</span>}
        description="Only you and the assigned moderator can read these. The person reported never sees them."
      />
      <QueryState
        query={query}
        isEmpty={(d) => d.length === 0}
        empty={
          <EmptyState icon={<ShieldCheck className="size-6" aria-hidden="true" />} title="No cases">
            Report a problem from a request, match, sprint or interview page. Request a correction
            from your own interview report.
          </EmptyState>
        }
      >
        {(items) => (
          <ul className="flex flex-col gap-3">
            {items.map((c) => (
              <CaseItem key={c.id} c={c} />
            ))}
          </ul>
        )}
      </QueryState>
    </Card>
  );
}

/** Section 02 Safety/account screen: block list and unblock, reports and correction history. */
export function SafetyPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-ink sm:text-3xl">Safety &amp; account</h1>
        <p className="mt-1 text-ink-muted">Blocks, reports and correction requests.</p>
      </div>
      <Alert tone="info" title="Data export and account deletion">
        Self-service export and deletion are not available in this version yet.
      </Alert>
      <Blocks />
      <Cases />
    </div>
  );
}
