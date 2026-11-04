# Live chat

Hands-free voice conversation: open the Live tab, press **Start**, speak. Echo transcribes the
utterance, answers with the main model, and speaks the answer out loud sentence by sentence. The
conversation is kept per session, so follow-ups work ("what about tomorrow?").

Target: **under 1.5 s from the end of your speech to the first audio of the answer**, on this
machine (RTX 4090, 16 CPU threads).

## Pipeline

```
mic (browser) ──► VAD ──► POST /api/live/turn (WAV, multipart)
                                   │
                       ┌───────────┴───────────┐
                       │ STT (Hugin stt service)│  http://stt:8089 in Docker,
                       │ distil-large-v3 int8   │  http://127.0.0.1:8089 on the host
                       └───────────┬───────────┘
                                   ▼ text
                  main model (streamChat, effort off, per-session history)
                                   ▼ tokens
                  sentence splitter (., !, ?, long clauses)
                                   ▼ per sentence
                  TTS (Piper, ~17× real time on CPU) → WAV
                                   ▼
                  SSE: audio events (base64 WAV) + transcript deltas → browser plays them
```

Half-duplex: Echo listens only when it is not speaking (and vice versa). Simpler than duplex
and matches how people talk to assistants.

## Why these choices

- **STT: reuse Hugin's existing `stt` service** (faster-whisper, `distil-large-v3` int8, CPU,
  `POST /transcribe` multipart → `{text, segments}`). It is already part of the running stack and
  costs nothing new. No new Python service, no new model download. If measured latency is too slow
  for the 1.5 s budget, the fallback is a small dedicated faster-whisper service (e.g.
  `base.en`/`small.en` int8, 5–20× real time on CPU) following the TTS service pattern —
  `stt_url` in `echo.yaml` keeps the switch to one line.
- **Portuguese:** `distil-large-v3` is multilingual (a distillation of `large-v3`), so PT is
  possible *if* the Hugin endpoint accepts a language hint or auto-detects; it is configured
  English-only for Hugin's use. Live chat starts English-first; PT is noted as a follow-up.
- **Client capture: raw PCM, not MediaRecorder blobs.** An `AudioContext` at 16 kHz feeds a
  worklet/script processor that buffers 16-bit mono samples and computes an RMS level.
  MediaRecorder's webm/opus would also decode fine on the server (faster-whisper uses PyAV/FFmpeg),
  but raw PCM is deterministic, tiny (32 KB/s), and needed anyway for VAD.
- **VAD: RMS energy with a hangover.** Speech ends after ~700 ms of silence below threshold;
  minimum utterance ~400 ms, maximum 20 s. Threshold adapts to the noise floor at Start. No
  server-side VAD needed: one utterance per request.
- **TTS per sentence with Piper.** Piper synthesizes a sentence in well under a second; the first
  sentence can start playing while the model is still generating the rest. Sentences stream as
  SSE `audio` events (base64 WAV); the browser plays them in order from a queue.
- **Reasoning effort off** for Live answers (short spoken answers do not need thinking; effort
  low/medium adds ~1 s+ before the first token).
- **Per-session conversation** lives in server memory (a `Map<sessionId, messages[]>`), so
  follow-ups work and each tab/session has its own thread. Cleared by a "New session" button or
  server restart. No DB: this is ephemeral, like a phone call.

## Protocol

`POST /api/live/turn` — multipart: `file` (WAV 16 kHz mono), fields `sessionId`, `voice`, `speed`.
Responds with SSE:

| event    | data                                   | meaning                          |
| -------- | -------------------------------------- | -------------------------------- |
| `stt`    | `{ text }`                             | transcription arrived            |
| `delta`  | `{ text }`                             | answer text as it streams        |
| `audio`  | `{ seq, b64, rate }`                   | one sentence's WAV (16 kHz)      |
| `error`  | `{ message }`                          | stage failed (stt/llm/tts)       |
| `done`   | `{ text, sessionId, timings }`         | turn finished; timings in ms     |

`timings`: `{ stt, firstToken, firstAudio, total }` — end-to-end breakdown shown in the UI and
used for the benchmarks below.

Server keeps `sessionId → messages[]` (system prompt + history, capped to the last ~20 turns to
keep the cached prefix small). The system prompt forces short plain spoken answers:
1–3 short sentences, no markdown, lists, code or stage directions.

## Latency budget (this machine)

| Stage                          | Expected              | Notes                                   |
| ------------------------------ | --------------------- | --------------------------------------- |
| upload (WAV, localhost)        | ~50 ms                | 5 s of speech = 160 KB                  |
| STT (distil-large-v3 int8 CPU) | 0.5–1.5 s for 5 s     | measured in `benchmarks.md`             |
| time to first token            | 0.4–0.7 s             | effort off, warm prefix cache           |
| first sentence (10 tokens)     | ~0.15 s               | 60–80 tok/s decode                      |
| first sentence TTS (Piper)     | ~0.2 s                | ~17× real time                          |
| **total**                      | **~1.5 s**            | STT is the risk; see fallback above     |

The first turn after a long idle pays the GPU clock-up (~1.5 s TTFT); subsequent turns in a
conversation stay fast because the prompt prefix is byte-identical and cached.

## UI (Live tab)

- **Start / Stop** (toggles the whole session), **New session** (clears history).
- Status line: *listening … / thinking … / speaking …* with the current utterance.
- Transcript panel: user lines and Echo's answers as they arrive, plus the per-turn timing
  breakdown (stt / first token / first audio).
- Voice picker reuses the shared voices (default: the chat voice; Piper voices preferred for
  speed — the server speaks at the Piper speed, Pocket TTS voices play back at their rate).
- While Echo speaks, the mic input is muted and any arriving audio is dropped.
