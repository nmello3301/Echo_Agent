# Echo: map for agents working on Echo itself

Echo is a local agent platform: one Node server (Hono; TypeScript run directly by Node, no build step) that serves a
React UI (Vite + Tailwind) and manages engines (llama.cpp `llama-server`) and Python services. It runs in Docker on
Windows: RTX 4090 (24 GB), 16 CPU threads, 31 GB RAM in the container. This file is already in your context in every
run in this folder: never read it with a tool, and use it instead of exploring.

**Context is your scarcest resource.** Never read a whole large file: `agent.ts` (~800 lines), `main.ts` (~570),
`Git.tsx` (~550), `engines.ts` (~420), `Agent.tsx` (~400), `gitview.ts` (~390), `selfdev.ts` (~360) and
`services/tts/server.py` (~550) each fill a large part of it. grep for the function or route first, then read that
range (offset/limit). Put new features in their own files (a route module mounted with `app.route(...)`, like
gitview.ts) rather than growing main.ts.

## Layout

`apps/server/src/`
- `main.ts`: every HTTP route (Hono) and the `/ws` WebSocket; startup and shutdown at the bottom.
- `agent.ts`: agent runs on the Pi coding agent (`AgentRun`): tool gating by rules.md, decision time, timeline events
  (`emit` → bus → `/ws` and `GET /api/agent/runs/:id/events`).
- `engines.ts`: the `Engine` class and one `*Spec()` per process (main model, decision model, notes RAG, TTS, SearXNG,
  Hugin). `get(spec).start()` starts or adopts a process and waits for its health URL.
- `llm.ts`: `streamChat(model, body, onDelta, signal, source)`, OpenAI-compatible streaming to the main model;
  `effortFields(model, effort)` sets reasoning effort.
- `webchat.ts`: Chat's web-search tool loop. `rag.ts`: notes search. `decision.ts`: Jebadiah decision client.
- `config.ts`: echo.yaml and models.yaml (hot-reloaded), `ROOT`, `dockerEnv`, `attach` (dev-instance mode).
- `db.ts` SQLite schema · `bus.ts` event bus · `stats.ts` live speed numbers · `monitor.ts` CPU/GPU/RAM sampler ·
  `rules.ts` rules.md classifier · `git.ts` checkpoints · `downloads.ts` Models tab · `selfdev.ts` self-work.
- `tools/`: agent tools. Shape: `{ name, label, description, parameters: Type.Object(...) (typebox), execute: async
  (id, params) => text("...") }`; throw an Error to report a failure. `index.ts` lists core and deferred groups.

`apps/server/test/server.test.ts`: `node:test` tests; fake HTTP servers on `127.0.0.1:0`, modules imported after
env is set.

`apps/web/src/`
- `main.tsx`: tabs and layout. `api.ts`: `api()` fetch helper, `readSSE()`, the shared WebSocket (`useServerEvent`).
- `components/`: `Chat.tsx` (streams `/api/chat` SSE), `Read.tsx` (OCR, speaks text), `Voices.tsx` (voice picker,
  cloning), `Agent.tsx`, `Decide.tsx`, `Hugin.tsx`, `Models.tsx`, `Monitor.tsx`; `ui.tsx` shared widgets.

`services/`: Python, one venv each (`services/<name>/.venv`).
- `tts/server.py`: TTS on port `tts` (echo.yaml). `POST /tts {text, voice, speed}` → WAV (whole file, not streamed);
  `GET /voices` → voices and models. Piper (fast, ~15x real time on CPU), Pocket TTS (natural, ~2x, clones voices),
  Kokoro 82M (ONNX, ~4x); Qwen3-TTS 0.6B (~0.6x on the GPU, ~0.3x on the CPU) and VoxCPM2 (~1x, ~0.2x; both clone
  voices) run in `tts/worker.py`, on the GPU when they fit (not beside the 27B), a child process with its own venv
  `services/tts-torch/.venv`, stopped after 10 idle minutes. Their model files come
  from the Models tab (`models/tts/<model>/`).
- `decision/server.py` Jebadiah renderer · `pyworkspace/kernel.py` the agent's python tool.

`sdk/`: the Echo SDK (`index.ts`) and CLI (`cli.ts`) that drive agent runs; no dependencies.

`tools/voice-compare.ts`: clones recordings in each TTS model through Echo's API and writes a page to compare them;
no dependencies, runs on the host too.

Speech to text: Echo has none of its own yet. Hugin's STT container answers inside Docker at `http://stt:8089`:
`POST /transcribe` (multipart `file`) → `{text, segments}`; faster-whisper `distil-large-v3` int8 on CPU, English only,
whole files only.

## How things connect

- UI ↔ server: JSON over `fetch`; streams are SSE (`streamSSE` in main.ts, `readSSE` in web/src/api.ts); server-wide
  events go over `/ws` via `publish()` from bus.ts.
- Server → model: `streamChat(activeMain()!.model, { messages, ...effortFields(m, effort), cache_prompt: true }, ...)`.
  The engine serves one request at a time: a new request waits behind a running one (agent runs included).
- A new service is an Engine: add a `*Spec()` and `start*()` beside `ttsSpec()` in engines.ts, start it in main.ts,
  and give it a port key in echo.yaml `ports`.

## Model facts (measured on this machine)

Qwen3.8 27B Q4_K_M on the 4090 with MTP speculative decoding: 60-80 tok/s decode, ~1500-1900 tok/s prompt reading.
Time to first token with effort `off` (no thinking): 0.4-0.7 s for a short prompt, ~1.5 s for the first request after
idle (GPU clocks up), plus ~0.6 s per 1K prompt tokens not already cached. Effort `low` thinks first: the answer starts
~1 s later on a simple question, more on hard ones. llama-server reuses the cached prefix when earlier messages stay
byte-identical and new ones are only appended.
VRAM is ~95% used by the 27B and its 32K context: another GPU model will not fit beside it.

## Verify and run your copy

- `echo_verify`: tsc for server, web and sdk, `node --test`, Python syntax (like `npm run verify`).
- `echo_dev start|restart|logs`: run this copy beside the live Echo, sandboxed, sharing the live model. Its ports are
  echo.yaml's + 1000 (UI 8777, TTS 9095). The user opens it at http://dev.localhost:7777. Restart after server or
  service changes; restart also rebuilds the web UI.
- `echo_dev_request`: call the dev instance. Reports time to headers, first bytes and done, SSE event arrival times and
  audio length; `body_file`/`save_to` move audio between requests (TTS output → STT input).
- bash runs in a sandbox: the working folder is writable, the live install is read-only, and there is no network
  unless rules.md allows the command. Never start servers with bash: it waits for them to exit.
- `node_modules`, `models`, `vendor/llama.cpp` and `services/*/.venv` are links to the live install: never install
  into them. A new npm package: replace the link with a real install (`rm node_modules && npm ci`, then add it). A new
  Python service: its own venv in the copy (`python3 -m venv services/<name>/.venv`).

## Conventions

- Node runs the TypeScript as is: no enums, namespaces or constructor parameter properties; local imports end in `.ts`;
  type-only imports use `import type` or `type`.
- Match the surrounding style. Comments say why, not what. No new dependency unless it clearly pays for itself.
- User-facing text: plain, short English. Document new features in README.md; ideas go in FuturePlans.md.
- Commit each verified step: `git add -A && git commit -m "..."`.
