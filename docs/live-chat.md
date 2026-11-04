# Live chat

Hands-free voice conversation in the **Live** tab (Alt+8): press **Start** and talk. When you stop, Echo answers
out loud, then listens again. The conversation is kept per session, so follow-ups work ("and how many people live
there?"). Measured: **median 1.44 s from the end of your speech to the first sound of the answer** (thinking off,
0.5 s pause; table in [benchmarks.md](benchmarks.md#live-tab-voice-turns-2026-11-04)).

## Pipeline

```
browser: mic ─► AudioWorklet ─► end-of-speech detection ─┬─ speech starts ─► POST /api/live/prime   (wake the model,
                                                         │                                            cache the history)
                                                         ├─ 200 ms silence ─► POST /api/live/stt     (transcribe early)
                                                         └─ 500 ms silence ─► POST /api/live/turn    ({text}, or the WAV)
server (live.ts):  text ─► main model, streamed (spoken-style system prompt + session history)
                        ─► Chunker: first chunk may end at a clause break, then sentence ends
                        ─► Piper per chunk ─► SSE `audio` events, in order, as each is ready
browser: decode ─► schedule gapless ─► play; listen again 300 ms after the last chunk ends
```

## Why it is built this way

- **Echo's own speech to text** (`services/stt`, faster-whisper `base.en` int8, 8 CPU threads, model kept loaded).
  Hugin's service took ~9.5 s per request; base.en takes ~0.35 s for a short question. small.en was 2.5x slower
  with the same words on clear speech; 16 threads were slower than 8. It stays on the CPU: the GPU is full.
- **The pause is the biggest cost, so the work hides inside it.** Echo waits 0.5 s of silence (0.4 and 0.7 s in
  the tab) to be sure you have finished. At 200 ms it already sends the utterance for transcription, so when the
  pause is confirmed the turn carries text, not audio. If you speak again, the early text is dropped.
- **Wake the model while you talk.** A GPU idle between turns drops its clocks, and another client (an agent run)
  may have pushed this conversation out of the model's cache. The moment you start speaking, `/prime` runs the
  conversation so far through the model for one token: the first word then comes in ~0.45 s instead of 0.8-1 s.
- **Speak early.** The first chunk may end at a comma once it has four words ("I don't have access to your
  location,"), later chunks at sentence ends, which sound more natural. Piper voices a sentence in ~50-150 ms.
- **Thinking off by default.** With thinking low the answers were a little richer but the first sound came ~1.5-7 s
  later; both answered five test questions correctly. The tab has an off/low toggle.
- **Half-duplex.** Echo does not listen while it thinks or talks (and 300 ms after): no hearing itself, no
  barge-in. **Interrupt** stops it at once.
- **Raw PCM, 16 kHz WAV.** The browser downsamples itself; the service reads such WAVs without decoding.
- **Sessions in memory** (`session` query parameter, last 20 exchanges, dropped after 2 h idle). Ephemeral, like a
  phone call; **New conversation** clears it.

## API (`/api/live`, live.ts)

| Endpoint | |
| --- | --- |
| `POST /turn?session&effort&voice` | body: WAV, or JSON `{text}`. SSE: `stt {text, ms}`, `delta {text}`, `audio {seq, text, wav}` (base64), `done {text, timings}`, `error {message}` |
| `POST /stt` | body: WAV → `{text, ms, audio_s}` |
| `POST /prime?session` · `POST /warm?voice` | wake the model (and load the voice) |
| `POST /reset?session` · `GET /config` | forget a conversation · the tab's defaults (echo.yaml `live`) |

`timings` (ms from the moment the request arrived): `stt`, `firstToken`, `tts` (first chunk), `firstAudio`,
`llm`, `total`.

## Testing without a microphone

Headless Edge plays a WAV file as the microphone: `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream
--use-file-for-fake-audio-capture=questions.wav%noloop`. Put a few seconds of silence after each question, longer
than the answer takes to speak, or the next question starts while Echo is still talking and is missed.

## Not yet

Portuguese (base.en is English-only; `base`/`small` are multilingual and slower), barge-in while Echo talks,
streaming speech to text while you speak, and Pocket TTS voices (natural but ~2 s per sentence).
