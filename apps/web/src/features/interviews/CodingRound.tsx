import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Play, Send, XCircle } from 'lucide-react';
import {
  CODE_LANGUAGE_LABELS,
  CODE_LANGUAGES,
  CODING_TASK_KIND_LABELS,
  INTERVIEW_LIMITS,
  type CodeLanguage,
  type InterviewSessionView,
} from '@cofoundry/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  LoadingState,
  SelectField,
  TextAreaField,
} from '../../components/ui';
import { ApiError } from '../../lib/api/client';
import { useInterviewActions } from './api';
import { CodeEditor } from './CodeEditor';
import { CameraSelfView } from './camera';
import { formatClock } from './status';

function useRemaining(deadline: string, serverNow: string) {
  const offset = useMemo(() => new Date(serverNow).getTime() - Date.now(), [serverNow]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  return new Date(deadline).getTime() - (now + offset);
}

/** Phase 9 coding round: task, Monaco editor, visible test runs, explanation and submission. */
export function CodingRound({ view, clientId }: { view: InterviewSessionView; clientId: string }) {
  const coding = view.coding;
  if (!coding) return <LoadingState label="Preparing your coding task" />;
  return <Round view={view} clientId={clientId} />;
}

function Round({ view, clientId }: { view: InterviewSessionView; clientId: string }) {
  const coding = view.coding!;
  const task = coding.task;
  const actions = useInterviewActions(view.id, clientId);
  const [language, setLanguage] = useState<CodeLanguage>(coding.draft?.language ?? 'javascript');
  const [code, setCode] = useState(
    coding.draft?.code ?? task.starterCode[coding.draft?.language ?? 'javascript'],
  );
  const [explanation, setExplanation] = useState(coding.draft?.explanation ?? '');
  const [confirm, setConfirm] = useState(false);
  const [resetToken, setResetToken] = useState(0);
  const remaining = useRemaining(coding.deadline, view.serverNow);
  const dirty = useRef(false);
  const lastRun = coding.runs[coding.runs.length - 1];

  // Autosave every 10 seconds when anything changed, so a reconnect or the deadline's
  // auto-submission uses the latest work. The interval is created once: the latest values and
  // the (per-render) mutation object are read through a ref, otherwise the 1-second countdown
  // re-render would restart the timer before it ever fired.
  const latest = useRef({ language, code, explanation, save: actions.saveCode.mutate });
  latest.current = { language, code, explanation, save: actions.saveCode.mutate };
  useEffect(() => {
    const t = window.setInterval(() => {
      if (!dirty.current) return;
      dirty.current = false;
      const { language: l, code: c, explanation: e, save } = latest.current;
      save({ language: l, code: c, explanation: e });
    }, INTERVIEW_LIMITS.codeAutosaveMs);
    return () => window.clearInterval(t);
  }, []);

  function switchLanguage(next: CodeLanguage) {
    const pristine = code === task.starterCode[language];
    setLanguage(next);
    if (pristine) {
      setCode(task.starterCode[next]);
      setResetToken((t) => t + 1);
    }
    dirty.current = true;
  }

  const error = [actions.runCode.error, actions.submitCode.error].find(
    (e) => e instanceof ApiError,
  ) as ApiError | undefined;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-ink">Coding task</h1>
        <span
          className="font-mono text-lg tabular-nums text-ink"
          aria-label="Time left for the coding task"
        >
          {formatClock(remaining)}
        </span>
      </div>
      <div className="grid gap-5 lg:grid-cols-[1fr_14rem]">
        <Card as="section" aria-labelledby="task-heading">
          <CardHeader
            title={<span id="task-heading">{task.title}</span>}
            description={task.selectionReason}
            action={<Badge tone="info">{CODING_TASK_KIND_LABELS[task.kind]}</Badge>}
          />
          <p className="text-ink">{task.prompt}</p>
          <p className="mt-2 text-sm text-ink-muted">
            Function: <code>{task.functionName[language]}</code>. {task.visibleTests.length} visible
            tests; {task.hiddenTestCount} hidden checks run after you submit.
          </p>
          <table className="mt-3 w-full text-left text-sm">
            <caption className="sr-only">Visible tests</caption>
            <thead>
              <tr className="text-ink-muted">
                <th scope="col" className="py-1 pr-3 font-medium">
                  Test
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  Arguments
                </th>
                <th scope="col" className="py-1 font-medium">
                  Expected
                </th>
              </tr>
            </thead>
            <tbody>
              {task.visibleTests.map((t) => (
                <tr key={t.name} className="border-t border-line align-top">
                  <td className="py-1.5 pr-3">{t.name}</td>
                  <td className="py-1.5 pr-3 font-mono text-xs break-all">{t.input}</td>
                  <td className="py-1.5 font-mono text-xs break-all">{t.expected}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Card as="section" aria-label="Your camera" className="self-start">
          <CameraSelfView resume compact />
        </Card>
      </div>

      {!coding.execution.available ? (
        <Alert tone="caution" title="Test runs are unavailable">
          {coding.execution.message}
        </Alert>
      ) : null}

      <Card as="section" aria-labelledby="editor-heading" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 id="editor-heading" className="text-base font-semibold text-ink">
            Your solution
          </h2>
          <SelectField
            label="Language"
            value={language}
            onChange={(e) => switchLanguage(e.target.value as CodeLanguage)}
          >
            {CODE_LANGUAGES.map((l) => (
              <option key={l} value={l}>
                {CODE_LANGUAGE_LABELS[l]}
              </option>
            ))}
          </SelectField>
        </div>
        <CodeEditor
          label={`Code editor (${CODE_LANGUAGE_LABELS[language]})`}
          value={code}
          resetToken={resetToken}
          language={language}
          onChange={(v) => {
            setCode(v);
            dirty.current = true;
          }}
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="secondary"
            icon={<Play className="size-4" aria-hidden="true" />}
            disabled={
              !coding.execution.available ||
              coding.runsRemaining === 0 ||
              code.length > INTERVIEW_LIMITS.codeMaxChars
            }
            loading={actions.runCode.isPending}
            onClick={() => actions.runCode.mutate({ language, code })}
          >
            Run visible tests
          </Button>
          <span className="text-sm text-ink-muted">{coding.runsRemaining} runs left</span>
        </div>
        {lastRun ? (
          <section
            aria-label="Test results"
            aria-live="polite"
            className="rounded-lg bg-surface-sunk p-4"
          >
            <p className="text-sm font-medium text-ink">
              {lastRun.status === 'completed'
                ? `${lastRun.passed} of ${lastRun.total} visible tests passed`
                : lastRun.status === 'compile_error'
                  ? 'The code did not compile'
                  : lastRun.status === 'timeout'
                    ? 'Time limit exceeded'
                    : 'The program stopped with an error'}
            </p>
            <ul className="mt-2 flex flex-col gap-1 text-sm">
              {lastRun.results.map((r) => (
                <li key={r.name} className="flex items-start gap-2">
                  {r.outcome === 'passed' ? (
                    <CheckCircle2
                      className="mt-0.5 size-4 shrink-0 text-success"
                      aria-hidden="true"
                    />
                  ) : (
                    <XCircle className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
                  )}
                  <span>
                    {r.name}: {r.outcome}
                    {r.outcome !== 'passed' && r.actual !== null ? (
                      <span className="block font-mono text-xs text-ink-muted">got {r.actual}</span>
                    ) : null}
                    {r.message ? (
                      <span className="block text-xs text-ink-muted">{r.message}</span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
            {lastRun.diagnostics ? (
              <pre className="mt-2 max-h-40 overflow-auto text-xs text-ink-muted">
                {lastRun.diagnostics}
              </pre>
            ) : null}
          </section>
        ) : null}
        <TextAreaField
          label="Explain your approach (shared with the founder)"
          value={explanation}
          maxLength={INTERVIEW_LIMITS.explanationMaxChars}
          counter={`${explanation.length}/${INTERVIEW_LIMITS.explanationMaxChars}`}
          onChange={(e) => {
            setExplanation(e.target.value);
            dirty.current = true;
          }}
        />
        {error ? (
          <Alert tone="danger" title="Something went wrong" live>
            {error.message}
          </Alert>
        ) : null}
        {confirm ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm text-ink">
              Submit now? You cannot change your solution afterwards.
            </span>
            <Button
              icon={<Send className="size-4" aria-hidden="true" />}
              loading={actions.submitCode.isPending}
              onClick={() => actions.submitCode.mutate({ language, code, explanation })}
            >
              Submit solution
            </Button>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              Keep working
            </Button>
          </div>
        ) : (
          <Button className="self-start" onClick={() => setConfirm(true)}>
            Submit solution and finish
          </Button>
        )}
      </Card>
    </div>
  );
}
