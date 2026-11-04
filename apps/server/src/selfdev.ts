// Self-work: Echo working on its own source. The agent edits a working copy of Echo (a git clone in the projects
// folder, never the live tree), checks it with verify(), and runs it as a dev instance next to the live Echo:
// sandboxed, on its own ports, using the live Echo's engines, and shown at http://dev.localhost:<ui port>.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, unlinkSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import YAML from "yaml";
import { publish } from "./bus.ts";
import { attach, config, ROOT } from "./config.ts";
import { bwrapArgs, clip, run } from "./tools/util.ts";

/** Dev instance ports = the working copy's own ports + this (UI 7777 → 8777, TTS 8095 → 9095, ...). */
export const DEV_PORT_OFFSET = 1000;

/** The Echo checkout that contains dir (walking up), or undefined. The live tree itself never counts. */
export function echoCheckout(dir: string): string | undefined {
  let d = path.resolve(dir);
  for (;;) {
    if (existsSync(path.join(d, "apps/server/src/main.ts")) && existsSync(path.join(d, "echo.yaml"))) {
      return d === ROOT ? undefined : d;
    }
    const up = path.dirname(d);
    if (up === d) return undefined;
    d = up;
  }
}

function requireCheckout(dir: string): string {
  if (!path.isAbsolute(dir)) throw new Error(`expected an absolute path, got ${dir}`);
  if (path.resolve(dir) === ROOT) throw new Error("that is the live Echo; self-work happens in a separate working copy");
  const c = echoCheckout(dir);
  if (!c) throw new Error(`not an Echo working copy (no apps/server/src/main.ts and echo.yaml): ${dir}`);
  return c;
}

// ---------- linking a working copy to the live install's dependencies ----------

/** What a fresh clone lacks (all git-ignored): dependencies, models, Python venvs and llama.cpp. Linking them to
 *  the live install makes the clone runnable at once, without downloading anything. `models/` is a real folder in
 *  the copy with one link per model folder of the live install, so a model the copy's code downloads (a new
 *  models/<name>) lands in the copy, which is writable, while the live models stay read-only. */
function linkTargets(): string[] {
  const rels = ["node_modules", "vendor/llama.cpp"];
  const models = path.join(ROOT, "models");
  if (existsSync(models)) for (const m of readdirSync(models)) rels.push(`models/${m}`);
  for (const s of readdirSync(path.join(ROOT, "services"))) if (existsSync(path.join(ROOT, "services", s, ".venv"))) rels.push(`services/${s}/.venv`);
  return rels;
}
// A symlink is not a folder to git, so .gitignore's "node_modules/" would not hide it
const EXCLUDES = ["/node_modules", "/models", "/vendor/llama.cpp", "services/*/.venv", "/data", "apps/web/node_modules", "/.echo"];

export interface LinkReport {
  dir: string;
  linked: string[];
  kept: string[];
  notes: string[];
}

export function linkCheckout(dir: string): LinkReport {
  const root = requireCheckout(dir);
  const r: LinkReport = { dir: root, linked: [], kept: [], notes: [] };
  // Copies linked before models/ held one link per model had a single link to the whole folder: replace it
  const modelsLink = path.join(root, "models");
  try {
    if (lstatSync(modelsLink).isSymbolicLink() && readlinkSync(modelsLink) === path.join(ROOT, "models")) {
      unlinkSync(modelsLink);
      r.notes.push("models/ is now a folder of links to the live models, so new models download into the copy");
    }
  } catch {}
  for (const rel of linkTargets()) {
    const target = path.join(ROOT, rel);
    const link = path.join(root, rel);
    if (!existsSync(target)) continue;
    let st: ReturnType<typeof lstatSync> | undefined;
    try {
      st = lstatSync(link);
    } catch {}
    if (st?.isSymbolicLink() && readlinkSync(link) === target) r.kept.push(rel);
    else if (st) r.notes.push(`${rel} already exists in the copy (${st.isSymbolicLink() ? `links to ${readlinkSync(link)}` : "a real folder"}); left as it is`);
    else {
      mkdirSync(path.dirname(link), { recursive: true });
      symlinkSync(target, link);
      r.linked.push(rel);
    }
  }
  const gitDir = path.join(root, ".git");
  if (existsSync(path.join(gitDir, "info")) || existsSync(gitDir)) {
    const file = path.join(gitDir, "info/exclude");
    mkdirSync(path.dirname(file), { recursive: true });
    const have = existsSync(file) ? readFileSync(file, "utf8").split("\n").map((l) => l.trim()) : [];
    const add = EXCLUDES.filter((e) => !have.includes(e));
    if (add.length) appendFileSync(file, `\n# Echo self-work: links to the live install\n${add.join("\n")}\n`);
    // The agent may commit in the copy; give it an identity there (the container has none)
    const git = (...a: string[]) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8" }).trim();
    try {
      git("config", "--local", "user.name");
    } catch {
      git("config", "--local", "user.name", "Echo (self-work)");
      git("config", "--local", "user.email", "echo-self@localhost");
      r.notes.push("set a local git identity for the agent's commits: Echo (self-work) <echo-self@localhost>");
    }
  } else r.notes.push("not a git repository: Echo's checkpoints will initialise one");
  return r;
}

// ---------- verify: typecheck, tests, Python syntax ----------

export type VerifyStep = "server" | "web" | "tests" | "python";

/** Pull the useful lines out of tsc output: errors only, at most `max`. */
function tscErrors(out: string, max = 25): string[] {
  const lines = out.split("\n").filter((l) => /error TS\d+/.test(l));
  return lines.length > max ? [...lines.slice(0, max), `… and ${lines.length - max} more`] : lines;
}

/** node --test output: the summary counts plus each failing test with the first lines of its error. */
function testFailures(out: string): { summary: string; failures: string[] } {
  const summary = ["tests", "pass", "fail", "skipped"].map((k) => new RegExp(`^[#ℹ] ${k} (\\d+)`, "m").exec(out)?.[0]?.slice(2)).filter(Boolean).join(", ");
  const failures: string[] = [];
  const lines = out.split("\n");
  lines.forEach((l, i) => {
    if (/^\s*not ok \d+/.test(l) || /^\s*✖ /.test(l)) {
      const detail = lines.slice(i + 1, i + 12).filter((x) => /error|expected|actual|Error|assert/i.test(x)).slice(0, 4);
      failures.push([l.trim(), ...detail.map((d) => `    ${d.trim()}`)].join("\n"));
    }
  });
  return { summary, failures: [...new Set(failures)].slice(0, 12) };
}

/** Run the checks in a working copy, inside the agent's sandbox (no network), and return a short report. */
export async function verify(dir: string, only?: VerifyStep[]): Promise<{ ok: boolean; report: string }> {
  const root = requireCheckout(dir);
  const steps = only?.length ? only : (["server", "web", "tests", "python"] as VerifyStep[]);
  // the checks run as the live Echo would, even when a dev instance (which has these set) runs them
  const env = { ECHO_ATTACH: "", ECHO_PORT_OFFSET: "" };
  const sh = (cmd: string) => run("bwrap", [...bwrapArgs(root), "/bin/bash", "-c", cmd], { cwd: root, env, timeoutMs: 15 * 60_000 });
  const parts: string[] = [];
  let ok = true;
  for (const s of steps) {
    const t0 = Date.now();
    const secs = () => `${((Date.now() - t0) / 1000).toFixed(1)} s`;
    if (s === "server" || s === "web") {
      const r = await sh(s === "server" ? "node_modules/.bin/tsc -p apps/server && { [ ! -f sdk/tsconfig.json ] || node_modules/.bin/tsc -p sdk; }" : "node_modules/.bin/tsc -p apps/web --noEmit");
      const errs = tscErrors(r.stdout + r.stderr);
      if (r.code === 0) parts.push(`✓ typecheck ${s} (${secs()})`);
      else {
        ok = false;
        parts.push(`✗ typecheck ${s} (${secs()})\n${errs.join("\n") || clip(r.stdout + r.stderr, 1500)}`);
      }
    } else if (s === "tests") {
      const r = await sh(`node --test --test-reporter=tap --test-timeout=120000 ${existsSync(path.join(root, "apps/server/test")) ? "apps/server/test/*.test.ts" : ""}`);
      const t = testFailures(r.stdout + r.stderr);
      if (r.code === 0) parts.push(`✓ tests: ${t.summary} (${secs()})`);
      else {
        ok = false;
        parts.push(`✗ tests: ${t.summary || `exit ${r.code}`} (${secs()})\n${t.failures.join("\n") || clip(r.stdout + r.stderr, 1500)}`);
      }
    } else if (s === "python") {
      const bad: string[] = [];
      let n = 0;
      const servicesDir = path.join(root, "services");
      for (const svc of existsSync(servicesDir) ? readdirSync(servicesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : []) {
        const py = path.join(servicesDir, svc, ".venv/bin/python");
        const files = readdirSync(path.join(servicesDir, svc)).filter((f) => f.endsWith(".py"));
        if (!files.length) continue;
        n += files.length;
        const r = await sh(`${existsSync(py) ? `services/${svc}/.venv/bin/python` : "python3"} -m py_compile ${files.map((f) => `services/${svc}/${f}`).join(" ")}`);
        if (r.code !== 0) bad.push(clip(r.stderr || r.stdout, 800));
      }
      if (bad.length) {
        ok = false;
        parts.push(`✗ python syntax (${secs()})\n${bad.join("\n")}`);
      } else parts.push(`✓ python syntax, ${n} files (${secs()})`);
    }
  }
  return { ok, report: parts.join("\n") };
}

// ---------- the dev instance ----------

export type DevStatus = "stopped" | "building" | "starting" | "ready" | "error";

class DevInstance {
  dir = "";
  port = 0;
  status: DevStatus = "stopped";
  error = "";
  startedAt = 0;
  readyMs = 0;
  log: string[] = [];
  private proc: ChildProcess | undefined;
  private stopping = false;

  info() {
    return {
      dir: this.dir || null, port: this.port || null, status: this.status, error: this.error, pid: this.proc?.pid ?? null,
      readyMs: this.readyMs || null, url: this.port ? `http://dev.localhost:${config.echo.ports.ui}` : null,
    };
  }

  private set(s: DevStatus, error = "") {
    this.status = s;
    this.error = error;
    publish({ type: "dev_instance", ...this.info() });
  }

  private append(text: string) {
    for (const line of text.split("\n")) if (line.trim()) this.log.push(line);
    if (this.log.length > 2000) this.log.splice(0, this.log.length - 1500);
  }

  tail(n = 60) {
    return this.log.slice(-n).join("\n");
  }

  async start(dir: string, opts: { buildUi?: boolean } = {}) {
    const root = requireCheckout(dir);
    if (!existsSync(path.join(root, "node_modules"))) throw new Error(`${root} has no node_modules: link it first (POST /api/self/link, or \`node sdk/cli.ts self init\`)`);
    // A copy without attach mode would load its own models: a second 27B does not fit in VRAM
    if (!readFileSync(path.join(root, "apps/server/src/config.ts"), "utf8").includes("ECHO_ATTACH")) {
      throw new Error("this copy predates dev instances (no ECHO_ATTACH in apps/server/src/config.ts), so it would load a second copy of the model; update it first (node sdk/cli.ts self sync)");
    }
    await this.stop();
    this.dir = root;
    this.log = [];
    this.startedAt = Date.now();
    this.readyMs = 0;
    let ownPorts: Record<string, number> = {};
    try {
      ownPorts = (YAML.parse(readFileSync(path.join(root, "echo.yaml"), "utf8")) as { ports: Record<string, number> }).ports;
    } catch (e) {
      throw new Error(`the copy's echo.yaml does not parse: ${(e as Error).message}`);
    }
    this.port = (ownPorts.ui ?? 7777) + DEV_PORT_OFFSET;
    if (opts.buildUi !== false) {
      this.set("building");
      this.append("[echo] building the copy's web UI (vite build)…");
      const r = await run("bwrap", [...bwrapArgs(root), "/bin/bash", "-c", "cd apps/web && ../../node_modules/.bin/vite build --configLoader native --logLevel warn"], { cwd: root, timeoutMs: 5 * 60_000 });
      this.append(r.stdout + r.stderr);
      if (r.code !== 0) {
        this.set("error", "the web UI did not build; see the log");
        throw new Error(`vite build failed:\n${clip(r.stdout + r.stderr, 2500)}`);
      }
    }
    this.set("starting");
    // The copy runs in the same sandbox as the agent's commands, plus network (to reach the engines and bind its
    // port) and the GPU devices: it can write only inside the copy and models/tts (TTS voice downloads).
    const writable = [path.join(ROOT, "models/tts")].filter(existsSync).map((p) => realpathSync(p));
    const gpu = ["/dev/dxg", ...(existsSync("/dev") ? readdirSync("/dev").filter((d) => d.startsWith("nvidia")).map((d) => `/dev/${d}`) : [])].filter(existsSync);
    const args = [...bwrapArgs(root, { network: true, writable }), ...gpu.flatMap((d) => ["--dev-bind", d, d]), "node", "apps/server/src/main.ts"];
    this.append(`[echo] starting the dev instance from ${root} on port ${this.port}`);
    this.stopping = false;
    const { ECHO_DB: _db, ECHO_MODEL: _model, ...env } = process.env; // the copy keeps its own database in its data/
    const p = spawn("bwrap", args, {
      cwd: root,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...env, ECHO_ATTACH: "1", ECHO_PORT_OFFSET: String(DEV_PORT_OFFSET), ECHO_HOST: "127.0.0.1" },
    });
    this.proc = p;
    p.stdout?.on("data", (b: Buffer) => this.append(b.toString()));
    p.stderr?.on("data", (b: Buffer) => this.append(b.toString()));
    p.on("exit", (code, signal) => {
      if (this.proc === p) this.proc = undefined;
      this.append(`[echo] dev instance exited (code ${code ?? "-"}, signal ${signal ?? "-"})`);
      if (this.stopping) this.set("stopped");
      else this.set("error", `exited (code ${code ?? "-"}); see its log`);
    });
    const t0 = Date.now();
    while (Date.now() - t0 < 90_000) {
      if (!this.proc) throw new Error(`the dev instance exited while starting:\n${this.tail(40)}`);
      try {
        const r = await fetch(`http://127.0.0.1:${this.port}/api/models`, { signal: AbortSignal.timeout(1500) });
        if (r.ok) {
          this.readyMs = Date.now() - this.startedAt;
          this.set("ready");
          return this.info();
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }
    await this.stop();
    this.set("error", "did not answer within 90 s");
    throw new Error(`the dev instance did not answer within 90 s:\n${this.tail(40)}`);
  }

  async stop() {
    const p = this.proc;
    if (!p?.pid) {
      if (this.status !== "stopped" && this.status !== "error") this.set("stopped");
      return;
    }
    this.stopping = true;
    try {
      process.kill(-p.pid, "SIGTERM");
    } catch {}
    const t0 = Date.now();
    while (this.proc && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 100));
    if (this.proc?.pid) {
      try {
        process.kill(-this.proc.pid, "SIGKILL");
      } catch {}
    }
  }
}

export const dev = new DevInstance();

// ---------- http://dev.localhost:<port> → the dev instance ----------
// Browsers resolve *.localhost to this machine, so the published UI port serves both: the live Echo by its usual
// name, the dev instance under dev.localhost. The UI uses relative URLs, so it works unchanged behind the proxy.

export function isDevHost(host: string | undefined): boolean {
  return !attach.on && /^dev\.localhost(:\d+)?$/i.test(host ?? ""); // a dev instance has no dev instance of its own
}

function notRunning(res: http.ServerResponse) {
  res.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><meta charset="utf-8"><title>Echo dev instance</title><body style="font:15px system-ui;background:#111;color:#ddd;padding:3em">
<h2>No dev instance is running</h2><p>This address shows the agent's working copy of Echo while it runs.</p>
<p>Status: <b>${dev.status}</b>${dev.error ? ` (${dev.error.replace(/[<&]/g, "")})` : ""}</p>
<p>Start it with <code>node sdk/cli.ts self dev start</code>, or let the agent call <code>echo_dev</code>.</p></body>`);
}

// The dev instance gets its own address as Host: with dev.localhost it would try to proxy the request onwards itself
const devHost = () => `127.0.0.1:${dev.port}`;

export function proxyHttp(req: http.IncomingMessage, res: http.ServerResponse) {
  if (dev.status !== "ready") return notRunning(res);
  const headers = { ...req.headers, host: devHost(), "x-forwarded-host": req.headers.host };
  const up = http.request({ host: "127.0.0.1", port: dev.port, method: req.method, path: req.url, headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on("error", (e) => {
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
    res.end(`dev instance: ${e.message}`);
  });
  req.pipe(up);
}

export function proxyUpgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer) {
  if (dev.status !== "ready") return socket.destroy();
  const up = net.connect(dev.port, "127.0.0.1", () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`, `Host: ${devHost()}`, `X-Forwarded-Host: ${req.headers.host}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (!/^host$/i.test(req.rawHeaders[i])) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    up.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  const end = () => {
    up.destroy();
    socket.destroy();
  };
  up.on("error", end);
  socket.on("error", end);
}
