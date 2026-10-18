"""Speech engines: faster-whisper (speech-to-text) and Piper (text-to-speech).

Both are free and open source:
  * faster-whisper (MIT) with OpenAI Whisper weights (MIT), run locally with CTranslate2.
  * Piper (piper-tts, GPL-3.0) is invoked as a SEPARATE PROCESS (``python -m piper``) and never
    imported, so this service only exchanges text and WAV bytes with it.

Audio is processed in memory only; nothing is written to disk.
"""

from __future__ import annotations

import io
import os
import subprocess
import sys
import threading
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Protocol


class EngineUnavailable(Exception):
    """The model is not loaded or cannot run (reported as HTTP 503)."""


class AudioRejected(Exception):
    """The audio cannot be decoded or is too long (reported as HTTP 422)."""


@dataclass
class Segment:
    start: float
    end: float
    text: str
    avg_logprob: float
    no_speech_prob: float
    compression_ratio: float


@dataclass
class Transcript:
    text: str
    language: str
    language_probability: float
    duration_sec: float
    segments: List[Segment]
    model: str

    def to_json(self) -> Dict[str, Any]:
        return {
            "text": self.text,
            "language": self.language,
            "languageProbability": round(float(self.language_probability), 4),
            "durationSec": round(float(self.duration_sec), 3),
            "segments": [
                {
                    "start": round(float(s.start), 3),
                    "end": round(float(s.end), 3),
                    "text": s.text,
                    "avgLogprob": round(float(s.avg_logprob), 4),
                    "noSpeechProb": round(float(s.no_speech_prob), 4),
                    "compressionRatio": round(float(s.compression_ratio), 4),
                }
                for s in self.segments
            ],
            "model": self.model,
        }


class SpeechToText(Protocol):
    model_name: Optional[str]

    def ready(self) -> bool: ...

    def transcribe(self, audio: bytes, language: str) -> Transcript: ...


class TextToSpeech(Protocol):
    voice_name: Optional[str]

    def ready(self) -> bool: ...

    def synthesize(self, text: str) -> bytes: ...


class WhisperEngine:
    """faster-whisper with conservative decoding so unclear audio is not "filled in".

    * vad_filter: Silero VAD (bundled with faster-whisper) removes silence before decoding.
    * condition_on_previous_text=False: avoids the repetition loops Whisper is known for.
    * Segments keep avg_logprob / no_speech_prob / compression_ratio so the backend can mark
      unclear or uncertain stretches instead of trusting them.
    """

    def __init__(self, model: str, device: str, compute_type: str, download_root: Optional[str], max_seconds: float):
        self.model_name: Optional[str] = model
        self._max_seconds = max_seconds
        self._lock = threading.Lock()
        self._model = None
        self._error: Optional[str] = None
        try:
            from faster_whisper import WhisperModel  # type: ignore

            self._model = WhisperModel(model, device=device, compute_type=compute_type, download_root=download_root)
        except Exception as exc:  # noqa: BLE001 - reported through /healthz
            self._error = type(exc).__name__

    def ready(self) -> bool:
        return self._model is not None

    def transcribe(self, audio: bytes, language: str) -> Transcript:
        if self._model is None:
            raise EngineUnavailable(self._error or "model not loaded")
        from faster_whisper.audio import decode_audio  # type: ignore

        try:
            samples = decode_audio(io.BytesIO(audio))
        except Exception as exc:  # noqa: BLE001
            raise AudioRejected("audio could not be decoded") from exc
        duration = len(samples) / 16000.0
        if duration > self._max_seconds:
            raise AudioRejected("audio too long")
        with self._lock:  # one decode at a time per process (CPU bound)
            segments, info = self._model.transcribe(
                samples,
                language=language,
                beam_size=5,
                vad_filter=True,
                vad_parameters={"min_silence_duration_ms": 500},
                condition_on_previous_text=False,
                temperature=[0.0, 0.2, 0.4],
            )
            out = [
                Segment(s.start, s.end, s.text, s.avg_logprob, s.no_speech_prob, s.compression_ratio)
                for s in segments
            ]
        return Transcript(
            text="".join(s.text for s in out).strip(),
            language=info.language,
            language_probability=info.language_probability,
            duration_sec=duration,
            segments=out,
            model=self.model_name or "unknown",
        )


class PiperEngine:
    """Runs ``python -m piper -m <voice.onnx> -f -`` per request: text on stdin, WAV on stdout.

    ``-f -`` is required: without it piper plays audio through ffplay or writes output.wav into
    the working directory.
    """

    def __init__(self, voice_path: str, timeout_sec: float = 30.0):
        self.voice_name: Optional[str] = os.path.basename(voice_path).removesuffix(".onnx") if voice_path else None
        self._voice_path = voice_path
        self._timeout = timeout_sec

    def ready(self) -> bool:
        return bool(self._voice_path) and os.path.isfile(self._voice_path) and os.path.isfile(self._voice_path + ".json")

    def synthesize(self, text: str) -> bytes:
        if not self.ready():
            raise EngineUnavailable("voice model missing")
        line = " ".join(text.split())  # one line: piper synthesises each input line
        try:
            proc = subprocess.run(
                [sys.executable, "-m", "piper", "-m", self._voice_path, "-f", "-"],
                input=line.encode("utf-8"),
                capture_output=True,
                timeout=self._timeout,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise EngineUnavailable("synthesis timed out") from exc
        if proc.returncode != 0 or not proc.stdout.startswith(b"RIFF"):
            raise EngineUnavailable("synthesis failed")
        return proc.stdout
