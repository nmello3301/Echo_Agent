# Echo

A local-first agent platform with a web UI that runs entirely on this laptop. Six tabs (Chat, Decide, Agent, Hugin,
Models, Read) and a Monitor panel. The spec is in `Local Agent Platform — Build Prompt v1.md`.

## Run it

**On any Linux or Windows machine with an NVIDIA GPU: Docker.** `./setup.sh` (or `.\setup.ps1`), then
`docker compose up -d --build`. See [docs/docker.md](docs/docker.md).

**Natively on this laptop:**

```
cd ~/Desktop/EchoV1
./echo up        # starts the backend and the models, then opens the UI as an Omarchy web app
```

The UI lives at **http://127.0.0.1:7777**: open it in any browser while Echo is running.

Without a terminal: open the app launcher (Super+Space) and type **Echo**, or use `~/Desktop/Echo.desktop`.
Right-click either one for **Stop Echo**. `Start Echo.sh` and `Stop Echo.sh` in this folder do the same.

```
./echo status    # engines and their state
./echo open      # open the UI again
./echo logs      # follow all logs
./echo down      # stop the UI, the main model and the decision model
./echo restart
```

Keys: Alt+1..6 switch tabs, Alt+M collapses the Monitor.

## Read tab

Paste a screenshot (Ctrl+V, or *Paste from clipboard*) or type in the text box: Echo reads the text with Tesseract
and speaks it with Piper (`services/tts`, voice in `models/tts/`). *Auto summarize + read* speaks a 2-5 sentence
summary from the active main model instead of the full text. Ctrl+Enter in the box reads it.

## Rules: what the agent may do without asking

`rules.md` holds permission switches (`[x]` allowed without asking, `[ ]` ask me first) plus "always ask" and
"never" lists. Echo uses it to decide which commands run, which wait for your approval and which are refused.
The main model reads it at the start of each run, and the decision model sees a summary at every decision time.

## Models tab

One-click downloads of the models Echo uses, straight into the folders `models.yaml` points at. Downloads resume.
Flash-Next also needs the Strata engine compiled, which needs the CUDA toolkit; the tab shows the command and a
Build button.

## Hugin and your notes

Hugin (voice notes, dictation, meetings) runs inside Echo: `./echo up` starts its Docker stack, `./echo down`
stops it. Its settings are in `vendor/HuginVoiceNotes/.env` (generated; API token and UI password); Echo's
additions to its compose file are in `services/hugin/compose.echo.yml`. Notes are written to
`data/hugin/notes/` as Markdown.

Every Markdown note in the folders listed under `notes.dirs` in `echo.yaml` is indexed automatically (new,
edited and deleted notes within seconds). Search is hybrid: keywords (SQLite FTS5) + meaning (embeddings),
fused and reranked; it works across English and Portuguese. Use it from:

- the **Hugin** tab → *My notes* (search, browse, read); *Hugin app* is Hugin's own UI, logged in for you;
- **Chat** with *Use my notes* on: answers from your notes with numbered sources;
- the **agent**: `notes_search` (always loaded), `notes_read` and `notes_list` (via tool_search).

Retrieval eval: `cd apps/server && node ../../evals/rag_eval.ts` (22 questions over 20 synthetic notes).

## Agent tools

Always loaded: `read`, `edit`, `write`, `grep`, `find`, `ls`, `bash` (sandboxed), `todo`, `checkpoint`, plus:

| Tool | What it does |
| --- | --- |
| `web_search` | Local SearXNG (Docker container `echo-searxng`, port 8888) |
| `fetch_page` | A page or PDF URL as clean text; with `question`, only the relevant passages |
| `python` | Persistent Python (numpy, scipy, sympy, pint units, matplotlib); plots come back as images |
| `screenshot` | Screen, active window, or a window by name, shown to the model (Qwen3.8 27B reads images) |
| `notes_search` | Your notes (Hugin voice notes and other note folders), with title, date and file |

Loaded on demand with `tool_search` (no prompt cost until a task needs them):

| Group | Tools |
| --- | --- |
| Blender | `blender_python` (live through the MCP Bridge add-on on port 9876, else headless), `blender_scene`, `blender_preview`, `blender_api`, `blender_bridge` |
| Godot | `godot_check`, `godot_run`, `godot_screenshot`, `godot_export` |
| CAD | `cad_build` (build123d to STL/STEP, measurements, preview render), `mesh_check` |
| Documents | `pdf_text` (OCR for scanned pages), `ocr_image` |
| Code | `repo_map` (tree-sitter), `code_diagnostics` (tsc, pyright, ruff, clangd, Godot) |

Tool outputs (plots, renders, screenshots) go to `.echo/` in the working folder; CAD parts go to `cad/`.

## What runs

| Piece | What | Port |
| --- | --- | --- |
| Backend + UI | Node 22+ (TypeScript, run directly), Hono, SQLite (`data/echo.db`) | 7777 |
| Main model | Qwen3.8-27B Q4_K_M in llama.cpp `llama-server` (CUDA, MTP speculative decoding), **or** Qwen3.8-Flash-Next in Strata. Pick in the model selector; only one runs at a time | 8081 / 8080 |
| Decision model | Jebadiah 9B v2 Q8_0 in a CPU-only `llama-server` | 8090 |
| Decision server | Python, Jebadiah's own prompt renderer (`services/decision/server.py`) | 8091 |
| Web search | SearXNG in Docker (`services/searxng/settings.yml`) | 8888 |
| Notes RAG | Qwen3-Embedding-0.6B and Qwen3-Reranker-0.6B in `llama-server` (weights in RAM) | 8093 / 8094 |
| Hugin | Voice notes: Docker Compose stack in `vendor/HuginVoiceNotes` (Whisper `distil-large-v3` on CPU, Ollama `qwen2.5:3b-instruct`, ntfy) | 8088 (ntfy 8092) |

Everything binds to 127.0.0.1. Nothing phones home: Pi runs with `PI_OFFLINE=1` and `PI_TELEMETRY=0`.

## Install on Omarchy

Already done on this machine. From scratch:

1. Node 22.19+ and Python 3 (`pacman -S nodejs npm python`), bubblewrap for the agent sandbox (`pacman -S bubblewrap`).
2. `npm install`
3. llama.cpp: download the `ubuntu-cuda-12.8-x64` build and its `cudart` archive from
   https://github.com/ggml-org/llama.cpp/releases into `vendor/llama.cpp/`, merge the libraries into the build
   folder and link it as `vendor/llama.cpp/bin` (only the NVIDIA driver is needed).
4. Models: use the Models tab, or download by hand (see `models.yaml` for paths):
   - `models/qwen27b/`: `Qwen3.8-27B-UD-Q4_K_M.gguf`, `mmproj-F16.gguf`, `mtp-Qwen3.8-27B-Q4_0.gguf` from `unsloth/Qwen3.8-27B-GGUF`
   - `models/jebadiah/`: `jebadiah-9b-v2-Q8_0.gguf`, the tokenizer files, `scripts/` and `temperatures.json` from `frontier-infra/jebadiah-9b-v2-GGUF`
5. Decision server: `python3 -m venv services/decision/.venv && services/decision/.venv/bin/pip install transformers jinja2`
6. Strata (optional, path A): see below.

### Strata (Qwen3.8-Flash-Next)

Strata has no ready-made Linux engine, so it compiles one. That needs the CUDA toolkit:

```
sudo pacman -S --needed base-devel cmake cuda
cd vendor/Strata
./setup.sh --yes --family qwen --model IQ2_XS --context 32768 --no-start --data-dir ../../models/strata
```

The model files are already in `models/strata/models/IQ2_XS/`. Setup writes `run-iq2_xs.sh`, which
`models.yaml` points at; Flash-Next then becomes selectable in the UI.

## Configuration

- `echo.yaml`: ports, paths, agent step budget, sandbox, thresholds, notifications.
- `models.yaml`: model endpoints. Entries with `coming_soon: true` show in the selectors, disabled.

Both reload when saved.

## The agent loop

Action time: the main model works through Pi (read, edit, write, grep, find, ls, bash in a bubblewrap sandbox
limited to the working folder, `todo`, `checkpoint`). It ends after 8 tool calls, when the model calls
`checkpoint`, or before anything irreversible.

Decision time: Jebadiah answers `done`, `progress`, `next_step`, `effort` and one `action_safe` per queued
action in one pass, then `needs_human` on its own with those answers in its state. Above 0.5 the run pauses
and asks you in the UI, with a desktop notification (and ntfy if configured). Irreversible actions always
need your approval as well, and approved ones run outside the sandbox.

Every edit batch gets a git checkpoint, stored under `refs/echo/` with a private index, so your branches
and staging area are untouched. Every decision is logged to `evals/decisions.jsonl` and SQLite.

## Layout

```
apps/server/   backend (TypeScript, run directly by Node)
apps/web/      UI (Vite + React + Tailwind), built to apps/web/dist
services/decision/  Python decision server
models/  vendor/  data/  evals/   (not in git)
docs/          hardware.md, benchmarks.md, notes.md
```
