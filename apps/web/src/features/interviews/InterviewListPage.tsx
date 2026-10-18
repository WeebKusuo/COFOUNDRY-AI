import { Link } from 'react-router';
import { ClipboardList } from 'lucide-react';
import { Card, EmptyState, QueryState } from '../../components/ui';
import { formatDate } from '../briefs/status';
import { useInterviews } from './api';
import { EvaluationBadge, InterviewStatusBadge } from './status';

/** Founder: invitations sent and reports. Candidate: interview invitations inbox. */
export function InterviewListPage({
  viewer: role,
  embedded = false,
}: {
  viewer: 'founder' | 'candidate';
  /** Rendered inside another page (the candidate inbox tab) without its own heading. */
  embedded?: boolean;
}) {
  const query = useInterviews(role);
  const founder = role === 'founder';
  const base = founder ? '/founder/interviews' : '/candidate/inbox';
  return (
    <div className="flex flex-col gap-6">
      {embedded ? null : (
        <div>
          <h1 className="text-2xl font-bold text-ink sm:text-3xl">
            {founder ? 'Interviews' : 'Inbox'}
          </h1>
          <p className="mt-1 text-ink-muted">
            {founder
              ? 'Invitations you sent from your candidate results, their progress and the reports.'
              : 'Interview invitations from founders. Each invitation expires 7 days after it was sent.'}
          </p>
        </div>
      )}
      <QueryState
        query={query}
        isEmpty={(d) => d.length === 0}
        empty={
          <EmptyState
            icon={<ClipboardList className="size-6" aria-hidden="true" />}
            title="No invitations yet"
          >
            {founder
              ? 'Invite a candidate from your Candidates page.'
              : 'When a founder invites you to an interview, it appears here.'}
          </EmptyState>
        }
      >
        {(items) => (
          <ul className="flex flex-col gap-3">
            {items.map((i) => (
              <li key={i.id}>
                <Card className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="text-base font-semibold text-ink">
                      <Link to={`${base}/${i.id}`} className="hover:underline">
                        {founder ? i.candidate.displayName : i.briefTitle}
                      </Link>
                    </h2>
                    <p className="text-sm text-ink-muted">
                      {founder ? i.briefTitle : `From ${i.founder.displayName}`} · invited{' '}
                      {formatDate(i.invitedAt)}
                      {i.status === 'invited' ? ` · expires ${formatDate(i.expiresAt)}` : ''}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <InterviewStatusBadge status={i.status} />
                    <EvaluationBadge status={i.evaluationStatus} />
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
