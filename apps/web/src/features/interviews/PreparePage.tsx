import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import {
  ArrowLeft,
  Camera,
  CheckCircle2,
  Code2,
  FileText,
  ListChecks,
  Mic,
  RefreshCw,
  ShieldCheck,
  Volume2,
  XCircle,
} from 'lucide-react';
import {
  CODE_LANGUAGE_LABELS,
  CODE_LANGUAGES,
  INTERVIEW_LIMITS,
  INTERVIEW_PRIVACY_NOTICE,
  VOICE_TEST_TEXT,
  type InterviewSessionView,
  type QuestionPreparation,
} from '@cofoundry/shared';
import { Alert, Badge, Button, Card, CardHeader, QueryState, Spinner } from '../../components/ui';
import { ApiError } from '../../lib/api/client';
import { ResumeSection } from '../resume/ResumeSection';
import { fetchSpeech, interviewKeys, roomClientId, useInterview, useInterviewActions } from './api';
import { micProblem, useMicrophone } from './audio';
import { CameraSelfView } from './camera';
import { browserVoice, speakLine, speechPlayer, type VoiceSource } from './player';

function Check({ ok, children }: { ok: boolean | null; children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2 text-sm">
      {ok === null ? null : ok ? (
        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
      ) : (
        <XCircle className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
      )}
      <span>{children}</span>
    </p>
  );
}

export function LevelMeter({ level, label }: { level: number; label: string }) {
  const pct = Math.round(level * 100);
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      className="h-2 w-full overflow-hidden rounded-full bg-surface-sunk"
    >
      <div
        className="h-full rounded-full bg-brand transition-[width]"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function StepTitle({ n, icon, children }: { n: number; icon: React.ReactNode; children: string }) {
  return (
    <span className="flex items-center gap-2">
      <span
        className="font-mono text-[0.6875rem] font-medium tracking-[0.08em] text-ink-muted"
        aria-hidden="true"
      >
        {String(n).padStart(2, '0')}
      </span>
      {icon}
      {children}
    </span>
  );
}

function QuestionsStatus({
  q,
  canPrepare,
  retrying,
  onRetry,
  error,
}: {
  q: QuestionPreparation;
  canPrepare: boolean;
  retrying: boolean;
  onRetry: () => void;
  error: string | null;
}) {
  if (q.status === 'ready') {
    return (
      <div className="flex flex-col gap-3">
        <Check ok>
          {q.plannedCount} interview questions are ready, prepared from your resume
          {q.resumeVersion ? ` (version ${q.resumeVersion})` : ''}. Follow-up questions adapt to
          your answers during the interview.
        </Check>
        {q.basedOn && (q.basedOn.projects.length > 0 || q.basedOn.technologies.length > 0) ? (
          <div className="flex flex-col gap-2 text-sm">
            {q.basedOn.projects.length > 0 ? (
              <div>
                <p className="font-semibold text-ink">Projects found in your resume</p>
                <ul className="mt-1 flex flex-wrap gap-1.5" aria-label="Projects">
                  {q.basedOn.projects.map((p) => (
                    <li key={p}>
                      <Badge>{p}</Badge>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {q.basedOn.technologies.length > 0 ? (
              <div>
                <p className="font-semibold text-ink">Tech stack</p>
                <ul className="mt-1 flex flex-wrap gap-1.5" aria-label="Tech stack">
                  {q.basedOn.technologies.map((t) => (
                    <li key={t}>
                      <Badge tone="info">{t}</Badge>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }
  if (q.status === 'waiting_for_resume') {
    return <Check ok={false}>{q.message}</Check>;
  }
  if (q.status === 'failed' || error) {
    return (
      <Alert
        tone="danger"
        title="Questions could not be prepared"
        live
        action={
          <Button
            variant="secondary"
            size="sm"
            icon={<RefreshCw className="size-4" aria-hidden="true" />}
            loading={retrying}
            onClick={onRetry}
          >
            Retry
          </Button>
        }
      >
        {error ?? q.message}
      </Alert>
    );
  }
  if (q.status !== 'preparing' && !canPrepare) {
    return <Check ok={false}>The questions cannot be prepared on this server right now.</Check>;
  }
  // not_started / stale are picked up automatically; preparing is in progress.
  return (
    <div className="flex items-center gap-3 text-sm text-ink" role="status">
      <Spinner size="sm" label="" />
      <span>
        {q.status === 'stale'
          ? 'Your resume changed — preparing the questions again from the new version…'
          : 'Reading your resume and preparing questions from your projects and tech stack…'}
      </span>
    </div>
  );
}

function Body({ view }: { view: InterviewSessionView }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const clientId = roomClientId(view.id);
  const actions = useInterviewActions(view.id, clientId);
  const mic = useMicrophone();
  const [voice, setVoice] = useState<'idle' | 'playing' | VoiceSource>('idle');
  const r = view.readiness;
  const q = r?.questions ?? null;
  const live = view.status === 'in_progress' || view.status === 'coding';
  const voiceConsent = view.consent?.items.speech_transcription === true;
  const voiceAnswers = voiceConsent && r?.speechToText.available === true;
  const canPrepare = view.allowedActions.includes('prepare') && r?.interviewer.available === true;
  const questionsReady = q?.status === 'ready';
  const canStart =
    !!r &&
    r.resume.ready &&
    questionsReady &&
    r.interviewer.available &&
    view.allowedActions.includes('start');

  // Prepare the questions automatically when they are missing or stale for the current resume.
  const requested = useRef<string | null>(null);
  const prepareKey =
    q && (q.status === 'not_started' || q.status === 'stale') && r?.resume.ready
      ? `${q.status}:${r.resume.resumeVersion}`
      : null;
  const prepareMutate = actions.prepare.mutate;
  useEffect(() => {
    if (!prepareKey || !canPrepare || requested.current === prepareKey) return;
    requested.current = prepareKey;
    prepareMutate();
  }, [prepareKey, canPrepare, prepareMutate]);

  const prepareError =
    actions.prepare.error instanceof ApiError ? actions.prepare.error.message : null;

  async function testVoice() {
    setVoice('playing');
    await speechPlayer.unlock().catch(() => undefined);
    setVoice(
      await speakLine(
        r?.textToSpeech.available === true,
        () => fetchSpeech(view.id, 'voice-test'),
        VOICE_TEST_TEXT,
      ),
    );
  }

  async function start() {
    await speechPlayer.unlock().catch(() => undefined);
    if (!live) await actions.start.mutateAsync();
    void navigate(`/candidate/interviews/${view.id}/room`);
  }

  const mp = micProblem(mic.state);
  const blockers: string[] = [];
  if (!live) {
    if (r && !r.resume.ready) blockers.push('Add your resume (step 1).');
    else if (q && !questionsReady) blockers.push('Wait until your questions are ready (step 2).');
    if (r && !r.interviewer.available) blockers.push('The AI interviewer is not configured.');
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          to={`/candidate/inbox/${view.id}`}
          className="flex items-center gap-1 text-sm text-ink-muted hover:underline"
        >
          <ArrowLeft className="size-4" aria-hidden="true" /> Invitation
        </Link>
        <h1 className="mt-2 text-2xl font-bold text-ink sm:text-3xl">Prepare for your interview</h1>
        <p className="mt-1 text-ink-muted">
          {view.brief.title} · with {view.founder.displayName}
        </p>
      </div>

      <Card as="section" aria-labelledby="how-heading">
        <CardHeader
          title={<span id="how-heading">How it works</span>}
          description={`About ${r?.approximateMinutes ?? 40} minutes. The timer starts when you press Start and keeps running if you disconnect.`}
        />
        <ol className="list-decimal space-y-1 pl-5 text-sm text-ink">
          <li>
            Your resume is read first and the questions are prepared from your projects and tech
            stack. Start becomes available when they are ready.
          </li>
          <li>
            The AI interviewer reads each question aloud (up to {INTERVIEW_LIMITS.maxQuestions}{' '}
            questions, {INTERVIEW_LIMITS.conversationSeconds / 60} minutes) and follows up on your
            answers.
          </li>
          <li>
            {voiceAnswers
              ? 'Answer out loud. Your answer is recorded, turned into text you can check and correct, and then checked by a separate AI evaluator. You can also type.'
              : 'Type your answers. Every question is also shown as text.'}
          </li>
          <li>
            Then a short coding task ({INTERVIEW_LIMITS.codingSeconds / 60} minutes) in a code
            editor, with tests you can run.
          </li>
          <li>
            All your answers and code are saved and evaluated into one report that you and the
            founder can both read.
          </li>
        </ol>
      </Card>

      {view.status === 'accepted' ? (
        <ResumeSection
          title={
            <StepTitle
              n={1}
              icon={<FileText className="size-4 text-ink-muted" aria-hidden="true" />}
            >
              Your resume
            </StepTitle>
          }
          description="Required. The interview questions are prepared from the projects and technologies in it. Contact details are removed before AI processing."
          onChanged={() => void qc.invalidateQueries({ queryKey: interviewKeys.one(view.id) })}
        />
      ) : null}
      {r && !r.resume.ready ? (
        <Alert tone="caution" title="Resume needed before the interview">
          {r.resume.message}
        </Alert>
      ) : null}

      <Card as="section" aria-labelledby="questions-heading">
        <CardHeader
          title={
            <span id="questions-heading">
              <StepTitle
                n={2}
                icon={<ListChecks className="size-4 text-ink-muted" aria-hidden="true" />}
              >
                Interview questions
              </StepTitle>
            </span>
          }
        />
        {q ? (
          <QuestionsStatus
            q={q}
            canPrepare={canPrepare}
            retrying={actions.prepare.isPending}
            error={prepareError}
            onRetry={() => actions.prepare.mutate()}
          />
        ) : (
          <Check ok={null}>Checking…</Check>
        )}
      </Card>

      <div className="grid gap-6 md:grid-cols-2">
        <Card as="section" aria-labelledby="camera-heading">
          <CardHeader
            title={
              <span id="camera-heading">
                <StepTitle
                  n={3}
                  icon={<Camera className="size-4 text-ink-muted" aria-hidden="true" />}
                >
                  Camera
                </StepTitle>
              </span>
            }
            description="Optional. See yourself during the interview, like a video call."
          />
          <CameraSelfView resume />
        </Card>

        <div className="flex flex-col gap-6">
          <Card as="section" aria-labelledby="mic-heading">
            <CardHeader
              title={
                <span id="mic-heading">
                  <StepTitle
                    n={4}
                    icon={<Mic className="size-4 text-ink-muted" aria-hidden="true" />}
                  >
                    Microphone
                  </StepTitle>
                </span>
              }
            />
            {!voiceConsent ? (
              <p className="text-sm text-ink-muted">
                You chose typed answers (no speech transcription consent), so no microphone is
                needed.
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                {!r?.speechToText.available ? (
                  <Alert tone="caution" title="Voice answers are off">
                    {r?.speechToText.message}
                  </Alert>
                ) : null}
                <Button
                  variant="secondary"
                  className="self-start"
                  loading={mic.state === 'requesting'}
                  onClick={() => void mic.request()}
                >
                  {mic.state === 'ready' ? 'Microphone on' : 'Test microphone'}
                </Button>
                {mic.state === 'ready' ? (
                  <>
                    <LevelMeter level={mic.level} label="Microphone input level" />
                    <p className="text-sm text-ink-muted">
                      Speak a few words — the bar should move.
                    </p>
                  </>
                ) : null}
                {mp ? (
                  <Alert tone="caution" title={mp.title} live>
                    {mp.body}
                  </Alert>
                ) : null}
              </div>
            )}
          </Card>

          <Card as="section" aria-labelledby="voice-heading">
            <CardHeader
              title={
                <span id="voice-heading">
                  <StepTitle
                    n={5}
                    icon={<Volume2 className="size-4 text-ink-muted" aria-hidden="true" />}
                  >
                    AI voice
                  </StepTitle>
                </span>
              }
            />
            <div className="flex flex-col gap-3">
              <Button
                variant="secondary"
                className="self-start"
                loading={voice === 'playing'}
                onClick={() => void testVoice()}
              >
                Play voice check
              </Button>
              {voice === 'server' ? <Check ok>Voice check played.</Check> : null}
              {voice === 'browser' ? (
                <Check ok>Voice check played with your browser’s on-device voice.</Check>
              ) : null}
              {voice === 'none' ? (
                <Check ok={false}>
                  No voice could play on this device. Check your sound; every question is also shown
                  as text.
                </Check>
              ) : null}
              {!r?.textToSpeech.available ? (
                <p className="text-sm text-ink-muted">
                  {r?.textToSpeech.message}{' '}
                  {browserVoice.available
                    ? 'Your browser’s on-device voice will read the questions instead.'
                    : 'If your browser has an on-device voice, it reads the questions instead.'}
                </p>
              ) : null}
            </div>
          </Card>
        </div>
      </div>

      <Card as="section" aria-labelledby="code-heading">
        <CardHeader
          title={
            <span id="code-heading" className="flex items-center gap-2">
              <Code2 className="size-4 text-ink-muted" aria-hidden="true" />
              Coding task
            </span>
          }
        />
        <ul className="list-disc space-y-1 pl-5 text-sm text-ink">
          <li>
            A short task chosen for the role: fix a bug, complete a function, improve slow code or
            handle edge cases.
          </li>
          <li>Languages: {CODE_LANGUAGES.map((l) => CODE_LANGUAGE_LABELS[l]).join(', ')}.</li>
          <li>
            Run the visible tests while you work; hidden tests check edge cases after you submit.
            Add a short explanation of your approach.
          </li>
        </ul>
        {!r?.codeExecution.available ? (
          <Alert tone="caution" title="Test runs unavailable" className="mt-3">
            {r?.codeExecution.message}
          </Alert>
        ) : null}
      </Card>

      <Card as="section" aria-labelledby="privacy-heading">
        <CardHeader
          title={
            <span id="privacy-heading" className="flex items-center gap-2">
              <ShieldCheck className="size-4 text-ink-muted" aria-hidden="true" />
              Privacy and retention
            </span>
          }
        />
        <p className="text-sm text-ink-muted">{INTERVIEW_PRIVACY_NOTICE}</p>
        <p className="mt-2 text-sm text-ink-muted">
          AI provider: {r?.interviewer.providers.join(', ') || 'not configured'}.
        </p>
      </Card>

      {r && !r.interviewer.available ? (
        <Alert tone="danger" title="Interview unavailable">
          {r.interviewer.message}
        </Alert>
      ) : null}
      {actions.start.error instanceof ApiError ? (
        <Alert tone="danger" title="Could not start" live>
          {actions.start.error.message}
        </Alert>
      ) : null}
      <div className="flex flex-col items-start gap-2">
        <Button
          size="lg"
          disabled={!canStart && !live}
          loading={actions.start.isPending}
          onClick={() => void start()}
        >
          {live ? 'Continue interview' : 'Start interview'}
        </Button>
        {blockers.length > 0 ? (
          <p className="text-sm text-ink-muted" id="start-blockers">
            {blockers.join(' ')}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function PreparePage() {
  const { interviewId = '' } = useParams();
  const query = useInterview(interviewId);
  return <QueryState query={query}>{(view) => <Body view={view} />}</QueryState>;
}
