# Hardware probe

Probed 2026-10-03 on the target laptop.

| Item | Value |
| --- | --- |
| GPU | NVIDIA GeForce RTX 3060 Laptop GPU |
| VRAM | 6144 MiB total, 5803 MiB free at idle |
| Driver | 610.43.02 (CUDA UMD 13.3) |
| CUDA toolkit | Not installed (no `nvcc`, no `/opt/cuda`) |
| CPU | AMD Ryzen 7 4800H, 8 cores / 16 threads (Zen 2) |
| CPU flags | AVX2, FMA, F16C. **No AVX-512** |
| RAM | 62 GiB usable, ~59 GiB available at idle |
| Swap | 66 GiB (includes 4 GiB zram) |
| Disk | Kingston SNV2S2000G NVMe, 1.6 TB free on `/home` |
| Power | On AC at probe time |

## Tooling

| Tool | Status |
| --- | --- |
| node / npm | v25.9.0 / 11.12.1 |
| python3 | 3.14.5 |
| git | 2.54.0 |
| gcc | 16.1.1 |
| bubblewrap | 0.11.2 |
| notify-send, grim, yay | present |
| cmake | **missing** |
| CUDA toolkit (nvcc) | **missing** |
| uv, pnpm | missing (optional) |

## Implications

- No AVX-512: CPU decode for Jebadiah 9B and for offloaded experts runs on AVX2 kernels only.
- Building llama.cpp with CUDA and building Strata both need `cmake` and the `cuda` package.
- GCC 16 is newer than CUDA usually accepts as a host compiler; the build may need `gcc14` as `CUDAHOSTCXX`.
