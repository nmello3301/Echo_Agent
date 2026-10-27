"""Echo's text-to-speech service, with two engines behind one API:

- Piper: fast (~17x real time on CPU). Each voice is an .onnx file in --voices-dir, downloaded on first use (60-120 MB).
- Kyutai Pocket TTS: more natural, slower (2 CPU cores), and it clones a voice from a short sample. Its model
  (~220 MB) downloads and loads on first use. Cloning needs the weights at https://huggingface.co/kyutai/pocket-tts,
  which are free but gated: accept the terms there and give this service an HF_TOKEN.

POST   /tts          {"text": "...", "speed": 1.0, "voice": "piper:en_US-lessac-medium"}  ->  audio/wav
GET    /voices                                     ->  {"voices": [...], "default": "<id>", "cloning": true|false|null}
POST   /voices       {"name": "...", "audio": "<base64 16-bit PCM WAV>"}  ->  the cloned voice
DELETE /voices/<id>                                ->  {"ok": true}
GET    /health                                     ->  {"status": "ok"}

Voice ids: "piper:<voice>", "pocket:<voice>", "clone:<id>". `speed` only changes Piper voices: Pocket TTS has no
speed control, so the UI sets the playback rate for those.
Cloned voices live in --clones-dir: <id>.json (name), <id>.wav (the sample) and <id>.safetensors (the voice state).

Setup (once): python -m venv services/tts/.venv && services/tts/.venv/bin/pip install -r services/tts/requirements.txt
"""

import argparse
import base64
import io
import json
import re
import secrets
import time
import wave
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock
from urllib.parse import unquote

import numpy as np
from piper import PiperVoice, SynthesisConfig

MAX_CHARS = 20_000
SAMPLE_MIN_S, SAMPLE_MAX_S = 3, 60

PIPER_VOICES = {  # a curated set: single speaker, medium or high quality
    "en_US-lessac-medium": "Lessac", "en_US-amy-medium": "Amy", "en_US-ryan-high": "Ryan",
    "en_US-hfc_female-medium": "HFC female", "en_US-hfc_male-medium": "HFC male",
    "en_GB-alba-medium": "Alba", "en_GB-cori-high": "Cori", "en_GB-northern_english_male-medium": "Northern English male",
}
POCKET_VOICES = [  # the English model's pre-made voices (pocket_tts README)
    "alba", "anna", "azelma", "bill_boerst", "caro_davy", "charles", "cosette", "eponine", "eve", "fantine", "george",
    "jane", "jean", "javert", "marius", "mary", "michael", "paul", "peter_yearsley", "stuart_bell", "vera",
]
NO_CLONING = (
    "Voice cloning needs Kyutai's cloning weights, which are free but gated: sign in at "
    "https://huggingface.co/kyutai/pocket-tts and accept the terms, and create a read token at "
    "https://huggingface.co/settings/tokens. Docker: put it in .env as HF_TOKEN=... and run `docker compose up -d`. "
    "Native: run `services/tts/.venv/bin/hf auth login`, then `./echo restart`."
)

p = argparse.ArgumentParser()
p.add_argument("--port", type=int, default=8095)
p.add_argument("--voices-dir", required=True, help="folder for Piper voices (.onnx with its .onnx.json)")
p.add_argument("--clones-dir", required=True, help="folder for cloned voices")
p.add_argument("--default", default="piper:en_US-lessac-medium", help="voice used when a request names none")
args = p.parse_args()

voices_dir = Path(args.voices_dir)
clones_dir = Path(args.clones_dir)
clones_dir.mkdir(parents=True, exist_ok=True)


class BadRequest(Exception):
    pass


# ---------- Piper ----------
piper_voices: dict[str, PiperVoice] = {}
piper_lock = Lock()  # one synthesis at a time: a voice is not shared safely between threads


def piper_voice(name: str) -> PiperVoice:
    if name not in PIPER_VOICES:
        raise BadRequest(f"unknown voice piper:{name}")
    if name not in piper_voices:
        path = voices_dir / f"{name}.onnx"
        if not path.exists():
            from piper.download_voices import download_voice

            print(f"tts: downloading Piper voice {name} ...", flush=True)
            voices_dir.mkdir(parents=True, exist_ok=True)
            download_voice(name, voices_dir)
        piper_voices[name] = PiperVoice.load(str(path))
    return piper_voices[name]


def piper_tts(name: str, text: str, speed: float) -> bytes:
    buf = io.BytesIO()
    # length_scale stretches time: 0.8 = faster speech, 1.25 = slower
    cfg = SynthesisConfig(length_scale=1.0 / max(0.5, min(2.0, speed)))
    with piper_lock:
        voice = piper_voice(name)
        with wave.open(buf, "wb") as w:
            voice.synthesize_wav(text, w, syn_config=cfg)
    return buf.getvalue()


# ---------- Pocket TTS ----------
pocket_model = None
pocket_lock = Lock()  # generation is not thread-safe, and the model loads once
pocket_states: OrderedDict = OrderedDict()  # voice id -> voice state, most recently used last


def pocket():
    """The model, loaded on first use. Without access to the gated weights it loads the one that can't clone."""
    global pocket_model
    if pocket_model is None:
        from pocket_tts import TTSModel

        print("tts: loading Pocket TTS ...", flush=True)
        t0 = time.time()
        pocket_model = TTSModel.load_model()
        print(f"tts: Pocket TTS loaded in {time.time() - t0:.1f} s (voice cloning: {pocket_model.has_voice_cloning})", flush=True)
    return pocket_model


def pocket_state(voice: str):
    if voice not in pocket_states:
        kind, name = voice.split(":", 1)
        if kind == "pocket":
            if name not in POCKET_VOICES:
                raise BadRequest(f"unknown voice {voice}")
            source = name
        else:
            source = clones_dir / f"{clone_id(name)}.safetensors"
            if not source.exists():
                raise BadRequest(f"unknown voice {voice}")
        pocket_states[voice] = pocket().get_state_for_audio_prompt(source)
        while len(pocket_states) > 8:
            pocket_states.popitem(last=False)
    pocket_states.move_to_end(voice)
    return pocket_states[voice]


def pocket_tts(voice: str, text: str) -> bytes:
    with pocket_lock:
        model = pocket()
        audio = model.generate_audio(pocket_state(voice), text)
    pcm = (audio.clamp(-1, 1).numpy() * 32767).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(model.sample_rate)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


# ---------- cloned voices ----------
def clone_id(s: str) -> str:
    if not re.fullmatch(r"[a-z0-9-]{1,64}", s):
        raise BadRequest(f"bad voice id {s!r}")
    return s


def clones() -> list[dict]:
    out = []
    for f in sorted(clones_dir.glob("*.json")):
        meta = json.loads(f.read_text())
        if (clones_dir / f"{f.stem}.safetensors").exists():
            out.append({"id": f"clone:{f.stem}", "name": meta["name"], "kind": "clone", "created": meta.get("created")})
    return out


def clone(name: str, audio_b64: str) -> dict:
    name = " ".join(name.split())[:40]
    if not name:
        raise BadRequest("give the voice a name")
    try:
        wav = base64.b64decode(audio_b64, validate=True)
        with wave.open(io.BytesIO(wav)) as w:
            seconds = w.getnframes() / w.getframerate()
    except Exception:
        raise BadRequest("the sample should be a WAV file")
    if not SAMPLE_MIN_S <= seconds <= SAMPLE_MAX_S:
        raise BadRequest(f"the sample is {seconds:.1f} s long: use {SAMPLE_MIN_S}-{SAMPLE_MAX_S} s of speech")

    with pocket_lock:
        model = pocket()
        if not model.has_voice_cloning:
            raise BadRequest(NO_CLONING)
        from pocket_tts import export_model_state

        vid = f"{re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')[:40] or 'voice'}-{secrets.token_hex(3)}"
        files = [clones_dir / f"{vid}.{ext}" for ext in ("wav", "safetensors", "json")]
        try:
            files[0].write_bytes(wav)
            state = model.get_state_for_audio_prompt(files[0], truncate=True)
            export_model_state(state, files[1])
            files[2].write_text(json.dumps({"name": name, "created": time.strftime("%Y-%m-%dT%H:%M:%S")}))
        except Exception:
            for f in files:
                f.unlink(missing_ok=True)
            raise
        pocket_states[f"clone:{vid}"] = state
    print(f"tts: cloned voice {vid} from {seconds:.1f} s of audio", flush=True)
    return next(v for v in clones() if v["id"] == f"clone:{vid}")


def delete_clone(vid: str) -> None:
    vid = clone_id(vid)
    if not (clones_dir / f"{vid}.json").exists():
        raise BadRequest(f"unknown voice clone:{vid}")
    with pocket_lock:
        for ext in ("json", "safetensors", "wav"):
            (clones_dir / f"{vid}.{ext}").unlink(missing_ok=True)
        pocket_states.pop(f"clone:{vid}", None)


def voices() -> dict:
    piper = [
        {"id": f"piper:{v}", "name": n, "kind": "piper", "accent": "UK" if v.startswith("en_GB") else "US",
         "installed": (voices_dir / f"{v}.onnx").exists()}
        for v, n in PIPER_VOICES.items()
    ]
    pocket_voices = [{"id": f"pocket:{v}", "name": v.replace("_", " ").title(), "kind": "pocket"} for v in POCKET_VOICES]
    cloning = None if pocket_model is None else pocket_model.has_voice_cloning
    return {"voices": piper + pocket_voices + clones(), "default": args.default, "cloning": cloning}


def synthesize(text: str, speed: float, voice: str) -> bytes:
    kind, _, name = voice.partition(":")
    if kind == "piper":
        return piper_tts(name, text, speed)
    if kind in ("pocket", "clone"):
        return pocket_tts(voice, text)
    raise BadRequest(f"unknown voice {voice}")


class Handler(BaseHTTPRequestHandler):
    def _json(self, code: int, obj: dict) -> None:
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> dict:
        return json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")

    def _run(self, fn) -> None:
        """Errors come back as JSON instead of dropping the connection; BadRequest is the caller's mistake."""
        try:
            fn()
        except BadRequest as e:
            self._json(400, {"error": str(e)})
        except Exception as e:
            self._json(500, {"error": str(e)})

    def do_GET(self) -> None:
        if self.path == "/health":
            self._json(200, {"status": "ok"})
        elif self.path == "/voices":
            self._run(lambda: self._json(200, voices()))
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self) -> None:
        if self.path == "/tts":
            self._run(self._tts)
        elif self.path == "/voices":
            self._run(self._clone)
        else:
            self._json(404, {"error": "not found"})

    def do_DELETE(self) -> None:
        m = re.fullmatch(r"/voices/clone:(.+)", unquote(self.path))
        if not m:
            return self._json(404, {"error": "not found"})
        self._run(lambda: self._delete(m[1]))

    def _clone(self) -> None:
        req = self._body()
        self._json(200, clone(str(req.get("name", "")), str(req.get("audio", ""))))

    def _delete(self, vid: str) -> None:
        delete_clone(vid)
        self._json(200, {"ok": True})

    def _tts(self) -> None:
        req = self._body()
        text = str(req.get("text", "")).strip()[:MAX_CHARS]
        if not text:
            raise BadRequest("no text")
        audio = synthesize(text, float(req.get("speed", 1.0)), str(req.get("voice") or args.default))
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(audio)))
        self.end_headers()
        self.wfile.write(audio)

    def log_message(self, *a) -> None:  # keep Echo's engine log quiet
        pass


if args.default.startswith("piper:"):
    piper_voice(args.default.split(":", 1)[1])  # load it now (~5 s) so the first read is quick
print(f"tts: default voice {args.default}, listening on 127.0.0.1:{args.port}", flush=True)
ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
