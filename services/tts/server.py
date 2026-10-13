"""Echo's text-to-speech service: Piper with one voice, loaded once (loading takes ~5 s, speaking ~17x real time).

POST /tts  {"text": "...", "speed": 1.0}  ->  audio/wav
GET  /health                               ->  {"status": "ok"}

Setup (once): python -m venv services/tts/.venv && services/tts/.venv/bin/pip install -r services/tts/requirements.txt
The voice is downloaded on first start when its file is missing (about 60 MB).
"""

import argparse
import io
import json
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock

from piper import PiperVoice, SynthesisConfig

MAX_CHARS = 20_000

p = argparse.ArgumentParser()
p.add_argument("--port", type=int, default=8095)
p.add_argument("--voice", required=True, help="path to a Piper .onnx voice (its .onnx.json next to it)")
args = p.parse_args()

voice_path = Path(args.voice)
if not voice_path.exists():
    from piper.download_voices import download_voice

    print(f"tts: downloading voice {voice_path.stem} ...", flush=True)
    voice_path.parent.mkdir(parents=True, exist_ok=True)
    download_voice(voice_path.stem, voice_path.parent)
voice = PiperVoice.load(str(voice_path))
lock = Lock()  # one synthesis at a time: the model is not shared safely between threads


def synthesize(text: str, speed: float) -> bytes:
    buf = io.BytesIO()
    # length_scale stretches time: 0.8 = faster speech, 1.25 = slower
    cfg = SynthesisConfig(length_scale=1.0 / max(0.5, min(2.0, speed)))
    with lock, wave.open(buf, "wb") as w:
        voice.synthesize_wav(text, w, syn_config=cfg)
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    def _json(self, code: int, obj: dict) -> None:
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path == "/health":
            self._json(200, {"status": "ok"})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self) -> None:
        if self.path != "/tts":
            return self._json(404, {"error": "not found"})
        try:
            req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            text = str(req.get("text", "")).strip()[:MAX_CHARS]
            if not text:
                return self._json(400, {"error": "no text"})
            audio = synthesize(text, float(req.get("speed", 1.0)))
        except Exception as e:  # report instead of dropping the connection
            return self._json(500, {"error": str(e)})
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(audio)))
        self.end_headers()
        self.wfile.write(audio)

    def log_message(self, *a) -> None:  # keep Echo's engine log quiet
        pass


print(f"tts: voice {args.voice} loaded, listening on 127.0.0.1:{args.port}", flush=True)
ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
