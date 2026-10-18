"""Speech service tests with stub engines (no models needed). Run: python -m unittest discover -s tests"""

import http.client
import json
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

from cofoundry_speech.engines import AudioRejected, EngineUnavailable, PiperEngine, Segment, Transcript
from cofoundry_speech.server import SpeechApp, make_handler

TOKEN = "t" * 40


class FakeStt:
    model_name = "fake-whisper"

    def __init__(self):
        self.calls = []
        self.fail = None

    def ready(self):
        return True

    def transcribe(self, audio, language):
        self.calls.append((len(audio), language))
        if self.fail:
            raise self.fail
        return Transcript("hello world", "en", 0.99, 1.5, [Segment(0.0, 1.5, " hello world", -0.2, 0.01, 1.1)], "fake-whisper")


class FakeTts:
    voice_name = "fake-voice"

    def ready(self):
        return True

    def synthesize(self, text):
        return b"RIFF" + text.encode()


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.stt = FakeStt()
        cls.app = SpeechApp(TOKEN, cls.stt, FakeTts(), max_queue=2)
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(cls.app))
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def request(self, method, path, body=None, headers=None, token=TOKEN):
        req = urllib.request.Request(self.base + path, data=body, method=method)
        if token:
            req.add_header("Authorization", f"Bearer {token}")
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req) as res:
                return res.status, res.headers.get("Content-Type"), res.read()
        except urllib.error.HTTPError as err:
            return err.code, err.headers.get("Content-Type"), err.read()

    def test_requires_the_bearer_token(self):
        self.assertEqual(self.request("GET", "/healthz", token=None)[0], 401)
        self.assertEqual(self.request("GET", "/healthz", token="x" * 40)[0], 401)

    def test_health(self):
        status, _, body = self.request("GET", "/healthz")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["stt"], {"ready": True, "model": "fake-whisper"})

    def test_transcribe_returns_segments_with_confidence_fields(self):
        status, ctype, body = self.request("POST", "/v1/transcribe", b"\x1aE\xdf\xa3audio", {"Content-Type": "audio/webm;codecs=opus", "X-Language": "en"})
        self.assertEqual(status, 200)
        self.assertEqual(ctype, "application/json")
        data = json.loads(body)
        self.assertEqual(data["segments"][0], {"start": 0.0, "end": 1.5, "text": " hello world", "avgLogprob": -0.2, "noSpeechProb": 0.01, "compressionRatio": 1.1})
        self.assertEqual(set(data), {"text", "language", "languageProbability", "durationSec", "segments", "model"})

    def test_rejects_bad_audio_requests(self):
        self.assertEqual(self.request("POST", "/v1/transcribe", b"x", {"Content-Type": "video/webm"})[0], 415)
        self.assertEqual(self.request("POST", "/v1/transcribe", b"x", {"Content-Type": "audio/wav", "X-Language": "fr"})[0], 422)
        # Oversized bodies are refused from the Content-Length header, before any byte is read.
        conn = http.client.HTTPConnection("127.0.0.1", self.httpd.server_address[1])
        conn.putrequest("POST", "/v1/transcribe")
        conn.putheader("Authorization", f"Bearer {TOKEN}")
        conn.putheader("Content-Type", "audio/wav")
        conn.putheader("Content-Length", str(4 * 1024 * 1024 + 1))
        conn.endheaders()
        self.assertEqual(conn.getresponse().status, 413)
        conn.close()

    def test_engine_errors_map_to_status_codes(self):
        self.stt.fail = AudioRejected("audio could not be decoded")
        self.assertEqual(self.request("POST", "/v1/transcribe", b"x", {"Content-Type": "audio/wav"})[0], 422)
        self.stt.fail = EngineUnavailable("no model")
        self.assertEqual(self.request("POST", "/v1/transcribe", b"x", {"Content-Type": "audio/wav"})[0], 503)
        self.stt.fail = None

    def test_synthesize(self):
        status, ctype, body = self.request("POST", "/v1/synthesize", json.dumps({"text": "Hi there"}).encode(), {"Content-Type": "application/json"})
        self.assertEqual((status, ctype), (200, "audio/wav"))
        self.assertTrue(body.startswith(b"RIFF"))
        self.assertEqual(self.request("POST", "/v1/synthesize", json.dumps({"text": "x" * 1001}).encode(), {"Content-Type": "application/json"})[0], 422)
        self.assertEqual(self.request("POST", "/v1/synthesize", b"not json", {"Content-Type": "application/json"})[0], 422)

    def test_rejects_short_tokens_at_startup(self):
        with self.assertRaises(ValueError):
            SpeechApp("short", FakeStt(), FakeTts())


class PiperEngineTest(unittest.TestCase):
    def test_reports_missing_voice_as_unavailable(self):
        engine = PiperEngine("/nonexistent/voice.onnx")
        self.assertFalse(engine.ready())
        with self.assertRaises(EngineUnavailable):
            engine.synthesize("hello")


if __name__ == "__main__":
    unittest.main()
