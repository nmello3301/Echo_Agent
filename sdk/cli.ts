#!/usr/bin/env node
// Echo from the terminal: node sdk/cli.ts help
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { type ApprovalRequest, Echo, type Effort, type HitlRequest, type Run, type RunEvent, type TurnHandlers, type TurnResult } from "./index.ts";

const HELP = `Echo SDK command line (talks to Echo at $ECHO_URL, default http://127.0.0.1:7777)

  node sdk/cli.ts status                    model, engines, dev instance, live runs
  node sdk/cli.ts run [options] <task…>     start an agent run and follow it
  node sdk/cli.ts follow <run> [options]    follow a live run (--chat to keep talking to it)
  node sdk/cli.ts send <run> <text…>        send a follow-up and follow the turn
  node sdk/cli.ts resume <run>              carry on after a pause (its model was unloaded) and follow the turn
  node sdk/cli.ts runs | stop <run> | diff <run> [--from sha]

  Self-work (the agent changing Echo itself, in a working copy you review before merging):
  node sdk/cli.ts self init                 clone this repo to <Projects>/echo and link it to the live install
  node sdk/cli.ts self run [options] <task…>  a run in the working copy (gets echo_verify, echo_dev, echo_dev_request)
  node sdk/cli.ts self verify [--only server,web,tests,python]
  node sdk/cli.ts self dev start|restart|stop|status|logs [--no-build]   the copy, live at http://dev.localhost:7777
  node sdk/cli.ts self diff [--full]        what the copy changed since it was cloned or synced
  node sdk/cli.ts self branch [name] [-m msg] [--pr]  commit the copy's changes and fetch them here as a branch to review;
                                            --pr also pushes it to GitHub and prints the pull request link
  node sdk/cli.ts self sync                 fast-forward the copy to this repo's current branch

Run options:
  --cwd DIR            working folder as Echo sees it (default $ECHO_CWD, else /projects)
  --effort E           off | low | medium | high (default: echo.yaml)
  --model ID           main model id (models.yaml)
  --budget N           tool calls between decision times (echo.yaml's step_budget; 16 for self run)
  --instructions TEXT  extra system instructions for this run (@file reads a file)
  --approve P          commands that need approval: ask | yes | no | ui (default: ask in a terminal, else ui)
                       yes runs them unattended and outside the sandbox: only for tasks you trust
  --hitl P             "needs you" questions: ask | continue | stop | ui (default: ask in a terminal, else ui)
  --chat               after each turn, type a follow-up (empty line or /exit to leave, /stop to stop the run)
  --stream             print the agent's text as it is written      --thinking  also print its reasoning
  --json               one JSON event per line                       --quiet     only the final answer
  --detach             print the run id and exit`;

const opts = {
  cwd: { type: "string" }, effort: { type: "string" }, model: { type: "string" }, budget: { type: "string" },
  instructions: { type: "string" }, approve: { type: "string" }, hitl: { type: "string" }, chat: { type: "boolean" },
  stream: { type: "boolean" }, thinking: { type: "boolean" }, json: { type: "boolean" }, quiet: { type: "boolean" },
  detach: { type: "boolean" }, from: { type: "string" }, only: { type: "string" }, full: { type: "boolean" },
  "no-build": { type: "boolean" }, message: { type: "string", short: "m" }, dir: { type: "string" }, mount: { type: "string" }, pr: { type: "boolean" },
  url: { type: "string" }, help: { type: "boolean", short: "h" },
} as const;
const { values: o, positionals } = parseArgs({ options: opts, allowPositionals: true });
const echo = new Echo({ url: o.url });
const tty = process.stdin.isTTY && process.stdout.isTTY;
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------- output ----------
const c = (code: number) => (s: string) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = c(2);
const red = c(31);
const green = c(32);
const yellow = c(33);
const cyan = c(36);
let midLine = false; // a tool line or streamed text is waiting for its end
let openTool: string | undefined; // the tool call whose line is open
const out = (s: string) => {
  if (midLine) process.stdout.write("\n");
  midLine = false;
  openTool = undefined;
  console.log(s);
};
const one = (v: unknown, n = 110) => {
  const s = (typeof v === "string" ? v : JSON.stringify(v) ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};
const secs = (ms?: number) => (ms === undefined ? "" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

function toolArgs(name: string, a: any): string {
  if (!a || typeof a !== "object") return one(a);
  if (name === "bash") return one(a.command);
  if (["read", "edit", "write", "ls"].includes(name)) return one(a.path ?? a.file_path ?? "");
  if (name === "grep" || name === "find") return one(`${a.pattern ?? ""} ${a.path ?? ""}`);
  if (name === "echo_dev_request") return one(`${a.method ?? (a.json ? "POST" : "GET")} ${a.path}`);
  if (name === "echo_dev") return a.action;
  return one(a, 90);
}

function printEvent(e: RunEvent) {
  if (o.json) return console.log(JSON.stringify(e));
  if (o.quiet) return;
  switch (e.kind) {
    case "task":
      return out(`${cyan("▶")} ${one(e.task, 200)}\n  ${dim(`in ${e.cwd}${e.self ? " (Echo working copy: self-work tools on)" : ""}`)}`);
    case "user":
      return out(`${cyan("»")} ${e.text}`);
    case "note":
      return out(dim(`  · ${e.text}`));
    case "phase":
      return e.phase === "decision" ? out(dim(`  ◇ decision time: ${e.trigger}`)) : undefined;
    case "decision": {
      const a = e.applied ?? {};
      return out(dim(`  ◇ ${a.next} · progress ${a.progress} · effort ${a.effort} · p(needs you) ${(a.pHuman ?? 0).toFixed(2)} (${secs(e.latency_ms)})`));
    }
    case "todo":
      return out(dim(`  ☐ plan: ${(e.items ?? []).map((t: any) => `${t.status === "done" ? "✓" : t.status === "in_progress" ? "▸" : "·"} ${t.text}`).join("  ")}`));
    case "tool_start":
      // left open: tool_end finishes the line, unless something else is printed first
      if (midLine) process.stdout.write("\n");
      process.stdout.write(`  → ${e.name} ${dim(toolArgs(e.name, e.args))}`);
      midLine = true;
      openTool = e.id;
      return;
    case "tool_end": {
      const mark = e.isError ? red(`✗ ${secs(e.ms)}`) : green(`✓ ${secs(e.ms)}`);
      const detail = e.isError || e.name === "echo_verify" ? dim(String(e.result ?? "").split("\n").slice(0, e.isError ? 6 : 12).map((l) => `      ${l}`).join("\n")) : "";
      if (midLine && openTool === e.id) {
        process.stdout.write(`  ${mark}\n`);
        midLine = false;
      } else out(`    ${e.name} ${mark}`);
      openTool = undefined;
      if (detail) console.log(detail);
      return;
    }
    case "text_delta":
      if (o.stream) {
        process.stdout.write(e.delta);
        midLine = true;
        openTool = undefined;
      }
      return;
    case "thinking_delta":
      if (o.thinking) {
        process.stdout.write(dim(e.delta));
        midLine = true;
        openTool = undefined;
      }
      return;
    case "message":
      if (o.thinking && e.thinking && !o.stream) out(dim(e.thinking));
      if (e.text?.trim() && !o.stream) out(`${cyan("◆")} ${e.text.trim()}`);
      else if (midLine) out("");
      return;
    case "checkpoint":
      return out(dim(`  ⎇ checkpoint ${String(e.sha).slice(0, 8)} ${e.label}`));
    case "approval":
      return out(yellow(`  ? needs approval: ${e.action}${e.reason ? ` (${e.reason})` : ""}`));
    case "approval_result":
      return out(dim(`    ${e.approved ? "approved" : "not approved"}${e.reply ? `: ${e.reply}` : ""}`));
    case "hitl":
      return out(yellow(`  ? needs you: ${e.summary}`));
    case "hitl_reply":
      return out(dim(`    reply: ${e.reply ?? ""}`));
    case "revert":
      return out(yellow(`  ↶ reverted to ${String(e.sha).slice(0, 8)}`));
    case "error":
      return out(red(`  ✗ ${e.message}`));
    case "status":
      if (e.status === "waiting_approval" || e.status === "waiting_human") return out(yellow(`  … waiting (${e.status === "waiting_human" ? "a reply" : "approval"})`));
      return;
  }
}

async function ask(q: string): Promise<string> {
  if (midLine) out("");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(q)).trim();
  } finally {
    rl.close();
  }
}

/** Ask until the answer is not "?", which prints a TLDR of the request instead. */
async function askOrExplain(run: Run, requestId: string, q: string): Promise<string> {
  for (;;) {
    const a = await ask(q);
    if (a !== "?") return a;
    out(dim("    explaining…"));
    try {
      out((await run.explain(requestId)).split("\n").map((l) => `    ${l}`).join("\n"));
    } catch (e) {
      out(red(`    ✗ ${(e as Error).message}`));
    }
  }
}

function handlers(): TurnHandlers {
  const approve = o.approve ?? (tty ? "ask" : "ui");
  const hitl = o.hitl ?? (tty ? "ask" : "ui");
  if (!["ask", "yes", "no", "ui"].includes(approve)) throw new Error(`--approve: ask, yes, no or ui (not ${approve})`);
  if (!["ask", "continue", "stop", "ui"].includes(hitl)) throw new Error(`--hitl: ask, continue, stop or ui (not ${hitl})`);
  return {
    onEvent: (e) => printEvent(e),
    onApproval: async (r: ApprovalRequest, run: Run) => {
      if (approve === "yes") return true;
      if (approve === "no") return { approved: false, reply: "declined by the SDK's --approve no policy" };
      if (approve === "ui") return void out(dim("    answer it in Echo's web UI (Agent tab)"));
      const a = (await askOrExplain(run, r.id, `    approve? [y]es / [n]o${r.folder ? ` / [a]lways for ${r.folder}` : ""} / [?] TLDR / or type a reason to refuse: `)).toLowerCase();
      if (a === "y" || a === "yes") return true;
      if (r.folder && (a === "a" || a === "always")) return { approved: true, remember: true };
      return { approved: false, reply: a === "n" || a === "no" || !a ? undefined : a };
    },
    onHitl: async (r: HitlRequest, run: Run) => {
      if (hitl === "continue" || hitl === "stop") return hitl;
      if (hitl === "ui") return void out(dim("    answer it in Echo's web UI (Agent tab)"));
      return (await askOrExplain(run, r.id, `    reply (continue / re-plan / revert / stop, ? for a TLDR, or an instruction): `)) || "continue";
    },
  };
}

function finish(r: TurnResult) {
  if (o.json) return;
  const tools = r.toolCalls.length;
  const failed = r.toolCalls.filter((t) => t.isError).length;
  const line = `${r.status === "idle" ? green("✓") : r.status === "error" ? red("✗") : yellow("■")} ${r.status} after ${secs(r.durationMs)} · ${tools} tool calls${failed ? ` (${failed} failed)` : ""} · ${r.decisions} decision times`;
  if (o.quiet) console.log(r.text);
  else out(dim(line));
}

async function follow(run: Run, first: TurnResult | Promise<TurnResult>) {
  let r = await first;
  finish(r);
  if (r.status === "paused" && !o.json && !o.quiet) out(yellow(`  its model was unloaded: node sdk/cli.ts resume ${run.id} (or send it a message) to carry on`));
  while (o.chat && (r.status === "idle" || r.status === "paused")) {
    const next = await ask(cyan("» "));
    if (!next || next === "/exit") break;
    if (next === "/stop") {
      await run.stop();
      break;
    }
    r = await run.send(next, handlers());
    finish(r);
  }
  if (!o.json && !o.quiet) out(dim(`run ${run.id}: node sdk/cli.ts follow ${run.id} --chat   ·   diff: node sdk/cli.ts diff ${run.id}`));
  process.exitCode = r.status === "error" ? 1 : r.status === "stopped" ? 2 : 0;
}

function startOptions(cwd: string, task: string, defaultBudget?: number) {
  let instructions = o.instructions;
  if (instructions?.startsWith("@")) instructions = readFileSync(instructions.slice(1), "utf8");
  const budget = o.budget ? Number(o.budget) : defaultBudget;
  if (budget !== undefined && !(Number.isInteger(budget) && budget > 0)) throw new Error("--budget: a positive whole number");
  return { cwd, task, effort: o.effort as Effort | undefined, model: o.model, instructions, stepBudget: budget };
}

// Self-work runs are long and verify themselves (echo_verify, echo_dev_request), and a decision time costs ~25 s
// while the decision model runs from RAM next to the 27B: check in every 16 tool calls instead of echo.yaml's 8.
const SELF_STEP_BUDGET = 16;

async function runTask(cwd: string, words: string[], defaultBudget?: number) {
  const task = words.join(" ").trim();
  if (!task) throw new Error("what should the agent do? (the task goes after the options)");
  const h = handlers();
  const run = await echo.start(startOptions(cwd, task, defaultBudget));
  if (o.detach) return console.log(run.id);
  await follow(run, run.turn(h, 0));
}

// ---------- self-work: host-side paths and git ----------
function dotenv(): Record<string, string> {
  const f = path.join(REPO, ".env");
  const env: Record<string, string> = {};
  if (!existsSync(f)) return env;
  for (const l of readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(l);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

/** The working copy on this machine (host) and the same folder as Echo sees it (mount; differs in Docker). */
function selfPaths() {
  const env = dotenv();
  const projects = env.PROJECTS_DIR || path.join(os.homedir(), "Projects");
  const host = path.resolve(o.dir ?? process.env.ECHO_SELF_DIR ?? path.join(projects, "echo"));
  let mount = o.mount ?? process.env.ECHO_SELF_MOUNT;
  if (!mount) {
    const rel = path.relative(path.resolve(projects), host);
    mount = env.PROJECTS_DIR && !rel.startsWith("..") && !path.isAbsolute(rel)
      ? path.posix.join(env.PROJECTS_MOUNT || "/projects", ...rel.split(path.sep))
      : host;
  }
  return { host, mount };
}

const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const tryGit = (dir: string, ...args: string[]) => {
  try {
    return git(dir, ...args);
  } catch {
    return undefined;
  }
};

/** Push a branch of this repo to GitHub and print the link that opens a pull request for it (no gh CLI needed). */
async function pullRequest(name: string) {
  const remote = tryGit(REPO, "remote", "get-url", "origin");
  if (!remote) throw new Error("this repo has no origin remote to open a pull request on");
  const base = git(REPO, "rev-parse", "--abbrev-ref", "HEAD");
  tryGit(REPO, "fetch", "--quiet", "origin", base);
  // a pull request shows every commit its branch has beyond the base branch on GitHub
  const unpushed = tryGit(REPO, "rev-list", "--count", `origin/${base}..${base}`);
  if (unpushed && unpushed !== "0") {
    out(yellow(`Note: your ${base} has ${unpushed} commit(s) GitHub does not have yet; the pull request will list them too unless you push ${base} first (git push origin ${base}).`));
  }
  git(REPO, "push", "--quiet", "-u", "origin", name);
  const repo = /github\.com[:/](.+?)(?:\.git)?\/?$/.exec(remote)?.[1];
  out(`\nPushed ${cyan(name)} to origin.`);
  out(repo ? `Open the pull request: https://github.com/${repo}/compare/${base}...${name}?expand=1` : `Open a pull request for ${name} on ${remote}.`);
  out(`After merging it there: git pull, then rebuild Echo (docker compose up -d --build).`);
}

/** The commit the copy's work starts from: where it last met this repo. */
function selfBase(host: string): string {
  return tryGit(host, "merge-base", "HEAD", "@{upstream}") ?? tryGit(host, "merge-base", "HEAD", "origin/HEAD") ?? git(host, "rev-list", "--max-parents=0", "HEAD");
}

async function self(sub: string | undefined, rest: string[]) {
  const { host, mount } = selfPaths();
  if (["diff", "branch", "sync"].includes(sub ?? "") && !existsSync(path.join(host, ".git"))) {
    throw new Error(`no working copy at ${host}: run \`node sdk/cli.ts self init\` first (or pass --dir)`);
  }
  switch (sub) {
    case "init": {
      if (existsSync(path.join(host, ".git"))) out(`${host} is already a working copy; linking it again.`);
      else if (existsSync(host)) throw new Error(`${host} exists and is not a git repository; move it or pass --dir`);
      else {
        if (git(REPO, "status", "--porcelain")) out(yellow(`Note: the copy starts from this repo's last commit; uncommitted changes here are not in it.`));
        git(path.dirname(host), "clone", "--quiet", REPO, host);
        out(`Cloned ${REPO} (${git(REPO, "rev-parse", "--abbrev-ref", "HEAD")} @ ${git(host, "rev-parse", "--short", "HEAD")}) to ${host}`);
      }
      const r = await echo.self.link(mount);
      out(`Linked in ${r.dir}: ${[...r.linked, ...r.kept].join(", ") || "nothing"}`);
      for (const n of r.notes) out(dim(`  · ${n}`));
      out(`\nNext:\n  node sdk/cli.ts self run "your task"\n  node sdk/cli.ts self dev start   → ${dim("http://dev.localhost:7777")}`);
      return;
    }
    case "run":
      return runTask(mount, rest, SELF_STEP_BUDGET);
    case "verify": {
      const r = await echo.self.verify(mount, o.only?.split(",").map((s) => s.trim()) as any);
      out(r.report);
      process.exitCode = r.ok ? 0 : 1;
      return;
    }
    case "dev": {
      const action = rest[0] ?? "status";
      if (action === "start" || action === "restart") {
        out(dim(`starting the dev instance from ${mount}${o["no-build"] ? "" : " (building its UI first)"}…`));
        try {
          const d = await echo.self.dev.start(mount, !o["no-build"]);
          out(`${green("✓")} dev instance ready in ${secs(d.readyMs ?? 0)}: ${d.url}`);
        } catch (e) {
          out(red(`✗ ${(e as Error).message}`));
          out(dim(await echo.self.dev.logs(30).catch(() => "")));
          process.exitCode = 1;
        }
      } else if (action === "stop") out(`dev instance: ${(await echo.self.dev.stop()).status}`);
      else if (action === "logs") out(await echo.self.dev.logs(Number(rest[1] ?? 200)));
      else out(JSON.stringify(await echo.self.dev.status(), null, 1));
      return;
    }
    case "diff": {
      const base = selfBase(host);
      const log = git(host, "log", "--oneline", `${base}..HEAD`);
      const status = git(host, "status", "--short");
      out(`${host} since ${git(host, "log", "-1", "--format=%h %s", base)}`);
      out(log ? `\nCommits:\n${log}` : "\nNo commits yet.");
      out(status ? `\nUncommitted:\n${status}` : "\nNo uncommitted changes.");
      if (o.full) out(`\n${git(host, "diff", base)}`);
      else {
        const stat = git(host, "diff", "--stat", base);
        if (stat) out(`\n${stat}`);
      }
      return;
    }
    case "branch": {
      const name = rest[0] ?? `echo-self/${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "").replace(/^(\d{8})/, "$1-")}`;
      const base = selfBase(host);
      git(host, "add", "-A");
      const staged = tryGit(host, "diff", "--cached", "--quiet") === undefined;
      // Run again on the copy's current branch, it adds any new work to that branch (and --pr publishes it)
      const onIt = git(host, "rev-parse", "--abbrev-ref", "HEAD") === name;
      if (!onIt && !staged && git(host, "rev-list", "--count", `${base}..HEAD`) === "0") return out("The working copy has no changes to bring back.");
      if (!onIt) git(host, "switch", "-c", name);
      if (staged) git(host, "commit", "--quiet", "-m", o.message ?? `Echo self-work (${new Date().toISOString().slice(0, 10)})`);
      git(REPO, "fetch", "--quiet", host, `${name}:${name}`);
      out(`Branch ${cyan(name)} is now in ${REPO} (your checkout is unchanged):\n`);
      out(git(REPO, "log", "--oneline", `HEAD..${name}`));
      out(`\n${git(REPO, "diff", "--stat", `HEAD...${name}`)}`);
      if (!o.pr) {
        out(`\nReview: git diff HEAD...${name}\nMerge:  git merge ${name}, then rebuild: docker compose up -d --build`);
        out(`Or open a pull request on GitHub: node sdk/cli.ts self branch ${name} --pr`);
      } else await pullRequest(name);
      out(`The copy stays on ${name}; keep working there, or \`node sdk/cli.ts self sync\` after you merge.`);
      return;
    }
    case "sync": {
      if (git(host, "status", "--porcelain")) throw new Error("the copy has uncommitted changes: bring them back first (self branch) or discard them");
      const branch = git(REPO, "rev-parse", "--abbrev-ref", "HEAD");
      git(host, "fetch", "--quiet", "origin");
      const current = git(host, "rev-parse", "--abbrev-ref", "HEAD");
      if (current !== branch) git(host, "switch", "--quiet", branch);
      git(host, "merge", "--ff-only", "--quiet", `origin/${branch}`);
      out(`The copy is on ${branch} at ${git(host, "log", "-1", "--format=%h %s")}.`);
      return;
    }
    default:
      throw new Error("self: init, run, verify, dev, diff, branch or sync");
  }
}

// ---------- commands ----------
async function main() {
  const [cmd, ...rest] = positionals;
  if (o.help || !cmd || cmd === "help") return console.log(HELP);
  switch (cmd) {
    case "status": {
      const [models, engines, dev, runs] = await Promise.all([echo.models(), echo.engines(), echo.self.dev.status().catch(() => undefined), echo.runs()]);
      out(`Echo at ${echo.url} · main model ${cyan(models.active ?? "none")}`);
      for (const e of engines) out(`  ${e.status === "ready" ? green("●") : e.status === "error" ? red("●") : yellow("●")} ${e.name} ${dim(e.status + (e.error ? `: ${e.error}` : ""))}`);
      out(dev ? `Dev instance: ${dev.status}${dev.url && dev.status === "ready" ? ` at ${dev.url}` : ""}${dev.dir ? dim(` (${dev.dir})`) : ""}` : dim("Dev instance: not supported by this Echo (rebuild it)"));
      out(runs.live.length ? `Live runs:\n${runs.live.map((r) => `  ${r.id}  ${r.status.padEnd(16)} ${one(r.task, 70)}`).join("\n")}` : "No live runs.");
      return;
    }
    case "runs": {
      const runs = await echo.runs();
      for (const r of runs.live) out(`${r.id}  ${green(r.status.padEnd(16))} ${dim(r.cwd)}  ${one(r.task, 60)}`);
      for (const r of runs.past.filter((p) => !runs.live.some((l) => l.id === p.id)).slice(0, 15)) {
        out(dim(`${r.id}  ${r.status.padEnd(16)} ${new Date(r.created_at).toISOString().slice(0, 16)}  ${one(r.task, 60)}`));
      }
      return;
    }
    case "run":
      return runTask(o.cwd ?? process.env.ECHO_CWD ?? "/projects", rest);
    case "follow": {
      const run = echo.run(need(rest[0], "run id"));
      const s = await run.summary();
      if (!s) throw new Error("that run is not live (finished runs can be viewed in the UI, not followed)");
      out(dim(`${s.task.slice(0, 120)} · ${s.status}`));
      if (s.status === "idle" || s.status === "paused" || s.status === "stopped" || s.status === "error") {
        return follow(run, { status: s.status, text: "", messages: [], toolCalls: [], decisions: 0, errors: [], durationMs: 0, lastSeq: s.events });
      }
      return follow(run, run.turn(handlers(), s.events));
    }
    case "send": {
      const run = echo.run(need(rest[0], "run id"));
      return follow(run, run.send(need(rest.slice(1).join(" "), "text"), handlers()));
    }
    case "resume": {
      const run = echo.run(need(rest[0], "run id"));
      return follow(run, run.resume(handlers()));
    }
    case "stop":
      await echo.run(need(rest[0], "run id")).stop();
      return out("stopped");
    case "diff":
      return console.log((await echo.run(need(rest[0], "run id")).diff(o.from)) || "(no changes)");
    case "self":
      return self(rest[0], rest.slice(1));
    default:
      throw new Error(`unknown command ${cmd} (node sdk/cli.ts help)`);
  }
}

function need(v: string | undefined, what: string): string {
  if (!v) throw new Error(`missing ${what}`);
  return v;
}

main().catch((e) => {
  out(red(`✗ ${(e as Error).message}`));
  if ((e as any).cause?.code === "ECONNREFUSED") out(dim(`Echo is not answering at ${echo.url}`));
  process.exit(1);
});
