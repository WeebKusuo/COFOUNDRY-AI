import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import type { InterviewSessionView } from '@cofoundry/shared';
import { Alert, Button, Card, CardHeader, QueryState, TextField } from '../../components/ui';
import { ApiError } from '../../lib/api/client';
import { formatDate } from '../briefs/status';
import { useInterview, useInterviewActions } from './api';
import { ReportSection } from './ReportView';
import { SendRequestPanel } from '../collaboration/RequestPages';
import { BlockControl, ReportControl } from '../safety/SafetyActions';
import { EvaluationBadge, InterviewStatusBadge } from './status';

function Body({ view }: { view: InterviewSessionView }) {
  const actions = useInterviewActions(view.id);
  const [reason, setReason] = useState('');
  const canCancel = view.allowedActions.includes('cancel');
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link
          to="/founder/interviews"
          className="flex items-center gap-1 text-sm text-ink-muted hover:underline"
        >
          <ArrowLeft className="size-4" aria-hidden="true" /> Interviews
        </Link>
        <h1 className="text-2xl font-bold text-ink sm:text-3xl">
          {view.candidate.displayName} · {view.briefTitle}
        </h1>
        <div className="flex flex-wrap items-center gap-2 text-sm text-ink-muted">
          <InterviewStatusBadge status={view.status} />
          <EvaluationBadge status={view.evaluationStatus} />
          <span>Invited {formatDate(view.invitedAt)}</span>
          {view.status === 'invited' ? <span>· expires {formatDate(view.expiresAt)}</span> : null}
        </div>
      </div>

      {view.status !== 'submitted' ? (
        <Card as="section">
          <CardHeader
            title="Progress"
            description="Answers and code become visible to you only after the candidate submits."
          />
          <dl className="grid gap-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-ink-muted">Stage</dt>
              <dd className="text-ink">{view.progress.stage.replace('_', ' ')}</dd>
            </div>
            <div>
              <dt className="text-ink-muted">Questions asked</dt>
              <dd className="text-ink">{view.progress.questionsAsked}</dd>
            </div>
            <div>
              <dt className="text-ink-muted">Accepted</dt>
              <dd className="text-ink">{formatDate(view.acceptedAt)}</dd>
            </div>
          </dl>
          {canCancel ? (
            <div className="mt-4 flex flex-wrap items-end gap-3">
              <TextField
                label="Reason for cancelling"
                value={reason}
                maxLength={500}
                onChange={(e) => setReason(e.target.value)}
              />
              <Button
                variant="danger"
                disabled={reason.trim().length === 0}
                loading={actions.cancel.isPending}
                onClick={() => actions.cancel.mutate(reason.trim())}
              >
                Cancel interview
              </Button>
            </div>
          ) : null}
          {actions.cancel.error instanceof ApiError ? (
            <Alert tone="danger" title="Could not cancel" live className="mt-3">
              {actions.cancel.error.message}
            </Alert>
          ) : null}
        </Card>
      ) : view.allowedActions.includes('view_report') ? (
        <ReportSection
          interviewId={view.id}
          actions={(report) => (
            <SendRequestPanel
              briefId={view.briefId}
              interviewId={view.id}
              candidateUserId={view.candidateUserId}
              candidateName={view.candidate.displayName}
              quarantined={!!report.quarantine}
            />
          )}
        />
      ) : (
        <Alert tone="caution" title="Report unavailable">
          The answers and report are no longer available to you (the candidate withdrew assessment
          consent, or this collaboration is no longer available).
        </Alert>
      )}
      {view.status !== 'cancelled' || view.cancellationReason !== 'unavailable' ? (
        <div className="flex flex-wrap gap-3">
          <ReportControl
            targetType={
              view.status === 'submitted' && view.allowedActions.includes('view_report')
                ? 'report'
                : 'user'
            }
            targetId={
              view.status === 'submitted' && view.allowedActions.includes('view_report')
                ? view.id
                : view.candidateUserId
            }
            label="Report a problem"
          />
          <BlockControl userId={view.candidateUserId} name={view.candidate.displayName} />
        </div>
      ) : null}
    </div>
  );
}

export function FounderInterviewPage() {
  const { interviewId = '' } = useParams();
  const query = useInterview(interviewId, { poll: true });
  return <QueryState query={query}>{(view) => <Body view={view} />}</QueryState>;
}
