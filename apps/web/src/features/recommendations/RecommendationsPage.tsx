import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Clock, FileText, RefreshCw, Search, Users } from 'lucide-react';
import {
  GATE_LABELS,
  MATCH_LIMITATION_NOTICE,
  type InterviewSummary,
  type RecommendationEntryView,
  type RecommendationSearchResponse,
} from '@cofoundry/shared';
import { ApiError } from '../../lib/api/client';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  SelectField,
} from '../../components/ui';
import { useMyBriefs } from '../briefs/api';
import { formatDate } from '../briefs/status';
import { CandidateCard } from './CandidateCard';
import { useRecommendations, useRunSearch } from './api';
import { useInterviews } from '../interviews/api';

export function RecommendationsPage() {
  const briefs = useMyBriefs();
  const [params, setParams] = useSearchParams();
  const open = (briefs.data?.pages.flatMap((p) => p.data) ?? []).filter((b) => b.status === 'open');
  const requested = params.get('brief');
  const selected = open.find((b) => b.id === requested) ?? open[0] ?? null;

  return (
    <div className="flex flex-col gap-6">
      <div className="max-w-3xl">
        <h1 className="text-2xl font-bold text-ink sm:text-3xl">Candidates</h1>
        <p className="mt-2 text-ink-muted">
          Ranked by the deterministic match-v3.0 rules against one of your open briefs. Every factor
          is shown; nothing is decided by AI.
        </p>
      </div>

      {briefs.isPending ? (
        <LoadingState label="Loading your briefs" />
      ) : briefs.isError ? (
        <ErrorState
          error={briefs.error}
          onRetry={() => void briefs.refetch()}
          retrying={briefs.isFetching}
        />
      ) : !selected ? (
        <EmptyState
          icon={<FileText className="size-5" aria-hidden="true" />}
          title="No open brief to match"
          action={
            <Link to="/founder/briefs" className="font-medium text-brand hover:underline">
              Go to your briefs
            </Link>
          }
        >
          Publish a brief first. Matching uses its required skills, team levels, time and interests.
        </EmptyState>
      ) : (
        <>
          <div className="max-w-xl">
            <SelectField
              label="Brief"
              value={selected.id}
              onChange={(e) => setParams({ brief: e.target.value }, { replace: true })}
            >
              {open.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.title}
                </option>
              ))}
            </SelectField>
          </div>
          <Results key={selected.id} briefId={selected.id} />
        </>
      )}
    </div>
  );
}

/** Minutes left until expiry, re-evaluated every 15 seconds without stealing focus. */
function useMinutesLeft(expiresAt: string | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    setNow(Date.now()); // a new batch restarts the countdown from the current time
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, [expiresAt]);
  if (!expiresAt) return null;
  return Math.max(0, Math.ceil((new Date(expiresAt).getTime() - now) / 60_000));
}

function Results({ briefId }: { briefId: string }) {
  const latest = useRecommendations(briefId);
  const run = useRunSearch(briefId);
  const batch = latest.data?.kind === 'results' ? latest.data.data : null;
  const invitations = useInterviews('founder', briefId);
  const byCandidate = new Map((invitations.data ?? []).map((i) => [i.candidateUserId, i]));
  const minutesLeft = useMinutesLeft(batch?.expiresAt ?? null);
  const expired = minutesLeft === 0;

  const runError =
    run.error instanceof ApiError
      ? run.error.code === 'RATE_LIMITED'
        ? 'Too many searches. Wait a minute and try again.'
        : run.error.message
      : run.error
        ? 'The search failed. Try again.'
        : null;

  const searchButton = (label: string) => (
    <Button
      icon={<Search className="size-4" aria-hidden="true" />}
      loading={run.isPending}
      onClick={() => run.mutate()}
    >
      {label}
    </Button>
  );

  if (latest.isPending) return <LoadingState label="Loading results" />;
  if (latest.isError) {
    return (
      <ErrorState
        error={latest.error}
        onRetry={() => void latest.refetch()}
        retrying={latest.isFetching}
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {runError ? <Alert tone="danger" title={runError} live /> : null}
      {!batch ? (
        <Card className="flex flex-col items-start gap-4">
          <div>
            <h2 className="text-lg font-semibold text-ink">No current results</h2>
            <p className="mt-1 text-ink-muted">
              {latest.data?.kind === 'none' ? latest.data.message : null} Results are kept for 15
              minutes and re-checked against candidates’ current profiles and consent.
            </p>
          </div>
          {searchButton('Find candidates')}
        </Card>
      ) : (
        <>
          <BatchSummary
            batch={batch}
            minutesLeft={minutesLeft ?? 0}
            onRefresh={() => run.mutate()}
            refreshing={run.isPending}
          />
          {expired ? (
            <Alert
              tone="caution"
              title="These results expired"
              live
              action={searchButton('Run a new search')}
            >
              Profiles may have changed. Run a new search before acting on them.
            </Alert>
          ) : null}
          <Group
            title="Recommended"
            description="Complete profiles that meet every hard requirement."
            entries={batch.recommendations}
            usable={!expired}
            invite={{ briefId, batchId: batch.batchId, byCandidate }}
          />
          <Group
            title="Provisional"
            description="No project evidence supplied. Ranked separately so missing projects never help or hurt a complete profile."
            entries={batch.provisional}
            usable={!expired}
            invite={{ briefId, batchId: batch.batchId, byCandidate }}
          />
          <Group
            title="Near matches"
            description="Below a time target you did not make mandatory. The shortfall is listed on each card."
            entries={batch.nearMatches}
            usable={!expired}
            invite={{ briefId, batchId: batch.batchId, byCandidate }}
          />
          <p className="text-sm text-ink-muted">{MATCH_LIMITATION_NOTICE}</p>
        </>
      )}
    </div>
  );
}

function BatchSummary({
  batch,
  minutesLeft,
  onRefresh,
  refreshing,
}: {
  batch: RecommendationSearchResponse;
  minutesLeft: number;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const gates = batch.exclusions.gates.filter((g) => g.count > 0);
  return (
    <Card as="section" aria-label="Search summary" className="flex flex-col gap-4 shadow-none">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-sm text-ink-muted">
          <Badge tone="neutral">{batch.algorithmVersion}</Badge>
          <span>Generated {formatDate(batch.generatedAt)}</span>
          <span className="inline-flex items-center gap-1" aria-live="polite">
            <Clock className="size-4" aria-hidden="true" />
            {minutesLeft > 0 ? `Valid for ${minutesLeft} more min` : 'Expired'}
          </span>
        </div>
        <Button
          variant="secondary"
          size="sm"
          icon={<RefreshCw className="size-4" aria-hidden="true" />}
          loading={refreshing}
          onClick={onRefresh}
        >
          Run a new search
        </Button>
      </div>
      <dl className="grid grid-cols-3 gap-3 text-sm">
        <div>
          <dt className="text-ink-muted">Recommended</dt>
          <dd className="text-lg font-semibold text-ink">{batch.recommendations.length}</dd>
        </div>
        <div>
          <dt className="text-ink-muted">Provisional</dt>
          <dd className="text-lg font-semibold text-ink">{batch.provisional.length}</dd>
        </div>
        <div>
          <dt className="text-ink-muted">Near matches</dt>
          <dd className="text-lg font-semibold text-ink">{batch.nearMatches.length}</dd>
        </div>
      </dl>
      <p className="text-sm text-ink-muted">
        {batch.exclusions.totalExcluded === 0
          ? 'No discoverable candidate failed a hard requirement.'
          : `${batch.exclusions.totalExcluded} discoverable candidate${batch.exclusions.totalExcluded === 1 ? '' : 's'} did not meet a hard requirement: ${gates
              .map((g) => `${GATE_LABELS[g.code].toLowerCase()} (${g.count})`)
              .join(', ')}. Identities are never shown.`}
      </p>
    </Card>
  );
}

function Group({
  title,
  description,
  entries,
  usable,
  invite,
}: {
  title: string;
  description: string;
  entries: RecommendationEntryView[];
  usable: boolean;
  invite: { briefId: string; batchId: string; byCandidate: Map<string, InterviewSummary> };
}) {
  return (
    <section aria-label={title} className="flex flex-col gap-4">
      <div>
        <h2 className="flex items-center gap-2 text-lg font-semibold text-ink">
          <Users className="size-5 text-brand" aria-hidden="true" />
          {title}
          <span className="text-sm font-normal text-ink-muted">({entries.length})</span>
        </h2>
        <p className="mt-1 text-sm text-ink-muted">{description}</p>
      </div>
      {entries.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line-strong p-5 text-sm text-ink-muted">
          No candidates scored 50 or more in this group.
        </p>
      ) : (
        <ol className="flex flex-col gap-4">
          {entries.map((entry, i) => (
            <CandidateCard
              key={entry.candidateUserId}
              entry={entry}
              rank={i + 1}
              usable={usable}
              invite={{
                briefId: invite.briefId,
                batchId: invite.batchId,
                existing: invite.byCandidate.get(entry.candidateUserId),
              }}
            />
          ))}
        </ol>
      )}
    </section>
  );
}
