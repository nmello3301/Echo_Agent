# Project notes

Running list of decisions, open questions and things to revisit.

## To look into later

- Planned features now live in `FuturePlans.md` (root).
- **CLM 8B as an alternative decision model.** Evaluate against Jebadiah 9B v2 on `evals/decisions.jsonl`
  and the decision eval set before switching. Listed as "Coming soon" in the Decide selector (models.yaml).
- **Rune 26B-A4B v3** (stronger, reads images): needs our own GGUF conversion; try once the loop works.
- **Jebadiah 27B as a LoRA head**: only if the main model moves to Qwen3.8-27B in llama-server.

## Known limitations of the MVP (2026-10-03)

- **Flash-Next (Strata) is not built yet.** Needs `sudo pacman -S --needed base-devel cmake cuda`, then Strata's
  setup compiles its engine (20-40 min). The 68 GB of model files are already downloaded. Until then it shows as
  "not installed" in the selectors.
- **Decision state on a hybrid model:** Jebadiah cannot reuse an arbitrary prompt prefix, so every question
  re-reads most of the state. GPU op offload keeps it at ~1.5 s per question; a decision time is ~10 s.
- **Jebadiah is cautious about `rm`:** it rated `rm old_notes.txt` unsafe (P 0.39) even when the task asked for it,
  which raised a human-in-the-loop card. Watch the "was this needed?" answers and tune
  `thresholds.action_safe` / `needs_human` in echo.yaml.
- Agent runs live in memory: finished runs can be viewed after a restart, not resumed.
- Pi's system prompt and tools are ~3K tokens, so the first agent turn takes ~30 s to read on the 27B.
- Domain tools (Blender MCP, Godot, CAD, SearXNG, vision screenshots) are Phase 4+ and not wired yet.

## Rules (rules.md), answered 2026-10-06

- Phone push (self-hosted ntfy) for "needs you" moments: maybe later; desktop notification only for now.
- `sudo` cannot take a password non-interactively, so allowed `sudo pacman -S ...` calls fail unless sudo is
  set up passwordless for pacman. Decide later whether to add a sudoers rule or keep installs manual.
- Agent may suggest improvements to its tools and skills; implementing them needs the user's permission.

## Tools (added 2026-10-06)

- Qwen3.8 27B reads images: a 768 px render costs ~440 prompt tokens (~6 s). Verified on a CAD render and a Godot frame.
- Live Blender mode (MCP Bridge add-on, port 9876) tested 2026-10-06: the bridge starts with Blender; scene summary, live bpy and window preview all work.
- `godot_screenshot` opens a game window briefly (Godot's movie writer needs a real renderer).
- `screenshot` cannot capture while the screen is locked or off (it now says so after 15 s).
- Not installed, so not wired: OpenSCAD, FreeCAD, KiCad CLI (`pacman -S openscad freecad kicad` would add them), Unity/Unreal.

## Hugin and notes RAG (added 2026-10-06)

- Measured: a 20-30 s voice note takes ~1 minute from upload to note (Whisper distil-large-v3 int8 + qwen2.5:3b, CPU).
- Retrieval eval (evals/rag_eval.ts): top-1 22/22, top-3 22/22, ~2.1 s per search (reranking 12 candidates).
  When passages tie, the newer note ranks first (a later note usually supersedes an earlier one).
- The embedding and reranker servers keep weights in RAM and run prompt batches on the GPU with a small batch
  (ubatch 256): pure CPU took 41 s to rerank 20 passages; GPU-assisted takes ~11 s. All engines: 4.9 GB VRAM.
- Hugin writes notes as root (Docker); Echo only reads them.
- Hugin's own index (hugin.db) and Echo's notes index (data/notes-rag.db) are separate; Echo's is rebuilt from the files.
