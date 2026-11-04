"""Echo's speech-to-text service for the Live tab: faster-whisper on the CPU, the model loaded once and kept.

POST /transcribe   body: the audio (16 kHz mono 16-bit WAV is fastest; anything FFmpeg reads works)
                   ->  {"text": "...", "ms": 210, "audio_s": 2.4}
GET  /health       ->  {"status": "ok", "model": "base.en", "threads": 8}

Tuned for short utterances: English only, greedy decoding (beam 1), no timestamps, no fallback temperatures. The
browser has already cut the utterance at the end of speech, so no VAD here either.
Weights download on first use into --models-dir (base.en ~145 MB, small.en ~480 MB).

Setup (once): python -m venv services/stt/.venv && services/stt/.venv/bin/pip install -r services/stt/requirements.txt
"""

import argparse
import io
import json
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock

import numpy as np
from faster_whisper import WhisperModel

p = argparse.ArgumentParser()
p.add_argument("--port", type=int, default=8096)
p.add_argument("--model", default="base.en", help="faster-whisper model: base.en, small.en, ...")
p.add_argument("--models-dir", required=True, help="where the weights download to")
p.add_argument("--threads", type=int, default=8)
args = p.parse_args()

t0 = time.perf_counter()
model = WhisperModel(args.model, device="cpu", compute_type="int8", cpu_threads=args.threads, download_root=args.models_dir)
lock = Lock()  # one transcription at a time: they share the CPU threads anyway


def pcm16(data: bytes):
    """A 16-bit PCM WAV as 16 kHz mono float32, read directly; None for anything else (FFmpeg decodes those)."""
    try:
        with wave.open(io.BytesIO(data)) as w:
            if w.getsampwidth() != 2:
                return None
            channels, rate, frames = w.getnchannels(), w.getframerate(), w.readframes(w.getnframes())
    except (wave.Error, EOFError):
        return None
    a = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768
    if channels > 1:
        a = a.reshape(-1, channels).mean(axis=1)
    if rate != 16000:  # linear resampling is plenty for speech recognition
        n = int(len(a) * 16000 / rate)
        a = np.interp(np.linspace(0, len(a) - 1, n), np.arange(len(a)), a).astype(np.float32)
    return a


def transcribe(data: bytes) -> dict:
    t = time.perf_counter()
    audio = pcm16(data)
    with lock:
        segments, info = model.transcribe(
            audio if audio is not None else io.BytesIO(data), language="en", beam_size=1, best_of=1, temperature=0.0,
            condition_on_previous_text=False, without_timestamps=True, vad_filter=False,
        )
        text = " ".join(s.text.strip() for s in segments).strip()
    return {"text": text, "ms": round((time.perf_counter() - t) * 1000), "audio_s": round(info.duration, 2)}


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
            self._json(200, {"status": "ok", "model": args.model, "threads": args.threads})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self) -> None:
        if self.path != "/transcribe":
            return self._json(404, {"error": "not found"})
        data = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        if not data:
            return self._json(400, {"error": "no audio"})
        try:
            self._json(200, transcribe(data))
        except Exception as e:
            self._json(500, {"error": str(e)})

    def log_message(self, *a) -> None:  # keep Echo's engine log quiet
        pass


# warm up: the first transcription initialises the CPU kernels (~1 s); do it now, not on the user's first turn
model.transcribe(np.zeros(16000, dtype=np.float32), language="en", beam_size=1, without_timestamps=True)
print(f"stt: {args.model} on {args.threads} CPU threads, ready in {time.perf_counter() - t0:.1f} s, listening on 127.0.0.1:{args.port}", flush=True)
ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
