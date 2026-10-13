# Echo — future plans

Features and upgrades planned for Echo but not built yet. Add to this list freely; when one is built, move it
to "Done" with the date (or delete it). Known limitations of what already exists live in `docs/notes.md`.

## Models

- **CLM 8B as an alternative decision model.** Compare it with Jebadiah 9B v2 on `evals/decision-set.jsonl` and
  on logged agent decisions (`evals/decisions.jsonl`) before switching. Listed as "Coming soon" in Decide.
- **Rune 26B-A4B v3** as the decision model (stronger, reads images). Needs our own GGUF conversion; swap it in
  during decision time.
- **A ~4 GB decision model that runs on the GPU next to Strata.** While Strata is the main model it takes
  ~5.5 GB of the 6 GB card, so the decision LLM and notes embed/rerank run CPU-only (slower decisions). Find a
  decision model that fits beside it, or one that makes GPU use possible on the 27B path too.
- **Jebadiah 27B as a LoRA head** on the main model, only if the main model stays Qwen3.8-27B in llama-server.
- **Qwen3.8-Flash-Next via Strata** (path A). Model files are downloaded; needs the CUDA toolkit
  (`sudo pacman -S --needed base-devel cmake cuda`) and the Build button in the Models tab. Untested on 6 GB VRAM.
- **Upgrade Hugin's LLM** from `qwen2.5:3b-instruct` if notes or cleanups feel thin (e.g. a 7-8B instruct model
  for summaries only). Set in `vendor/HuginVoiceNotes/.env`.
- **Cloud fallback** for tasks the local model fails twice (the "Coming soon" entry in the model selector).

## Hugin (voice notes)

- **UI pass** on Hugin's own web pages (from Hugin's README: reference images first).
- **Persistent recording shortcut** that works outside the browser tab (Hugin's Omarchy client + Hyprland binds).
- Merge Hugin's web UI into Echo's own UI instead of embedding it.
- Phone push for finished notes through Hugin's ntfy (desktop notifications only for now).
- **Portuguese (multilingual) transcription.** Hugin's CPU Whisper, `distil-large-v3`, is English-only: a
  Portuguese test note came out as garbled English. Switch `STT_MODEL_CPU` to `large-v3-turbo` (multilingual,
  slower on CPU) if you dictate in Portuguese.
- Hugin's Omarchy client for global hotkeys (`SUPER+D` dictate, `SUPER+SHIFT+D` voice note); needs Hyprland
  binds and `wtype`, `wl-clipboard`.
- More note sources for the RAG: an Obsidian vault or project folders (add them to `notes.dirs` in echo.yaml).

## Agent

- **Phone push (self-hosted ntfy)** for "needs you" moments; desktop notification only for now.
- **Passwordless sudo for pacman** (a sudoers rule) so allowed system-package installs can actually run, or keep
  installs manual.
- **Sub-agents** with fresh context for search-heavy subtasks (roadmap tier 5).
- **Trace viewer**: every turn, token count, cache hit, latency.
- **Agent eval suite** (`evals/`): ~20 real tasks across code, Blender and CAD to compare models, prompts and features.
- Resume finished agent runs after a restart (runs live in memory today).
- Echo may suggest new tools, skills and integrations; implementing them needs approval (rules.md).

## Tools

- OpenSCAD, FreeCAD and KiCad CLI (not installed: `pacman -S openscad freecad kicad`).
- Unity / Unreal through MCP, if those engines come into use.
- Skills folder (`SKILL.md`) for repeatable workflows: Blender scene setup, Godot export, CAD part from sketch.

## Platform

- Benchmark 32K-token prompts on both main models; tool-call correctness check for Flash-Next.
- A single combined UI (today Echo and Hugin each have experimental UIs).

## Done

- 2026-10-06: Hugin integrated into Echo (Docker stack managed by `./echo`, notes RAG, Hugin tab).
