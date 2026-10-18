import { useState } from 'react';
import { Link } from 'react-router';
import { CheckCircle2, Send } from 'lucide-react';
import type { InterviewSummary } from '@cofoundry/shared';
import { Button } from '../../components/ui';
import { ApiError } from '../../lib/api/client';
import { useInvite } from './api';
import { InterviewStatusBadge } from './status';

/**
 * "Invite to interview" on a recommendation card. The server revalidates the batch (fresh,
 * listed candidate, unchanged profile, gates) — the client only asks and reports the answer.
 */
export function InviteAction({
  briefId,
  batchId,
  candidateUserId,
  displayName,
  usable,
  existing,
  describedById,
}: {
  briefId: string;
  batchId: string;
  candidateUserId: string;
  displayName: string;
  usable: boolean;
  existing: InterviewSummary | undefined;
  describedById: string;
}) {
  const invite = useInvite(briefId);
  const [confirming, setConfirming] = useState(false);

  if (invite.isSuccess && invite.data) {
    return (
      <span role="status" className="flex items-center gap-2 text-sm text-ink">
        <CheckCircle2 className="size-4 text-success" aria-hidden="true" />
        Invitation sent to {displayName}.
        <Link
          to={`/founder/interviews/${invite.data.id}`}
          className="font-medium text-brand underline"
        >
          View
        </Link>
      </span>
    );
  }
  if (existing) {
    return (
      <span className="flex flex-wrap items-center gap-2 text-sm text-ink-muted">
        <InterviewStatusBadge status={existing.status} />
        <Link
          to={`/founder/interviews/${existing.id}`}
          className="font-medium text-brand underline"
        >
          Open interview
        </Link>
      </span>
    );
  }
  const error = invite.error instanceof ApiError ? invite.error : null;
  return (
    <span className="flex flex-col gap-2">
      {confirming ? (
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-ink">
            Invite {displayName}? They get 7 days to accept. One interview per candidate and brief.
          </span>
          <Button
            size="sm"
            loading={invite.isPending}
            onClick={() => invite.mutate({ candidateUserId, batchId })}
          >
            Send invitation
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </span>
      ) : (
        <Button
          size="sm"
          disabled={!usable}
          icon={<Send className="size-4" aria-hidden="true" />}
          aria-describedby={describedById}
          onClick={() => setConfirming(true)}
        >
          Invite to interview
        </Button>
      )}
      <span id={describedById} className="text-xs text-ink-muted">
        {usable
          ? 'An AI-assisted voice interview with a short coding task, based on their resume.'
          : 'These results expired. Run a new search before inviting anyone.'}
      </span>
      {error ? (
        <span role="alert" className="text-sm text-danger">
          {error.code === 'STALE_RECOMMENDATION'
            ? `${error.message} Run a new search.`
            : error.message}
        </span>
      ) : null}
    </span>
  );
}
