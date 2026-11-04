// Echo SDK: drive Echo's agent from scripts and the terminal (see README.md in this folder).
// No dependencies: runs on Node 22.18+ as plain .ts (type stripping), on the host or inside the container.

export type Effort = "off" | "low" | "medium" | "high";
export type RunStatus = "starting" | "action" | "decision" | "waiting_human" | "waiting_approval" | "idle" | "done" | "stopped" | "error";

/** One entry of a run's timeline. Stored events carry `seq` (1, 2, ...); the live-only text_delta and
 *  thinking_delta events do not. Kinds: task, user, note, status, phase, message, text_delta, thinking_delta,
 *  tool_start, tool_end, todo, checkpoint, decision, approval, approval_result, hitl, hitl_reply, revert, error. */
export interface RunEvent {
  kind: string;
  ts: number;
  seq?: number;
  [k: string]: any;
}

export interface RunSummary {
  id: string;
  cwd: string;
  task: string;
  status: RunStatus;
  effort: Effort;
  todo: { text: string; status: string }[];
  checkpoints: { sha: string; label: string; ts: number }[];
  model?: string;
  pending: { id: string; kind: "hitl" | "approval" }[];
  context?: { tokens?: number | null; contextWindow?: number; percent?: number | null } | null;
  /** seq of the last stored event */
  events: number;
  stepBudget: number;
  /** The Echo working copy the run works in (self-work), or null */
  self: string | null;
}

/** A command or write that needs approval under rules.md. */
export interface ApprovalRequest {
  id: string;
  action: string;
  reason?: string;
  rule?: string;
  folder?: string;
  decision?: { noul?: number };
}
/** Decision time thinks a human should look (p = its probability). */
export interface HitlRequest {
  id: string;
  probability: number;
  summary: string;
  options: string[];
}
/** true/false, or details; undefined leaves the request open for the web UI (or another client) to answer. */
export type ApprovalAnswer = boolean | { approved: boolean; reply?: string; remember?: boolean } | undefined;
/** "continue", "re-plan", "revert", "stop", or any instruction for the agent; undefined leaves it for the UI. */
export type HitlAnswer = string | undefined;

export interface StartOptions {
  /** The working folder, as Echo sees it (inside Docker: /projects/...) */
  cwd: string;
  task: string;
  effort?: Effort;
  model?: string;
  /** Appended to the system prompt for this run only */
  instructions?: string;
  /** Tool calls between decision times (echo.yaml agent.step_budget by default) */
  stepBudget?: number;
}

export interface TurnHandlers {
  onEvent?: (e: RunEvent, run: Run) => void;
  onApproval?: (req: ApprovalRequest, run: Run) => ApprovalAnswer | Promise<ApprovalAnswer>;
  onHitl?: (req: HitlRequest, run: Run) => HitlAnswer | Promise<HitlAnswer>;
  signal?: AbortSignal;
}

export interface ToolCallRecord {
  id: string;
  name: string;
  args: unknown;
  ms?: number;
  isError?: boolean;
  result?: string;
}

export interface TurnResult {
  /** idle (the agent finished and waits for more), stopped or error */
  status: RunStatus;
  /** The last thing the agent said */
  text: string;
  messages: string[];
  toolCalls: ToolCallRecord[];
  decisions: number;
  errors: string[];
  durationMs: number;
  /** seq of the last stored event seen, to continue from */
  lastSeq: number;
}

export class EchoError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const SETTLED = new Set<RunStatus>(["idle", "done", "stopped", "error"]);
const WORKING = new Set<RunStatus>(["starting", "action", "decision", "waiting_human", "waiting_approval"]);

export class Echo {
  url: string;

  constructor(opts: { url?: string } = {}) {
    this.url = (opts.url ?? process.env.ECHO_URL ?? "http://127.0.0.1:7777").replace(/\/+$/, "");
  }

  async request<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await fetch(`${this.url}${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let j: any;
    try {
      j = text ? JSON.parse(text) : {};
    } catch {
      // an Echo older than this SDK answers unknown /api paths with its web page
      throw new EchoError(r.ok ? `${method} ${path}: not an Echo API answer (is Echo older than the SDK? rebuild it)` : `HTTP ${r.status}: ${text.slice(0, 200)}`, r.ok ? 404 : r.status);
    }
    if (!r.ok) throw new EchoError(j.error ?? `HTTP ${r.status}`, r.status);
    return j as T;
  }

  /** Server-sent events from a GET endpoint, as {event, data} pairs. */
  async *sse(path: string, signal?: AbortSignal): AsyncGenerator<{ event: string; data: any }> {
    const r = await fetch(`${this.url}${path}`, { headers: { Accept: "text/event-stream" }, signal });
    if (!r.ok || !r.body) throw new EchoError(`${path}: HTTP ${r.status}`, r.status);
    const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += value;
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let event = "message";
          let data = "";
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          if (data) yield { event, data: JSON.parse(data) };
        }
      }
    } finally {
      reader.cancel().catch(() => {});
    }
  }

  models() {
    return this.request("GET", "/api/models");
  }
  engines(): Promise<{ id: string; name: string; role: string; status: string; error: string }[]> {
    return this.request("GET", "/api/engines");
  }
  metrics() {
    return this.request("GET", "/api/metrics");
  }
  runs(): Promise<{ live: RunSummary[]; past: { id: string; cwd: string; task: string; status: string; created_at: number }[] }> {
    return this.request("GET", "/api/agent/runs");
  }

  /** Wait until the active main model answers. Returns its id. */
  async waitReady(timeoutMs = 10 * 60_000): Promise<string> {
    const t0 = Date.now();
    for (;;) {
      const { active } = await this.models();
      const e = active && (await this.engines()).find((x) => x.id === active);
      if (e?.status === "ready") return active;
      if (e?.status === "error") throw new EchoError(`${active}: ${e.error}`, 503);
      if (Date.now() - t0 > timeoutMs) throw new EchoError("the main model is not ready", 504);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  /** Start an agent run; follow it with run.turn(). */
  async start(opts: StartOptions): Promise<Run> {
    const s = await this.request<RunSummary>("POST", "/api/agent/runs", opts);
    return new Run(this, s.id);
  }

  /** A handle on an existing run. */
  run(id: string): Run {
    return new Run(this, id);
  }

  /** Start a run and wait for its first turn to finish. */
  async task(opts: StartOptions & TurnHandlers): Promise<{ run: Run; result: TurnResult }> {
    const { onEvent, onApproval, onHitl, signal, ...start } = opts;
    const run = await this.start(start);
    return { run, result: await run.turn({ onEvent, onApproval, onHitl, signal }, 0) };
  }

  /** Self-work: the agent on a working copy of Echo. Paths are as Echo sees them (/projects/... in Docker). */
  self = {
    /** Link a fresh clone to the live install's node_modules, models, venvs and llama.cpp. */
    link: (dir: string) => this.request<{ dir: string; linked: string[]; kept: string[]; notes: string[] }>("POST", "/api/self/link", { dir }),
    /** Typecheck, test and syntax-check a working copy (sandboxed). */
    verify: (dir: string, only?: ("server" | "web" | "tests" | "python")[]) => this.request<{ ok: boolean; report: string }>("POST", "/api/self/verify", { dir, only }),
    dev: {
      status: () => this.request<DevInfo>("GET", "/api/self/dev"),
      /** (Re)start the dev instance from a working copy; builds its web UI first unless buildUi is false. */
      start: (dir?: string, buildUi?: boolean) => this.request<DevInfo>("POST", "/api/self/dev/start", { dir, buildUi }),
      stop: () => this.request<DevInfo>("POST", "/api/self/dev/stop", {}),
      logs: (lines = 200) => this.request<{ log: string }>("GET", `/api/self/dev/logs?lines=${lines}`).then((r) => r.log),
    },
  };
}

export interface DevInfo {
  dir: string | null;
  port: number | null;
  status: "stopped" | "building" | "starting" | "ready" | "error";
  error: string;
  pid: number | null;
  readyMs: number | null;
  /** Open this in a browser */
  url: string | null;
}

export class Run {
  echo: Echo;
  id: string;

  constructor(echo: Echo, id: string) {
    this.echo = echo;
    this.id = id;
  }

  async summary(): Promise<RunSummary | null> {
    return (await this.echo.request<{ summary: RunSummary | null }>("GET", `/api/agent/runs/${this.id}`)).summary;
  }

  /** Every stored event so far (for finished runs too). */
  async history(): Promise<RunEvent[]> {
    return (await this.echo.request<{ events: RunEvent[] }>("GET", `/api/agent/runs/${this.id}`)).events.map((e, i) => ({ ...e, seq: i + 1 }));
  }

  /** The run's events after `after` (seq), then live ones as they happen. Reconnects (from the last seq) if the
   *  connection drops; ends when the run is no longer live on the server, or on `signal`. */
  async *events(opts: { after?: number; signal?: AbortSignal } = {}): AsyncGenerator<RunEvent> {
    let last = opts.after ?? 0;
    let failures = 0;
    while (!opts.signal?.aborted) {
      try {
        for await (const { event, data } of this.echo.sse(`/api/agent/runs/${this.id}/events?after=${last}`, opts.signal)) {
          failures = 0;
          if (event === "error") throw new EchoError(data.error, 404);
          if (event === "end") return;
          if (event !== "event") continue;
          if (typeof data.seq === "number") last = data.seq;
          yield data as RunEvent;
        }
      } catch (e) {
        if (opts.signal?.aborted || (e instanceof EchoError && e.status === 404)) throw e;
        if (++failures > 30) throw e;
        await new Promise((r) => setTimeout(r, Math.min(5000, 300 * failures)));
      }
    }
  }

  /** Follow the run until its current turn settles (idle, stopped or error), answering approvals and
   *  needs-you questions through the handlers. `after`: the seq to start from (default: now). */
  async turn(handlers: TurnHandlers = {}, after?: number): Promise<TurnResult> {
    const from = after ?? (await this.summary())?.events ?? 0;
    const t0 = Date.now();
    const res: TurnResult = { status: "starting", text: "", messages: [], toolCalls: [], decisions: 0, errors: [], durationMs: 0, lastSeq: from };
    const calls = new Map<string, ToolCallRecord>();
    let working = false;
    for await (const e of this.events({ after: from, signal: handlers.signal })) {
      if (typeof e.seq === "number") res.lastSeq = e.seq;
      handlers.onEvent?.(e, this);
      switch (e.kind) {
        case "task":
        case "user":
          working = true;
          break;
        case "message":
          if (e.text) {
            res.messages.push(e.text);
            res.text = e.text;
          }
          break;
        case "tool_start": {
          const r: ToolCallRecord = { id: e.id, name: e.name, args: e.args };
          calls.set(e.id, r);
          res.toolCalls.push(r);
          break;
        }
        case "tool_end": {
          const r = calls.get(e.id);
          if (r) Object.assign(r, { ms: e.ms, isError: e.isError, result: e.result });
          break;
        }
        case "decision":
          res.decisions++;
          break;
        case "error":
          res.errors.push(e.message);
          break;
        case "approval":
          if (handlers.onApproval) {
            const a = await handlers.onApproval(e as unknown as ApprovalRequest, this);
            if (a !== undefined) await this.answer(e.id, typeof a === "boolean" ? { approved: a } : a).catch(() => {});
          }
          break;
        case "hitl":
          if (handlers.onHitl) {
            const a = await handlers.onHitl(e as unknown as HitlRequest, this);
            if (a !== undefined) await this.answer(e.id, { reply: a }).catch(() => {});
          }
          break;
        case "status": {
          const s = e.status as RunStatus;
          res.status = s;
          if (WORKING.has(s)) working = true;
          if (s === "stopped" || s === "error" || (working && SETTLED.has(s))) {
            res.durationMs = Date.now() - t0;
            return res;
          }
          break;
        }
      }
    }
    // the stream ended: the run is no longer live on the server (Echo restarted)
    res.status = res.status === "starting" ? "stopped" : res.status;
    res.durationMs = Date.now() - t0;
    return res;
  }

  /** Send a follow-up (or steer the agent mid-turn) and follow the turn it starts. */
  async send(text: string, handlers: TurnHandlers = {}): Promise<TurnResult> {
    const from = (await this.summary())?.events ?? 0;
    await this.echo.request("POST", `/api/agent/runs/${this.id}/message`, { text });
    return this.turn(handlers, from);
  }

  answer(pendingId: string, v: { approved?: boolean; reply?: string; remember?: boolean }) {
    return this.echo.request("POST", `/api/agent/runs/${this.id}/answer`, { pendingId, ...v });
  }

  /** A short explanation of an approval or needs-you request: what led to it and what each answer would do. */
  async explain(requestId: string): Promise<string> {
    return (await this.echo.request<{ text: string }>("POST", `/api/agent/runs/${this.id}/explain`, { requestId })).text;
  }

  stop() {
    return this.echo.request("POST", `/api/agent/runs/${this.id}/stop`, {});
  }

  /** The working folder's changes since the run started (or since checkpoint `from`). */
  async diff(from?: string): Promise<string> {
    return (await this.echo.request<{ diff: string }>("GET", `/api/agent/runs/${this.id}/diff${from ? `?from=${encodeURIComponent(from)}` : ""}`)).diff;
  }

  /** Put the working folder back to a checkpoint; returns the files removed. */
  async revert(sha: string): Promise<string[]> {
    return (await this.echo.request<{ removed: string[] }>("POST", `/api/agent/runs/${this.id}/revert`, { sha })).removed;
  }
}
