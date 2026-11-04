import { readFileSync, watch } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export interface MainModel {
  id: string;
  name: string;
  coming_soon?: boolean;
  engine?: "llama-server" | "strata";
  port?: number;
  base_url?: string;
  model?: string;
  mmproj?: string;
  draft?: string;
  command?: string;
  setup_args?: string[]; // Strata: extra ./setup.sh flags for this machine's VRAM
  context?: number;
  gpu_layers?: number;
  threads?: number;
  /** llama-server KV cache type for K and V (f16 by default; q8_0 halves it) */
  kv_cache?: string;
  /** Keep the vision projector in RAM instead of VRAM */
  mmproj_on_cpu?: boolean;
  supports_tools?: boolean;
  supports_vision?: boolean;
  reasoning_levels?: string[];
  max_concurrency?: number;
}

export interface DecisionModel {
  id: string;
  name: string;
  coming_soon?: boolean;
  engine?: "llama-server";
  port?: number;
  model?: string;
  context?: number;
  gpu_layers?: number;
  threads?: number;
  tokenizer?: string;
}

export interface EchoConfig {
  host: string;
  ports: { ui: number; decision: number; search: number; embed: number; rerank: number; hugin: number; tts: number; stt?: number };
  paths: { data: string; evals: string; llama_server: string };
  default_model: string;
  agent: {
    step_budget: number;
    default_effort: string;
    sandbox: boolean;
    network: boolean;
    checkpoints: boolean;
  };
  thresholds: { needs_human: number; action_safe: number; stalled_replans: number };
  notify: { desktop: boolean; ntfy_url: string };
  monitor: { interval_ms: number };
  notes: { dirs: string[]; hugin_dir: string };
  /** Live tab: speech-to-text model and CPU threads (services/stt), and the answers' default thinking level and voice */
  live?: { stt_model?: string; stt_threads?: number; effort?: string; voice?: string };
  /** Git tab: folders whose git repositories it shows, and GitHub repositories ("owner/name") for pull requests */
  git?: { dirs?: string[]; github?: string[] };
}

export interface ModelsConfig {
  main: MainModel[];
  decision: DecisionModel[];
}

/** A dev instance: a working copy of Echo that the agent edits, started by the live Echo (selfdev.ts). It uses the
 *  live Echo's engines (main model, decision model, notes RAG) and runs its own UI, TTS and any new service on ports
 *  shifted by `offset`, so both run side by side on one GPU. */
export const attach = {
  on: process.env.ECHO_ATTACH === "1",
  offset: Number(process.env.ECHO_PORT_OFFSET ?? 0) || 0,
};
// Services a dev instance shares with the live Echo instead of running its own
const SHARED_PORTS = new Set(["decision", "search", "embed", "rerank", "hugin"]);

function load<T>(file: string): T {
  const v = YAML.parse(readFileSync(path.join(ROOT, file), "utf8")) as T;
  if (file === "echo.yaml" && attach.offset) {
    const ports = (v as EchoConfig).ports as Record<string, number>;
    for (const k of Object.keys(ports)) if (!SHARED_PORTS.has(k)) ports[k] += attach.offset;
  }
  return v;
}

export const config = {
  echo: load<EchoConfig>("echo.yaml"),
  models: load<ModelsConfig>("models.yaml"),
};

/** Set by docker-compose.yml; unset when Echo runs natively (./echo up), where echo.yaml applies. */
export const dockerEnv = {
  /** Interface the UI binds to: 0.0.0.0 in a container so the published port reaches it. */
  host: process.env.ECHO_HOST,
  /** SearXNG and Hugin run as their own Compose services: Echo waits for them instead of starting them. */
  externalServices: process.env.ECHO_EXTERNAL_SERVICES === "1",
  searchUrl: process.env.ECHO_SEARCH_URL,
  huginUrl: process.env.ECHO_HUGIN_URL,
};

export function abs(p: string): string {
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}

type Listener = () => void;
const listeners: Listener[] = [];
export function onConfigChange(fn: Listener) {
  listeners.push(fn);
}

// Hot reload: a bad edit keeps the last good config and logs why.
for (const [file, key] of [["echo.yaml", "echo"], ["models.yaml", "models"]] as const) {
  let timer: NodeJS.Timeout | undefined;
  watch(path.join(ROOT, file), () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        (config as Record<string, unknown>)[key] = load(file);
        console.log(`[config] reloaded ${file}`);
        listeners.forEach((fn) => fn());
      } catch (e) {
        console.error(`[config] ${file} not reloaded: ${(e as Error).message}`);
      }
    }, 200);
  }).unref();
}

export function mainModel(id: string): MainModel | undefined {
  return config.models.main.find((m) => m.id === id && !m.coming_soon);
}
