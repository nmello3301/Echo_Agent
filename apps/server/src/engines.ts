import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, type WriteStream } from "node:fs";
import path from "node:path";
import { publish } from "./bus.ts";
import { abs, config, type DecisionModel, dockerEnv, type MainModel, ROOT } from "./config.ts";

export type EngineStatus = "stopped" | "starting" | "ready" | "error";

interface Spec {
  id: string;
  name: string;
  role: "main" | "decision-llm" | "decision-server";
  cmd: string;
  args: string[];
  env?: Record<string, string>;
  healthUrl: string;
  stopCmd?: string[]; // for processes that do not stop with their client (docker)
  external?: boolean; // started by something else (Docker Compose): only wait for it to answer
  healthHeaders?: Record<string, string>;
}

export class Engine {
  spec: Spec;
  status: EngineStatus = "stopped";
  error = "";
  proc: ChildProcess | undefined;
  startedAt = 0;
  loadMs = 0;
  log: string[] = [];
  private file: WriteStream | undefined;
  private stopping = false;

  constructor(spec: Spec) {
    this.spec = spec;
  }

  get pid() {
    return this.proc?.pid;
  }

  private set(status: EngineStatus, error = "") {
    this.status = status;
    this.error = error;
    publish({ type: "engine", id: this.spec.id, status, error, loadMs: this.loadMs });
  }

  private append(chunk: Buffer) {
    this.file?.write(chunk);
    for (const line of chunk.toString().split("\n")) {
      if (!line.trim()) continue;
      this.log.push(line);
      publish({ type: "engine_log", id: this.spec.id, line });
    }
    if (this.log.length > 800) this.log.splice(0, this.log.length - 600);
  }

  async start(): Promise<void> {
    if (this.status === "ready" || this.status === "starting") return this.waitReady();
    if (await this.healthy()) {
      // Already running outside Echo (e.g. started by hand): adopt it.
      this.append(Buffer.from(`[echo] ${this.spec.id} already answering at ${this.spec.healthUrl}, adopting it\n`));
      this.set("ready");
      return;
    }
    if (this.spec.external) {
      this.append(Buffer.from(`[echo] ${this.spec.id} is started by Docker Compose; waiting for ${this.spec.healthUrl}\n`));
      this.startedAt = Date.now();
      this.set("starting");
      return this.waitReady(5 * 60_000).catch((e) => {
        this.set("error", `not answering at ${this.spec.healthUrl}`);
        throw e;
      });
    }
    const logs = abs(path.join(config.echo.paths.data, "logs"));
    mkdirSync(logs, { recursive: true });
    this.file = createWriteStream(path.join(logs, `${this.spec.id}.log`), { flags: "a" });
    this.append(Buffer.from(`[echo] starting: ${this.spec.cmd} ${this.spec.args.join(" ")}\n`));
    this.stopping = false;
    this.startedAt = Date.now();
    this.set("starting");
    // detached: its own process group, so stop() also ends the engine's children
    this.proc = spawn(this.spec.cmd, this.spec.args, {
      cwd: ROOT,
      env: { ...process.env, ...this.spec.env },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.proc.stdout?.on("data", (b: Buffer) => this.append(b));
    this.proc.stderr?.on("data", (b: Buffer) => this.append(b));
    this.proc.on("error", (e) => this.set("error", e.message));
    this.proc.on("exit", (code, signal) => {
      this.proc = undefined;
      this.file?.end();
      if (this.stopping) this.set("stopped");
      else this.set("error", `exited (code ${code ?? "-"}, signal ${signal ?? "-"}); see its log`);
    });
    return this.waitReady();
  }

  async waitReady(timeoutMs = 15 * 60_000): Promise<void> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (this.status === "error" || this.status === "stopped") throw new Error(`${this.spec.id}: ${this.error || this.status}`);
      if (this.status === "ready") return;
      if (await this.healthy()) {
        this.loadMs = Date.now() - this.startedAt;
        this.append(Buffer.from(`[echo] ${this.spec.id} ready after ${(this.loadMs / 1000).toFixed(1)} s\n`));
        this.set("ready");
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`${this.spec.id}: not ready after ${timeoutMs / 1000} s`);
  }

  async healthy(): Promise<boolean> {
    try {
      const r = await fetch(this.spec.healthUrl, { signal: AbortSignal.timeout(1500), headers: this.spec.healthHeaders });
      if (!r.ok) return false;
      const j = (await r.json().catch(() => ({}))) as { status?: string };
      return !j.status || j.status === "ok" || j.status === "loaded";
    } catch {
      return false;
    }
  }

  async stop(): Promise<void> {
    if (this.spec.external) return; // Docker Compose owns its lifecycle
    if (this.spec.stopCmd) {
      const [c, ...a] = this.spec.stopCmd;
      await new Promise((r) => spawn(c, a, { stdio: "ignore" }).on("exit", r).on("error", r));
    }
    const p = this.proc;
    if (!p?.pid) {
      if (this.status !== "stopped") this.set("stopped");
      return;
    }
    this.stopping = true;
    try {
      process.kill(-p.pid, "SIGTERM");
    } catch {}
    const t0 = Date.now();
    while (this.proc && Date.now() - t0 < 20_000) await new Promise((r) => setTimeout(r, 200));
    if (this.proc?.pid) {
      try {
        process.kill(-this.proc.pid, "SIGKILL");
      } catch {}
    }
  }

  info() {
    return {
      id: this.spec.id,
      name: this.spec.name,
      role: this.spec.role,
      status: this.status,
      error: this.error,
      pid: this.pid,
      loadMs: this.loadMs,
    };
  }
}

function llamaArgs(m: { model?: string; mmproj?: string; draft?: string; context?: number; gpu_layers?: number; threads?: number; port?: number }, extra: string[]) {
  const a = ["-m", abs(m.model!), "--host", "127.0.0.1", "--port", String(m.port), "-c", String(m.context ?? 8192), "-np", "1"];
  if (m.gpu_layers !== undefined) a.push("-ngl", String(m.gpu_layers));
  if (m.threads) a.push("-t", String(m.threads));
  if (m.mmproj && existsSync(abs(m.mmproj))) a.push("--mmproj", abs(m.mmproj));
  if (m.draft && existsSync(abs(m.draft))) a.push("--model-draft", abs(m.draft), "--spec-type", "draft-mtp");
  return [...a, ...extra];
}

// Strata fills the 6 GB card on its own: while it is the main model, the helper llama-servers
// (decision LLM, notes embed/rerank) run CPU-only instead of offloading prompt batches to the GPU.
const startModel = config.models.main.find((m) => m.id === (process.env.ECHO_MODEL ?? config.echo.default_model));
let helpersOnGpu = startModel?.engine !== "strata";

function llamaEnv(gpu: boolean): Record<string, string> {
  const bin = path.dirname(abs(config.echo.paths.llama_server));
  return { LD_LIBRARY_PATH: [bin, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":"), ...(gpu ? {} : { CUDA_VISIBLE_DEVICES: "" }) };
}

function mainSpec(m: MainModel): Spec {
  const health = `http://127.0.0.1:${m.port}/health`;
  if (m.engine === "strata") {
    // BROWSER=true: Strata's start script passes --open; Echo has its own UI, so no browser tab on every start
    return { id: m.id, name: m.name, role: "main", cmd: abs(m.command!), args: [], env: { BROWSER: "true" }, healthUrl: health };
  }
  return {
    id: m.id,
    name: m.name,
    role: "main",
    cmd: abs(config.echo.paths.llama_server),
    args: llamaArgs(m, ["--jinja", "--reasoning-format", "deepseek", "--metrics", "--cache-reuse", "256"]),
    env: llamaEnv(true),
    healthUrl: health,
  };
}

function decisionSpecs(d: DecisionModel): Spec[] {
  return [
    {
      id: d.id,
      name: d.name,
      role: "decision-llm",
      cmd: abs(config.echo.paths.llama_server),
      args: llamaArgs(d, []),
      // GPU visible even with 0 layers: weights stay in RAM, large prompt batches run on the GPU (~4x faster decisions)
      env: llamaEnv(helpersOnGpu),
      healthUrl: `http://127.0.0.1:${d.port}/health`,
    },
    {
      id: "decision-server",
      name: "Decision server (Jebadiah renderer)",
      role: "decision-server",
      cmd: path.join(ROOT, "services/decision/.venv/bin/python"),
      args: [
        path.join(ROOT, "services/decision/server.py"),
        "--port", String(config.echo.ports.decision),
        "--llama", `http://127.0.0.1:${d.port}`,
        "--model-dir", abs(d.tokenizer!),
      ],
      healthUrl: `http://127.0.0.1:${config.echo.ports.decision}/health`,
    },
  ];
}

const engines = new Map<string, Engine>();

function get(spec: Spec): Engine {
  let e = engines.get(spec.id);
  if (!e) {
    e = new Engine(spec);
    engines.set(spec.id, e);
  } else if (e.status === "stopped" || e.status === "error") {
    e.spec = spec; // pick up config edits on the next start
  }
  return e;
}

export let activeMainId: string | undefined;
let switching: Promise<void> | undefined;

/** Start a main model, stopping any other main model first (they cannot share RAM and VRAM). */
export async function useMainModel(id: string): Promise<void> {
  const m = config.models.main.find((x) => x.id === id && !x.coming_soon);
  if (!m) throw new Error(`unknown model ${id}`);
  if (m.engine !== "strata" && m.model && !existsSync(abs(m.model))) throw new Error(`${m.name}: model file not downloaded yet (${m.model})`);
  if (m.engine === "strata" && !existsSync(abs(m.command!))) throw new Error(`${m.name}: Strata is not set up yet (missing ${m.command})`);
  const run = async () => {
    for (const e of engines.values()) if (e.spec.role === "main" && e.spec.id !== id) await e.stop();
    const gpu = m.engine !== "strata";
    if (gpu !== helpersOnGpu) {
      helpersOnGpu = gpu;
      await restartHelpers();
    }
    activeMainId = id;
    publish({ type: "active_model", id });
    await get(mainSpec(m)).start();
  };
  switching = (switching ?? Promise.resolve()).catch(() => {}).then(run);
  return switching;
}

/** Restart the running helper llama-servers so they pick up helpersOnGpu. */
async function restartHelpers(): Promise<void> {
  const ids = ["rag-embed", "rag-rerank", ...config.models.decision.map((d) => d.id)];
  const running = [...engines.values()].filter((e) => ids.includes(e.spec.id) && e.status !== "stopped");
  await Promise.all(running.map((e) => e.stop()));
  const restarts: Promise<void>[] = [];
  if (running.some((e) => e.spec.role === "decision-llm")) restarts.push(startDecision());
  if (running.some((e) => e.spec.id.startsWith("rag-"))) restarts.push(startRag());
  await Promise.all(restarts.map((p) => p.catch((e) => console.error("[engines]", e.message))));
}

export function activeMain(): { model: MainModel; engine: Engine } | undefined {
  if (!activeMainId) return undefined;
  const model = config.models.main.find((x) => x.id === activeMainId);
  const engine = engines.get(activeMainId);
  return model && engine ? { model, engine } : undefined;
}

export async function startDecision(): Promise<void> {
  const d = config.models.decision.find((x) => !x.coming_soon);
  if (!d) return;
  const [llm, server] = decisionSpecs(d).map(get);
  await llm.start();
  await server.start();
}

export function decisionReady(): boolean {
  return [...engines.values()].filter((e) => e.spec.role !== "main").every((e) => e.status === "ready") &&
    engines.has("decision-server");
}

export function allEngines(): Engine[] {
  return [...engines.values()];
}

export function engineById(id: string): Engine | undefined {
  return engines.get(id);
}

/** SearXNG runs as a Docker container; Echo starts it with the other services and stops it on shutdown. */
export function searchSpec(): Spec {
  const port = config.echo.ports.search ?? 8888;
  return {
    id: "search",
    name: "Web search (SearXNG)",
    role: "decision-server",
    cmd: "docker",
    args: ["run", "--rm", "--name", "echo-searxng", "-p", `127.0.0.1:${port}:8080`,
      "-v", `${path.join(ROOT, "services/searxng/settings.yml")}:/etc/searxng/settings.yml:ro`, "searxng/searxng:latest"],
    stopCmd: ["docker", "stop", "-t", "5", "echo-searxng"],
    healthUrl: `${dockerEnv.searchUrl ?? `http://127.0.0.1:${port}`}/healthz`,
    external: dockerEnv.externalServices,
  };
}

/** The notes RAG models: small, weights in RAM, prompt batches on the GPU (small ubatch to keep VRAM low). */
function ragSpecs(): Spec[] {
  const common = ["-c", "8192", "-b", "2048", "-ub", "256", "-np", "1", "-ngl", "0", "-t", "8", "--host", "127.0.0.1"];
  return [
    { id: "rag-embed", name: "Notes embeddings (Qwen3-Embedding-0.6B)", role: "decision-server", cmd: abs(config.echo.paths.llama_server),
      args: ["-m", abs("models/rag/Qwen3-Embedding-0.6B-Q8_0.gguf"), "--embedding", "--pooling", "last", ...common, "--port", String(config.echo.ports.embed ?? 8093)],
      env: llamaEnv(helpersOnGpu), healthUrl: `http://127.0.0.1:${config.echo.ports.embed ?? 8093}/health` },
    { id: "rag-rerank", name: "Notes reranker (Qwen3-Reranker-0.6B)", role: "decision-server", cmd: abs(config.echo.paths.llama_server),
      args: ["-m", abs("models/rag/qwen3-reranker-0.6b-q8_0.gguf"), "--reranking", ...common, "--port", String(config.echo.ports.rerank ?? 8094)],
      env: llamaEnv(helpersOnGpu), healthUrl: `http://127.0.0.1:${config.echo.ports.rerank ?? 8094}/health` },
  ];
}

/** Read tab's text-to-speech: Piper and Pocket TTS (voice cloning), CPU-only (services/tts/server.py).
 * Voices download into models/ (Pocket TTS through the Hugging Face cache there); cloned voices are kept in data/. */
export function ttsSpec(): Spec {
  const port = config.echo.ports.tts ?? 8095;
  return {
    id: "tts",
    name: "Text to speech (Piper, Pocket TTS)",
    role: "decision-server",
    cmd: path.join(ROOT, "services/tts/.venv/bin/python"),
    args: [path.join(ROOT, "services/tts/server.py"), "--port", String(port), "--voices-dir", abs("models/tts"),
      "--clones-dir", abs(path.join(config.echo.paths.data, "tts/voices"))],
    env: { HF_HUB_CACHE: abs("models/tts/hf") },
    healthUrl: `http://127.0.0.1:${port}/health`,
  };
}

export async function startTts(): Promise<void> {
  await get(ttsSpec()).start();
}

export async function startRag(): Promise<void> {
  await Promise.all(ragSpecs().map((s) => get(s).start()));
}

/** Hugin's settings (.env in its folder): the API token and UI password Echo uses on your behalf. */
export function huginEnv(): Record<string, string> {
  // In Docker the root .env passes them to Echo's container directly
  if (process.env.HUGIN_UI_PASSWORD) return { HUGIN_UI_PASSWORD: process.env.HUGIN_UI_PASSWORD, HUGIN_API_TOKEN: process.env.HUGIN_API_TOKEN ?? "" };
  const f = path.join(abs(config.echo.notes?.hugin_dir ?? "vendor/HuginVoiceNotes"), ".env");
  const out: Record<string, string> = {};
  if (!existsSync(f)) return out;
  for (const l of readFileSync(f, "utf8").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(l.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** Hugin's Docker Compose stack (CPU profile): API, worker, Whisper, Ollama, ntfy. */
export function huginSpec(): Spec {
  const dir = abs(config.echo.notes?.hugin_dir ?? "vendor/HuginVoiceNotes");
  const compose = ["compose", "--project-directory", dir, "-f", path.join(dir, "docker-compose.yml"),
    "-f", path.join(ROOT, "services/hugin/compose.echo.yml"), "--profile", "cpu"];
  return {
    id: "hugin",
    name: "Hugin voice notes",
    role: "decision-server",
    cmd: "docker",
    args: [...compose, "up", "--no-build"],
    stopCmd: ["docker", ...compose, "stop"],
    healthUrl: `${dockerEnv.huginUrl ?? `http://127.0.0.1:${config.echo.ports.hugin ?? 8088}`}/api/v1/health`,
    external: dockerEnv.externalServices,
    healthHeaders: { Authorization: `Bearer ${huginEnv().HUGIN_API_TOKEN ?? ""}` },
  };
}

export async function startHugin(): Promise<void> {
  // Natively Hugin needs its own .env; in Docker its settings come from the root .env instead
  if (!dockerEnv.externalServices && !existsSync(path.join(abs(config.echo.notes?.hugin_dir ?? "vendor/HuginVoiceNotes"), ".env"))) return;
  await get(huginSpec()).start();
}

export async function startSearch(): Promise<void> {
  await get(searchSpec()).start();
}

export async function stopAll() {
  await Promise.all([...engines.values()].map((e) => e.stop()));
}
