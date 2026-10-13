# Local Agent Platform — Build Prompt v1

Oct 3, 2026 · @Nick

## 1. Role and mission

You are a senior full-stack and ML-infrastructure engineer. Build **Echo**, a local-first agent platform with a clean web UI that runs entirely on my laptop. It must squeeze the most capability out of a local model running on modest hardware, and grow over time into a strong agent for my work: engineering, software, game development and Blender.

**How to work with me**

- Work in the phases in section 8. Stop at the end of each phase, show me what works (screenshots or a short demo script), and list decisions you made.
- Verify before you assume. Several components below are weeks old (Qwen3.8, Strata, Jebadiah and the other Jev-style models). Read their current READMEs and docs before writing integration code; if anything here contradicts them, the docs win and you tell me.
- Ask before anything hard to undo: installing system packages with pacman/yay, changing GPU drivers, downloading anything over \~5 GB, or editing files outside the project folder.
- Measure, don't guess. Any performance claim (tokens/s, VRAM, prompt-processing speed) comes from a benchmark you ran on this machine.
- Keep it simple. Prefer a small number of well-understood dependencies over frameworks.

## 2. Hardware and environment

The GPU is the binding constraint: a laptop RTX 3060 has 6 GB of VRAM (confirmed with nvidia-smi), so most model weights will live in system RAM. Design every choice around that.

| Item | Value | Implication |
| --- | --- | --- |
| OS | Omarchy (Arch Linux, Hyprland) | Use pacman/AUR, not apt. Many "Linux" installers assume Ubuntu; check before running them. |
| GPU | RTX 3060 Laptop, 6 GB VRAM, confirmed | Shared with the desktop compositor; budget \~5 GB usable. |
| RAM | 64 GB | Holds most of the model; leave \~12 GB for the OS, browser, Blender and the decision model. |
| Power | Laptop | Detect AC vs battery; warn in the UI when on battery or thermally throttled. |
| Ports | Strata defaults to 127.0.0.1:8080 | The platform UI uses another port (e.g. 7777). Everything binds to 127.0.0.1 only. |

First task of Phase 0: run a hardware probe (GPU model, VRAM total and free, driver and CUDA version, CPU flags such as AVX2/AVX-512, RAM, disk free, NVMe or not) and write it to `docs/hardware.md`.

## 3. Architecture and stack

&#91;embedded content: Echo architecture · UI, backend, four local services\]

The browser only ever talks to the backend; the backend owns every engine, queues requests, and streams events and metrics back.

- **Backend:** Node 22+ with TypeScript (Hono or Fastify), because Pi's SDK is TypeScript. Python only inside the decision server.
- **Frontend:** Vite + React or Svelte, Tailwind, no component framework heavier than needed. Dark theme first.
- **Storage:** SQLite for conversations, runs, decision logs and metrics history.
- **Config:** `models.yaml` (endpoints) and `echo.yaml` (ports, paths, thresholds), both hot-reloaded.
- **Processes:** systemd user units (or one supervisor script) for the engine, decision server and backend; open the UI as an Omarchy web app.

## 4. Inference layer (the main model)

The app talks to any OpenAI-compatible endpoint through a provider registry, so the engine underneath can change without touching the UI. Path A (Strata with Qwen3.8-Flash-Next) is the chosen main engine. Paths B and C are fallbacks if Strata can't run acceptably on the 6 GB GPU; Phase 0 confirms with measurements.

| Path | Engine | Model | Why | Risk on this laptop |
| --- | --- | --- | --- | --- |
| A (preferred) | [Strata](https://github.com/Niko1221/Strata) | [Qwen3.8-Flash-Next](https://recipes.vllm.ai/Qwen/Qwen3.8-Flash-Next) (125B MoE, \~6B active per token), Coder or IQ2\_XS build | Built to spread an MoE across VRAM, RAM and SSD; only \~6B parameters are read per token. OpenAI API at `/v1`, Anthropic API at `/v1/messages`, built-in MCP server, reasoning effort off/low/medium/high. | Strata asks for 12 GB VRAM and says 8 GB runs slowly; 6 GB is untested. Its setup script uses `apt`, so on Arch use the manual build path. Loads 35-55 GB into RAM and pins part of it. Serves one request at a time. |
| B (fallback) | llama.cpp `llama-server` (CUDA build) | [Qwen3.8-27B](https://huggingface.co/unsloth/Qwen3.8-27B-GGUF) dense, Q4\_K\_M (Q6 only if B is fast enough) | Mature, supports partial GPU offload, tool calling via `--jinja`, multimodal. | Dense: every token reads all \~16 GB of Q4 weights, most of them from RAM. Expect low single-digit tokens/s (estimate, measure it). Q6 is \~22 GB and slower still. |
| C (if both are too slow) | llama.cpp with `--n-cpu-moe` | A smaller-active MoE such as Qwen3.6-35B-A3B | Proven on 8 GB cards with experts in RAM. | Older generation; lower ceiling than A. |

**Required engine behaviour (all paths)**

- Default reasoning effort **low**. Qwen3.8 27B defaults to xhigh, which [badly overthinks](https://simonwillison.net/2026/Aug/16/qwen-38-27b/); expose effort per request.
- Keep the KV/prefix cache warm: system prompt and tool definitions are byte-stable, history is append-only. Strata re-reads a fresh prompt at roughly 1 minute per 30K tokens but continues a reused prefix in seconds, so cache misses dominate agent latency.
- Use MTP / speculative decoding where the engine supports it.
- A `models.yaml` describes each endpoint: base URL, model id, context length, supports\_tools, supports\_vision, reasoning levels, max concurrency (Strata = 1).
- Process management: start/stop/health-check the engine from the app (systemd user units or a supervisor), surface its log in the UI.

## 5. Action time and decision time

The agent alternates between two phases that never overlap. In **action time**, Qwen3.8-Flash-Next in Strata plans and uses tools. In **decision time**, Jebadiah 9B judges the work so far. Because they never run together, Jebadiah gets the CPU to itself instead of competing with Strata's expert offload.

**The loop**

1. **Action time.** The main model works until a checkpoint: its step budget runs out (default 8 tool calls, tunable), it calls the `checkpoint` tool because it thinks a subtask is done, or it is about to do something irreversible. Irreversible means deleting files, force-pushing, overwriting files outside git, installing system packages, or sending anything off the machine. Irreversible actions are queued, never run in action time.
2. **Hand-off.** At the checkpoint the main model writes a compact state: goal, plan, a diff summary, test and check results, queued actions, and any questions it wants judged. The backend adds the standard questions below.
3. **Decision time.** Jebadiah answers all questions in one request, so the shared state is processed once.
4. **Human in the loop.** The last question of every decision time, always, asked on its own with the other answers in its state.
5. **Apply.** The backend continues, re-plans, reverts to the last checkpoint, runs or drops queued actions, or pauses for me.

**Standard decision-time questions**

| Name | Type | Question | Effect |
| --- | --- | --- | --- |
| `done` | noul | The evidence shows the current subtask is complete. | True: move to the next subtask. |
| `action_safe` | noul, one per queued action | This queued action is safe to run as described. | Below threshold: drop it and tell the main model why. |
| `progress` | score | Stalled, slow, steady, strong | Stalled twice in a row: force a re-plan. |
| `next_step` | choice | Continue, re-plan, revert to last checkpoint, research first, finish | Sets the next action time's instruction. |
| `effort` | score | Low, medium, high | Reasoning effort for the next action time. |
| `needs_human` | noul | Should we get a human in the loop? | See below. Always last. |

**Human in the loop**

- Criteria: true when the agent is blocked, unsure what I want, facing an irreversible or costly choice, or repeating the same failure; false when it can proceed safely on its own.
- Asked exactly once, at the end of every decision time. Its state includes the other answers and their confidences, so low confidence elsewhere pushes it up.
- Above threshold (start at 0.5, tune on logs), pause the run and contact me with a short summary: why, what it needs, and the options. Channels: an in-app card, a desktop notification (`notify-send`, shown by Omarchy's mako), and optional phone push through a self-hosted ntfy server. My reply joins the state and action time resumes.
- Hard rules still apply regardless of the score: anything outside the sandbox always asks me.
- Log each HITL decision and whether I agreed it was needed; tune the threshold from that.

**Decision model: Jebadiah 9B v2 on CPU**

- Serve [jebadiah-9b-v2 GGUF](https://huggingface.co/frontier-infra/jebadiah-9b-v2-GGUF) with a second llama-server on CPU only (`-ngl 0`, its own port, e.g. 8090). Jebadiah's standalone Python server needs a CUDA GPU or Apple Silicon, so don't use it.
- Port Jebadiah's `scripts/decide_gguf.py` into the backend: render the prompt exactly as AINode does, read option-label log probabilities from `/completion`, apply `temperatures.json`.
- Prefer Q8\_0. The 9B is sensitive to quantization: against bf16 it keeps 257/260 picks at Q8\_0, 250 at Q5\_K\_M and 240 at Q4\_K\_M. Drop to Q5\_K\_M only if Phase 0 shows Strata, Jebadiah and the desktop don't fit in 64 GB together.
- If it fits, keep Jebadiah loaded but idle during action time. If not, load it at the start of each decision time and show the load time in the Monitor.
- One `DecisionClient.decide(state, questions)` in front of it. Log every decision with probabilities and latency into `evals/decisions.jsonl`; tune every threshold there.

**Later options (note only, do not build now)**

- **Add-on LoRA head.** If the main model ever moves to Qwen3.8-27B in llama-server, Jebadiah 27B can run as a per-request LoRA on the same weights for about 0.3 GB. Only merged weights are published, so recover the rank-16 adapter by SVD of merged minus base. Load it with `--lora-init-without-apply` and enable it per request with `"lora":[{"id":0,"scale":1}]`. Validate against Jebadiah's 260-question agreement check (their Q4 file: 258/260). This cannot work with Flash-Next, which is a different base model.
- **Rune 26B-A4B v3.** Stronger (Decision Index 57.44, second only to Jev 1.13) and reads images, which suits Blender and game screenshot checks. Only 51.6 GB of bf16 weights exist, so we would convert it to GGUF ourselves and swap it in during decision time. Use decision temperature 2. Try once the loop works.
- **CLM 8B.** Look into it later as an alternative decision model. Compare it with Jebadiah 9B on the decision eval set and on logged agent decisions before switching.

## 6. UI specification

A simple, clean, dark-first single-page app with three tabs across the top and a collapsible Monitor panel on the right that stays visible on every tab. Keyboard-friendly (it lives on a Hyprland desktop), fast to load, no login.

**Tab 1: Chat**

- Standard chat with streaming, Markdown, code blocks with copy, and image attach (both Qwen3.8 models are multimodal).
- Model selector at the top. The configured local model is selectable; every other entry is listed but disabled with a "Coming soon" badge (placeholders: other local models, a cloud fallback).
- Reasoning effort control (off / low / medium / high), default low. Thinking is shown collapsed.
- Conversations persisted to SQLite on the server, listed in a left sidebar with search, rename, delete.
- Stop button that actually aborts generation on the engine.

**Tab 2: Decide**

- Same layout and selector style as Chat; the selector lists decision models (Jebadiah 9B live, Rune v3 and others "Coming soon").
- A State box (text, pasted JSON or a file) and a list of questions. Each question has a name, a type picker (choice / yes-no / score), instructions, and type-specific fields: 2-50 options with optional descriptions for choice; optional meanings of true and false for yes-no; ordered levels with labels for score.
- Results per question: the winning option, a horizontal bar per option with its probability, the confidence, and latency in ms. Yes-no shows a single probability gauge.
- Save question sets as reusable presets; show the raw request and response JSON in a collapsible panel.

**Tab 3: Agent**

- Pick a working folder, give a task, watch the run: streamed reasoning (collapsed), each tool call as a card with arguments, output, duration and status.
- Approve/deny prompts for risky actions; a visible todo/plan list; a context-usage bar; stop and resume.
- Diff viewer for file edits with one-click revert (git checkpoints). A timeline alternates action-time and decision-time blocks; each decision block shows its answers and probabilities, and a human-in-the-loop request appears as a card I can reply to.
- Starts minimal in Phase 3 and grows through the roadmap in section 7.

**Monitor panel (right side, all tabs)**

- RAM: used / total, plus how much the inference engine holds (pinned and resident).
- GPU: VRAM used / total, utilisation %, temperature, power draw (via NVML or `nvidia-smi --query-gpu`).
- CPU: utilisation %, and per-core load as a compact strip.
- Tokens per second: live decode tok/s for the current stream, prompt-processing tok/s, time to first token, plus a 60-second sparkline. Take numbers from the engine's own timing fields where available; never compute decode speed as tokens divided by total request time.
- Context: tokens used / limit for the active conversation, and prefix-cache reuse when the engine reports it.
- Engine status: which model is loaded, healthy or not, queue (Strata handles one request at a time), and the decision model's status. A phase indicator shows whether the agent is in action time or decision time, plus the last human-in-the-loop probability.
- Updates over one WebSocket at \~1 Hz; collapsible to a slim strip showing just tok/s, VRAM and RAM.

## 7. Agent mode roadmap

A local model wins by spending few tokens, keeping its cache warm and checking its own work. Each item below is built, measured against the eval suite, and kept only if it helps.

**Harness.** Build Agent mode on [Pi](https://github.com/earendil-works/pi) (MIT, Earendil): a minimal harness whose fixed overhead is [under 1,000 tokens versus \~6,900 for OpenCode](https://composio.dev/content/pi-vs-opencode), which matters at local speeds. Embed it with the Pi TypeScript SDK (`AgentSession`) or drive `pi --mode rpc` over JSONL. Pi skips sub-agents and plan mode by design; add what we need as Pi extensions. Hermes Agent is the alternative if persistent memory becomes the priority, but it needs a 64K+ context and is heavier.

**Action-time tools**

These are the tools the main model can call in action time. Start with the core rows; add a domain row when its tier comes up. Each tool returns short, structured output so it doesn't flood the context.

| Area | Tools | Rule |
| --- | --- | --- |
| Files and code | read, write, exact-match edit with diff, glob, ripgrep, tree-sitter repo map and symbol search | Every edit batch gets a git checkpoint. |
| Shell | Sandboxed bash (bubblewrap) with timeouts; background processes with log tail and kill | Network off unless allowed. |
| Git | status, diff, log, commit, branch, checkpoint, revert | Push only after a decision time and my approval. |
| Code checks | LSP diagnostics (pyright, tsserver, clangd, rust-analyzer as installed), test runner, linters, formatters | Results go into the decision-time state. |
| Python workspace | Persistent Python kernel with numpy, scipy, sympy, pint (units) and matplotlib | Numbers are computed here, never written from memory. |
| Vision | Screenshot (grim on Hyprland), image viewer that sends a picture to Flash-Next (Strata's image input) | Renders and UIs are checked by looking, not assumed. |
| Blender | Blender MCP servers (run bpy, scene and object summaries, viewport screenshot, render thumbnail), headless `blender -b --python`, bpy API docs lookup | A screenshot check follows every bpy change. |
| Game dev | Godot headless (run a scene, run tests, export), GDScript LSP, screenshot of a running scene; Unity or Unreal through MCP if I use them | Confirm which engine I use before building. |
| Engineering and CAD | CadQuery or build123d, FreeCAD Python, OpenSCAD CLI (render to PNG and STL), trimesh mesh checks, KiCad CLI (ERC/DRC) if I do electronics | Export a preview image for every part. |
| Research | Local SearXNG search, page fetch with summary, PDF and datasheet text extraction (pdftotext) | Summarise before anything enters the context. |
| Planning and memory | todo list, project notes file, skill loader (SKILL.md), `checkpoint` (end action time now) | The agent may end action time early. |
| System | GPU, RAM and CPU status from the Monitor | Don't start heavy jobs (renders, big builds) that would starve Strata. |

**Tier 1: make the local model reliable**

- Small default tool set (read, write, edit, bash, grep/glob, todo); extra tools loaded on demand by a tool-search step so they don't sit in every prompt.
- Byte-stable system prompt and tool list; append-only history; compaction only at a high watermark, summarising old turns into a single block so the cache breaks once.
- Strict tool-call validation against JSON Schema with one automatic repair retry and a clear error back to the model.
- Reasoning effort per step: low for routine tool calls, high for planning and debugging.
- Git checkpoint before every edit batch; revert from the UI.
- Sandboxed shell (bubblewrap on Arch) scoped to the working folder; network off unless allowed.

**Tier 2: the action/decision loop** (section 5)

- Checkpoint logic, the standard decision-time questions, the human-in-the-loop question and its notification channels.
- Distinct question sets per domain (code, Blender, CAD) added only when the eval set shows they help.
- Every decision logged with its probabilities, so thresholds are tuned on real runs.

**Tier 3: verification loops (where most quality comes from)**

- Code: run tests, linters and type checkers after edits; feed failures back. Tree-sitter repo map (Aider-style) and LSP diagnostics for navigation.
- Blender: connect Blender MCP servers (I already use some); after each `bpy` change, render a viewport screenshot and have the vision model check it against the goal. A `bpy` API lookup tool to cut hallucinated calls.
- Game dev: Godot or Unity MCP servers if available; headless test runs; screenshot-and-compare for scenes.
- Engineering: CadQuery/build123d or FreeCAD scripting with exported previews checked visually; numeric results recomputed in Python, never trusted from text.

**Tier 4: memory and skills**

- Project instructions file (AGENTS.md) read at start; a per-project notes file the agent appends to.
- Skills folder (SKILL.md files) for repeatable workflows: Blender scene setup, Godot export, CAD part from sketch.
- Local web search through a self-hosted SearXNG, with fetched pages summarised before they enter context.

**Tier 5: scale and observability**

- Sequential sub-agents with fresh context for search-heavy subtasks (the engine serves one request at a time).
- Trace viewer: every turn, token count, cache hit, latency.
- Eval suite (`evals/`): \~20 real tasks across code, Blender and CAD, run on demand to compare models, prompts and features.
- Optional cloud escalation for tasks the local model fails twice (wired to the "Coming soon" selector entry).

## 8. Phases and definition of done

Stop and report at the end of each phase.

1. **Phase 0: probe and benchmark.** Hardware probe; install Strata (manual Arch build) and llama.cpp; benchmark path A, plus B and C only if A disappoints, at 8K and 32K prompts: decode tok/s, prompt tok/s, TTFT, peak VRAM and RAM, and one tool-call correctness check. Also check that Strata and Jebadiah 9B (Q8\_0) fit in RAM together, and time Jebadiah's load from disk. Write `docs/benchmarks.md`.
2. **Phase 1: skeleton and Chat.** Monorepo, backend, provider registry, SQLite, Chat tab with model selector and "Coming soon" entries, Monitor panel.
3. **Phase 2: Decide.** Jebadiah 9B on CPU behind `DecisionClient`, Decide tab with presets and probability bars, the decision eval set.
4. **Phase 3: Agent v0.** Pi embedded, the core action-time tools, Tier 1 items, the action/decision loop with the human-in-the-loop question and notifications, Agent tab with timeline, tool cards, approvals, diffs and checkpoints.
5. **Phase 4+: roadmap tiers 3-5 and the domain tool rows**, one feature at a time, each measured against `evals/`. The later options in section 5 (LoRA head, Rune v3, CLM 8B) are revisited here.

**Constraints**

- Offline by default: no telemetry, no outbound calls except model downloads and searches I enable.
- Everything on 127.0.0.1; optional API key if I ever expose it.
- One command to start everything (`./echo up`) and one to stop; a README that covers install on Omarchy.
- Typed code, tests for the backend's provider, decision and agent-event layers.

**Done for each phase means:** it starts from a clean checkout with the documented commands, the tests pass, the Monitor shows real numbers, and you have shown me it working.
