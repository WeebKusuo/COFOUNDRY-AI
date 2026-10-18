import {
  publicReason,
  INTERVIEW_LIMITS as L,
  LIVE_STATUSES,
  type CodeRunView,
  type CodingView,
  type InterviewAction,
  type InterviewParty,
  type InterviewReadiness,
  type InterviewSessionView,
  type InterviewSummary,
  type TurnView,
} from '@cofoundry/shared';
import type { UserRecord } from '../auth/store.js';
import { findTask } from '../coding/tasks.js';
import { answeredCount, coveredTypes, questionTurns } from './policy.js';
import type { CodingRecord, InterviewRecord, TurnRecord } from './records.js';

/**
 * Participant projections. Rules:
 *  - Hidden fields (expected concepts, hidden tests, resume text/context, client ids) never leave
 *    the server.
 *  - The founder sees progress only until submission; afterwards the transcript, code and report
 *    unless the candidate withdrew assessment consent.
 *  - allowedActions is computed here so clients never infer permissions from status alone.
 */

export type ViewerRole = 'founder' | 'candidate';

export function viewerRole(user: UserRecord, rec: InterviewRecord): ViewerRole | null {
  if (user.id === rec.candidateUserId) return 'candidate';
  if (user.id === rec.founderUserId) return 'founder';
  return null;
}

export function consentActive(rec: InterviewRecord): boolean {
  return !!rec.consent && rec.consent.withdrawnAt === null;
}

/** Founder access to answers, code and report: after submission, consent active, no block. */
export function founderMaySeeContent(rec: InterviewRecord): boolean {
  return rec.status === 'submitted' && consentActive(rec) && !rec.blockedAt;
}

export function allowedActions(
  rec: InterviewRecord,
  role: ViewerRole,
  now: Date,
  opts: { activeElsewhere: boolean; retryAllowed: boolean },
): InterviewAction[] {
  const out: InterviewAction[] = [];
  const unexpired = now < rec.expiresAt;
  if (role === 'candidate') {
    switch (rec.status) {
      case 'invited':
        out.push(rec.briefAccessAt ? 'view_brief' : 'acknowledge_brief');
        if (rec.briefAccessAt && unexpired) out.push('accept');
        out.push('decline');
        break;
      case 'accepted':
        out.push('view_brief');
        if (unexpired) out.push('prepare', 'start');
        out.push('cancel', 'withdraw_consent');
        break;
      case 'in_progress':
        out.push('view_brief');
        out.push(opts.activeElsewhere ? 'resume' : 'answer');
        if (!opts.activeElsewhere && answeredCount(rec.turns) > 0) out.push('finish_conversation');
        out.push('cancel', 'withdraw_consent');
        break;
      case 'coding':
        out.push('view_brief');
        if (opts.activeElsewhere) out.push('resume');
        else if (rec.coding) out.push('code', 'submit_code');
        out.push('cancel', 'withdraw_consent');
        break;
      case 'submitted':
        out.push('view_brief', 'view_report');
        if (opts.retryAllowed) out.push('retry_evaluation');
        if (consentActive(rec)) out.push('withdraw_consent');
        break;
      default:
        break;
    }
  } else {
    if (['invited', 'accepted', 'in_progress', 'coding'].includes(rec.status)) out.push('cancel');
    out.push('view_brief');
    if (founderMaySeeContent(rec)) {
      out.push('view_report');
      if (opts.retryAllowed) out.push('retry_evaluation');
    }
  }
  return out;
}

function turnView(t: TurnRecord, role: ViewerRole): TurnView {
  return {
    index: t.index,
    kind: t.kind,
    questionType: t.questionType,
    topic: t.topic,
    intent: t.intent,
    difficulty: t.difficulty,
    prompt: t.prompt,
    parentIndex: t.parentIndex,
    resumeEvidence: t.resumeEvidence,
    askedAt: t.askedAt,
    answer: t.answer
      ? {
          text: t.answer.text,
          inputMode: t.answer.inputMode,
          transcriptOriginal: t.answer.transcriptOriginal,
          transcriptConfidence: t.answer.transcriptConfidence,
          uncertainSegments: t.answer.uncertainSegments,
          edited: t.answer.edited,
          editRatio: t.answer.editRatio,
          skipped: t.answer.skipped,
          skipReason: t.answer.skipReason,
          submittedAt: t.answer.submittedAt,
        }
      : null,
    draft:
      role === 'candidate' && t.draft && !t.answer
        ? {
            text: t.draft.text,
            segments: t.draft.segments,
            confidence: t.draft.confidence,
            noSpeech: t.draft.noSpeech,
            durationSec: t.draft.durationSec,
            recordingsUsed: t.draft.recordingsUsed,
          }
        : null,
  };
}

function codingView(
  c: CodingRecord,
  role: ViewerRole,
  execution: { available: boolean; message: string | null },
): CodingView | null {
  const task = findTask(c.taskId);
  if (!task) return null;
  return {
    task: {
      taskId: task.id,
      taskVersion: task.version,
      title: task.title,
      kind: task.kind,
      prompt: task.prompt,
      functionName: { ...task.functionName },
      starterCode: { ...task.starterCode },
      visibleTests: task.visibleTests.map((t) => ({
        name: t.name,
        input: JSON.stringify(t.args),
        expected: JSON.stringify(t.expected),
      })),
      hiddenTestCount: task.hiddenTests.length + (task.performance ? 1 : 0),
      selectionReason: c.selection.reason,
    },
    startedAt: c.startedAt,
    deadline: c.deadline,
    draft: role === 'candidate' ? c.draft : null,
    runs: role === 'candidate' ? c.runs.map((r): CodeRunView => ({ ...r })) : [],
    runsRemaining: Math.max(0, L.codeRunsPerSession - c.runCount),
    execution,
    submission: c.submission,
  };
}

export function partyOf(user: UserRecord | null): InterviewParty {
  return {
    displayName: user?.displayName ?? 'Former user',
    demoAccount: user?.accountMode === 'demo',
  };
}

export function toSummary(
  rec: InterviewRecord,
  role: ViewerRole,
  parties: { candidate: UserRecord | null; founder: UserRecord | null },
  now: Date,
  retryAllowed: boolean,
): InterviewSummary {
  return {
    id: rec.id,
    briefId: rec.briefId,
    briefVersion: rec.briefVersion,
    briefTitle: rec.briefPreview.title,
    status: rec.status,
    evaluationStatus: rec.evaluationStatus,
    candidateUserId: rec.candidateUserId,
    founderUserId: rec.founderUserId,
    candidate: partyOf(parties.candidate),
    founder: partyOf(parties.founder),
    invitedAt: rec.invitedAt.toISOString(),
    expiresAt: rec.expiresAt.toISOString(),
    submittedAt: rec.submittedAt?.toISOString() ?? null,
    allowedActions: allowedActions(rec, role, now, { activeElsewhere: false, retryAllowed }),
  };
}

export function toSessionView(
  rec: InterviewRecord,
  role: ViewerRole,
  ctx: {
    parties: { candidate: UserRecord | null; founder: UserRecord | null };
    now: Date;
    clientId: string | null;
    readiness: InterviewReadiness | null;
    execution: { available: boolean; message: string | null };
    currentProfileRevision: number | null;
    retryAllowed: boolean;
    reportAvailable: boolean;
  },
): InterviewSessionView {
  const activeElsewhere =
    role === 'candidate' &&
    LIVE_STATUSES.has(rec.status) &&
    rec.activeClientId !== null &&
    ctx.clientId !== rec.activeClientId;
  const showContent = role === 'candidate' || founderMaySeeContent(rec);
  const questions = questionTurns(rec.turns);
  const last = rec.turns[rec.turns.length - 1];
  const current =
    LIVE_STATUSES.has(rec.status) && last && last.kind === 'question' && !last.answer
      ? last.index
      : null;
  const stage =
    rec.status === 'in_progress'
      ? 'conversation'
      : rec.status === 'coding'
        ? 'coding'
        : rec.status === 'submitted'
          ? 'done'
          : 'not_started';
  const fullBriefVisible = role === 'founder' || rec.briefAccessAt !== null;
  return {
    ...toSummary(rec, role, ctx.parties, ctx.now, ctx.retryAllowed),
    allowedActions: allowedActions(rec, role, ctx.now, {
      activeElsewhere,
      retryAllowed: ctx.retryAllowed,
    }),
    viewerRole: role,
    serverNow: ctx.now.toISOString(),
    brief: rec.briefPreview,
    fullBrief: fullBriefVisible ? rec.briefFull : null,
    briefAccessAcknowledgedAt: rec.briefAccessAt?.toISOString() ?? null,
    acceptedAt: rec.acceptedAt?.toISOString() ?? null,
    startedAt: rec.startedAt?.toISOString() ?? null,
    conversationDeadline: rec.conversationDeadline?.toISOString() ?? null,
    codingDeadline: rec.codingDeadline?.toISOString() ?? null,
    globalDeadline: rec.globalDeadline?.toISOString() ?? null,
    consent: rec.consent,
    cancellationReason: rec.cancellationReason ? publicReason(rec.cancellationReason) : null,
    readiness: role === 'candidate' ? ctx.readiness : null,
    progress: {
      stage,
      questionsAsked: questions.length,
      questionsAnswered: answeredCount(rec.turns),
      maxQuestions: L.maxQuestions,
      minQuestions: L.minQuestions,
      topicsCovered: coveredTypes(rec.turns),
    },
    turns: showContent ? rec.turns.map((t) => turnView(t, role)) : [],
    currentTurnIndex: role === 'candidate' ? current : null,
    // The founder does not see the candidate's preparation activity before the interview.
    generation: {
      status: role === 'founder' && rec.status === 'accepted' ? 'idle' : rec.generation.status,
      message:
        !(role === 'founder' && rec.status === 'accepted') && rec.generation.status === 'failed'
          ? 'The AI interviewer could not prepare the next step. Retry in a moment.'
          : null,
    },
    coding:
      rec.coding && (role === 'candidate' || founderMaySeeContent(rec))
        ? codingView(rec.coding, role, ctx.execution)
        : null,
    activeElsewhere,
    currentProfileRevision: role === 'candidate' ? ctx.currentProfileRevision : null,
    reportAvailable: ctx.reportAvailable && (role === 'candidate' || founderMaySeeContent(rec)),
  };
}
