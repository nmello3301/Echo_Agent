"""Echo's text-to-speech service: six models behind one API.

- Piper: fast (~17x real time on CPU). Each voice is an .onnx file in --voices-dir, downloaded on first use (60-120 MB).
- Kyutai Pocket TTS: more natural, slower (2 CPU cores), and it clones a voice from a short sample. Its model
  (~220 MB) downloads and loads on first use. Cloning needs the weights at https://huggingface.co/kyutai/pocket-tts,
  which are free but gated: accept the terms there and give this service an HF_TOKEN.
- Kokoro 82M (ONNX): natural preset voices in several languages, fast on the CPU. Downloaded on the Models tab.
- Qwen3-TTS 0.6B and VoxCPM2: larger PyTorch models that clone a voice from a few seconds of speech (Qwen3-TTS also
  has preset speakers). They run in a worker process with its own venv (worker.py, services/tts-torch/.venv), started
  on first use: qwen-tts pins its own transformers, and both pull in heavy extras. Downloaded on the Models tab.
- Qwen3-TTS Fast: Qwen3-TTS's files, voices and clones run through faster-qwen3-tts (CUDA graphs), on the GPU only.

POST   /tts          {"text": "...", "speed": 1.0, "voice": "piper:en_US-lessac-medium"}  ->  audio/wav
GET    /voices                                     ->  {"voices": [...], "models": [...], "default": "<id>"}
POST   /voices       {"name", "audio": "<base64 16-bit PCM WAV>", "engine", "transcript"}  ->  the cloned voice
DELETE /voices/<id>                                ->  {"ok": true}
GET    /health                                     ->  {"status": "ok"}

Voice ids: "piper:<voice>", "pocket:<voice>", "kokoro:<voice>", "qwen3:<speaker>", "clone:<id>", and "fast:" before a
Qwen3-TTS voice's id for the same voice in Qwen3-TTS Fast. `speed` changes Piper and Kokoro voices; for the others the
UI sets the playback rate.
Cloned voices live in --clones-dir: <id>.json (name, engine, transcript), <id>.wav (the sample) and, for Pocket TTS,
<id>.safetensors (the voice state). Clones made before there were several engines are Pocket TTS ones.

Setup (once): python -m venv services/tts/.venv && services/tts/.venv/bin/pip install -r services/tts/requirements.txt
"""

import argparse
import base64
import ctypes
import io
import json
import re
import secrets
import signal
import subprocess
import sys
import time
import wave
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock, Thread
from urllib.parse import unquote

import numpy as np
from piper import PiperVoice, SynthesisConfig

MAX_CHARS = 20_000
SAMPLE_MIN_S, SAMPLE_MAX_S = 3, 60
ROOT = Path(__file__).resolve().parents[2]

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
p.add_argument("--voices-dir", required=True, help="models/tts: Piper voices (.onnx with its .onnx.json), and the Models tab's downloads")
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


# ---------- Kokoro 82M (ONNX, in this process) ----------
KOKORO_DIR = voices_dir / "kokoro"
KOKORO_FILES = ("kokoro-v1.0.onnx", "voices-v1.0.bin")
# The first letter of a Kokoro voice is its language: espeak-ng's code, and how the UI shows it. Japanese and
# Chinese voices are left out: they need their own phonemizers, which kokoro-onnx doesn't bundle.
KOKORO_LANGS = {"a": ("en-us", "US"), "b": ("en-gb", "UK"), "e": ("es", "Spanish"), "f": ("fr-fr", "French"),
                "h": ("hi", "Hindi"), "i": ("it", "Italian"), "p": ("pt-br", "Portuguese")}
# Listed first: the voices Kokoro's authors grade best (VOICES.md: A, A-, B-, B-)
KOKORO_BEST = ["af_heart", "af_bella", "af_nicole", "bf_emma"]
kokoro_model = None
# Kokoro loads and runs on this one thread: a session run from another thread than the one that created it took
# twice as long (3.3 s instead of 1.7 s for 7 s of speech, 2026-11-05). It also keeps requests one at a time.
kokoro_thread = ThreadPoolExecutor(max_workers=1, thread_name_prefix="kokoro")


def kokoro_installed() -> bool:
    return all((KOKORO_DIR / f).exists() for f in KOKORO_FILES)


def kokoro():
    """The model (only on kokoro_thread)."""
    global kokoro_model
    if kokoro_model is None:
        if not kokoro_installed():
            raise BadRequest("Kokoro isn't downloaded yet: download it on the Models tab")
        import onnxruntime as ort
        from kokoro_onnx import Kokoro

        t0 = time.time()
        # 8 threads: 4.2x real time on the 8700F, against 3.2x with ONNX Runtime's default (2026-11-05)
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = 8
        session = ort.InferenceSession(str(KOKORO_DIR / KOKORO_FILES[0]), opts, providers=["CPUExecutionProvider"])
        kokoro_model = Kokoro.from_session(session, str(KOKORO_DIR / KOKORO_FILES[1]))
        print(f"tts: Kokoro loaded in {time.time() - t0:.1f} s", flush=True)
    return kokoro_model


def kokoro_voices() -> list[dict]:
    if not kokoro_installed():
        return []
    best = {v: i for i, v in enumerate(KOKORO_BEST)}
    names = sorted(kokoro_thread.submit(lambda: kokoro().get_voices()).result(), key=lambda v: (best.get(v, len(best)), v))
    out = []
    for v in names:
        lang = KOKORO_LANGS.get(v[:1])
        if lang and v[1:2] in ("f", "m") and v[2:3] == "_":
            out.append({"id": f"kokoro:{v}", "name": v[3:].replace("_", " ").title(), "engine": "kokoro", "speed": True,
                        "accent": f"{lang[1]} {'♀' if v[1] == 'f' else '♂'}"})
    return out


def kokoro_tts(name: str, text: str, speed: float) -> bytes:
    lang = KOKORO_LANGS.get(name[:1])
    if not lang:
        raise BadRequest(f"unknown voice kokoro:{name}")

    def run():
        model = kokoro()
        if name not in model.get_voices():
            raise BadRequest(f"unknown voice kokoro:{name}")
        return model.create(text, voice=name, speed=max(0.5, min(2.0, speed)), lang=lang[0])

    audio, rate = kokoro_thread.submit(run).result()
    return wav_bytes(np.asarray(audio, dtype=np.float32), rate)


def wav_bytes(audio, rate: int) -> bytes:
    """Float samples in [-1, 1] as a 16-bit mono WAV."""
    pcm = (np.clip(audio, -1, 1) * 32767).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


# ---------- Qwen3-TTS and VoxCPM2: the worker process ----------
def die_with_parent() -> None:
    # PR_SET_PDEATHSIG: no orphaned models. Linux sends it when the *thread* that started the child ends, so the worker
    # is started and driven from worker_thread, which lives as long as the service (request threads do not).
    ctypes.CDLL("libc.so.6", use_errno=True).prctl(1, signal.SIGTERM)


worker_thread = ThreadPoolExecutor(max_workers=1, thread_name_prefix="tts-worker")


TORCH_ENGINES = ("qwen3", "qwen3fast", "voxcpm")
FAST = "fast:"  # Qwen3-TTS Fast speaks Qwen3-TTS's voices: "fast:qwen3:Ryan", "fast:clone:<id>"


class Worker:
    """The PyTorch models' process (worker.py in services/tts-torch/.venv), started on first use; each model loads on
    its first request. One request at a time: a JSON line in on stdin, a JSON line back on stdout. It holds several GB
    of RAM (VoxCPM2 ~6 GB), so it stops after IDLE_S without a request; the next one starts it again (~10 s)."""

    venv = ROOT / "services" / "tts-torch"
    IDLE_S = 600

    def __init__(self):
        self.proc: subprocess.Popen | None = None
        self.last = 0.0
        Thread(target=self._watch, daemon=True).start()

    def running(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def call(self, req: dict) -> dict:
        return worker_thread.submit(self._call, req).result()

    def _watch(self) -> None:
        while True:
            time.sleep(60)
            worker_thread.submit(self._stop_if_idle)  # on worker_thread: never in the middle of a request

    def _stop_if_idle(self) -> None:
        if self.running() and time.monotonic() - self.last > self.IDLE_S:
            print(f"tts: stopping the PyTorch worker ({self.IDLE_S // 60} min unused, frees its memory)", flush=True)
            assert self.proc and self.proc.stdin
            self.proc.stdin.close()  # it exits at the end of its input
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
            self.proc = None

    def _call(self, req: dict) -> dict:
        self.last = time.monotonic()
        if not self.running():
            python = self.venv / ".venv" / "bin" / "python"
            if not python.exists():
                raise BadRequest("Qwen3-TTS and VoxCPM need their Python environment (services/tts-torch/.venv): rebuild "
                                 "Echo's image, or natively: python3 -m venv services/tts-torch/.venv && "
                                 "services/tts-torch/.venv/bin/pip install -r services/tts-torch/requirements.txt")
            print("tts: starting the PyTorch worker (Qwen3-TTS, VoxCPM) ...", flush=True)
            self.proc = subprocess.Popen(
                [str(python), str(Path(__file__).with_name("worker.py")), "--models-dir", str(voices_dir), "--clones-dir", str(clones_dir)],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, preexec_fn=die_with_parent)
        assert self.proc.stdin and self.proc.stdout
        self.proc.stdin.write(json.dumps(req) + "\n")
        self.proc.stdin.flush()
        line = self.proc.stdout.readline()
        if not line:
            self.proc = None
            raise RuntimeError("the PyTorch TTS worker stopped (see the TTS engine's log)")
        res = json.loads(line)
        if "error" in res:
            raise (BadRequest if res.get("bad") else RuntimeError)(res["error"])
        return res

    def tts(self, engine: str, voice: str, text: str) -> bytes:
        return base64.b64decode(self.call({"op": "tts", "engine": engine, "voice": voice, "text": text})["wav"])


worker = Worker()

QWEN3_DIR = voices_dir / "qwen3-tts"
VOXCPM_DIR = voices_dir / "voxcpm"


def dir_installed(d: Path) -> bool:
    """A downloaded Hugging Face folder: has its weights, and no file is still half-downloaded."""
    return d.is_dir() and any(d.glob("*.safetensors")) and not any(d.rglob("*.part"))


def qwen3_installed() -> bool:
    return all(dir_installed(QWEN3_DIR / sub) for sub in ("custom-voice", "base"))


def voxcpm_installed() -> bool:
    return dir_installed(VOXCPM_DIR)


# ---------- cloned voices ----------
def clone_id(s: str) -> str:
    if not re.fullmatch(r"[a-z0-9-]{1,64}", s):
        raise BadRequest(f"bad voice id {s!r}")
    return s


def clone_meta(vid: str) -> dict:
    f = clones_dir / f"{clone_id(vid)}.json"
    if not f.exists():
        raise BadRequest(f"unknown voice clone:{vid}")
    meta = json.loads(f.read_text())
    meta.setdefault("engine", "pocket")  # clones from before there were several engines
    return meta


def fast(v: dict) -> dict:
    """A Qwen3-TTS voice as Qwen3-TTS Fast lists it"""
    return {**v, "id": FAST + v["id"], "engine": "qwen3fast"}


def clones() -> list[dict]:
    out = []
    for f in sorted(clones_dir.glob("*.json")):
        meta = clone_meta(f.stem)
        made = (clones_dir / f"{f.stem}.safetensors" if meta["engine"] == "pocket" else clones_dir / f"{f.stem}.wav").exists()
        if made:
            out.append({"id": f"clone:{f.stem}", "name": meta["name"], "engine": meta["engine"], "clone": True,
                        "speed": False, "created": meta.get("created")})
    return out


def read_sample(audio_b64: str) -> tuple[bytes, float]:
    try:
        wav = base64.b64decode(audio_b64, validate=True)
        with wave.open(io.BytesIO(wav)) as w:
            return wav, w.getnframes() / w.getframerate()
    except Exception:
        raise BadRequest("the sample should be a WAV file")


def new_clone_id(name: str) -> str:
    return f"{re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')[:40] or 'voice'}-{secrets.token_hex(3)}"


def clone(name: str, audio_b64: str, engine: str = "pocket", transcript: str = "") -> dict:
    if engine in TORCH_ENGINES:
        return clone_with_worker(name, audio_b64, engine, transcript)
    if engine != "pocket":
        raise BadRequest(f"{MODELS.get(engine, {}).get('name', engine)} can't clone voices")
    return clone_pocket(name, audio_b64)


def clone_with_worker(name: str, audio_b64: str, engine: str, transcript: str) -> dict:
    """Qwen3-TTS and VoxCPM read the sample itself each time they speak (cached in the worker): keep the WAV and its
    words, and let the worker try it once now so a bad sample fails here rather than at the first use."""
    name = " ".join(name.split())[:40]
    if not name:
        raise BadRequest("give the voice a name")
    if not (voxcpm_installed() if engine == "voxcpm" else qwen3_installed()):
        raise BadRequest(f"{MODELS[engine]['name']} isn't downloaded yet: download it on the Models tab")
    wav, seconds = read_sample(audio_b64)
    lo, hi = MODELS[engine]["sample"]["min"], MODELS[engine]["sample"]["max"]
    if not lo <= seconds <= hi + 1:
        raise BadRequest(f"the sample is {seconds:.1f} s long: use {lo}-{hi} s of speech")
    vid = new_clone_id(name)
    files = [clones_dir / f"{vid}.{ext}" for ext in ("wav", "json")]
    try:
        files[0].write_bytes(wav)
        # A clone made in Qwen3-TTS Fast is a Qwen3-TTS voice: both models list and speak it
        files[1].write_text(json.dumps({"name": name, "engine": "qwen3" if engine == "qwen3fast" else engine,
                                        "transcript": " ".join(transcript.split()), "created": time.strftime("%Y-%m-%dT%H:%M:%S")}))
        worker.call({"op": "prepare", "engine": engine, "voice": f"clone:{vid}"})
    except Exception:
        for f in files:
            f.unlink(missing_ok=True)
        raise
    print(f"tts: cloned voice {vid} with {engine} from {seconds:.1f} s of audio", flush=True)
    made = next(v for v in clones() if v["id"] == f"clone:{vid}")
    return fast(made) if engine == "qwen3fast" else made


def clone_pocket(name: str, audio_b64: str) -> dict:
    name = " ".join(name.split())[:40]
    if not name:
        raise BadRequest("give the voice a name")
    wav, seconds = read_sample(audio_b64)
    if not SAMPLE_MIN_S <= seconds <= SAMPLE_MAX_S:
        raise BadRequest(f"the sample is {seconds:.1f} s long: use {SAMPLE_MIN_S}-{SAMPLE_MAX_S} s of speech")

    with pocket_lock:
        model = pocket()
        if not model.has_voice_cloning:
            raise BadRequest(NO_CLONING)
        from pocket_tts import export_model_state

        vid = new_clone_id(name)
        files = [clones_dir / f"{vid}.{ext}" for ext in ("wav", "safetensors", "json")]
        try:
            files[0].write_bytes(wav)
            state = model.get_state_for_audio_prompt(files[0], truncate=True)
            export_model_state(state, files[1])
            files[2].write_text(json.dumps({"name": name, "engine": "pocket", "created": time.strftime("%Y-%m-%dT%H:%M:%S")}))
        except Exception:
            for f in files:
                f.unlink(missing_ok=True)
            raise
        pocket_states[f"clone:{vid}"] = state
    print(f"tts: cloned voice {vid} from {seconds:.1f} s of audio", flush=True)
    return next(v for v in clones() if v["id"] == f"clone:{vid}")


def delete_clone(vid: str) -> None:
    engine = clone_meta(vid)["engine"]
    with pocket_lock:
        for ext in ("json", "safetensors", "wav"):
            (clones_dir / f"{vid}.{ext}").unlink(missing_ok=True)
        pocket_states.pop(f"clone:{vid}", None)
    if engine in TORCH_ENGINES and worker.running():
        for e in ("qwen3", "qwen3fast") if engine == "qwen3" else (engine,):
            worker.call({"op": "forget", "engine": e, "voice": f"clone:{vid}"})


# What the UI shows for each model. `pace`: measured on the desktop's CPU (16 threads), 2026-11-05, and its RTX 4090.
# `sample`: the recording to clone from, in seconds (min, max used, ideal range), from each model's own advice.
QWEN3_SAMPLE = {"min": 3, "max": 30, "ideal": [10, 20],
                "tip": "Complete sentences at a normal pace, pauses under 2 s. It copies best when it has the exact words "
                       "(Echo transcribes English ones); over 30 s can make it hang."}
MODELS = {
    "piper": {"name": "Piper", "about": "Plain, clear voices that read long texts quickly.", "pace": "~15x faster than real time",
              "canClone": False},
    "pocket": {"name": "Pocket TTS", "about": "Kyutai's natural-sounding English voices.", "pace": "~2x faster than real time",
               "slow": True, "canClone": True,
               "sample": {"min": 3, "max": 30, "ideal": [10, 15], "tip": "Kyutai's own voices are 10 s clips; only the first 30 s are used."}},
    "kokoro": {"name": "Kokoro", "about": "82M-parameter model with natural voices in English, Spanish, French, Hindi, Italian "
               "and Brazilian Portuguese. No cloning.", "pace": "~4x faster than real time", "canClone": False},
    "qwen3": {"name": "Qwen3-TTS", "about": "Alibaba's 0.6B model: nine preset speakers, and it clones a voice from a few seconds "
              "of speech. 10 languages, Portuguese included.", "pace": "~0.6x on the GPU, ~0.3x on the CPU: 10 s of speech takes 17-30 s",
              "slow": True, "canClone": True, "transcript": True, "sample": QWEN3_SAMPLE},
    "qwen3fast": {"name": "Qwen3-TTS Fast", "about": "Qwen3-TTS with the same voices and clones, run with CUDA graphs "
                  "(faster-qwen3-tts). GPU only: it needs ~4.5 GB free there, so not while the 27B is loaded.",
                  "pace": "~3.5x faster than real time on the 4090; the first sentence after it loads takes ~20 s", "canClone": True, "transcript": True, "sample": QWEN3_SAMPLE},
    "voxcpm": {"name": "VoxCPM2", "about": "OpenBMB's 2B model: copies a voice, accent and tone from a sample, in 30 languages. "
               "Every voice is a cloned one.", "pace": "~1x on the GPU, ~0.2x on the CPU: 10 s of speech takes 10-50 s",
               "slow": True, "canClone": True, "transcript": True,
               "sample": {"min": 5, "max": 30, "ideal": [10, 30],
                          "tip": "At least 5 s; more clean speech copies better. The exact words help (Echo transcribes English "
                                 "ones): wrong words are the main cause of glitches."}},
}
# Qwen3-TTS CustomVoice's speakers (each speaks all 10 languages, best its own)
QWEN3_SPEAKERS = {
    "Ryan": ("Ryan", "English ♂"), "Aiden": ("Aiden", "English ♂"), "Vivian": ("Vivian", "Chinese ♀"),
    "Serena": ("Serena", "Chinese ♀"), "Uncle_Fu": ("Uncle Fu", "Chinese ♂"), "Dylan": ("Dylan", "Beijing ♂"),
    "Eric": ("Eric", "Sichuan ♂"), "Ono_Anna": ("Ono Anna", "Japanese ♀"), "Sohee": ("Sohee", "Korean ♀"),
}


def models() -> list[dict]:
    installed = {"piper": True, "pocket": True, "kokoro": kokoro_installed(), "qwen3": qwen3_installed(), "qwen3fast": qwen3_installed(),
                 "voxcpm": voxcpm_installed()}
    cloning = {"pocket": None if pocket_model is None else pocket_model.has_voice_cloning,
               "qwen3": installed["qwen3"], "qwen3fast": installed["qwen3"], "voxcpm": installed["voxcpm"]}
    return [{"id": k, **m, "installed": installed[k], "cloning": cloning.get(k, False)} for k, m in MODELS.items()]


def voices() -> dict:
    piper = [
        {"id": f"piper:{v}", "name": n, "engine": "piper", "speed": True, "accent": "UK" if v.startswith("en_GB") else "US",
         "installed": (voices_dir / f"{v}.onnx").exists()}
        for v, n in PIPER_VOICES.items()
    ]
    pocket_voices = [{"id": f"pocket:{v}", "name": v.replace("_", " ").title(), "engine": "pocket", "speed": False} for v in POCKET_VOICES]
    qwen3 = [{"id": f"qwen3:{k}", "name": n, "engine": "qwen3", "speed": False, "accent": a} for k, (n, a) in QWEN3_SPEAKERS.items()] \
        if qwen3_installed() else []
    own = clones()
    fast_voices = [fast(v) for v in qwen3 + own if v["engine"] == "qwen3"]
    return {"voices": piper + pocket_voices + kokoro_voices() + qwen3 + own + fast_voices, "models": models(), "default": args.default}


def synthesize(text: str, speed: float, voice: str) -> bytes:
    if voice.startswith(FAST):
        inner = voice[len(FAST):]
        kind, _, name = inner.partition(":")
        if (clone_meta(name)["engine"] if kind == "clone" else kind) != "qwen3":
            raise BadRequest(f"unknown voice {voice}: Qwen3-TTS Fast speaks Qwen3-TTS voices")
        return worker.tts("qwen3fast", inner, text)
    kind, _, name = voice.partition(":")
    if kind == "clone":
        kind = clone_meta(name)["engine"]
    if kind == "piper":
        return piper_tts(name, text, speed)
    if kind == "pocket":
        return pocket_tts(voice, text)
    if kind == "kokoro":
        return kokoro_tts(name, text, speed)
    if kind in TORCH_ENGINES:
        return worker.tts(kind, voice, text)
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
        m = re.fullmatch(r"/voices/(?:fast:)?clone:(.+)", unquote(self.path))
        if not m:
            return self._json(404, {"error": "not found"})
        self._run(lambda: self._delete(m[1]))

    def _clone(self) -> None:
        req = self._body()
        self._json(200, clone(str(req.get("name", "")), str(req.get("audio", "")), str(req.get("engine") or "pocket"),
                              str(req.get("transcript") or "")))

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
