import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { publish } from "./bus.ts";
import { config, ROOT } from "./config.ts";

interface CatalogFile {
  url: string;
  dest: string; // relative to the project root
}

interface CatalogModel {
  id: string;
  name: string;
  role: string;
  about: string;
  files: CatalogFile[];
  engine?: "strata";
}

const HF = "https://huggingface.co";
const hf = (repo: string, file: string, rev = "main") => `${HF}/${repo}/resolve/${rev}/${file}`;

const QWEN27 = "unsloth/Qwen3.8-27B-GGUF";
const JEB = "frontier-infra/jebadiah-9b-v2-GGUF";
const FLASH = "ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF";
const FLASH_REV = "ed59f92082b1e93c0e96d60a8b11aab089b52f09"; // the revision Strata v0.1.38 pins

/** The initial models. Expand this list to add more. */
export const CATALOG: CatalogModel[] = [
  {
    id: "qwen3.8-27b",
    name: "Qwen3.8 27B (UD-Q4_K_M)",
    role: "Main model · llama.cpp",
    about: "Dense 27B with image input and an MTP head for speculative decoding.",
    files: [
      { url: hf(QWEN27, "Qwen3.8-27B-UD-Q4_K_M.gguf"), dest: "models/qwen27b/Qwen3.8-27B-UD-Q4_K_M.gguf" },
      { url: hf(QWEN27, "mmproj-F16.gguf"), dest: "models/qwen27b/mmproj-F16.gguf" },
      { url: hf(QWEN27, "MTP/mtp-Qwen3.8-27B-Q4_0.gguf"), dest: "models/qwen27b/mtp-Qwen3.8-27B-Q4_0.gguf" },
    ],
  },
  {
    id: "qwen3.8-flash-next",
    name: "Qwen3.8-Flash-Next (IQ2_XS)",
    role: "Main model · Strata",
    about: "125B MoE, ~6B active per token, spread over VRAM, RAM and SSD by Strata. The engine is compiled separately.",
    engine: "strata",
    files: [1, 2].map((i) => ({
      url: hf(FLASH, `IQ2_XS/Qwen3.8-Flash-Next-GSQ-RCO-IQ2_XS-0000${i}-of-00002.gguf`, FLASH_REV),
      dest: `models/strata/models/IQ2_XS/Qwen3.8-Flash-Next-GSQ-RCO-IQ2_XS-0000${i}-of-00002.gguf`,
    })),
  },
  {
    id: "jebadiah-9b-v2",
    name: "Jebadiah 9B v2 (Q8_0)",
    role: "Decision model · llama.cpp",
    about: "Answers typed questions with calibrated probabilities. Includes its prompt renderer and tokenizer.",
    files: [
      "jebadiah-9b-v2-Q8_0.gguf", "tokenizer.json", "tokenizer_config.json", "vocab.json", "merges.txt",
      "chat_template.jinja", "temperatures.json", "README.md", "scripts/jebadiah_prompt.py",
      "scripts/ainode_prompt_verbatim.py", "scripts/decide_gguf.py", "scripts/example-request.json",
    ].map((f) => ({ url: hf(JEB, f), dest: `models/jebadiah/${f}` })),
  },
];

const remoteSize = new Map<string, number>();
async function sizeOf(url: string): Promise<number> {
  const cached = remoteSize.get(url);
  if (cached) return cached;
  const r = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(15_000) });
  const n = Number(r.headers.get("x-linked-size") ?? r.headers.get("content-length") ?? 0);
  if (n) remoteSize.set(url, n);
  return n;
}

const localSize = (p: string) => (existsSync(p) ? statSync(p).size : 0);

interface Job {
  id: string;
  abort: AbortController;
  file: string;
  have: number;
  total: number;
  bytesPerSec: number;
  error?: string;
}
const jobs = new Map<string, Job>();

export async function catalogStatus() {
  return Promise.all(CATALOG.map(async (m) => {
    const files = await Promise.all(m.files.map(async (f) => {
      const dest = path.join(ROOT, f.dest);
      const total = await sizeOf(f.url).catch(() => 0);
      const have = localSize(dest);
      const partial = localSize(`${dest}.part`);
      const done = have > 0 && (!total || have === total);
      return { name: path.basename(f.dest), dest: f.dest, total, have: done ? have : partial, done };
    }));
    const total = files.reduce((a, f) => a + f.total, 0);
    const have = files.reduce((a, f) => a + f.have, 0);
    const job = jobs.get(m.id);
    return {
      id: m.id, name: m.name, role: m.role, about: m.about, files, total, have,
      state: job ? "downloading" : files.every((f) => f.done) ? "installed" : have > 0 ? "partial" : "missing",
      job: job ? { file: job.file, have: job.have, total: job.total, bytesPerSec: job.bytesPerSec, error: job.error } : null,
      engine: m.engine === "strata" ? strataStatus() : undefined,
    };
  }));
}

async function fetchFile(job: Job, f: CatalogFile, modelHave: () => number) {
  const dest = path.join(ROOT, f.dest);
  const total = await sizeOf(f.url);
  if (localSize(dest) > 0 && (!total || localSize(dest) === total)) return;
  mkdirSync(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  let have = localSize(part);
  job.file = path.basename(dest);
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(f.url, { headers: have ? { Range: `bytes=${have}-` } : {}, redirect: "follow", signal: job.abort.signal });
      if (!r.ok && r.status !== 206) throw new Error(`HTTP ${r.status}`);
      if (have && r.status !== 206) have = 0; // server ignored the range: start over
      const out = createWriteStream(part, { flags: have ? "a" : "w" });
      const reader = r.body!.getReader();
      let windowStart = performance.now();
      let windowBytes = 0;
      let lastPublish = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!out.write(value)) await new Promise((res) => out.once("drain", res));
        have += value.length;
        windowBytes += value.length;
        const t = performance.now();
        if (t - windowStart > 1000) {
          job.bytesPerSec = (windowBytes / (t - windowStart)) * 1000;
          windowStart = t;
          windowBytes = 0;
        }
        if (t - lastPublish > 500) {
          lastPublish = t;
          job.have = modelHave() + have;
          publish({ type: "download", id: job.id, file: job.file, have: job.have, total: job.total, bytesPerSec: job.bytesPerSec });
        }
      }
      await new Promise<void>((res, rej) => out.end((e?: Error | null) => (e ? rej(e) : res())));
      if (total && have !== total) throw new Error(`incomplete: ${have} of ${total} bytes`);
      renameSync(part, dest);
      return;
    } catch (e) {
      if (job.abort.signal.aborted) throw e;
      if (attempt >= 20) throw e;
      have = localSize(part);
      await new Promise((r) => setTimeout(r, 3000)); // resume where it stopped
    }
  }
}

export async function startDownload(id: string) {
  const m = CATALOG.find((x) => x.id === id);
  if (!m) throw new Error(`unknown model ${id}`);
  if (jobs.has(id)) return;
  const job: Job = { id, abort: new AbortController(), file: "", have: 0, total: 0, bytesPerSec: 0 };
  jobs.set(id, job);
  const sizes = await Promise.all(m.files.map((f) => sizeOf(f.url).catch(() => 0)));
  job.total = sizes.reduce((a, b) => a + b, 0);
  publish({ type: "download", id, state: "started", total: job.total });
  (async () => {
    try {
      let doneBytes = 0;
      for (const [i, f] of m.files.entries()) {
        await fetchFile(job, f, () => doneBytes);
        doneBytes += sizes[i] || localSize(path.join(ROOT, f.dest));
      }
      jobs.delete(id);
      publish({ type: "download", id, state: "done" });
      publish({ type: "active_model", id: null }); // makes the selectors re-read which models are installed
    } catch (e) {
      jobs.delete(id);
      const cancelled = job.abort.signal.aborted;
      publish({ type: "download", id, state: cancelled ? "cancelled" : "error", error: cancelled ? undefined : (e as Error).message });
    }
  })();
}

export function cancelDownload(id: string) {
  jobs.get(id)?.abort.abort();
}

// ---------- the Strata engine (compiled from source; needs the CUDA toolkit) ----------
const STRATA = path.join(ROOT, "vendor/Strata");
let build: { proc: ChildProcess; log: string[] } | undefined;

function nvcc(): string | undefined {
  for (const p of [...(process.env.PATH ?? "").split(":").map((d) => path.join(d, "nvcc")), "/opt/cuda/bin/nvcc", "/usr/local/cuda/bin/nvcc"]) {
    if (existsSync(p)) return p;
  }
  return undefined;
}

export function strataStatus() {
  return {
    cloned: existsSync(path.join(STRATA, "setup.sh")),
    cuda: !!nvcc(),
    built: existsSync(path.join(STRATA, "run-iq2_xs.sh")),
    building: !!build,
    log: build?.log.slice(-200) ?? [],
    installCommand: "sudo pacman -S --needed base-devel cmake cuda",
  };
}

export function buildStrata() {
  if (build) return;
  if (!existsSync(path.join(STRATA, "setup.sh"))) throw new Error("Strata is not in vendor/Strata (git clone https://github.com/Niko1221/Strata vendor/Strata)");
  const cuda = nvcc();
  if (!cuda) throw new Error("The CUDA toolkit is missing. Run: sudo pacman -S --needed base-devel cmake cuda");
  const m = config.models.main.find((x) => x.engine === "strata");
  const args = ["--yes", "--family", "qwen", "--model", "IQ2_XS", "--context", String(m?.context ?? 32768), ...(m?.setup_args ?? []),
    "--no-start", "--data-dir", path.join(ROOT, "models/strata")];
  const proc = spawn("./setup.sh", args, {
    cwd: STRATA,
    env: { ...process.env, PATH: `${path.dirname(cuda)}:${process.env.PATH}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  build = { proc, log: [] };
  const onData = (b: Buffer) => {
    for (const line of b.toString().split(/\r|\n/)) {
      if (!line.trim()) continue;
      build?.log.push(line);
      publish({ type: "strata_build", line });
    }
  };
  proc.stdout?.on("data", onData);
  proc.stderr?.on("data", onData);
  proc.on("exit", (code) => {
    publish({ type: "strata_build", done: true, code });
    build = undefined;
    publish({ type: "active_model", id: null });
  });
}
