import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import {
  CircleStop,
  Keyboard,
  Mic,
  RefreshCw,
  SkipForward,
  Volume2,
  Wifi,
  WifiOff,
} from 'lucide-react';
import {
  INTERVIEW_LIMITS,
  QUESTION_TYPE_LABELS,
  TURN_INTENT_LABELS,
  type InterviewSessionView,
  type TurnView,
} from '@cofoundry/shared';
import {
  Alert,
  Badge,
  Button,
  ButtonLink,
  Card,
  QueryState,
  TextAreaField,
} from '../../components/ui';
import { ApiError } from '../../lib/api/client';
import { fetchSpeech, roomClientId, useHeartbeat, useInterview, useInterviewActions } from './api';
import { micProblem, recordAnswer, useMicrophone } from './audio';
import { CameraSelfView } from './camera';
import { CodingRound } from './CodingRound';
import { InterviewerAvatar, type RoomActivity } from './InterviewerAvatar';
import { speakLine, speechPlayer, stopVoices, voiceLevel } from './player';
import { formatClock } from './status';

function useOnline() {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

/** Remaining time from server deadlines, corrected for the client clock offset. */
function useCountdown(deadline: string | null, serverNow: string) {
  const offset = useMemo(() => new Date(serverNow).getTime() - Date.now(), [serverNow]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  return deadline ? new Date(deadline).getTime() - (now + offset) : null;
}

function Transcript({ turns }: { turns: TurnView[] }) {
  return (
    <section aria-labelledby="transcript-heading" className="flex flex-col gap-3">
      <h2 id="transcript-heading" className="text-base font-semibold text-ink">
        Transcript
      </h2>
      <ol className="flex max-h-[28rem] flex-col gap-3 overflow-y-auto pr-1" aria-live="polite">
        {turns.map((t) => (
          <li key={t.index} className="flex flex-col gap-1">
            <p className="text-sm">
              <span className="font-semibold text-ink">Interviewer: </span>
              <span className="text-ink">{t.prompt}</span>
            </p>
            {t.answer ? (
              <p className="text-sm text-ink-muted">
                <span className="font-semibold text-ink">You: </span>
                {t.answer.skipped ? <em>Skipped</em> : t.answer.text}
              </p>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

function Room({ view }: { view: InterviewSessionView }) {
  const clientId = roomClientId(view.id);
  const actions = useInterviewActions(view.id, clientId);
  const heartbeat = useHeartbeat();
  const mic = useMicrophone();
  const online = useOnline();
  const [entered, setEntered] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [recording, setRecording] = useState<{ stop: () => void } | null>(null);
  const [typed, setTyped] = useState(view.consent?.items.speech_transcription !== true);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirmFinish, setConfirmFinish] = useState(false);
  const spoken = useRef(new Set<number>());

  const voiceConsent = view.consent?.items.speech_transcription === true;
  const voiceAllowed = voiceConsent && view.readiness?.speechToText.available === true;
  const ttsAvailable = view.readiness?.textToSpeech.available === true;
  const mp = micProblem(mic.state);
  const current =
    view.currentTurnIndex !== null
      ? (view.turns.find((t) => t.index === view.currentTurnIndex) ?? null)
      : null;
  const remaining = useCountdown(view.conversationDeadline, view.serverNow);
  const thinking =
    view.generation.status === 'running' || actions.upload.isPending || actions.answer.isPending;

  // Keep the session marked as active while the room is open.
  useEffect(() => {
    if (view.activeElsewhere) return;
    const t = window.setInterval(
      () => void heartbeat(view.id, clientId).catch(() => undefined),
      INTERVIEW_LIMITS.heartbeatSeconds * 1000,
    );
    return () => window.clearInterval(t);
  }, [heartbeat, view.id, clientId, view.activeElsewhere]);

  // Draft transcript arrives from the server after an upload.
  useEffect(() => {
    if (current?.draft) setText(current.draft.text);
  }, [current?.draft]);
  useEffect(() => {
    setText('');
    setError(null);
  }, [view.currentTurnIndex]);

  // Server voice when available, otherwise the browser's on-device voice; always shown as text.
  const speak = useCallback(
    async (turn: TurnView) => {
      setSpeaking(true);
      try {
        await speakLine(ttsAvailable, () => fetchSpeech(view.id, turn.index), turn.prompt);
      } finally {
        setSpeaking(false);
      }
    },
    [ttsAvailable, view.id],
  );
  // Leaving the room cancels queued lines too, not only the one playing.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      stopVoices();
    };
  }, []);

  // Speak each new interviewer turn once, in order (the intro, then every question): a question
  // that arrives while the intro is still playing waits for it instead of cutting it off.
  const queue = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    if (!entered) return;
    for (const t of view.turns) {
      if (spoken.current.has(t.index) || t.answer) continue;
      spoken.current.add(t.index);
      queue.current = queue.current.then(() => (alive.current ? speak(t) : undefined));
    }
  }, [entered, view.turns, speak]);

  async function enter() {
    await speechPlayer.unlock().catch(() => undefined);
    for (const t of view.turns) if (t.answer) spoken.current.add(t.index);
    // Rejoining after answering: do not replay the introduction.
    if (view.turns.some((t) => t.answer)) spoken.current.add(0);
    if (voiceAllowed) await mic.request();
    setEntered(true);
  }

  async function startRecording() {
    setError(null);
    const stream = mic.stream() ?? (await mic.request());
    if (!stream || !current) {
      setError('The microphone is not available. Type your answer instead.');
      setTyped(true);
      return;
    }
    const rec = recordAnswer(stream, {
      maxSeconds: INTERVIEW_LIMITS.audioMaxSeconds,
      silenceSeconds: 8,
      level: mic.getLevel,
    });
    setRecording(rec);
    const blob = await rec.done;
    setRecording(null);
    try {
      await actions.upload.mutateAsync({ turn: current.index, audio: blob });
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'Transcription failed. Try again or type your answer.',
      );
    }
  }

  async function submit(skip = false) {
    if (!current) return;
    setError(null);
    try {
      await actions.answer.mutateAsync({
        turn: current.index,
        text: skip ? '' : text,
        inputMode: typed || !current.draft ? 'typed' : 'voice',
        ...(skip ? { skip: true } : {}),
      });
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'Could not submit. Check your connection and retry.',
      );
    }
  }

  if (view.activeElsewhere) {
    return (
      <Card className="flex flex-col items-start gap-3">
        <h1 className="text-xl font-semibold text-ink">This interview is open in another window</h1>
        <p className="text-ink-muted">
          Only one window can run the interview. Continue here to take over; the other window will
          stop.
        </p>
        <Button loading={actions.attach.isPending} onClick={() => actions.attach.mutate()}>
          Continue here
        </Button>
      </Card>
    );
  }

  if (view.status === 'coding') return <CodingRound view={view} clientId={clientId} />;
  if (view.status === 'submitted') {
    return (
      <Card className="flex flex-col items-start gap-3">
        <h1 className="text-xl font-semibold text-ink">Interview submitted — thank you</h1>
        <p className="text-ink-muted">
          Your answers and code are being evaluated. You can read the same report as the founder
          once it is ready.
        </p>
        <ButtonLink to={`/candidate/inbox/${view.id}`}>View status and report</ButtonLink>
      </Card>
    );
  }
  if (view.status !== 'in_progress') {
    return (
      <Alert tone="caution" title="This interview is not in progress">
        <Link to={`/candidate/inbox/${view.id}`} className="underline">
          Back to the invitation
        </Link>
      </Alert>
    );
  }

  if (!entered) {
    return (
      <Card className="flex flex-col items-center gap-4 text-center">
        <InterviewerAvatar activity="idle" level={() => 0} />
        <h1 className="text-xl font-semibold text-ink">Your AI interviewer is ready</h1>
        <p className="max-w-prose text-ink-muted">
          Turn your sound on: each question is read aloud and shown as text.{' '}
          {voiceAllowed
            ? 'Your browser will ask for microphone access.'
            : 'You will type your answers.'}
        </p>
        {voiceConsent && !voiceAllowed ? (
          <Alert tone="caution" title="Voice answers are off">
            {view.readiness?.speechToText.message}
          </Alert>
        ) : null}
        <Button size="lg" onClick={() => void enter()}>
          Enter the interview room
        </Button>
      </Card>
    );
  }

  const activity: RoomActivity = speaking
    ? 'speaking'
    : recording
      ? 'listening'
      : thinking
        ? 'thinking'
        : current
          ? 'waiting'
          : 'idle';
  const level = () => (speaking ? voiceLevel() : recording ? mic.getLevel() : 0);
  const answered = view.progress.questionsAnswered;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2 text-sm text-ink-muted">
            <Badge tone="brand">
              Question {Math.max(1, view.progress.questionsAsked)} of up to{' '}
              {view.progress.maxQuestions}
            </Badge>
            <span aria-live="off">{answered} answered</span>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="flex items-center gap-1 text-ink-muted">
              {online ? (
                <Wifi className="size-4" aria-hidden="true" />
              ) : (
                <WifiOff className="size-4 text-danger" aria-hidden="true" />
              )}
              {online ? 'Connected' : 'Offline — reconnecting'}
            </span>
            <span
              className="font-mono text-lg tabular-nums text-ink"
              aria-label="Time left in the conversation"
            >
              {remaining === null ? '--:--' : formatClock(remaining)}
            </span>
          </div>
        </div>

        {!online ? (
          <Alert tone="caution" title="You are offline" live>
            Your progress is saved on the server. The timer keeps running; reconnect to continue.
          </Alert>
        ) : null}

        <Card className="flex flex-col items-center gap-4">
          <InterviewerAvatar activity={activity} level={level} />
          {current ? (
            <div className="w-full">
              <div className="mb-2 flex flex-wrap gap-2">
                {current.questionType ? (
                  <Badge tone="info">{QUESTION_TYPE_LABELS[current.questionType]}</Badge>
                ) : null}
                {current.intent && current.intent !== 'new_topic' ? (
                  <Badge>{TURN_INTENT_LABELS[current.intent]}</Badge>
                ) : null}
              </div>
              <h1 className="text-lg font-semibold text-ink sm:text-xl">{current.prompt}</h1>
              <Button
                variant="ghost"
                size="sm"
                className="mt-1"
                icon={<Volume2 className="size-4" aria-hidden="true" />}
                disabled={speaking}
                onClick={() => void speak(current)}
              >
                Repeat question
              </Button>
            </div>
          ) : view.generation.status === 'failed' ? (
            <Alert
              tone="danger"
              title="The next question could not be prepared"
              action={
                <Button
                  variant="secondary"
                  icon={<RefreshCw className="size-4" aria-hidden="true" />}
                  loading={actions.nextQuestion.isPending}
                  onClick={() => actions.nextQuestion.mutate()}
                >
                  Retry
                </Button>
              }
            >
              {view.generation.message}
            </Alert>
          ) : (
            <p className="text-ink-muted" role="status">
              {view.turns.length <= 1
                ? 'The interviewer is reading your resume and preparing the first question…'
                : 'Preparing the next question…'}
            </p>
          )}
        </Card>

        {current ? (
          <Card as="section" aria-labelledby="answer-heading" className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="answer-heading" className="text-base font-semibold text-ink">
                Your answer
              </h2>
              {voiceAllowed ? (
                <Button
                  variant="ghost"
                  size="sm"
                  icon={
                    typed ? (
                      <Mic className="size-4" aria-hidden="true" />
                    ) : (
                      <Keyboard className="size-4" aria-hidden="true" />
                    )
                  }
                  onClick={() => setTyped((t) => !t)}
                >
                  {typed ? 'Answer by voice' : 'Type instead'}
                </Button>
              ) : null}
            </div>
            {!typed ? (
              <div className="flex flex-wrap items-center gap-3">
                {recording ? (
                  <Button
                    variant="danger"
                    icon={<CircleStop className="size-4" aria-hidden="true" />}
                    onClick={() => recording.stop()}
                  >
                    Done answering
                  </Button>
                ) : (
                  <Button
                    icon={<Mic className="size-4" aria-hidden="true" />}
                    disabled={
                      speaking ||
                      thinking ||
                      (current.draft?.recordingsUsed ?? 0) >= INTERVIEW_LIMITS.maxRecordingsPerTurn
                    }
                    loading={actions.upload.isPending}
                    onClick={() => void startRecording()}
                  >
                    {current.draft ? 'Record again' : 'Start answering'}
                  </Button>
                )}
                <span className="text-sm text-ink-muted">
                  {recording
                    ? 'Recording… it stops after a long pause, or press Done.'
                    : actions.upload.isPending
                      ? 'Transcribing…'
                      : `Up to ${INTERVIEW_LIMITS.audioMaxSeconds / 60} minutes per answer.`}
                </span>
              </div>
            ) : null}
            {voiceConsent && !voiceAllowed ? (
              <p className="text-sm text-ink-muted">{view.readiness?.speechToText.message}</p>
            ) : null}
            {mp && voiceConsent ? (
              <Alert tone="caution" title={mp.title} live>
                {mp.body}
              </Alert>
            ) : null}
            {current.draft?.noSpeech ? (
              <Alert tone="caution" title="No speech was detected">
                Record again closer to the microphone, or type your answer.
              </Alert>
            ) : null}
            {current.draft && current.draft.confidence !== 'high' && !current.draft.noSpeech ? (
              <p className="text-sm text-caution">
                Some words may have been recognised incorrectly
                {current.draft.text.includes('[unclear audio]')
                  ? ' and unclear parts are marked [unclear audio]'
                  : ''}
                . Please check and correct the transcript — recognition problems are not counted as
                mistakes.
              </p>
            ) : null}
            {typed || current.draft ? (
              <TextAreaField
                label={typed ? 'Type your answer' : 'Transcript (you can correct it)'}
                value={text}
                maxLength={INTERVIEW_LIMITS.answerMaxChars}
                counter={`${text.length}/${INTERVIEW_LIMITS.answerMaxChars}`}
                onChange={(e) => setText(e.target.value)}
              />
            ) : null}
            {error ? (
              <Alert tone="danger" title="Something went wrong" live>
                {error}
              </Alert>
            ) : null}
            <div className="flex flex-wrap gap-3">
              <Button
                disabled={text.trim().length === 0 || thinking || !!recording}
                loading={actions.answer.isPending}
                onClick={() => void submit()}
              >
                Submit answer
              </Button>
              <Button
                variant="ghost"
                icon={<SkipForward className="size-4" aria-hidden="true" />}
                disabled={thinking || !!recording}
                onClick={() => void submit(true)}
              >
                Skip question
              </Button>
            </div>
          </Card>
        ) : null}
      </div>

      <aside className="flex flex-col gap-4">
        <Card as="section" aria-label="Your camera">
          <CameraSelfView resume compact />
        </Card>
        <Card>
          <Transcript turns={view.turns} />
        </Card>
        {view.allowedActions.includes('finish_conversation') ? (
          <Card className="flex flex-col gap-2">
            <p className="text-sm text-ink-muted">
              Finished early? Move on to the coding task. Any open question is marked skipped.
            </p>
            {confirmFinish ? (
              <div className="flex gap-2">
                <Button
                  size="sm"
                  loading={actions.finish.isPending}
                  onClick={() => actions.finish.mutate()}
                >
                  Yes, go to coding
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmFinish(false)}>
                  Keep talking
                </Button>
              </div>
            ) : (
              <Button size="sm" variant="secondary" onClick={() => setConfirmFinish(true)}>
                Finish conversation
              </Button>
            )}
          </Card>
        ) : null}
      </aside>
    </div>
  );
}

export function InterviewRoomPage() {
  const { interviewId = '' } = useParams();
  const clientId = roomClientId(interviewId);
  const query = useInterview(interviewId, { clientId, poll: true });
  return <QueryState query={query}>{(view) => <Room view={view} />}</QueryState>;
}
