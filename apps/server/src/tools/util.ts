import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { config, ROOT } from "../config.ts";

let linked: string[] | undefined;
/** Folders that programs in ~/.local/bin link into (e.g. ~/.local/share/blender-5.2.2). */
function linkedToolDirs(home: string): string[] {
  if (linked) return linked;
  const dirs = new Set<string>();
  try {
    for (const e of readdirSync(`${home}/.local/bin`)) {
      try {
        const target = realpathSync(`${home}/.local/bin/${e}`);
        if (target.startsWith(`${home}/`) && !target.startsWith(`${home}/.local/bin/`)) dirs.add(path.dirname(target));
      } catch {}
    }
  } catch {}
  linked = [...dirs];
  return linked;
}

const TOOLCHAINS = (home: string) => [
  `${home}/.local/share/mise`, `${home}/.local/bin`, `${home}/.local/share/omarchy/bin`, `${home}/.cargo`, `${home}/.rustup`,
  `${home}/go`, `${home}/.config/mise`, path.join(ROOT, "services"), path.join(ROOT, "node_modules"), ...linkedToolDirs(home),
];

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Run a program (no shell) and collect its output. timeoutMs 0 = no limit (the user's rules: no time limits). */
export function run(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; input?: string; signal?: AbortSignal } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const cap = 4 * 1024 * 1024;
    p.stdout.on("data", (b) => (stdout.length < cap ? (stdout += b) : undefined));
    p.stderr.on("data", (b) => (stderr.length < cap ? (stderr += b) : undefined));
    const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; p.kill("SIGKILL"); }, opts.timeoutMs) : undefined;
    opts.signal?.addEventListener("abort", () => p.kill("SIGTERM"), { once: true });
    p.on("error", (e) => { stderr += String(e); });
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    if (opts.input !== undefined) p.stdin.end(opts.input);
    else p.stdin.end();
  });
}

/** Keep the head and tail of long output so the model sees how it starts and how it ends. */
export function clip(s: string, max = 6000): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.6);
  return `${s.slice(0, head)}\n… [${s.length - max} characters cut] …\n${s.slice(-(max - head))}`;
}

export function text(t: string) {
  return { content: [{ type: "text" as const, text: t }], details: undefined };
}

export function imageContent(file: string) {
  const ext = path.extname(file).toLowerCase();
  const mimeType = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
  return { type: "image" as const, data: readFileSync(file).toString("base64"), mimeType };
}

/** Text plus images, for tools that let the model look at something it made. */
export function withImages(t: string, files: string[]) {
  return { content: [{ type: "text" as const, text: t }, ...files.map(imageContent)], details: undefined };
}

const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

// In a container the GPU runtime mounts files inside /proc (/proc/driver/nvidia/params), and the kernel then refuses
// a fresh /proc in a user namespace. There the sandbox reuses the container's /proc: the container already isolates it.
const IN_CONTAINER = existsSync("/.dockerenv") || process.env.ECHO_EXTERNAL_SERVICES === "1";

/** bubblewrap argv: system read-only, private home and /tmp, the working folder (and extras) writable. */
export function bwrapArgs(cwd: string, opts: { network?: boolean; writable?: string[] } = {}): string[] {
  const home = process.env.HOME ?? "/home";
  const a = ["--ro-bind", "/", "/", "--dev", "/dev", ...(IN_CONTAINER ? ["--ro-bind", "/proc", "/proc"] : ["--proc", "/proc"]), "--tmpfs", "/tmp", "--tmpfs", home];
  // The home folder is hidden (keys, browser profiles, other projects); toolchains installed under it stay
  // visible read-only so node/npm (mise), blender/godot (~/.local/bin), cargo and Echo's venvs still work.
  for (const d of TOOLCHAINS(home)) if (existsSync(d)) a.push("--ro-bind", d, d);
  a.push("--bind", cwd, cwd, "--unshare-all", "--die-with-parent", "--chdir", cwd);
  for (const d of opts.writable ?? []) if (d !== cwd) a.push("--bind", d, d);
  if (opts.network || config.echo.agent.network) a.push("--share-net");
  return a;
}

/** A shell command line wrapped in bubblewrap (for Pi's bash tool). */
export function sandboxedShell(command: string, cwd: string, network: boolean, writable: string[] = []): string {
  return `bwrap ${bwrapArgs(cwd, { network, writable }).map(q).join(" ")} /bin/bash -c ${q(command)}`;
}
