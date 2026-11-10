process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";
process.env.PI_SKIP_VERSION_CHECK = "1";

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  type AgentSession,
  createAgentSession,
  createBashToolDefinition,
  createToolSearchExtension,
  DefaultResourceLoader,
  type ExtensionAPI,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { publish } from "./bus.ts";
import { abs, config, type MainModel } from "./config.ts";
import { db, now } from "./db.ts";
import { type Answer, decisions, type Questions } from "./decision.ts";
import { activeMain, useMainModel } from "./engines.ts";
import { compactionSettings, compactsAt, contextSettings, echoCompaction } from "./compaction.ts";
import { checkpoint, diffSince, diffStat, initRepo, isRepo, revertTo } from "./git.ts";
import { effortFields, streamChat } from "./llm.ts";
import { echoCheckout } from "./selfdev.ts";
import { echoDevTools } from "./tools/echodev.ts";
import { DEFERRED_HINT, echoTools } from "./tools/index.ts";
import { sandboxedShell } from "./tools/util.ts";
import { classify, extensionDirsOnDisk, loadRules, pathVerdict, rememberExtensionDir, type Rules } from "./rules.ts";

type Effort = "off" | "low" | "medium" | "high";
type RunStatus = "starting" | "action" | "decision" | "waiting_human" | "waiting_approval" | "idle" | "done" | "stopped" | "error";

export interface TimelineEvent {
  kind: string;
  ts: number;
  [k: string]: unknown;
}

interface ToolRecord {
  id: string;
  name: string;
  args: unknown;
  started: number;
  result?: string;
  isError?: boolean;
  ms?: number;
}

interface Pending {
  id: string;
  kind: "hitl" | "approval";
  resolve: (v: { approved?: boolean; reply?: string; remember?: boolean }) => void;
}

const AGENT_DIR = abs(path.join(config.echo.paths.data, "pi"));

export interface RunOptions {
  /** Extra instructions appended to the system prompt for this run only */
  instructions?: string;
  /** Tool calls between decision times (default: agent.step_budget in echo.yaml) */
  stepBudget?: number;
}

const K = (n: number) => `${Math.round(n / 1024)}K`;
const systemAppend = (m: MainModel) => `You are Echo's coding agent, running locally on the user's own GPU (${m.name}). Your context window is
${K(m.context ?? 32768)} tokens. Past ${K(compactsAt(m.context ?? 32768))}, older turns are replaced by a summary (your plan, the user's
messages and the latest turns stay word for word), so context is your scarcest resource:
- Keep replies and tool calls short. Find code with grep or find first, then read only the lines you need (offset/limit).
- Keep a plan with the todo tool and update it as you go.
- When a subtask is done, or you are unsure how to continue, call the checkpoint tool with a short summary.
- The user's rules below say what you may do on your own. Routine actions they allow need no permission and no
  comment. Actions that need approval are paused by Echo automatically; just run them and describe them plainly.
- Compute numbers with the python tool, never from memory. Check your work (tests, linters, running the code) before saying it is done.
- The user's own notes (voice notes, meetings) are searchable with notes_search: use it when they refer to anything they said, decided or recorded, and cite (title, date).
- Look things up with web_search and fetch_page (pass a question so only the relevant part comes back) instead of guessing APIs.
- Check visual results by looking at them (screenshot, previews, read on an image file), not by assuming.
- ${DEFERRED_HINT}`;

// Added when the working folder is a working copy of Echo itself (see selfdev.ts)
const SELF_WORK = `# Working on Echo itself

The working folder is a working copy of Echo's own source: the program you are running in. A run in this folder is the
user asking you to change Echo, so you need no further permission to edit it: your changes stay in this copy until the
user reviews and merges them. Never write to the live install.
- AGENTS.md (already in your context) maps the code and its conventions: use it instead of exploring.
- After each batch of edits run echo_verify. Run the copy with echo_dev (restart after server or service changes) and
  test what you built with echo_dev_request, which also times each request.
- Never start Echo, its services or any other long-running process with bash: bash waits until the process exits.
- Commit finished, verified steps with git (git add -A && git commit -m "...") so the user can review them one by one.`;

// Sent when a turn hits the output cap (maxTokens) before any tool call: high effort can spend the whole
// turn planning, and without a nudge the run would go idle with nothing written.
const CONTINUE_AFTER_CAP = "Your last turn hit the output limit while thinking, before any tool call, so nothing was done. " +
  "Do not plan further: make your next tool call now (one file or one command), then continue step by step.";
const MAX_AUTO_CONTINUES = 3;

function short(v: unknown, n = 400): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function resultText(result: any): string {
  const c = result?.content;
  if (Array.isArray(c)) return c.map((x: any) => (x.type === "text" ? x.text : `[${x.type}]`)).join("\n");
  return typeof result === "string" ? result : JSON.stringify(result ?? "");
}

export interface ExplainInput {
  task: string;
  instruction?: string;
  plan: { text: string; status: string }[];
  /** The hitl or approval event */
  request: TimelineEvent;
  recent: { tool: string; args: string; result: string; error: boolean }[];
  messages: string[];
  checkpoint?: { sha: string; label: string };
  /** git diff --stat since that checkpoint: what "revert" would undo */
  undo: string;
  stepBudget: number;
}

/** The facts behind a request, with what each answer really does, for the model to explain to the user. */
export function explainPrompt(x: ExplainInput): string {
  const r = x.request as Record<string, any>;
  const plan = x.plan.length ? x.plan.map((t) => `${t.status === "done" ? "[done]" : t.status === "in_progress" ? "[now]" : "[todo]"} ${t.text}`).join("\n") : "(no plan written)";
  const recent = x.recent.length ? x.recent.map((t) => `- ${t.tool} ${t.args} → ${t.error ? "ERROR: " : ""}${t.result.replace(/\s+/g, " ")}`).join("\n") : "(none yet)";
  let request: string;
  if (r.kind === "hitl") {
    const revert = x.checkpoint
      ? `the working folder goes back to checkpoint ${x.checkpoint.sha.slice(0, 8)} ("${x.checkpoint.label}"), undoing ${x.undo.trim() ? `these changes:\n${x.undo.trim()}` : "nothing (no changes since then)"}\n  and the agent is told to take a different approach`
      : "there is no checkpoint yet, so nothing is undone; the agent is only told to undo its changes itself";
    request = [
      `Decision time (a small model that reviews the agent's work every ${x.stepBudget} tool calls, before risky commands and when the agent asks for a check) paused the run and asks the user.`,
      `Its judgement: next step "${r.next ?? "?"}", progress "${r.progress ?? "?"}", probability that a human is needed ${Number(r.probability ?? 0).toFixed(2)} (it asks above 0.5).`,
      r.trigger ? `What triggered the review: ${r.trigger}.` : "",
      r.queued?.length ? `A command is waiting to run: ${r.queued.join("; ")}.` : "",
      "The user's choices:",
      "- continue: the agent carries on as it was.",
      "- re-plan: the agent is told its approach is not working and must write a new plan before going on.",
      `- revert: ${revert}.`,
      "- stop: the run ends; its changes so far stay in the folder.",
      "- or type an instruction, which the agent follows.",
    ].filter(Boolean).join("\n");
  } else {
    request = [
      `The agent wants to run: ${r.action}`,
      `Echo asks first because: ${r.reason}${r.rule ? ` (the user's rule "${r.rule}")` : ""}.`,
      r.decision?.noul !== undefined ? `Decision time rated it safe and needed with probability ${Number(r.decision.noul).toFixed(2)}.` : "",
      "The user's choices:",
      "- approve: the command runs (outside the sandbox).",
      "- refuse: it does not run and the agent is told; a typed reason is passed on.",
      r.folder ? `- always allow ${r.folder}: approve, and writing in that folder never asks again.` : "",
    ].filter(Boolean).join("\n");
  }
  return [
    "Echo's coding agent is waiting for its user to answer a request. Explain the context to the user.",
    "",
    `Task: ${x.task.slice(0, 800)}`,
    x.instruction ? `Latest instruction from the user: ${x.instruction.slice(0, 400)}` : "",
    `Plan:\n${plan}`,
    `The agent's last tool calls, oldest first:\n${recent}`,
    x.messages.length ? `The agent's last words:\n${x.messages.map((m) => `"${m.slice(0, 300)}"`).join("\n")}` : "",
    "",
    `The request:\n${request}`,
    "",
    "Write a TLDR of at most 120 words, as 3 to 5 short bullets: what the agent is working on; what happened that led to this request " +
      "(name the concrete error or result); what the main choices would do here; and the choice you would make, with one reason " +
      "(say so if the facts above are not enough). Use only the facts above: do not claim progress or results they do not show. " +
      "Plain words, no preamble, no headings.",
  ].filter((l) => l !== "").join("\n");
}

function notify(title: string, body: string) {
  if (config.echo.notify.desktop) execFile("notify-send", ["-a", "Echo", "-u", "critical", title, body], () => {});
  if (config.echo.notify.ntfy_url) {
    fetch(config.echo.notify.ntfy_url, { method: "POST", body, headers: { Title: title } }).catch(() => {});
  }
}

function piModel(m: MainModel) {
  const llama = m.engine !== "strata";
  return {
    id: m.id,
    name: m.name,
    reasoning: true,
    input: m.supports_vision ? ["text", "image"] : ["text"],
    contextWindow: m.context ?? 32768,
    maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: llama
      ? {
          supportsDeveloperRole: false,
          supportsStore: false,
          thinkingFormat: "chat-template",
          chatTemplateKwargs: { enable_thinking: { $var: "thinking.enabled" }, reasoning_effort: { $var: "thinking.effort" } },
          maxTokensField: "max_tokens",
        }
      : { supportsDeveloperRole: false, supportsStore: false, supportsReasoningEffort: true, maxTokensField: "max_tokens" },
  };
}

export class AgentRun {
  id = randomUUID();
  cwd: string;
  task: string;
  status: RunStatus = "starting";
  effort: Effort;
  events: TimelineEvent[] = [];
  todo: { text: string; status: string }[] = [];
  session: AgentSession | undefined;
  startSha: string | undefined;
  lastSha: string | undefined;
  checkpoints: { sha: string; label: string; ts: number }[] = [];
  private tools = new Map<string, ToolRecord>();
  private recent: ToolRecord[] = [];
  private callsSinceDecision = 0;
  private progressHistory: string[] = [];
  private stalledInRow = 0;
  private editBatchOpen = false;
  private decisionLock: Promise<unknown> = Promise.resolve();
  private approvedCommands = new Set<string>();
  pending = new Map<string, Pending>();
  private model: MainModel | undefined;
  private instruction = "";
  private stopped = false;
  private hitCapWithoutTool = false;
  private autoContinues = 0;
  /** Pi's model object, for Echo's compaction summaries */
  private piModel: unknown;
  /** What the user said after the task, word for word: kept through compactions */
  userMessages: { ts: number; text: string }[] = [];
  private compactionStarted = 0;
  rules: Rules = loadRules();
  opts: RunOptions;
  /** The Echo working copy this run works in, if any: it gets the echo_* self-work tools and instructions */
  selfCheckout: string | undefined;

  constructor(cwd: string, task: string, effort: Effort, opts: RunOptions = {}) {
    this.cwd = path.resolve(cwd);
    this.toolset = echoTools(this.cwd);
    this.task = task;
    this.effort = effort;
    this.opts = opts;
    this.selfCheckout = echoCheckout(this.cwd);
  }

  get stepBudget() {
    return this.opts.stepBudget ?? config.echo.agent.step_budget;
  }

  emit(kind: string, data: Record<string, unknown> = {}, store = true) {
    const ev: TimelineEvent = { kind, ts: Date.now(), ...data };
    // stored events are numbered 1, 2, ... so a client can resume a stream after the last one it saw
    if (store) ev.seq = this.events.push(ev);
    publish({ type: "agent", runId: this.id, event: ev });
    if (store) this.persist();
  }

  private persistTimer: NodeJS.Timeout | undefined;
  private persist() {
    clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      db.prepare("UPDATE runs SET status=?, events=?, updated_at=? WHERE id=?").run(this.status, JSON.stringify(this.events), now(), this.id);
    }, 300);
  }

  setStatus(s: RunStatus) {
    if (this.stopped && s !== "stopped") return;
    this.status = s;
    this.emit("status", { status: s });
  }

  summary() {
    return {
      id: this.id, cwd: this.cwd, task: this.task, status: this.status, effort: this.effort,
      todo: this.todo, checkpoints: this.checkpoints, model: this.model?.id,
      pending: [...this.pending.values()].map((p) => ({ id: p.id, kind: p.kind })),
      context: this.session?.getContextUsage?.(),
      compaction: this.model ? { ...contextSettings(), window: this.model.context ?? 32768, at: compactsAt(this.model.context ?? 32768) } : undefined,
      events: this.events.length, stepBudget: this.stepBudget, self: this.selfCheckout ?? null,
    };
  }

  // ---------- checkpoints ----------
  async gitCheckpoint(label: string) {
    if (!config.echo.agent.checkpoints) return;
    if (!(await isRepo(this.cwd))) {
      await initRepo(this.cwd);
      this.emit("note", { text: "Initialised a git repository in the working folder for checkpoints (nothing is committed to your branches)." });
    }
    const sha = await checkpoint(this.cwd, label, `${this.id}/${this.checkpoints.length}`);
    this.lastSha = sha;
    this.startSha ??= sha;
    this.checkpoints.push({ sha, label, ts: Date.now() });
    this.emit("checkpoint", { sha, label });
  }

  async diff(from?: string) {
    const sha = from ?? this.startSha;
    if (!sha) return "";
    return diffSince(this.cwd, sha);
  }

  async revert(sha: string) {
    const removed = await revertTo(this.cwd, sha);
    this.emit("revert", { sha, removed });
    return removed;
  }

  /** "revert" from a needs-you card: back to the last checkpoint (taken before the latest batch of edits), and
   *  what to tell the agent about it. */
  private async revertLastBatch(): Promise<string> {
    const cp = this.checkpoints.at(-1);
    if (!cp) return "The user asked to revert, but there is no checkpoint yet: undo your recent changes yourself and take a different approach.";
    const removed = await this.revert(cp.sha);
    return `The user reverted the working folder to checkpoint ${cp.sha.slice(0, 8)} (${cp.label}): your edits since then are undone` +
      `${removed.length ? ` and the files you created since were deleted (${removed.join(", ")})` : ""}. ` +
      "Re-read a file before editing it again, and take a different approach.";
  }

  // ---------- TLDR for a pending request ----------
  private explanations = new Map<string, string>();

  /** A short explanation of a needs-you or approval request, written by the main model from the run's recent
   *  history (it is idle while the run waits). Cached per request. */
  async explain(requestId: string): Promise<string> {
    const cached = this.explanations.get(requestId);
    if (cached) return cached;
    const req = this.events.find((e) => (e.kind === "hitl" || e.kind === "approval") && e.id === requestId);
    if (!req) throw new Error("no such request in this run");
    const cp = this.checkpoints.at(-1);
    const undo = cp ? await diffStat(this.cwd, cp.sha).catch(() => "") : "";
    const messages = this.events.filter((e) => e.kind === "message" && e.text && e.ts <= req.ts).slice(-3).map((e) => String(e.text));
    const prompt = explainPrompt({
      task: this.task, instruction: this.instruction !== this.task ? this.instruction : undefined, plan: this.todo,
      request: req, recent: this.recent.slice(-12).map((r) => ({ tool: r.name, args: short(r.args, 200), result: short(r.result ?? "", 300), error: !!r.isError })),
      messages, checkpoint: cp, undo, stepBudget: this.stepBudget,
    });
    const m = this.model ?? activeMain()?.model;
    if (!m) throw new Error("no model is loaded");
    const res = await streamChat(m, { messages: [{ role: "user", content: prompt }], ...effortFields(m, "off"), max_tokens: 500 }, () => {}, new AbortController().signal, "explain");
    const text = res.content.trim();
    if (!text) throw new Error("the model returned nothing; try again");
    this.explanations.set(requestId, text);
    return text;
  }

  // ---------- human interaction ----------
  waitFor(kind: "hitl" | "approval", data: Record<string, unknown>): Promise<{ approved?: boolean; reply?: string; remember?: boolean }> {
    const id = randomUUID();
    const prev = this.status;
    this.setStatus(kind === "hitl" ? "waiting_human" : "waiting_approval");
    return new Promise((resolve) => {
      this.pending.set(id, {
        id,
        kind,
        resolve: (v) => {
          this.pending.delete(id);
          this.emit(kind === "hitl" ? "hitl_reply" : "approval_result", { id, ...v });
          this.setStatus(prev === "starting" ? "action" : prev);
          resolve(v);
        },
      });
      this.emit(kind, { id, ...data });
    });
  }

  answer(id: string, v: { approved?: boolean; reply?: string; remember?: boolean }) {
    const p = this.pending.get(id);
    if (!p) throw new Error("nothing is waiting for that answer");
    p.resolve(v);
  }

  // ---------- decision time ----------
  private async decisionTime(trigger: string, opts: { queued?: { cmd: string; why: string }[]; note?: string; modelQuestions?: string[] } = {}) {
    const run = async () => {
      this.rules = loadRules();
      this.setStatus("decision");
      this.emit("phase", { phase: "decision", trigger });
      let diff = "";
      if (this.startSha) diff = await diffStat(this.cwd, this.startSha).catch(() => "");
      const state = {
        user_rules: this.rules.summary,
        goal: this.task,
        latest_instruction: this.instruction !== this.task ? this.instruction : undefined,
        trigger,
        plan: this.todo,
        model_note: opts.note,
        recent_actions: this.recent.slice(-10).map((r) => ({
          tool: r.name, args: short(r.args, 300), result: short(r.result ?? "", 600), error: r.isError ?? false,
        })),
        diff_summary: diff.slice(-2000) || "no changes",
        queued_actions: (opts.queued ?? []).map((q) => ({ command: q.cmd, why_flagged: q.why })),
        progress_history: this.progressHistory.slice(-4),
      };
      const q: Questions = {
        done: { type: "noul", instructions: "The evidence shows the current subtask is complete.", criteria: { true: "complete, with evidence such as passing checks", false: "not complete, or no evidence yet" } },
        progress: { type: "score", instructions: "How is the agent progressing toward the goal?", criteria: ["stalled", "slow", "steady", "strong"] },
        next_step: {
          type: "choice",
          instructions: "What should the agent do next?",
          criteria: {
            continue: "keep going with the current plan",
            replan: "the plan is not working; make a new plan",
            revert: "recent changes made things worse; go back to the last checkpoint",
            research: "information is missing; read code or docs before acting",
            finish: "the goal is met; summarise and stop",
          },
        },
        effort: { type: "score", instructions: "How much reasoning effort does the next step need?", criteria: ["low", "medium", "high"] },
      };
      (opts.queued ?? []).forEach((a, i) => {
        q[`action_safe_${i}`] = { type: "noul", instructions: `This queued action is safe to run as described: ${a.cmd}`, criteria: { true: "safe and needed for the goal", false: "risky, destructive beyond the goal, or unclear" } };
      });
      (opts.modelQuestions ?? []).slice(0, 4).forEach((text, i) => {
        q[`model_q_${i}`] = { type: "noul", instructions: text, criteria: { true: "yes", false: "no" } };
      });
      const first = await decisions.decide(state, q, { source: "agent", runId: this.id });
      // needs_human is always last, on its own, with the other answers in its state
      const hitlState = { ...state, decisions: first.answers };
      const second = await decisions.decide(hitlState, {
        needs_human: { type: "noul", instructions: "Should we get a human in the loop?", criteria: { true: "the agent is blocked, unsure what the user wants, facing an irreversible or costly choice, or repeating the same failure", false: "it can proceed safely on its own" } },
      }, { source: "agent", runId: this.id });
      const answers: Record<string, Answer> = { ...first.answers, ...second.answers };
      const latency = first.latency_ms + second.latency_ms;
      this.callsSinceDecision = 0;
      this.editBatchOpen = false;
      return { answers, latency, state };
    };
    const p = this.decisionLock.then(run, run);
    this.decisionLock = p.catch(() => {});
    return p;
  }

  /** Apply decision answers; returns guidance for the model (undefined = continue silently). */
  private async apply(d: { answers: Record<string, Answer>; latency: number; state?: { trigger?: string } }, queued: { cmd: string }[] = []) {
    const a = d.answers;
    const pick = (ans: Answer | undefined) => {
      const probs = ans?.probabilities ?? {};
      return Object.entries(probs).sort((x, y) => y[1] - x[1])[0]?.[0];
    };
    const progress = ["stalled", "slow", "steady", "strong"][Number(pick(a.progress) ?? 2)];
    this.progressHistory.push(progress);
    this.stalledInRow = progress === "stalled" ? this.stalledInRow + 1 : 0;
    let next = a.next_step?.choice ?? "continue";
    if (this.stalledInRow >= config.echo.thresholds.stalled_replans && next === "continue") next = "replan";
    const effort = (["low", "medium", "high"] as const)[Math.round(a.effort?.score ?? 0)] ?? "low";
    const pHuman = a.needs_human?.noul ?? 0;
    const unsafe = queued.map((_, i) => (a[`action_safe_${i}`]?.noul ?? 0) < config.echo.thresholds.action_safe);
    if (this.effort !== "off" && this.session) {
      this.effort = effort;
      this.session.setThinkingLevel(effort);
    }
    if (a.done?.noul && a.done.noul > 0.5) {
      const open = this.todo.find((t) => t.status !== "done");
      if (open) open.status = "done";
      this.emit("todo", { items: this.todo });
    }
    this.emit("decision", { answers: a, latency_ms: d.latency, applied: { next, effort, progress, pHuman, unsafe } });
    publish({ type: "hitl_probability", runId: this.id, p: pHuman });

    const guidance: string[] = [];
    let human: string | undefined;
    if (pHuman > config.echo.thresholds.needs_human) {
      const why = [
        next !== "continue" ? `decision time suggests "${next}"` : "",
        progress === "stalled" ? "progress has stalled" : "",
        queued.length ? `queued: ${queued.map((x) => x.cmd).join("; ")}` : "",
      ].filter(Boolean).join(", ");
      const summary = `Needs you (p=${pHuman.toFixed(2)}). ${why || "The agent is unsure how to proceed."}`;
      notify("Echo needs you", `${this.task.slice(0, 80)}\n${summary}`);
      const r = await this.waitFor("hitl", {
        probability: pHuman, summary, options: ["continue", "re-plan", "revert", "stop"],
        next, progress, trigger: d.state?.trigger, queued: queued.map((x) => x.cmd),
      });
      human = (r.reply ?? "").trim();
      const row = db.prepare("INSERT INTO hitl (run_id, probability, summary, reply, created_at) VALUES (?,?,?,?,?)")
        .run(this.id, pHuman, summary, human, now());
      this.emit("hitl_logged", { rowId: Number(row.lastInsertRowid) });
      // your answer overrides decision time
      const word = human.toLowerCase();
      if (word === "stop" || this.stopped) {
        void this.stop();
        return { block: true, text: "The user stopped the run.", unsafe: queued.map(() => true), stopped: true, human };
      }
      if (word === "continue") next = "continue";
      else if (word === "re-plan" || word === "replan") {
        next = "replan";
        guidance.push("The user asked you to re-plan: your current approach is not working. Step back, look at what failed, " +
          "write a new plan with the todo tool, then continue with it.");
      } else if (word === "revert") {
        next = "revert";
        guidance.push(await this.revertLastBatch());
      } else {
        next = "continue";
        this.userMessages.push({ ts: Date.now(), text: human });
        guidance.push(`The user replied: "${human}". Follow it.`);
      }
    }
    // a queued action you chose to continue with goes on to the approval card instead of being dropped
    const finalUnsafe = human !== undefined ? queued.map(() => false) : unsafe;
    return { block: guidance.length > 0, text: guidance.join("\n"), unsafe: finalUnsafe, stopped: false, human };
  }

  // ---------- the Pi extension: action-time gate ----------
  private toolset!: ReturnType<typeof echoTools>;

  private extension = (pi: ExtensionAPI) => {
    const run = this;
    for (const t of this.toolset.core) pi.registerTool(t as any);
    if (this.selfCheckout) for (const t of echoDevTools(this.selfCheckout)) pi.registerTool(t as any);
    for (const g of this.toolset.deferred) for (const t of g.tools) pi.registerTool({ ...(t as any), exposure: "deferred", namespace: g.namespace });
    pi.registerTool({
      name: "todo",
      label: "Todo",
      description: "Replace the visible plan. Pass every item with its status (pending, in_progress, done).",
      parameters: Type.Object({
        items: Type.Array(Type.Object({ text: Type.String(), status: Type.String() })),
      }),
      execute: async (_id, params) => {
        run.todo = params.items;
        run.emit("todo", { items: run.todo });
        return { content: [{ type: "text", text: `Plan saved (${params.items.length} items).` }], details: undefined };
      },
    });
    pi.registerTool({
      name: "checkpoint",
      label: "Checkpoint",
      description: "End action time now: a subtask is done, or you want your work judged before continuing. Give a one-paragraph summary and optional yes/no questions you want judged.",
      parameters: Type.Object({
        summary: Type.String(),
        questions: Type.Optional(Type.Array(Type.String())),
      }),
      execute: async (_id, params) => {
        const d = await run.decisionTime("checkpoint tool", { note: params.summary, modelQuestions: params.questions });
        const g = await run.apply(d);
        run.setStatus("action");
        run.emit("phase", { phase: "action" });
        const mq = Object.entries(d.answers).filter(([k]) => k.startsWith("model_q_"))
          .map(([k, v]) => `${params.questions?.[Number(k.slice(8))]}: P(yes)=${(v.noul ?? 0).toFixed(2)}`);
        const text = [g.text || "Decision time: continue with the plan.", ...mq].join("\n");
        return { content: [{ type: "text", text }], details: undefined };
      },
    });
    pi.registerTool(createBashToolDefinition(this.cwd, {
      spawnHook: (ctx) => {
        if (!config.echo.agent.sandbox || run.approvedCommands.has(ctx.command)) return ctx;
        const v = classify(ctx.command, run.cwd, run.rules);
        if (v.kind === "allow" && v.unsandboxed) return ctx; // system packages and user timers need the real system
        const writable = run.rules.allow.get("write-extensions") ? extensionDirsOnDisk(run.rules) : [];
        return { ...ctx, command: sandboxedShell(ctx.command, run.cwd, v.kind === "allow" && !!v.network, writable) };
      },
    }));

    // Echo writes the compaction summary: Pi's structured summary plus the plan, the user's messages and the
    // checkpoints word for word (compaction.ts). If that fails, Pi writes its own.
    pi.on("session_before_compact", async (event) => {
      try {
        return { compaction: await echoCompaction(event, run.piModel, { plan: run.todo, userMessages: run.userMessages, checkpoints: run.checkpoints }) };
      } catch (e) {
        if (!event.signal.aborted) run.emit("note", { text: `Echo's compaction summary failed (${(e as Error).message}); Pi writes its own.` });
        return undefined;
      }
    });

    pi.on("tool_call", async (event) => {
      const name = event.toolName;
      const input = event.input as Record<string, any>;
      if (name === "checkpoint" || name === "todo") return undefined;

      // Writing outside the working folder follows rules.md (write-outside-workdir).
      if ((name === "edit" || name === "write") && input.path) {
        const target = path.resolve(run.cwd, String(input.path));
        const v = pathVerdict(target, run.cwd, run.rules);
        if (v.kind === "never") return { block: true, reason: `Blocked by the user's rules (never): ${v.why}.` };
        if (v.kind === "ask") {
          const folder = path.dirname(target);
          const r = await run.waitFor("approval", { action: `${name} ${target}`, reason: v.why, folder });
          if (!r.approved) return { block: true, reason: `The user did not approve writing ${target}.` };
          if (r.remember) {
            rememberExtensionDir(folder);
            run.rules = loadRules();
            run.emit("note", { text: `Added ${folder} to the always-writable folders in rules.md.` });
          }
        }
      }
      // A git checkpoint before each edit batch.
      if ((name === "edit" || name === "write") && !run.editBatchOpen) {
        run.editBatchOpen = true;
        await run.gitCheckpoint(`before edits (${run.checkpoints.length})`).catch((e) => run.emit("note", { text: `checkpoint failed: ${e.message}` }));
      }
      // Commands follow rules.md: allowed ones run (sandboxed), "ask" ones go to decision time and then
      // to you, "never" ones are refused.
      if (name === "bash") {
        const v = classify(String(input.command ?? ""), run.cwd, run.rules);
        if (v.kind === "never") {
          run.emit("note", { text: `Blocked by rules.md (never): ${input.command} — ${v.why}` });
          return { block: true, reason: `Blocked by the user's rules (never): ${v.why}. Do not try to work around this.` };
        }
        if (v.kind === "ask") {
          const why = v.why;
          const queued = [{ cmd: String(input.command), why }];
          const d = await run.decisionTime(`queued irreversible action (${why})`, { queued });
          const g = await run.apply(d, queued);
          if (g.stopped) return { block: true, reason: g.text };
          if (g.unsafe?.[0]) {
            run.setStatus("action");
            return { block: true, reason: `Decision time judged this action unsafe and dropped it: ${input.command}. ${g.text}` };
          }
          const r = await run.waitFor("approval", { action: String(input.command), reason: why, rule: v.category, decision: d.answers[`action_safe_0`] });
          run.setStatus("action");
          run.emit("phase", { phase: "action" });
          if (!r.approved) return { block: true, reason: `The user did not approve: ${input.command}${r.reply ? `. They said: ${r.reply}` : ""}` };
          run.approvedCommands.add(String(input.command)); // approved actions run outside the sandbox
          return g.block ? { block: true, reason: g.text } : undefined;
        }
      }
      // Step budget: decision time after N tool calls.
      run.callsSinceDecision++;
      if (run.callsSinceDecision > run.stepBudget) {
        const d = await run.decisionTime(`step budget (${run.stepBudget} tool calls)`);
        const g = await run.apply(d);
        run.setStatus("action");
        run.emit("phase", { phase: "action" });
        if (g.block) return { block: true, reason: g.text };
      }
      return undefined;
    });
  };

  // ---------- lifecycle ----------
  async start(modelId?: string) {
    db.prepare("INSERT INTO runs (id, cwd, task, model, status, events, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(this.id, this.cwd, this.task, modelId ?? null, this.status, "[]", now(), now());
    this.instruction = this.task;
    this.rules = loadRules();
    this.emit("task", { task: this.task, cwd: this.cwd, self: this.selfCheckout, stepBudget: this.stepBudget, instructions: this.opts.instructions });
    try {
      const id = modelId ?? activeMain()?.model.id ?? config.echo.default_model;
      this.emit("note", { text: `Loading ${id}…` });
      await useMainModel(id);
      const m = activeMain()!.model;
      this.model = m;
      mkdirSync(AGENT_DIR, { recursive: true });
      const modelsPath = path.join(AGENT_DIR, "models.json");
      writeFileSync(modelsPath, JSON.stringify({
        providers: { echo: { baseUrl: m.base_url, api: "openai-completions", apiKey: "local", models: [piModel(m)] } },
      }, null, 1));
      const modelRuntime = await ModelRuntime.create({ authPath: path.join(AGENT_DIR, "auth.json"), modelsPath });
      const model = modelRuntime.getModel("echo", m.id);
      if (!model) throw new Error(`Pi could not load model ${m.id}`);
      this.piModel = model;
      const settingsManager = SettingsManager.inMemory({
        enableInstallTelemetry: false,
        defaultTools: ["read", "edit", "write", "grep", "find", "ls", "bash", "tool_search"],
        compaction: compactionSettings(m.context ?? 32768), // echo.yaml agent.auto_compact, compact_at, keep_recent
        retry: { enabled: true, maxRetries: 1 },
      } as any);
      const resourceLoader = new DefaultResourceLoader({
        cwd: this.cwd,
        agentDir: AGENT_DIR,
        settingsManager,
        appendSystemPrompt: [
          systemAppend(m),
          `# The user's rules (rules.md)\n\n${this.rules.text}`,
          ...(this.selfCheckout ? [SELF_WORK] : []),
          ...(this.opts.instructions ? [`# Instructions for this run\n\n${this.opts.instructions}`] : []),
          // The task is also the first message, but compaction summarizes older messages, the task among them: here
          // its phases and constraints stay word for word for the whole run.
          `# Your task\n\nThe user's task, kept here because older messages get summarized:\n\n${this.task}`,
        ],
        extensionFactories: [this.extension, createToolSearchExtension()],
      });
      await resourceLoader.reload();
      const { session } = await createAgentSession({
        cwd: this.cwd,
        agentDir: AGENT_DIR,
        model,
        thinkingLevel: this.effort,
        modelRuntime,
        resourceLoader,
        settingsManager,
        sessionManager: SessionManager.inMemory(this.cwd),
        // No explicit allowlist: an allowlist would also hide the deferred tools from tool_search.
        // The starting set comes from the defaultTools setting; Echo's own direct tools activate on registration.
      });
      this.session = session;
      session.subscribe((e: any) => this.onEvent(e));
      await this.gitCheckpoint("run start").catch((e) => this.emit("note", { text: `checkpoint failed: ${e.message}` }));
      this.setStatus("action");
      this.emit("phase", { phase: "action" });
      void this.prompt(this.task);
    } catch (e) {
      this.emit("error", { message: (e as Error).message });
      this.setStatus("error");
    }
  }

  private async prompt(text: string) {
    try {
      await this.session!.prompt(text);
    } catch (e) {
      if (this.status !== "stopped") {
        this.emit("error", { message: (e as Error).message });
        this.setStatus("error");
      }
    }
  }

  async send(text: string) {
    if (!this.session) throw new Error("run not started");
    if (this.stopped) throw new Error("this run was stopped; start a new run");
    this.instruction = text;
    this.autoContinues = 0;
    this.userMessages.push({ ts: Date.now(), text });
    if (this.session.isStreaming) await this.session.steer(text);
    else {
      this.setStatus("action");
      void this.prompt(text);
    }
    this.emit("user", { text });
  }

  private onEvent(e: any) {
    switch (e.type) {
      case "message_update": {
        const a = e.assistantMessageEvent;
        if (a?.type === "text_delta") this.emit("text_delta", { delta: a.delta }, false);
        else if (a?.type === "thinking_delta") this.emit("thinking_delta", { delta: a.delta }, false);
        break;
      }
      case "message_end": {
        const m = e.message;
        if (m?.role !== "assistant") break;
        const text = (m.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
        const thinking = (m.content ?? []).filter((c: any) => c.type === "thinking").map((c: any) => c.thinking).join("");
        if (text || thinking) this.emit("message", { text, thinking });
        this.emitContext();
        if (m.stopReason === "error" && m.errorMessage) this.emit("error", { message: m.errorMessage });
        this.hitCapWithoutTool = m.stopReason === "length" && !(m.content ?? []).some((c: any) => c.type === "toolCall");
        break;
      }
      case "tool_execution_start": {
        this.autoContinues = 0;
        const r: ToolRecord = { id: e.toolCallId, name: e.toolName, args: e.args, started: Date.now() };
        this.tools.set(e.toolCallId, r);
        this.emit("tool_start", { id: e.toolCallId, name: e.toolName, args: e.args });
        break;
      }
      case "tool_execution_end": {
        const r = this.tools.get(e.toolCallId);
        const text = resultText(e.result);
        if (r) {
          r.result = text;
          r.isError = e.isError;
          r.ms = Date.now() - r.started;
          this.recent.push(r);
          if (this.recent.length > 30) this.recent.shift();
        }
        this.emit("tool_end", { id: e.toolCallId, name: e.toolName, result: short(text, 4000), isError: e.isError, ms: r?.ms, details: e.result?.details?.diff ? { diff: e.result.details.diff } : undefined });
        break;
      }
      case "agent_settled":
        if (this.status === "stopped" || this.status === "error") break;
        if (this.hitCapWithoutTool && this.autoContinues < MAX_AUTO_CONTINUES) {
          this.hitCapWithoutTool = false;
          this.autoContinues++;
          this.emit("note", { text: `Turn hit the output limit before any tool call; asking the model to act (${this.autoContinues}/${MAX_AUTO_CONTINUES}).` });
          void this.prompt(CONTINUE_AFTER_CAP);
          break;
        }
        this.setStatus("idle");
        break;
      case "compaction_start": {
        this.compactionStarted = Date.now();
        const u = this.session?.getContextUsage?.();
        this.emit("compaction", { phase: "start", reason: e.reason, tokens: u?.tokens ?? null, window: u?.contextWindow ?? this.model?.context });
        break;
      }
      case "compaction_end": {
        const ms = Date.now() - this.compactionStarted;
        if (e.result) {
          this.emit("compaction", { phase: "end", reason: e.reason, before: e.result.tokensBefore, after: e.result.estimatedTokensAfter ?? null, ms, summary: e.result.summary });
        } else {
          this.emit("compaction", { phase: "failed", reason: e.reason, ms, error: e.aborted ? "stopped" : e.errorMessage ?? "unknown error" });
        }
        break;
      }
    }
  }

  private emitContext() {
    const u = this.session?.getContextUsage?.();
    // unknown right after a compaction until the next reply: the meter keeps the compaction's estimate meanwhile
    if (u?.tokens != null) this.emit("context", { tokens: u.tokens, window: u.contextWindow }, false);
  }

  /** Compact now, like Claude Code's /compact. Only while the run waits for the user: mid-turn, Pi would abort the
   *  turn first (a running command included), and it compacts on its own there anyway. */
  async compactNow(focus?: string) {
    if (!this.session) throw new Error("run not started");
    if (this.stopped) throw new Error("this run was stopped");
    if (this.session.isCompacting) throw new Error("already compacting");
    // status, not only isStreaming: a message just sent has not started streaming yet
    if (this.status !== "idle" || this.session.isStreaming || this.pending.size) {
      throw new Error("the agent is working: compact when it waits for you (it compacts on its own as the context fills)");
    }
    try {
      await this.session.compact(focus?.trim() || undefined);
    } catch (e) {
      const m = (e as Error).message;
      if (/nothing to compact/i.test(m)) throw new Error("Nothing to compact yet: the whole conversation fits in what is kept word for word.");
      if (/already compacted/i.test(m)) throw new Error("Nothing new to compact since the last compaction.");
      throw e;
    }
  }

  async stop() {
    this.toolset.dispose();
    this.setStatus("stopped");
    this.stopped = true;
    for (const p of [...this.pending.values()]) p.resolve({ approved: false, reply: "stop" });
    await this.session?.abort().catch(() => {});
  }
}

export const runs = new Map<string, AgentRun>();

export async function startRun(cwd: string, task: string, effort: Effort, model?: string, opts: RunOptions = {}) {
  const r = new AgentRun(cwd, task, effort, opts);
  runs.set(r.id, r);
  void r.start(model);
  return r;
}

export function pastRuns() {
  return db.prepare("SELECT id, cwd, task, model, status, created_at, updated_at FROM runs ORDER BY created_at DESC LIMIT 50").all();
}

export function runEvents(id: string) {
  const live = runs.get(id);
  if (live) return live.events;
  const row = db.prepare("SELECT events FROM runs WHERE id=?").get(id) as { events: string } | undefined;
  return row ? JSON.parse(row.events) : [];
}

export function hitlVerdict(rowId: number, agreed: boolean) {
  db.prepare("UPDATE hitl SET agreed_needed=? WHERE id=?").run(agreed ? 1 : 0, rowId);
}
