# Benchmarks

## Desktop: RTX 4090 24 GB, Docker Desktop on Windows 11 (2026-11-04)

Qwen3.8-27B UD-Q4_K_M, llama.cpp b11381, MTP draft, 32K context, all layers on the GPU.

| Measure | Value |
| --- | --- |
| Decode | 55-88 tok/s (MTP draft acceptance 0.6-0.94) |
| Prompt reading | 1,900-2,200 tok/s (8K and 30K-token prompts) |
| Time to first token, effort off, short prompt | 0.4-0.7 s; ~1.5 s for the first request after idle |
| Time to first token, effort off, ~3.5K-token prompt | 2.8 s |
| Answer starts, effort low / medium, simple question | ~1.8 s / ~1.5 s (thinks first) |
| Decision time (Jebadiah from RAM, op offload, 7 questions) | ~26 s, 1-3.4 s per question at 300-500 tok/s |
| Agent: edit + echo_verify + dev instance + request + commit | 47 s, of which 26 s was one decision time |

The model is a hybrid (`qwen35`: 65 layers, full attention every 4th), so the KV cache is small: ~64 KB per token
in f16, ~2 GiB at 32K.

**VRAM stalls.** With the 4090 also driving the desktop, the card was full (llama 20.2 GB + 0.66 GB already in
shared system memory; dwm and Firefox ~1.5 GB each). The first long prompt after a quiet spell then read at 50-66
tok/s (a 30K prompt took 574 s, a 5K agent prompt 74 s) and the same prompt right after at 2,190 tok/s: Windows
moves part of the model's GPU memory to system RAM under pressure. models.yaml now sets `kv_cache: q8_0` and
`mmproj_on_cpu: true` for the 27B. After the restart: the WSL VM uses 18.4 GB of VRAM (was 20.2 GB) with ~0.3 GB
shared (was ~0.66 GB), the card 21.7 of 24 GB, and ~10K-token prompts read at 2,030-2,290 tok/s both right after
loading and after 10 idle minutes (no stall). A trivial agent run (one grep, effort off) now takes 7.7 s.

## Laptop: RTX 3060 Laptop 6 GB

Measured on this laptop (RTX 3060 Laptop 6 GB, Ryzen 7 4800H, 62 GiB RAM), on AC, 2026-10-03.
Numbers come from llama-server's own `timings` fields. Re-run with `python3 tools/bench.py <url> <words> <effort>`.

## Path B: Qwen3.8-27B UD-Q4_K_M, llama.cpp b11381 (CUDA 12.8 prebuilt)

`--fit` (default on, 1 GiB margin) put part of the model on the GPU: 4.6 GB VRAM used at 32K context.

| Setup | Prompt | Prompt tok/s | Decode tok/s | Notes |
| --- | ---: | ---: | ---: | --- |
| no speculative decoding | 18 tok | 6.9 | 2.39 | |
| no speculative decoding | 6,915 tok | 155.0 | 1.84 | ~45 s to read an 8K prompt |
| MTP draft (`--spec-type draft-mtp`) | 18 tok | 5.9 | 3.28 | draft acceptance 0.62 |
| MTP draft, via Echo chat | 52 tok | 6.7 | 3.79 | 83 of 108 drafts accepted |

- RAM: ~19 GB resident for the 27B process. Load time under Echo: 12.3 s.
- `--cache-reuse` is disabled by llama-server when a multimodal projector is loaded; the normal prefix cache
  (`cache_prompt`) still works, so appending to a conversation does not re-read it.
- 32K prompt: not yet measured (expect ~4 min to read at ~150 tok/s).

## Path A: Qwen3.8-Flash-Next IQ2_XS, Strata

Not measured yet: Strata has no ready-made Linux engine, so it must be compiled, which needs the CUDA toolkit
(`sudo pacman -S --needed base-devel cmake cuda`). Model files (68 GB) are downloaded to `models/strata/models/IQ2_XS/`.
Strata asks for 12 GB VRAM and says 8 GB runs slowly; 6 GB is untested.

## Decision model: Jebadiah 9B v2 Q8_0 (weights in RAM)

Jebadiah is a hybrid (recurrent + attention) model, so llama.cpp cannot reuse an arbitrary prompt prefix:
each question re-reads most of the state. Prompt reading speed decides decision-time latency.

| Setup | Prompt reading | Per question (example request) |
| --- | ---: | ---: |
| CPU only (`CUDA_VISIBLE_DEVICES=`), 8 threads | ~25 tok/s | ~4 s, ~10 s for a ~250-token agent state |
| `-ngl 0` with the GPU visible (op offload: big batches on the GPU, weights stay in RAM) | ~65-70 tok/s | **~1.5 s** |

Echo uses the second setup (no extra VRAM measured: 4.1-4.3 GB total with the 27B loaded).
First full agent decision time (6 questions + needs_human, CPU only): 74.5 s; to be re-measured with op offload.

| Measure | Value |
| --- | --- |
| Load time | 4.0 s (page cache warm) |
| RAM | ~10 GB resident |
| Example request | billing 0.635 / support 0.036 / sales 0.328; urgent 0.165 — matches the model card (0.641 / 0.036 / 0.323; 0.167) |

Strata-or-27B plus Jebadiah plus the desktop fit in RAM together: with the 27B and Jebadiah loaded, 55 GB was still available.

## Still to measure

- 32K-token prompts on both paths, tool-call correctness check on path A.
- Strata on 6 GB at all.
