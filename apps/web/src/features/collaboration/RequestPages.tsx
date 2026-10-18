import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { ArrowLeft, Handshake, MessagesSquare } from 'lucide-react';
import {
  COLLABORATION_LIMITS,
  EVIDENCE_LEVEL_LABELS,
  MATCH_NOT_EMPLOYMENT_NOTICE,
  formatScore,
  type EvidenceLevel,
  type MatchRequestView,
} from '@cofoundry/shared';
import {
  Alert,
  Button,
  ButtonLink,
  Card,
  CardHeader,
  EmptyState,
  QueryState,
  TextAreaField,
  TextField,
} from '../../components/ui';
import { formatDate } from '../briefs/status';
import { BlockControl, ReportControl } from '../safety/SafetyActions';
import {
  useRequest,
  useRequestActions,
  useRequestForInterview,
  useRequests,
  useSendRequest,
} from './api';
import {
  MutationError,
  RequestStatusBadge,
  Row,
  TermsList,
  Timeline,
  UnavailableNotice,
  fieldError,
} from './parts';

const base = (role: 'founder' | 'candidate') => (role === 'founder' ? '/founder' : '/candidate');

/** Founder "Requests" screen and the candidate inbox tab: own requests only. */
export function RequestList({ box }: { box: 'inbox' | 'sent' }) {
  const query = useRequests(box);
  const role = box === 'sent' ? 'founder' : 'candidate';
  return (
    <QueryState
      query={query}
      isEmpty={(d) => d.length === 0}
      empty={
        <EmptyState
          icon={<MessagesSquare className="size-6" aria-hidden="true" />}
          title="No collaboration requests yet"
        >
          {box === 'sent'
            ? 'After you read a completed interview report, you can send the candidate a collaboration request.'
            : 'When a founder invites you to collaborate after your interview, the request appears here.'}
        </EmptyState>
      }
    >
      {(items) => (
        <ul className="flex flex-col gap-3">
          {items.map((r) => (
            <li key={r.id}>
              <Card className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-base font-semibold text-ink">
                    <Link to={`${base(role)}/requests/${r.id}`} className="hover:underline">
                      {role === 'founder' ? r.candidate.displayName : r.briefTitle}
                    </Link>
                  </h2>
                  <p className="text-sm text-ink-muted">
                    {role === 'founder' ? r.briefTitle : `From ${r.founder.displayName}`} · sent{' '}
                    {formatDate(r.createdAt)}
                    {r.status === 'pending' ? ` · expires ${formatDate(r.expiresAt)}` : ''}
                  </p>
                </div>
                <RequestStatusBadge status={r.status} />
              </Card>
            </li>
          ))}
        </ul>
      )}
    </QueryState>
  );
}

export function SentRequestsPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-ink sm:text-3xl">Collaboration requests</h1>
        <p className="mt-1 text-ink-muted">
          Requests you sent after reviewing interview reports. Each expires 7 days after it was
          sent; you can withdraw it while it is pending.
        </p>
      </div>
      <RequestList box="sent" />
    </div>
  );
}

function ReportFacts({ r }: { r: MatchRequestView }) {
  return (
    <dl className="grid gap-3 text-sm sm:grid-cols-3">
      <Row label="Overall technical assessment">{formatScore(r.report.overallScore)}</Row>
      <Row label="Evidence">
        {r.report.evidenceLevel
          ? (EVIDENCE_LEVEL_LABELS[r.report.evidenceLevel as EvidenceLevel] ??
            r.report.evidenceLevel)
          : '—'}
      </Row>
      <Row label="Report version">{r.report.reportVersion}</Row>
      {r.report.openCorrections > 0 ? (
        <Row label="Open corrections" wide>
          {r.report.openCorrections} correction request(s) are open. They do not change scores or
          decide anything; read them with the report.
        </Row>
      ) : null}
    </dl>
  );
}

function RequestBody({ r }: { r: MatchRequestView }) {
  const actions = useRequestActions(r.id);
  const [reason, setReason] = useState('');
  const founder = r.viewerRole === 'founder';
  const other = founder ? r.candidate : r.founder;
  const can = (a: string) => r.allowedActions.includes(a as never);
  const error = actions.accept.error ?? actions.decline.error ?? actions.withdraw.error;
  const reportLink = founder
    ? `/founder/interviews/${r.interviewId}`
    : `/candidate/inbox/${r.interviewId}`;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link
          to={founder ? '/founder/requests' : '/candidate/inbox?tab=requests'}
          className="flex items-center gap-1 text-sm text-ink-muted hover:underline"
        >
          <ArrowLeft className="size-4" aria-hidden="true" /> {founder ? 'Requests' : 'Inbox'}
        </Link>
        <h1 className="text-2xl font-bold text-ink sm:text-3xl">
          {founder ? `${r.candidate.displayName} · ` : ''}
          {r.briefTitle}
        </h1>
        <div className="flex flex-wrap items-center gap-2 text-sm text-ink-muted">
          <RequestStatusBadge status={r.status} />
          <span>
            {founder ? 'Sent' : `From ${r.founder.displayName}`} {formatDate(r.createdAt)}
          </span>
          {r.status === 'pending' ? <span>· expires {formatDate(r.expiresAt)}</span> : null}
        </div>
      </div>
      {r.unavailable ? <UnavailableNotice /> : null}
      {r.status === 'accepted' && r.matchId ? (
        <Alert
          tone="success"
          title="Matched"
          action={
            <ButtonLink to={`${base(r.viewerRole)}/matches/${r.matchId}`} size="sm">
              Open the match
            </ButtonLink>
          }
        >
          {MATCH_NOT_EMPLOYMENT_NOTICE}
        </Alert>
      ) : null}
      <Card as="section" aria-labelledby="req-msg">
        <CardHeader title={<span id="req-msg">Message</span>} />
        <p className="whitespace-pre-wrap text-ink">{r.message || 'No message.'}</p>
        {r.responseReason ? (
          <p className="mt-3 text-sm text-ink-muted">
            {r.status === 'declined' ? 'Decline' : 'Withdrawal'} note: {r.responseReason}
          </p>
        ) : null}
      </Card>
      <Card as="section" aria-labelledby="req-terms">
        <CardHeader
          title={<span id="req-terms">Terms</span>}
          description="Frozen from the brief when the request was sent. Accepting means agreeing to collaborate on these terms."
        />
        <TermsList terms={r.terms} />
      </Card>
      <Card as="section" aria-labelledby="req-report">
        <CardHeader
          title={<span id="req-report">Interview report</span>}
          description="The request is based on this report version."
          action={
            <ButtonLink to={reportLink} variant="secondary" size="sm">
              Open report
            </ButtonLink>
          }
        />
        <ReportFacts r={r} />
      </Card>
      {can('accept') || can('decline') || can('withdraw') ? (
        <Card as="section" aria-labelledby="req-actions" className="flex flex-col gap-3">
          <CardHeader title={<span id="req-actions">Your decision</span>} />
          {can('accept') ? (
            <p className="text-sm text-ink-muted">
              Accepting creates a match with {r.founder.displayName}. {MATCH_NOT_EMPLOYMENT_NOTICE}
            </p>
          ) : null}
          <TextField
            label={
              can('withdraw')
                ? 'Reason for withdrawing (optional)'
                : 'Reason for declining (optional)'
            }
            value={reason}
            maxLength={COLLABORATION_LIMITS.reasonMax}
            error={fieldError(error, 'reason')}
            onChange={(e) => setReason(e.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            {can('accept') ? (
              <Button
                icon={<Handshake className="size-4" aria-hidden="true" />}
                loading={actions.accept.isPending}
                onClick={() => actions.accept.mutate()}
              >
                Accept and match
              </Button>
            ) : null}
            {can('decline') ? (
              <Button
                variant="secondary"
                loading={actions.decline.isPending}
                onClick={() => actions.decline.mutate(reason.trim())}
              >
                Decline
              </Button>
            ) : null}
            {can('withdraw') ? (
              <Button
                variant="danger"
                loading={actions.withdraw.isPending}
                onClick={() => actions.withdraw.mutate(reason.trim())}
              >
                Withdraw request
              </Button>
            ) : null}
          </div>
          <MutationError error={error} />
        </Card>
      ) : null}
      <Card as="section" aria-labelledby="req-timeline">
        <CardHeader title={<span id="req-timeline">Timeline</span>} />
        <Timeline entries={r.timeline} />
      </Card>
      {!r.unavailable ? (
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

export function RequestDetailPage() {
  const { requestId = '' } = useParams();
  const query = useRequest(requestId);
  return <QueryState query={query}>{(r) => <RequestBody r={r} />}</QueryState>;
}

/** On the founder's completed report: send (or open) the collaboration request. */
export function SendRequestPanel({
  briefId,
  interviewId,
  candidateUserId,
  candidateName,
  quarantined,
}: {
  briefId: string;
  interviewId: string;
  candidateUserId: string;
  candidateName: string;
  quarantined: boolean;
}) {
  const sent = useRequestForInterview(interviewId);
  const send = useSendRequest();
  const [message, setMessage] = useState('');
  const existing = sent.data ?? send.data;
  if (existing) {
    return (
      <Alert
        tone={existing.status === 'accepted' ? 'success' : 'info'}
        title={`Collaboration request: ${existing.status}`}
        action={
          <ButtonLink to={`/founder/requests/${existing.id}`} size="sm" variant="secondary">
            Open request
          </ButtonLink>
        }
      >
        Each candidate and brief pair gets one request.
      </Alert>
    );
  }
  if (quarantined) {
    return (
      <Alert tone="caution" title="Report quarantined">
        A moderator quarantined this report after a dispute, so it cannot support a new
        collaboration request.
      </Alert>
    );
  }
  return (
    <Card as="section" aria-labelledby="send-req" className="flex flex-col gap-3">
      <CardHeader
        title={<span id="send-req">Invite {candidateName} to collaborate</span>}
        description="The candidate sees the brief terms, your message and this report version. The request expires after 7 days."
      />
      <TextAreaField
        label="Message (optional)"
        value={message}
        maxLength={COLLABORATION_LIMITS.requestMessageMax}
        counter={`${message.length}/${COLLABORATION_LIMITS.requestMessageMax}`}
        error={fieldError(send.error, 'message')}
        onChange={(e) => setMessage(e.target.value)}
      />
      <Button
        className="self-start"
        icon={<Handshake className="size-4" aria-hidden="true" />}
        loading={send.isPending}
        onClick={() =>
          send.mutate({ briefId, interviewId, candidateUserId, message: message.trim() })
        }
      >
        Send collaboration request
      </Button>
      <MutationError error={send.error} title="Could not send the request" />
    </Card>
  );
}
