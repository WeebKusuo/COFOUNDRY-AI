import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { ArrowLeft, Handshake } from 'lucide-react';
import {
  COLLABORATION_LIMITS,
  MATCH_END_REASON_LABELS,
  MATCH_NOT_EMPLOYMENT_NOTICE,
  type MatchView,
} from '@cofoundry/shared';
import {
  Alert,
  Button,
  ButtonLink,
  Card,
  CardHeader,
  EmptyState,
  QueryState,
  TextField,
} from '../../components/ui';
import { formatDate } from '../briefs/status';
import { BlockControl, ReportControl } from '../safety/SafetyActions';
import { useEndMatch, useMatch, useMatches, useProposeSprint } from './api';
import {
  MatchStatusBadge,
  MutationError,
  SprintStatusBadge,
  TermsList,
  UnavailableNotice,
} from './parts';
import { SprintForm } from './SprintForm';
import { SprintPanel } from './SprintPanel';

export function MatchListPage({ viewer }: { viewer: 'founder' | 'candidate' }) {
  const query = useMatches(viewer);
  const base = viewer === 'founder' ? '/founder/matches' : '/candidate/matches';
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-ink sm:text-3xl">Matches</h1>
        <p className="mt-1 text-ink-muted">
          Accepted collaboration requests: the agreed terms, the trial sprint and its outcome.
        </p>
      </div>
      <QueryState
        query={query}
        isEmpty={(d) => d.length === 0}
        empty={
          <EmptyState
            icon={<Handshake className="size-6" aria-hidden="true" />}
            title="No matches yet"
          >
            {viewer === 'founder'
              ? 'A match is created when a candidate accepts your collaboration request.'
              : 'A match is created when you accept a founder’s collaboration request.'}
          </EmptyState>
        }
      >
        {(items) => (
          <ul className="flex flex-col gap-3">
            {items.map((m) => (
              <li key={m.id}>
                <Card className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="text-base font-semibold text-ink">
                      <Link to={`${base}/${m.id}`} className="hover:underline">
                        {viewer === 'founder' ? m.candidate.displayName : m.founder.displayName} ·{' '}
                        {m.briefTitle}
                      </Link>
                    </h2>
                    <p className="text-sm text-ink-muted">Matched {formatDate(m.startedAt)}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <MatchStatusBadge status={m.status} />
                    {m.sprint ? <SprintStatusBadge status={m.sprint.status} /> : null}
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

function ProposeSprint({ m }: { m: MatchView }) {
  const propose = useProposeSprint(m.id);
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <Card as="section" aria-labelledby="propose-heading" className="flex flex-col gap-3">
        <CardHeader
          title={<span id="propose-heading">Trial sprint</span>}
          description="One small, bounded trial (1-10 hours, deadline within 14 days) agreed by both of you before work starts."
        />
        <Button className="self-start" onClick={() => setOpen(true)}>
          Propose a trial sprint
        </Button>
      </Card>
    );
  }
  return (
    <Card as="section" aria-labelledby="propose-heading">
      <CardHeader
        title={<span id="propose-heading">Propose a trial sprint</span>}
        description="This saves a draft. Nothing is shared as agreed until you send it and both of you approve the same version."
      />
      <SprintForm
        initial={null}
        minimum={m.terms.compensation}
        submitLabel="Save draft proposal"
        pending={propose.isPending}
        error={propose.error}
        onCancel={() => setOpen(false)}
        onSubmit={(input) => propose.mutate(input)}
      />
    </Card>
  );
}

function Body({ m }: { m: MatchView }) {
  const end = useEndMatch(m.id);
  const [reason, setReason] = useState('');
  const founder = m.viewerRole === 'founder';
  const other = founder ? m.candidate : m.founder;
  const base = founder ? '/founder' : '/candidate';
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link
          to={`${base}/matches`}
          className="flex items-center gap-1 text-sm text-ink-muted hover:underline"
        >
          <ArrowLeft className="size-4" aria-hidden="true" /> Matches
        </Link>
        <h1 className="text-2xl font-bold text-ink sm:text-3xl">
          {other.displayName} · {m.briefTitle}
        </h1>
        <div className="flex flex-wrap items-center gap-2 text-sm text-ink-muted">
          <MatchStatusBadge status={m.status} />
          <span>Matched {formatDate(m.startedAt)}</span>
          {m.endedAt ? (
            <span>
              · {m.status === 'completed' ? 'completed' : 'ended'} {formatDate(m.endedAt)}
            </span>
          ) : null}
        </div>
      </div>
      {m.unavailable ? <UnavailableNotice /> : null}
      {m.status === 'ended' && m.endReason && !m.unavailable ? (
        <Alert tone="caution" title={MATCH_END_REASON_LABELS[m.endReason]}>
          {m.endNote ? `Note: ${m.endNote}` : 'The agreement and sprint records remain readable.'}
        </Alert>
      ) : null}
      <Card as="section" aria-labelledby="match-terms">
        <CardHeader
          title={<span id="match-terms">Agreed terms</span>}
          description={MATCH_NOT_EMPLOYMENT_NOTICE}
          action={
            <ButtonLink to={`${base}/requests/${m.requestId}`} variant="secondary" size="sm">
              Original request
            </ButtonLink>
          }
        />
        <TermsList terms={m.terms} />
      </Card>
      {m.sprint ? (
        <SprintPanel sprintId={m.sprint.id} />
      ) : m.allowedActions.includes('propose_sprint') ? (
        <ProposeSprint m={m} />
      ) : null}
      {m.allowedActions.includes('end') ? (
        <Card as="section" aria-labelledby="end-heading" className="flex flex-col gap-3">
          <CardHeader
            title={<span id="end-heading">End the match</span>}
            description="Either of you can end it at any time. An unfinished sprint is cancelled. This cannot be undone."
          />
          <div className="flex flex-wrap items-end gap-3">
            <TextField
              label="Reason (shared with the other participant)"
              value={reason}
              maxLength={COLLABORATION_LIMITS.reasonMax}
              onChange={(e) => setReason(e.target.value)}
            />
            <Button
              variant="danger"
              disabled={reason.trim().length === 0}
              loading={end.isPending}
              onClick={() => end.mutate(reason.trim())}
            >
              End match
            </Button>
          </div>
          <MutationError error={end.error} />
        </Card>
      ) : null}
      {!m.unavailable ? (
        <div className="flex flex-wrap gap-3">
          <ReportControl
            targetType="user"
            targetId={other.userId}
            label={`Report ${other.displayName}`}
          />
          <BlockControl userId={other.userId} name={other.displayName} />
        </div>
      ) : null}
    </div>
  );
}

export function MatchDetailPage() {
  const { matchId = '' } = useParams();
  const query = useMatch(matchId);
  return <QueryState query={query}>{(m) => <Body m={m} />}</QueryState>;
}
