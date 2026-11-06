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

## Chat tab

*Search the web* gives the model `web_search` (SearXNG) and `fetch_page`, the agent's own web tools: it decides
when to search, reads the best pages and cites them as [1], [2], with the queries and linked sources under the
answer. *Use my notes* puts matching passages from your notes in front of each question. Both can be on.

## Read tab

Paste a screenshot (Ctrl+V, or *Paste from clipboard*) or type in the text box: Echo reads the text with Tesseract
and speaks it (`services/tts`). *Auto summarize + read* speaks a 2-5 sentence summary from the active main model
instead of the full text. Ctrl+Enter in the box reads it.

*Change voice* (in Read and in Live) picks a **model** first, then one of its voices, with a ▶ button to hear each
one (on your own test sentence, if you like). Speeds are on the desktop's CPU (the GPU is the main model's): 2x real time
means 10 s of speech takes 5 s to make, 0.5x means it takes 20 s.

| Model | Voices | Cloning | Speed (CPU) | Download |
| --- | --- | --- | --- | --- |
| **Piper** | 8 English voices | no | ~15x real time | each voice on first use (60-120 MB) |
| **Pocket TTS** (Kyutai) | 21 English voices | yes (gated weights, see below) | ~2-3x real time | on first use (220 MB) |
| **Kokoro 82M** (ONNX) | 41 voices: English, Spanish, French, Hindi, Italian, Brazilian Portuguese | no | ~4x real time | Models tab (337 MB) |
| **Qwen3-TTS 0.6B** | 9 preset speakers, 10 languages | yes | ~0.5x real time | Models tab (4.7 GB) |
| **VoxCPM2** (OpenBMB, 2B) | cloned voices only, 30 languages | yes | ~0.2x real time | Models tab (4.6 GB) |

The Models tab's *Text to speech* filter shows the three downloads; a model that isn't downloaded yet links there.

**Clone a voice** appears under models that can clone. Upload a recording (WAV, MP3, M4A, OGG or FLAC): the browser
trims and converts it, the model turns it into a voice, and it is kept in `data/tts/voices/`. The ⓘ next to the
heading says how long the sample should be for that model: Pocket TTS 10-15 s (uses the first 30 s), Qwen3-TTS
10-20 s (3 s minimum; over 30 s can make it hang), VoxCPM2 10-30 s (5 s minimum). Qwen3-TTS and VoxCPM2 copy a
voice more closely when they know the recording's words: type them in, or leave the box empty and Echo transcribes
English recordings itself (Live's speech to text). Pocket TTS's cloning weights are free but gated: accept the terms
at https://huggingface.co/kyutai/pocket-tts with a Hugging Face account, then give Echo a read token: `HF_TOKEN=` in
`.env` and `docker compose up -d` (Docker), or `services/tts/.venv/bin/hf auth login` and `./echo restart` (native).

**Compare models.** `node tools/voice-compare.ts` clones the same recordings in Pocket TTS, Qwen3-TTS and VoxCPM2, has
each clone say the same sentences, and writes a page that plays them side by side, with a Kokoro preset for reference
(Kokoro can't clone). With Echo running, put one recording per voice in `data/voice-compare/samples/`: about 15 s suits
all three models, and anything but a WAV needs `ffmpeg`. Add `<voice>.txt` with its exact words if you have them (needed
for languages other than English), and `data/voice-compare/lines.txt` to choose the sentences, one per line. Then open
`data/voice-compare/results/index.html`. The clones also appear in the voice pickers. Models that aren't ready are
listed on the page; running the command again makes only what is missing or changed. Only clone voices you have
permission to use.

Qwen3-TTS and VoxCPM2 run in a separate worker process (`services/tts/worker.py`, venv `services/tts-torch/.venv`)
that starts the first time you use one of their voices. Qwen3-TTS loads in ~5 s and takes ~2.5 GB of RAM per model
(its preset speakers and its cloning are two models); VoxCPM2 loads in ~30 s and takes ~7 GB. Only one of the two
stays loaded, and the worker stops after 10 minutes unused, which frees the memory. On the CPU both are slower than
real time (bfloat16 where the CPU supports it, as this Ryzen does): Read waits for the whole text, and in Live they
delay every answer (Live speaks each sentence as soon as it is written), which the picker says.

After updating a native install, run `services/tts/.venv/bin/pip install -r services/tts/requirements.txt` once, and
for Qwen3-TTS and VoxCPM2: `python3 -m venv services/tts-torch/.venv && services/tts-torch/.venv/bin/pip install -r
services/tts-torch/requirements.txt`.

## Rules: what the agent may do without asking

`rules.md` holds permission switches (`[x]` allowed without asking, `[ ]` ask me first) plus "always ask" and
"never" lists. Echo uses it to decide which commands run, which wait for your approval and which are refused.
The main model reads it at the start of each run, and the decision model sees a summary at every decision time.

## Models tab

One-click downloads of the models Echo uses, straight into the folders `models.yaml` points at. Downloads resume.
The filter at the top shows one type at a time: *Language* (main models), *Decision* and *Text to speech* (Kokoro,
Qwen3-TTS, VoxCPM2; whole Hugging Face repositories are listed through its API, so new files are picked up).
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
- `models.yaml`: model endpoints. Entries with `coming_soon: true` show in the selectors, disabled. For llama-server
  models, `kv_cache: q8_0` halves the KV cache and `mmproj_on_cpu: true` keeps the vision projector in RAM; both
  leave VRAM free for the desktop (on a full card Windows moves part of the model to system RAM and long prompts crawl).

Both reload when saved.

## Live tab: talk to Echo

Press **Start** and talk; when you pause, Echo answers out loud and listens again. Follow-up questions work. The
first sound of the answer comes ~1.3-1.6 s after you stop talking (median 1.44 s, half of it the pause Echo waits
to be sure you have finished; pick 0.4, 0.5 or 0.7 s). **Thinking off** answers soonest; **thinking low** thinks
first (better on hard questions, ~1.5 s+ slower). **Interrupt** stops it mid-answer, **New conversation** forgets
the conversation. Each turn shows its delay and where the time went.

For harder questions the voice hands off to another model, says so ("Let me think about that"), and comes back
with a short spoken summary that names the model it checked. The **chat model** (the Chat tab's model, thinking at
medium, with web search for current facts) writes a full answer in ~10-20 s; that answer is saved in the Chat tab
as a "Live: ..." conversation. The **decide model** (Jebadiah, as in the Decide tab) gives a yes/no probability or
odds between options in ~1-5 s. Ask for either by name ("ask the decide model ..."), or let the voice choose.

Speech to text is Echo's own (`services/stt`: faster-whisper `base.en` on 8 CPU threads, ~0.35 s for a short
question; its weights, ~145 MB, download into `models/stt/` on first use). *Change voice* is the Read tab's picker
(its own choice, kept in the browser): any model and voice, cloned ones included. Live speaks each sentence as soon
as it is written, so a slow model (Pocket TTS, Qwen3-TTS, VoxCPM2) delays every answer, and the picker says so.
Settings: `live` in `echo.yaml`. English only for now. Details: [docs/live-chat.md](docs/live-chat.md).

## Git tab

A branch graph (branches, merges, tags; click a commit for its diff) of every git repository in the folders under
`git.dirs` in `echo.yaml` (your projects folder, including the agent's working copy of Echo, which updates as it
commits), and of the GitHub repositories under `git.github`, mirrored into `data/git/`. For those, **Pull requests**
lists the open ones with their description, commits and full diff, and merges (merge commit, squash or rebase) or
closes them. A merge is pinned to the commit you reviewed: if the branch moved since, GitHub refuses it.

Reading a public repository needs nothing. Merging and closing need a GitHub token: a fine-grained token
(github.com/settings/personal-access-tokens) for the repository with *Pull requests* and *Contents* set to *Read and
write*, as `GITHUB_TOKEN=` in `.env`, then `docker compose up -d`. The token stays on the server.

## SDK and self-work

`sdk/` drives the agent from scripts and the terminal (`node sdk/cli.ts help`), and runs the self-work loop where
Echo changes its own code: `node sdk/cli.ts self init` clones this repo into the projects folder, `self run "..."`
gives the agent a task there, and the agent verifies its work, runs the copy as a sandboxed dev instance (at
http://dev.localhost:7777, sharing the live model) and commits. `self branch` brings the result back here as a branch
to review and merge. `AGENTS.md` is the codebase map the agent reads in every run there. Details: [sdk/README.md](sdk/README.md).

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
