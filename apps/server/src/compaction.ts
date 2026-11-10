/** Context management for agent runs. Pi compacts on its own once the context passes a threshold: it summarizes the
 *  older turns and keeps the recent ones word for word. This module sets that threshold (echo.yaml agent.compact_at,
 *  70% of the window by default) and writes the summary Echo's way: Pi's structured summary with a coding agent's focus,
 *  followed by what Echo itself knows exactly and a model would only paraphrase (the plan, the user's messages, the git
 *  checkpoints). The task itself stays in the system prompt (agent.ts). */
import {
  compact,
  type CompactionResult,
  type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { config } from "./config.ts";

export interface ContextSettings {
  /** Compact on its own (manual compaction always works) */
  auto: boolean;
  /** Compact when this share of the window is used */
  at: number;
  /** Share of the window kept word for word after a compaction */
  keep: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function contextSettings(a: { auto_compact?: boolean; compact_at?: number; keep_recent?: number } = config.echo.agent): ContextSettings {
  const at = clamp(Number(a.compact_at ?? 0.7) || 0.7, 0.3, 0.9);
  // what is kept must leave room to work before the next compaction
  return { auto: a.auto_compact !== false, at, keep: clamp(Number(a.keep_recent ?? 0.25) || 0.25, 0.05, at / 2) };
}

/** Pi's compaction settings for a window: it compacts above contextWindow - reserveTokens. The reserve never drops
 *  below one full turn (maxTokens 8192) plus slack, so small windows compact a little earlier than `at`. */
export function compactionSettings(context: number, s: ContextSettings = contextSettings()) {
  return {
    enabled: s.auto,
    reserveTokens: Math.max(10240, Math.round(context * (1 - s.at))),
    keepRecentTokens: Math.round(context * s.keep),
  };
}

/** The tokens at which a run with this window compacts */
export function compactsAt(context: number, s: ContextSettings = contextSettings()) {
  return context - compactionSettings(context, s).reserveTokens;
}

// Appended to Pi's summary prompt ("Additional focus: ..."): what a coding agent needs to carry on without the messages
export const SUMMARY_FOCUS = [
  "The summary replaces the conversation for a coding agent that keeps working on the same task without the original messages.",
  "In Progress: say exactly where the work stopped (file, function, step) and what is half done, such as an edit not yet tested or a command about to run.",
  "Critical Context: keep exact file paths with line numbers, function and variable names, the commands that worked (build, test, run), test results and error messages word for word.",
  "Leave out file contents and long tool output that can be read again; say where to find them instead.",
  "The user's task, messages and plan are kept separately, word for word: do not copy them.",
].join(" ");

// Starts the part Echo writes itself. Stripped before the summary is updated, so it never gets summarized again.
export const ECHO_PART = "\n\n---\n# Kept by Echo, word for word\n";

export interface RunState {
  plan: { text: string; status: string }[];
  /** What the user said during the run (the task excluded), oldest first */
  userMessages: { ts: number; text: string }[];
  checkpoints: { sha: string; label: string }[];
}

const MAX_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 1500;

export function echoPart(s: RunState): string {
  const mark = (st: string) => (st === "done" ? "[done]" : st === "in_progress" ? "[now]" : "[todo]");
  const out = [
    "## Plan (the todo tool's list now)",
    s.plan.length ? s.plan.map((t) => `- ${mark(t.status)} ${t.text}`).join("\n") : "(no plan written yet: write one with the todo tool)",
  ];
  if (s.userMessages.length) {
    const time = (ts: number) => new Date(ts).toISOString().slice(11, 16);
    const msgs = s.userMessages.slice(-MAX_MESSAGES).map((m) => {
      const t = m.text.length > MAX_MESSAGE_CHARS ? `${m.text.slice(0, MAX_MESSAGE_CHARS)}…` : m.text;
      return `- ${time(m.ts)} UTC: ${t}`;
    });
    if (s.userMessages.length > MAX_MESSAGES) msgs.unshift(`- (${s.userMessages.length - MAX_MESSAGES} earlier messages left out)`);
    out.push("", "## The user's messages during the run (the task is in the system prompt)", msgs.join("\n"));
  }
  if (s.checkpoints.length) {
    out.push("", "## Git checkpoints (newest last)", s.checkpoints.slice(-8).map((c) => `- ${c.sha.slice(0, 10)} ${c.label}`).join("\n"));
  }
  out.push("", "## After this summary",
    "The earlier messages are gone, file contents included. Before editing a file again, read the lines you will change: an edit needs their exact current text.");
  return ECHO_PART + out.join("\n");
}

export function stripEchoPart(summary: string | undefined): string | undefined {
  if (summary === undefined) return undefined;
  const i = summary.indexOf(ECHO_PART);
  return i < 0 ? summary : summary.slice(0, i);
}

/** Echo's compaction, for Pi's session_before_compact hook: Pi's summarizer with Echo's focus and without thinking
 *  (a summary needs none, and thinking could use up the output cap and fail the compaction), plus Echo's part. */
export async function echoCompaction(event: SessionBeforeCompactEvent, model: any, state: RunState): Promise<CompactionResult> {
  const p = event.preparation;
  // A run is one long turn (one prompt, then tool calls), so its first compaction cuts mid-turn. Pi would then write a
  // short "turn prefix" summary that takes no focus (and a second model call when there is older history too):
  // summarizing everything up to the cut in one structured summary keeps the same messages and the focus.
  const merged = p.isSplitTurn ? { messagesToSummarize: [...p.messagesToSummarize, ...p.turnPrefixMessages], turnPrefixMessages: [], isSplitTurn: false } : {};
  const preparation = { ...p, ...merged, previousSummary: stripEchoPart(p.previousSummary) };
  const focus = [SUMMARY_FOCUS, event.customInstructions ? `The user asked to focus on: ${event.customInstructions}` : ""].filter(Boolean).join("\n");
  const r = await compact(preparation, model, "local", undefined, focus, event.signal, "off");
  return { ...r, summary: r.summary + echoPart(state) };
}
