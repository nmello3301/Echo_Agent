"""The PyTorch text-to-speech models (Qwen3-TTS 0.6B and VoxCPM2) in their own process, driven by server.py: one JSON
request per line on stdin, one JSON reply per line on stdout. It runs in services/tts-torch/.venv: qwen-tts pins its
own transformers, and both pull in heavy extras that the main TTS venv (Piper, Pocket TTS, Kokoro) does without.

{"op": "tts", "engine", "voice", "text"}  ->  {"wav": "<base64 16-bit WAV>"}
{"op": "prepare", "engine", "voice"}      ->  {}   reads a cloned voice's sample now, so a bad one fails when cloned
{"op": "forget", "engine", "voice"}       ->  {}   a deleted clone
Errors: {"error": "...", "bad": true when the request was at fault}.

Engines: "qwen3" (voices "qwen3:<speaker>" and "clone:<id>") and "voxcpm" ("clone:<id>" only). A clone is <id>.wav
and <id>.json (its words in "transcript") in --clones-dir. Each model loads on its first request and stays loaded
until the other engine is used: both together held 11 GB. server.py stops the whole worker when it sits unused.
"""

import argparse
import base64
import gc
import io
import json
import os
import subprocess
import sys
import time
import wave
from collections import OrderedDict
from pathlib import Path

# Replies go to the real stdout; whatever the libraries print goes to stderr, which is the TTS engine's log
replies = os.fdopen(os.dup(1), "w", buffering=1)
os.dup2(2, 1)
sys.stdout = sys.stderr
os.environ.setdefault("TQDM_DISABLE", "1")  # VoxCPM draws a progress bar per sentence into the engine log

import numpy as np  # noqa: E402
import torch  # noqa: E402

p = argparse.ArgumentParser()
p.add_argument("--models-dir", required=True, help="models/tts")
p.add_argument("--clones-dir", required=True)
# Measured on a Ryzen 7 8700F: Qwen3-TTS is as fast on 4 threads as on 8 (it is bound by its many small steps) and
# slower on 16; VoxCPM2 is bigger and uses 8
p.add_argument("--threads", type=int, default=0, help="CPU threads (default: 4 for Qwen3-TTS, 8 for VoxCPM2)")
args = p.parse_args()
models_dir, clones_dir = Path(args.models_dir), Path(args.clones_dir)


def bf16_cpu() -> bool:
    """bfloat16 halves Qwen3-TTS's time on CPUs with bfloat16 instructions (0.41x vs 0.19x real time on Zen 4) and
    is much slower than float32 on the rest."""
    try:
        flags = Path("/proc/cpuinfo").read_text()
    except OSError:
        return False
    return "avx512_bf16" in flags or "amx_bf16" in flags


def gpu_free_mib() -> int:
    """Free GPU memory, 0 without a usable GPU. Asks nvidia-smi: asking torch starts a CUDA context, which then holds
    memory of its own for as long as this process lives."""
    if not torch.cuda.is_available():
        return 0
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=memory.free", "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=10).stdout
        return int(out.split()[0])
    except (OSError, subprocess.SubprocessError, ValueError, IndexError):
        return 0


def choose_device(engine) -> str:
    """The GPU when the model fits there. Beside the 27B it doesn't, and a full card stalls both, so it runs on the CPU."""
    engine.device = "cuda" if gpu_free_mib() >= engine.gpu_mib else "cpu"
    return engine.device


def release_memory() -> None:
    gc.collect()
    if torch.cuda.is_initialized():
        torch.cuda.empty_cache()


MAX_PROMPTS = 8  # cloned voices kept read, most recently used last


class Bad(Exception):
    pass


def sample(voice: str) -> tuple[Path, str]:
    """A cloned voice's recording and its words."""
    vid = voice.split(":", 1)[1]
    meta = clones_dir / f"{vid}.json"
    if not meta.exists() or "/" in vid:
        raise Bad(f"unknown voice {voice}")
    return clones_dir / f"{vid}.wav", json.loads(meta.read_text()).get("transcript", "")


def loaded(what: str, t0: float) -> None:
    print(f"tts worker: {what} loaded in {time.perf_counter() - t0:.1f} s", flush=True)


class Prompts(OrderedDict):
    """Cloned voices already read by the model (reading a sample takes a second or more)."""

    def get_or(self, voice: str, make):
        if voice not in self:
            self[voice] = make()
            while len(self) > MAX_PROMPTS:
                self.popitem(last=False)
        self.move_to_end(voice)
        return self[voice]


class Qwen3:
    """Qwen3-TTS 0.6B: the CustomVoice model speaks the preset speakers, the Base model clones."""

    threads = 4
    gpu_mib = 4500  # free GPU memory to run there; one model peaked at +3.8 GB
    device = "cpu"

    def __init__(self):
        self.models: dict = {}
        self.prompts = Prompts()

    def loaded(self) -> bool:
        return bool(self.models)

    def unload(self) -> None:
        self.models.clear()
        self.prompts.clear()

    def model(self, kind: str):
        if kind not in self.models:
            from qwen_tts import Qwen3TTSModel

            t0 = time.perf_counter()
            on_gpu = choose_device(self) == "cuda"
            dtype = torch.bfloat16 if on_gpu or bf16_cpu() else torch.float32
            self.models[kind] = Qwen3TTSModel.from_pretrained(str(models_dir / "qwen3-tts" / kind), device_map="cuda:0" if on_gpu else "cpu", dtype=dtype)
            loaded(f"Qwen3-TTS {kind} ({self.device})", t0)
        return self.models[kind]

    def prompt(self, voice: str):
        def make():
            wav, words = sample(voice)
            # Without the words only the speaker's timbre is copied (x-vector), which sounds less like them
            return self.model("base").create_voice_clone_prompt(ref_audio=str(wav), ref_text=words or None, x_vector_only_mode=not words)

        return self.prompts.get_or(voice, make)

    def tts(self, voice: str, text: str):
        kind, _, name = voice.partition(":")
        if kind == "clone":
            wavs, rate = self.model("base").generate_voice_clone(text=text, language="Auto", voice_clone_prompt=self.prompt(voice))
        elif kind == "qwen3":
            wavs, rate = self.model("custom-voice").generate_custom_voice(text=text, language="Auto", speaker=name)
        else:
            raise Bad(f"unknown voice {voice}")
        return wavs[0], rate


class VoxCPM:
    """VoxCPM2: no preset voices, every voice is cloned from a sample. With the sample's words it copies the voice
    more closely ("hi-fi" cloning); without them it still clones from the sound alone. Its weights are bfloat16."""

    threads = 8
    gpu_mib = 7500  # peaked at +6.9 GB
    device = "cpu"

    def __init__(self):
        self.m = None
        self.prompts = Prompts()

    def loaded(self) -> bool:
        return self.m is not None

    def unload(self) -> None:
        self.m = None
        self.prompts.clear()

    def model(self):
        if self.m is None:
            from voxcpm import VoxCPM as Model

            t0 = time.perf_counter()
            # no denoiser (an extra model from ModelScope, and it changes the voice)
            self.m = Model.from_pretrained(str(models_dir / "voxcpm"), load_denoiser=False, optimize=False, device=choose_device(self))
            loaded(f"VoxCPM2 ({self.device})", t0)
        return self.m

    def prompt(self, voice: str):
        def make():
            wav, words = sample(voice)
            if not wav.exists():
                raise Bad(f"unknown voice {voice}")
            # The sample encoded once (VoxCPM.generate() would encode it again for every sentence)
            return self.model().tts_model.build_prompt_cache(
                reference_wav_path=str(wav), **({"prompt_wav_path": str(wav), "prompt_text": words} if words else {}))

        return self.prompts.get_or(voice, make)

    def tts(self, voice: str, text: str):
        if not voice.startswith("clone:"):
            raise Bad(f"unknown voice {voice}: VoxCPM only speaks cloned voices")
        tts = self.model().tts_model
        # As VoxCPM.generate(): retry_badcase reruns a sentence whose audio came out far too long for its text
        wav, _, _ = tts.generate_with_prompt_cache(target_text=" ".join(text.split()), prompt_cache=self.prompt(voice), max_len=4096,
                                                   inference_timesteps=10, cfg_value=2.0, retry_badcase=True)
        return wav.squeeze(0).float().cpu().numpy(), tts.sample_rate


def wav_b64(audio, rate: int) -> str:
    if isinstance(audio, torch.Tensor):
        audio = audio.detach().float().cpu().numpy()
    pcm = (np.clip(np.asarray(audio, dtype=np.float32).reshape(-1), -1, 1) * 32767).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(int(rate))
        w.writeframes(pcm.tobytes())
    return base64.b64encode(buf.getvalue()).decode()


def main() -> None:
    engines = {"qwen3": Qwen3(), "voxcpm": VoxCPM()}
    print("tts worker: ready", flush=True)
    for line in sys.stdin:
        try:
            req = json.loads(line)
            op, voice = req.get("op"), str(req.get("voice", ""))
            engine = engines.get(str(req.get("engine")))
            if not engine:
                raise Bad(f"unknown engine {req.get('engine')}")
            if op != "forget":
                # One engine's models in memory at a time
                for other in engines.values():
                    if other is not engine and other.loaded():
                        other.unload()
                        release_memory()
                # On the CPU because the GPU was full, and it no longer is (the 27B was unloaded, say): load it again
                if engine.loaded() and engine.device == "cpu" and gpu_free_mib() >= engine.gpu_mib:
                    engine.unload()
                    release_memory()
            torch.set_num_threads(args.threads or engine.threads)
            if op == "tts":
                t0 = time.perf_counter()
                with torch.inference_mode():
                    audio, rate = engine.tts(voice, str(req.get("text", "")))
                out = {"wav": wav_b64(audio, rate)}
                seconds = len(np.asarray(audio).reshape(-1)) / rate
                print(f"tts worker: {seconds:.1f} s of speech in {time.perf_counter() - t0:.1f} s", flush=True)
            elif op == "prepare":
                with torch.inference_mode():
                    engine.prompt(voice)
                out = {}
            elif op == "forget":
                engine.prompts.pop(voice, None)
                out = {}
            else:
                raise Bad(f"unknown op {op}")
        except Bad as e:
            out = {"error": str(e), "bad": True}
        except Exception as e:  # the model's own errors: keep serving
            out = {"error": f"{type(e).__name__}: {e}"}
        replies.write(json.dumps(out) + "\n")


main()
