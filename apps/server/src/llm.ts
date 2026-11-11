import { Agent, fetch as undiciFetch } from "undici";
import type { MainModel } from "./config.ts";
import { ArrivalRate, applyTimings, live, type Timings } from "./stats.ts";

// The engine serves one request at a time, so a request can wait minutes behind a long answer, and a long
// prompt can take minutes to read. Node's fetch gives up after 300 s without headers; engines get no limit.
export const engineDispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
export const engineFetch = (url: string, init: RequestInit = {}) =>
  undiciFetch(url, { ...(init as any), dispatcher: engineDispatcher }) as unknown as Promise<Response>;

export type Effort = "off" | "low" | "medium" | "high";

/** Request fields that set reasoning effort, per engine. Strata takes OpenAI's reasoning_effort
 *  off/low/medium/high. llama-server takes reasoning_effort for the template and, for "off",
 *  the template switch enable_thinking=false. */
export function effortFields(model: MainModel, effort: Effort): Record<string, unknown> {
  if (model.engine === "strata") return { reasoning_effort: effort };
  if (effort === "off") return { chat_template_kwargs: { enable_thinking: false } };
  return { reasoning_effort: effort, chat_template_kwargs: { enable_thinking: true } };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface StreamResult {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  timings?: Timings;
  ttftMs: number | null;
  finishReason?: string;
  aborted: boolean;
  /** Why Echo cut it off, when it did (its model was unloaded): "Qwen3.8 27B was unloaded" */
  stopped?: string;
}

// Requests on their way to a main model, so unloading the model can cut them off at once (stopMain in engines.ts)
const inflight = new Set<{ model: string; ac: AbortController }>();

/** Abort every request to this main model; the callers get an `aborted` result with `stopped` set to the reason. */
export function abortEngineRequests(modelId: string, reason: string): number {
  let n = 0;
  for (const r of inflight) {
    if (r.model !== modelId) continue;
    r.ac.abort(reason);
    n++;
  }
  return n;
}

/** Stream an OpenAI-compatible chat completion, calling onDelta for text and reasoning deltas. */
export async function streamChat(
  model: MainModel,
  body: Record<string, unknown>,
  onDelta: (d: { content?: string; reasoning?: string }) => void,
  signal: AbortSignal,
  source: string,
): Promise<StreamResult> {
  const t0 = performance.now();
  const res: StreamResult = { content: "", reasoning: "", toolCalls: [], ttftMs: null, aborted: false };
  const rate = new ArrivalRate();
  const cut = { model: model.id, ac: new AbortController() };
  inflight.add(cut);
  const either = AbortSignal.any([signal, cut.ac.signal]);
  Object.assign(live, { active: true, source, decodeTps: null, ttftMs: null, generated: 0 });
  try {
    const r = await engineFetch(`${model.base_url}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer local" },
      body: JSON.stringify({ ...body, stream: true, timings_per_token: true, stream_options: { include_usage: true } }),
      signal: either,
    });
    if (!r.ok || !r.body) throw new Error(`engine answered ${r.status}: ${(await r.text()).slice(0, 500)}`);
    const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        let j: any;
        try {
          j = JSON.parse(data);
        } catch {
          continue;
        }
        if (j.error) throw new Error(j.error.message ?? JSON.stringify(j.error));
        const delta = j.choices?.[0]?.delta ?? {};
        const content: string | undefined = delta.content ?? undefined;
        const reasoning: string | undefined = delta.reasoning_content ?? delta.reasoning ?? undefined;
        if (content || reasoning) {
          if (res.ttftMs === null) {
            res.ttftMs = performance.now() - t0;
            live.ttftMs = res.ttftMs;
          }
          if (content) res.content += content;
          if (reasoning) res.reasoning += reasoning;
          onDelta({ content, reasoning });
          const est = rate.tick();
          if (!j.timings && est) live.decodeTps = est;
          if (!j.timings) live.generated++;
        }
        // tool calls arrive in pieces: the id and name first, then the arguments a few characters at a time
        for (const tc of delta.tool_calls ?? []) {
          const t = (res.toolCalls[tc.index ?? 0] ??= { id: "", type: "function", function: { name: "", arguments: "" } });
          if (tc.id) t.id = tc.id;
          if (tc.function?.name) t.function.name = tc.function.name;
          if (tc.function?.arguments) t.function.arguments += tc.function.arguments;
        }
        if (j.choices?.[0]?.finish_reason) res.finishReason = j.choices[0].finish_reason;
        if (j.timings) {
          res.timings = j.timings;
          applyTimings(j.timings, model.context);
        }
      }
    }
  } catch (e) {
    if (!either.aborted) throw e;
    res.aborted = true;
    if (cut.ac.signal.aborted && !signal.aborted) res.stopped = String(cut.ac.signal.reason);
  } finally {
    inflight.delete(cut);
    live.active = false;
  }
  return res;
}
