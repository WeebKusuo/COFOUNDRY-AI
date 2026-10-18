# Phase 08 — Live voice-based adaptive AI interview

Date: 18 October 2026. See [PHASE_07_README](PHASE_07_README.md) for the shared context and
[INTERVIEWS.md](../architecture/INTERVIEWS.md),
[AI_PROVIDER_ARCHITECTURE.md](../architecture/AI_PROVIDER_ARCHITECTURE.md) for the design.

## Interview room (`/candidate/interviews/:id/room`)

- **AI interviewer visualizer**: an animated orb driven by the live audio level (TTS output while
  speaking, microphone while listening), with a text status — "AI interviewer is speaking",
  "Listening to your answer", "AI interviewer is thinking", "Your turn". No video avatar; reduced
  motion respected.
- Current question (always shown as text, spoken via TTS, "Repeat question"), question type and
  intent badges, "Question n of up to 10", answered count, a server-synchronised countdown,
  online/offline banner ("Your progress is saved on the server…"), accessible transcript
  (`aria-live`), "Finish conversation" with confirmation, and a seamless switch to the coding
  round. A "take over" screen when another window holds the session.
- Audio is unlocked by an explicit "Enter the interview room" click (autoplay policies).

## Spoken introduction and TTS

The fixed introduction ("Hello! I'm your AI interviewer. I'll be conducting your initial
technical interview based on your resume, projects and technical experience. We'll also
complete a short practical coding assessment.") is turn 0. Questions are spoken through
`GET /interviews/:id/turns/:n/speech` (WAV from Piper in the speech service; cached briefly in
memory), voice check `GET /interviews/:id/voice-test`. When TTS is unavailable the room says so
and shows text only.

## Adaptive questioning (explicit state machine, no LangGraph)

1. At start, `resume_context` structures the redacted resume (skills, projects with claimed
   contributions, experience, achievements); every item must quote the resume verbatim or is
   dropped.
2. After each answer, the server computes a **policy** and `interview_turn` must follow it
   (`checkTurnPolicy` validates; violations are retried, then reported as a failed generation):
   - coverage plan for new topics: background → resume project → fundamentals → resume project
     → architecture → problem solving → scenario → …;
   - intent required by the reading of the last answer: strong → go deeper (implementation
     detail for resume projects), partial → focused follow-up, vague → ask for a concrete
     example, incorrect → check understanding **once**, unclear audio → clarify **once**;
   - follow-up depth ≤ 2, then a new topic; skipped answers move on; covered topics are not
     reopened; prompts too similar to any earlier one (token Jaccard ≥ 0.75) are rejected;
     difficulty moves at most one step; new resume-project topics must quote the resume;
   - at most 10 questions and 20 minutes; the model may end only after 6 answers with
     background, resume project, fundamentals and architecture covered.
3. Each question stores type, topic, intent, difficulty, parent (follow-up chain), resume quote,
   hidden expected concepts (for the evaluator only) and model/prompt metadata; the steering
   signal is stored on the answer it describes.

Generation runs in the background under a token and a lease derived from the configured AI
timeout and retry budget (the client polls every 1.5 s). Provider failures are retried with backoff; a final failure shows "The next question
could not be prepared" with Retry — never an invented question. An expired lease (crash) becomes
a retryable failure.

## Speech-to-text

The browser records each answer with MediaRecorder (microphone only), stopping on "Done
answering", after 8 s of silence once speech was heard, or at 3 minutes. The raw audio is posted
to `POST /interviews/:id/turns/:n/audio` (audio/webm|ogg|wav|mp4|mpeg, ≤ 4 MiB, 15/min, at most 3
recordings per question), forwarded in memory to the speech service and **never stored**.
faster-whisper decodes English with VAD and `condition_on_previous_text=False`; the backend
(`analyseTranscript`) drops silent or repetitive (hallucinated) segments as `[unclear audio]`,
marks low-confidence words, and computes a confidence level. "No speech detected" never yields
words. The candidate edits the transcript before submitting; the original, the edit share and
the confidence are stored with the answer and shown in the report. Typed answers are always
available (and the only mode without transcription consent). Answers are bound to the exact turn
index; closed or future turns return 409 `QUESTION_CLOSED`.

HTTP was chosen over WebSocket: answers are recorded and transcribed as one clip (Whisper is
not a streaming recogniser), so streaming would add complexity without lowering latency.

## Speech service (`services/speech`)

Python 3.9+ stdlib HTTP server, bearer token (constant-time, ≥ 32 chars), loopback by default,
bounded bodies, one decode at a time with a small queue, metadata-only logs.
`faster-whisper==1.2.1`, `av<16` (PyAV 16 broke faster-whisper's decoder — found while
verifying), `piper-tts==1.8.0` run as `python -m piper -m <voice> -f -`. See its README.

## Tests

- `interviews.conversation.test.ts` (21): follow-up intents for strong/vague/incorrect answers,
  depth limit, single understanding check, skip → new topic, coverage order, no repeated prompts,
  steering-signal alignment; budget of 10 questions → coding; answer/turn alignment and
  `QUESTION_CLOSED`; finish early; conversation deadline on reconnect; global deadline
  auto-submit; failing interviewer → retryable state, retries counted, recovery; policy
  violations rejected; interrupted lease; interviewer inputs contain no email/phone/links/
  name/ids/brief problem; resume injection flagged; transcription with unclear and uncertain
  segments, voice answer with edits; silence never invents words; recording limits, formats and
  service failure; typed-only without consent; TTS for intro and voice check, no audio stored;
  TTS failure reported.
- `ai/contracts.test.ts` (policy unit tests), `ai/openai-compatible.test.ts` (Groq adapter over
  HTTP against a local stub), `ai/registry-invoke.test.ts` (consent, retries, backoff,
  Retry-After, timeouts, cancellation, metadata-only logs), `speech.test.ts` (speech client),
  `services/speech/tests` (8, Python), web `interviews.test.tsx` (room: typed answer to the right
  turn, takeover), E2E (fake microphone → MediaRecorder upload → transcript → follow-up).

## Live verification and blockers

- **Verified live:** Piper TTS through the real speech service, called from the backend client:
  a 7.8 s WAV of the introduction synthesised on CPU in 4.3 s (old-format `en-us-lessac-medium`
  voice from Piper's GitHub release, used for this local check only; the recommended voice is
  `en_US-ljspeech-medium`). faster-whisper audio decoding and Silero VAD ran live.
- **Not verified live:** Whisper transcription (model weights are hosted on Hugging Face, which
  is unreachable here; the service reports `stt.ready=false` honestly) and Groq (unreachable, no
  key). Both paths are covered by tests against stubs/doubles only.
