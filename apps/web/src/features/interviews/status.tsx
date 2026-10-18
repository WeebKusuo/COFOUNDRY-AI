import type { EvaluationStatus, InterviewStatus } from '@cofoundry/shared';
import { Badge, type BadgeTone } from '../../components/ui';

const LABELS: Record<InterviewStatus, { label: string; tone: BadgeTone }> = {
  invited: { label: 'Invited', tone: 'info' },
  accepted: { label: 'Accepted', tone: 'brand' },
  in_progress: { label: 'Interview in progress', tone: 'brand' },
  coding: { label: 'Coding task in progress', tone: 'brand' },
  submitted: { label: 'Submitted', tone: 'neutral' },
  declined: { label: 'Declined', tone: 'neutral' },
  expired: { label: 'Expired', tone: 'caution' },
  cancelled: { label: 'Cancelled', tone: 'caution' },
};

export function InterviewStatusBadge({ status }: { status: InterviewStatus }) {
  const s = LABELS[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

const EVAL: Record<EvaluationStatus, string> = {
  none: '',
  queued: 'Evaluation queued',
  running: 'Evaluating',
  failed: 'Evaluation failed',
  succeeded: 'Report ready',
};

export function EvaluationBadge({ status }: { status: EvaluationStatus }) {
  if (status === 'none') return null;
  return (
    <Badge tone={status === 'failed' ? 'danger' : status === 'succeeded' ? 'brand' : 'info'}>
      {EVAL[status]}
    </Badge>
  );
}

/** mm:ss for a countdown; never negative. */
export function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
