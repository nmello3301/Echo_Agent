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
server (live.ts):  text ─► Live's model (the tab's pick, else echo.yaml live.model, a 9B swapped in for the 27B), streamed (spoken-style
                        system prompt + session history)
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
| `POST /turn?session&effort&voice&persona&model` | body: WAV, or JSON `{text}`. SSE: `stt {text, ms}`, `delta {text}`, `audio {seq, text, wav}` (base64), `tool {name, model, ms?, ...}`, `done {text, model, timings}`, `error {message}` |
| `POST /stt` | body: WAV → `{text, ms, audio_s}` |
| `POST /prime?session&persona&model` · `POST /warm?voice&persona&model` | wake the model, loading it if another is in (and load the voice) |
| `POST /greet?session&persona` | the persona's greeting when its conversation is new: `{text, wav}` (base64), else `{text: ""}`; it joins the conversation |
| `POST /reset?session` · `GET /config` | forget a conversation · the tab's defaults (echo.yaml `live`) |
| `GET/POST /personas` · `PUT/DELETE /personas/:id` | personas (personas.ts, SQLite table `live_personas`) |

## Personas

A persona is a name, a voice, instructions and settings (thinking off/low, reply length short/medium/long, temperature
or the model's own, speech speed 0.8-1.3x, a greeting, and whether it may call `ask_chat` and `decide`). Its system
prompt is "You are <name>, talking with the user by voice...", then its instructions, then Live's spoken-style rules
under "How to talk:" (the length rule follows its reply length; the helper rule and the tools follow what it may use).
Echo's own prompt, without a persona, is unchanged. Reply length sets `max_tokens` (400, 700 or 1,400, plus 1,100 when
thinking); speech speed is the TTS service's `tempo`, a pitch-keeping stretch with sox (~10 ms a sentence). The tab
keeps one session per persona, so switching back resumes a conversation; with the persona chosen, the thinking switch,
Change voice and the model picker save to it.

`model` (a `models.yaml` main model id) picks the model: the request's, else the persona's (`model`, null to follow
Echo's), else `live.model`, each only if it is downloaded, else whichever main model is loaded (`liveModelId`). The tab
sends Echo's pick from the browser's `localStorage` (`echo.live.model`) or the persona's. Only one main model fits, so a
pick that is not loaded is swapped in by the request; the tab calls `/warm` when the pick or the persona changes while
Live runs, and shows "loading ..." if that takes over 1.5 s.

`timings` (ms from the moment the request arrived): `stt`, `firstToken`, `tts` (first chunk), `firstAudio`,
`llm`, `total`, and `tool` when another model was asked.

## Handing off to the chat or decide model

The voice model gets two tools: `ask_chat {question, web?}` and `decide {question, options?}`. When it calls one,
the turn speaks "Let me think about that." (or "Let me weigh that up.") at once, sends `tool {name, model}`, asks the
other model, sends `tool` again with the result (`ms`, the question, the decide answer or the saved conversation's
id), then a second, thinking-off request turns the result into two or three spoken sentences. If the summary does
not name the model, "I checked the chat/decide model." is spoken after it. Only the question and the spoken summary
stay in the session's history.

- **ask_chat** runs the Chat tab's request (effort medium; `web: true` uses Chat's search loop) and saves the
  question and full answer as a "Live: ..." conversation, so the details are there to read.
- **decide** sends a Decide-tab question to Jebadiah: yes/no (`noul`) or a choice between 2-6 options; it is logged
  with `source: "live"`.
- `/warm` and `/prime` render the same tools, so the cached prompt prefix still matches the turn's.

Measured in text mode (2026-11-04, model idle and warm): decide ~1.3-5 s for the tool, "Let me weigh that up" at
~1.2-3 s, the whole turn 4-10 s; ask_chat (Monty Hall, ~3,000-character answer) 15.8 s for the tool, the summary's
first sound ~1.5 s after it, 21 s in all. A plain question still answers directly (Canberra: 1.5 s).

## Testing without a microphone

Headless Edge plays a WAV file as the microphone: `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream
--use-file-for-fake-audio-capture=questions.wav%noloop`. Put a few seconds of silence after each question, longer
than the answer takes to speak, or the next question starts while Echo is still talking and is missed.

## Not yet

Portuguese (base.en is English-only; `base`/`small` are multilingual and slower), barge-in while Echo talks,
streaming speech to text while you speak, and Pocket TTS voices (natural but ~2 s per sentence).
