# CoFoundry speech service

Internal HTTP service used only by the Express API: **faster-whisper** speech-to-text (MIT;
Whisper weights MIT) and **Piper** text-to-speech (GPL-3.0, invoked as a separate process with
`python -m piper`, never imported). Python 3.9+, CPU is enough.

From the repository root, `npm run speech:setup` does all of the following (virtualenv, pinned
packages, the `en_US-ljspeech-medium` voice, the Whisper model, and the `.env` settings) and
`npm run speech:dev` starts the service with the `.env` values (`npm run dev` runs it too). Options:
`npm run speech:setup -- --voice <piper-voice> --model <whisper-model> --skip-models --no-env`.

Manual equivalent:

```bash
cd services/speech
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m piper.download_voices en_US-ljspeech-medium --data-dir models
SPEECH_SERVICE_TOKEN=$(openssl rand -hex 24) \
PIPER_VOICE=models/en_US-ljspeech-medium.onnx \
.venv/bin/python -m cofoundry_speech
```

| Variable                | Default            | Meaning                                                                                   |
| ----------------------- | ------------------ | ----------------------------------------------------------------------------------------- |
| `SPEECH_SERVICE_TOKEN`  | (required)         | Bearer token, ≥ 32 characters; same value as the API's                                    |
| `SPEECH_HOST`/`PORT`    | 127.0.0.1/8765     | Bind address (keep it on loopback or a private network)                                   |
| `WHISPER_MODEL`         | `small.en`         | Model name (downloaded from Hugging Face on first start) or a local CTranslate2 directory |
| `WHISPER_DEVICE`        | `cpu`              | `cpu` or `cuda`                                                                           |
| `WHISPER_COMPUTE_TYPE`  | `int8`             | CTranslate2 compute type                                                                  |
| `WHISPER_DOWNLOAD_ROOT` | (cache)            | Where models are stored                                                                   |
| `WHISPER_MAX_SECONDS`   | 185                | Longest accepted recording                                                                |
| `PIPER_VOICE`           | (required for TTS) | Path to `<voice>.onnx` (its `.onnx.json` beside it)                                       |

API: `GET /healthz`, `POST /v1/transcribe` (raw `audio/webm|ogg|wav|mp4|mpeg` ≤ 4 MiB,
`X-Language: en`), `POST /v1/synthesize` (`{"text"}` ≤ 1,000 chars → `audio/wav`). Audio and text
are processed in memory and never written or logged (only method, path, status, duration).

Decoding avoids invented words: Silero VAD removes silence, `condition_on_previous_text=False`
prevents repetition loops, and per-segment `avgLogprob`, `noSpeechProb` and `compressionRatio`
are returned so the API marks unclear audio as `[unclear audio]` and uncertain words for the
candidate to correct.

Voice licences differ per voice: check each voice's `MODEL_CARD`. `en_US-ljspeech-*` is trained
on the public-domain LJ Speech dataset; `lessac` voices use a dataset with its own restrictive
licence.

Notes verified while building (18 October 2026): faster-whisper 1.2.1 fails with PyAV 16+
(`metadata_errors` was removed), hence `av<16`; Piper must be called with `-f -`, otherwise it
plays audio through `ffplay` or writes `output.wav` into the working directory.

Tests (no models needed): `python3 -m unittest discover -s tests -t .` or `npm run test:speech`.
