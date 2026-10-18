"""CoFoundry speech service: an internal HTTP API used only by the Express backend.

Endpoints (all require ``Authorization: Bearer <SPEECH_SERVICE_TOKEN>``):
  GET  /healthz          -> {"status": "ok", "stt": {...}, "tts": {...}}
  POST /v1/transcribe    raw audio body (audio/webm|ogg|wav|mp4|mpeg), header X-Language: en
                         -> transcript JSON with per-segment confidence fields
  POST /v1/synthesize    {"text": "..."} -> audio/wav

Security: binds to 127.0.0.1 by default, constant-time token check, bounded bodies, no
redirects, no file writes, nothing about audio or text is logged (only method, path, status and
duration).
"""

from __future__ import annotations

import hmac
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Optional, Tuple

from .engines import AudioRejected, EngineUnavailable, PiperEngine, SpeechToText, TextToSpeech, WhisperEngine

AUDIO_TYPES = {"audio/webm", "audio/ogg", "audio/wav", "audio/x-wav", "audio/mp4", "audio/mpeg"}
MAX_AUDIO_BYTES = 4 * 1024 * 1024
MAX_JSON_BYTES = 16 * 1024
MAX_TEXT_CHARS = 1000


class SpeechApp:
    def __init__(self, token: str, stt: SpeechToText, tts: TextToSpeech, max_queue: int = 4):
        if len(token) < 32:
            raise ValueError("SPEECH_SERVICE_TOKEN must be at least 32 characters")
        self.token = token.encode("utf-8")
        self.stt = stt
        self.tts = tts
        self._slots = threading.BoundedSemaphore(max_queue)

    def authorized(self, header: Optional[str]) -> bool:
        if not header or not header.startswith("Bearer "):
            return False
        return hmac.compare_digest(header[7:].encode("utf-8"), self.token)

    def health(self) -> Tuple[int, str, bytes]:
        body = {
            "status": "ok",
            "stt": {"ready": self.stt.ready(), "model": self.stt.model_name},
            "tts": {"ready": self.tts.ready(), "voice": self.tts.voice_name},
        }
        return 200, "application/json", json.dumps(body).encode()

    def transcribe(self, content_type: str, language: str, body: bytes) -> Tuple[int, str, bytes]:
        if content_type not in AUDIO_TYPES:
            return error(415, "unsupported audio type")
        if language != "en":
            return error(422, "only English is supported")
        if not body:
            return error(422, "empty audio")
        if not self._slots.acquire(blocking=False):
            return error(503, "busy")
        try:
            transcript = self.stt.transcribe(body, language)
        except AudioRejected as exc:
            return error(422, str(exc))
        except EngineUnavailable:
            return error(503, "speech-to-text unavailable")
        finally:
            self._slots.release()
        return 200, "application/json", json.dumps(transcript.to_json()).encode()

    def synthesize(self, body: bytes) -> Tuple[int, str, bytes]:
        try:
            payload: Any = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return error(422, "invalid JSON")
        text = payload.get("text") if isinstance(payload, dict) else None
        if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT_CHARS:
            return error(422, "text must be 1-1000 characters")
        if not self._slots.acquire(blocking=False):
            return error(503, "busy")
        try:
            wav = self.tts.synthesize(text)
        except EngineUnavailable:
            return error(503, "text-to-speech unavailable")
        finally:
            self._slots.release()
        return 200, "audio/wav", wav


def error(status: int, message: str) -> Tuple[int, str, bytes]:
    return status, "application/json", json.dumps({"error": message}).encode()


def make_handler(app: SpeechApp):
    class Handler(BaseHTTPRequestHandler):
        server_version = "cofoundry-speech"
        sys_version = ""

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - stdlib signature
            return  # replaced by the metadata-only log in _send

        def _send(self, status: int, content_type: str, body: bytes, started: float) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            if status >= 400:
                self.send_header("Connection", "close")
                self.close_connection = True
            self.end_headers()
            self.wfile.write(body)
            sys.stderr.write(
                f"{self.command} {self.path.split('?')[0]} {status} {int((time.monotonic() - started) * 1000)}ms\n"
            )

        def _read_body(self, limit: int) -> Optional[bytes]:
            length = self.headers.get("Content-Length")
            if length is None or not length.isdigit():
                return None
            n = int(length)
            if n > limit:
                return None
            return self.rfile.read(n)

        def _authorized(self, started: float) -> bool:
            if app.authorized(self.headers.get("Authorization")):
                return True
            self._send(*error(401, "unauthorized"), started)
            return False

        def do_GET(self) -> None:  # noqa: N802 - stdlib naming
            started = time.monotonic()
            if not self._authorized(started):
                return
            if self.path == "/healthz":
                return self._send(*app.health(), started)
            self._send(*error(404, "not found"), started)

        def do_POST(self) -> None:  # noqa: N802
            started = time.monotonic()
            if not self._authorized(started):
                return
            content_type = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            if self.path == "/v1/transcribe":
                body = self._read_body(MAX_AUDIO_BYTES)
                if body is None:
                    return self._send(*error(413, "audio too large or missing length"), started)
                language = (self.headers.get("X-Language") or "en").strip().lower()
                return self._send(*app.transcribe(content_type, language, body), started)
            if self.path == "/v1/synthesize":
                if content_type != "application/json":
                    return self._send(*error(415, "send JSON"), started)
                body = self._read_body(MAX_JSON_BYTES)
                if body is None:
                    return self._send(*error(413, "body too large"), started)
                return self._send(*app.synthesize(body), started)
            self._send(*error(404, "not found"), started)

    return Handler


def main() -> None:
    token = os.environ.get("SPEECH_SERVICE_TOKEN", "")
    host = os.environ.get("SPEECH_HOST", "127.0.0.1")
    port = int(os.environ.get("SPEECH_PORT", "8765"))
    stt = WhisperEngine(
        model=os.environ.get("WHISPER_MODEL", "small.en"),
        device=os.environ.get("WHISPER_DEVICE", "cpu"),
        compute_type=os.environ.get("WHISPER_COMPUTE_TYPE", "int8"),
        download_root=os.environ.get("WHISPER_DOWNLOAD_ROOT") or None,
        max_seconds=float(os.environ.get("WHISPER_MAX_SECONDS", "185")),
    )
    tts = PiperEngine(os.environ.get("PIPER_VOICE", ""))
    app = SpeechApp(token, stt, tts)
    httpd = ThreadingHTTPServer((host, port), make_handler(app))
    sys.stderr.write(
        f"speech service on {host}:{port} stt_ready={stt.ready()} model={stt.model_name} "
        f"tts_ready={tts.ready()} voice={tts.voice_name}\n"
    )
    httpd.serve_forever()


if __name__ == "__main__":
    main()
