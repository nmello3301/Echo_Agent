// Live tab: hands-free voice chat (docs/live-chat.md). One turn: the user's utterance (WAV) → speech to text
// (services/stt, faster-whisper on the CPU) → the main model, streamed → speakable chunks → text to speech (Piper)
// per chunk, each sent back the moment it is ready, so Echo starts talking while the model is still writing.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { abs, config, type MainModel } from "./config.ts";
import { db, now } from "./db.ts";
import { type Answer, decisions, type Questions } from "./decision.ts";
import { activeMain, activeMainId, startStt, useMainModel } from "./engines.ts";
import { getPersona, type Persona, type ReplyLength } from "./personas.ts";
import { type Effort, effortFields, type StreamResult, streamChat, type ToolCall } from "./llm.ts";
import { chatWithWeb } from "./webchat.ts";

const LENGTH_RULE: Record<ReplyLength, string> = {
  short: "- Answer in one to three short sentences of plain spoken English, starting with the answer itself.",
  medium: "- Answer in up to six sentences of plain spoken English, starting with the answer itself.",
  long: "- Answer as fully as the question needs, in plain spoken English and short sentences, starting with the answer itself.",
};
// Room for the answer (thinking adds its own): 400 tokens never cut a three-sentence answer
const REPLY_TOKENS: Record<ReplyLength, number> = { short: 400, medium: 700, long: 1400 };

function helperRule(chat: boolean, decide: boolean): string {
  if (chat && decide) return `- You can hand a question to the chat model (ask_chat) or the decide model (decide). Answer directly whenever a few
  sentences will do. Use ask_chat for questions that need careful reasoning, current facts or a detailed answer, and
  decide when the user wants a judgement or a decision. Always use them when the user asks you to.`;
  if (chat) return "- You can hand a question to the chat model (ask_chat). Answer directly whenever a few sentences will do. Use ask_chat for " +
    "questions that need careful reasoning, current facts or a detailed answer, and always when the user asks you to.";
  if (decide) return "- You can ask the decide model (decide) when the user wants a judgement or a decision, and always when they ask you to.";
  return "";
}

/** Live's system prompt: Echo's own, or a persona's instructions above the same spoken-style rules (whatever a
 *  persona is told, its answers must stay speakable). */
export function systemPrompt(p?: Persona): string {
  const helpers = p?.helpers ?? { chat: true, decide: true };
  const rules = [
    LENGTH_RULE[p?.length ?? "short"],
    "- No markdown, lists, headings, code, emoji or links. Write numbers, units and symbols the way they are said.",
    ...(p?.length === "long" ? [] : ["- If a full answer would be long, give the gist and offer to say more."]),
    "- If the user's words make no sense (a speech recognition slip), say what you heard and ask them to repeat.",
    helperRule(helpers.chat, helpers.decide),
  ].filter(Boolean).join("\n");
  const intro = `You are ${p?.name ?? "Echo"}, talking with the user by voice: everything you write is spoken aloud.`;
  return p?.prompt ? `${intro}\n\n${p.prompt}\n\nHow to talk:\n${rules}` : `${intro}\n${rules}`;
}

// The voice model's tools: the Chat tab's model (thinking, optionally the web) and the Decide tab's model
const LIVE_TOOLS = [
  {
    type: "function",
    function: {
      name: "ask_chat",
      description: "Hand a question to the chat model, which thinks it through carefully (and can search the web) and writes a full answer. " +
        "It takes several seconds. For questions that need careful reasoning, up-to-date facts or detail.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "The question, written to stand on its own (include what was said before if it matters)" },
          web: { type: "boolean", description: "Search the web first: for news, prices, schedules and other current facts" },
        },
        required: ["question"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "decide",
      description: "Ask the decide model, a small model trained to judge, for a calibrated probability: yes or no, or which of a few options. " +
        "For decisions and judgements (should I..., which is better..., is it likely...).",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "The yes/no question or the decision, with the facts that matter" },
          options: { type: "array", items: { type: "string" }, description: "2 to 6 options to choose from; leave out for a yes/no question" },
        },
        required: ["question"],
      },
    },
  },
];
const CHAT_EFFORT: Effort = "medium";

/** The tools a persona may use (all of them without one), as request fields */
export function liveTools(p?: Persona) {
  const tools = LIVE_TOOLS.filter((t) => (t.function.name === "decide" ? (p?.helpers.decide ?? true) : (p?.helpers.chat ?? true)));
  return tools.length ? { tools } : {};
}

/** A persona's generation settings for a request: reply room and, when it set one, the temperature */
function replyFields(p: Persona | undefined, effort: Effort) {
  const room = REPLY_TOKENS[p?.length ?? "short"];
  return { max_tokens: effort === "off" ? room : room + 1100, ...(p?.temperature != null ? { temperature: p.temperature } : {}) };
}

/** The Decide tab's question format for a spoken decision: a choice between options, or yes/no. */
export function decideQuestions(question: string, options?: unknown): Questions {
  const opts = (Array.isArray(options) ? options : []).map(String).map((o) => o.trim()).filter(Boolean).slice(0, 6);
  if (opts.length >= 2) {
    return { answer: { type: "choice", instructions: question, criteria: Object.fromEntries(opts.map((o, i) => [String.fromCharCode(65 + i), o])) } };
  }
  return { answer: { type: "noul", instructions: question, criteria: { true: "yes", false: "no" } } };
}

/** The decide model's answer in words, for the voice model to summarize. */
export function describeDecision(a: Answer | undefined, options?: unknown): string {
  if (!a) return "no answer";
  if (a.type === "noul") {
    const p = a.noul ?? 0;
    return `${p >= 0.5 ? "yes" : "no"} (probability of yes: ${Math.round(p * 100)} percent)`;
  }
  const opts = (Array.isArray(options) ? options : []).map(String);
  return Object.entries(a.probabilities ?? {}).sort((x, y) => y[1] - x[1])
    .map(([k, v]) => `${opts[k.charCodeAt(0) - 65] ?? k}: ${Math.round(v * 100)} percent`).join(", ");
}

/** Does the spoken summary say which model it checked? (The user always hears it.) */
export const mentionsModel = (text: string, model: "chat" | "decide") => new RegExp(`\\b(?:${model === "chat" ? "chat" : "decide|decision"}) model\\b`, "i").test(text);

interface ToolUse {
  model: "chat" | "decide";
  /** What goes back to the voice model */
  result: string;
  detail: Record<string, unknown>;
  ms: number;
}

/** Keep a chat-model answer in the Chat tab, where the user can read it in full. */
function saveChat(question: string, res: StreamResult, modelId: string): string {
  const id = randomUUID();
  db.prepare("INSERT INTO conversations (id, title, model, created_at, updated_at) VALUES (?,?,?,?,?)").run(id, `Live: ${question.slice(0, 54)}`, modelId, now(), now());
  db.prepare("INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?,?,?,?)").run(id, "user", JSON.stringify(question), now());
  db.prepare("INSERT INTO messages (conversation_id, role, content, reasoning, stats, created_at) VALUES (?,?,?,?,?,?)")
    .run(id, "assistant", JSON.stringify(res.content), res.reasoning || null, JSON.stringify({ ...res.timings, model: modelId, effort: CHAT_EFFORT, source: "live" }), now());
  return id;
}

async function runTool(call: ToolCall, lastQuestion: string, signal: AbortSignal, pick?: string): Promise<ToolUse> {
  const t = performance.now();
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(call.function.arguments || "{}");
  } catch {}
  const question = String(args.question ?? "").trim() || lastQuestion;
  if (call.function.name === "decide") {
    const d = await decisions.decide({ question, asked_by_voice: lastQuestion }, decideQuestions(question, args.options), { source: "live" });
    const said = describeDecision(d.answers.answer, args.options);
    return {
      model: "decide", detail: { question, answer: said }, ms: Math.round(performance.now() - t),
      result: `The decide model's answer to "${question}": ${said}. Tell the user in one or two short spoken sentences, then say you checked the decide model.`,
    };
  }
  // the same model as the voice (only one fits on the GPU), thinking this time
  const m = await mainModel(pick);
  const req = { messages: [{ role: "user", content: question }], ...effortFields(m, CHAT_EFFORT), cache_prompt: true };
  const res: StreamResult = args.web
    ? await chatWithWeb(m, req, async () => {}, async () => {}, signal, 1)
    : await streamChat(m, req, () => {}, signal, "live-chat");
  if (res.stopped) throw new Error(`Stopped: ${res.stopped}.`);
  const conversationId = saveChat(question, res, m.id);
  return {
    model: "chat", detail: { question, conversationId, web: !!args.web, chars: res.content.length }, ms: Math.round(performance.now() - t),
    result: `The chat model's full answer:\n${res.content.slice(0, 6000)}\n\nSummarize it for the user in two or three short spoken sentences, ` +
      "then say you checked the chat model and that the full answer is in the Chat tab.",
  };
}

const MAX_MESSAGES = 40; // 20 exchanges; older ones drop off the front
const SESSION_TTL_MS = 2 * 60 * 60_000;
const sessions = new Map<string, { messages: { role: "user" | "assistant"; content: string }[]; at: number }>();

function session(id: string) {
  const now = Date.now();
  for (const [k, s] of sessions) if (now - s.at > SESSION_TTL_MS) sessions.delete(k);
  let s = sessions.get(id);
  if (!s) sessions.set(id, (s = { messages: [], at: now }));
  s.at = now;
  return s;
}

/** Text as it should be spoken: markdown and symbols the model let slip through are dropped or said in words. */
export function speakable(t: string): string {
  return t
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/^\s*(?:[-*•]|\d+\.)\s+/gm, "")
    .replace(/[*_#`>|~]/g, "")
    .replace(/\s*&\s*/g, " and ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Cuts the model's streamed text into chunks worth speaking. The first may end at a clause break (once it has a
 *  few words) so Echo starts talking early; later ones end at sentence ends, which sound more natural. */
export class Chunker {
  private buf = "";
  private first = true;

  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    for (;;) {
      const sentence = /[.!?…]+["')\]]*(?=\s)|\n+/.exec(this.buf);
      let end = sentence ? sentence.index + sentence[0].length : -1;
      if (this.first) {
        const clause = /[,;:—](?=\s)/g;
        for (let m; (m = clause.exec(this.buf)) && (end < 0 || m.index < end);) {
          if (this.buf.slice(0, m.index).trim().split(/\s+/).length >= 4) {
            end = m.index + 1;
            break;
          }
        }
      }
      if (end < 0 && this.buf.length > 240) end = this.buf.lastIndexOf(" ", 240); // a runaway sentence
      if (end <= 0) return out;
      const chunk = this.buf.slice(0, end).trim();
      this.buf = this.buf.slice(end);
      if (chunk) {
        out.push(chunk);
        this.first = false;
      }
    }
  }

  flush(): string | undefined {
    const rest = this.buf.trim();
    this.buf = "";
    return rest || undefined;
  }
}

/** One chunk of speech as a WAV, from the TTS service (Piper voices take ~50-150 ms for a sentence). */
async function synth(text: string, voice: string | undefined, signal: AbortSignal, tempo = 1): Promise<Uint8Array> {
  // tempo: a persona's speech speed, applied by the TTS service without changing the pitch
  const r = await fetch(`http://127.0.0.1:${config.echo.ports.tts}/tts`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, voice, speed: 1, tempo }), signal,
  });
  if (!r.ok) throw new Error(`text to speech: ${((await r.json().catch(() => ({}))) as { error?: string }).error ?? r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

const downloaded = (m: MainModel | undefined) =>
  !!m && !m.coming_soon && (m.engine === "strata" ? existsSync(abs(m.command ?? "-")) : existsSync(abs(m.model ?? "-")));

/** The model Live answers with: the one picked in the Live tab (a persona's own, or Echo's), else echo.yaml
 *  `live.model` (a 9B leaves the GPU room for a fast voice; the 27B fills it), each only once it is downloaded, else
 *  whichever main model is loaded. Only one main model fits, so answering swaps it in. */
export function liveModelId(pick?: string): string {
  for (const id of [pick, config.echo.live?.model]) {
    if (id && downloaded(config.models.main.find((x) => x.id === id))) return id;
  }
  return activeMainId ?? config.echo.default_model;
}

async function mainModel(pick?: string): Promise<MainModel> {
  const id = liveModelId(pick);
  if (activeMainId !== id || activeMain()?.engine.status !== "ready") await useMainModel(id);
  return activeMain()!.model;
}

const sttUrl = () => `http://127.0.0.1:${config.echo.ports.stt ?? 8096}`;

export interface Transcription {
  text: string;
  /** Time the service spent, decoding included */
  ms: number;
  audio_s: number;
}

/** Transcribe one utterance (16 kHz mono 16-bit WAV is fastest) with Echo's speech-to-text service. */
export async function transcribe(wav: Uint8Array, signal?: AbortSignal): Promise<Transcription> {
  await startStt(); // returns at once when it is running
  const r = await fetch(`${sttUrl()}/transcribe`, { method: "POST", body: wav as Uint8Array<ArrayBuffer>, signal });
  const j = (await r.json().catch(() => ({}))) as Partial<Transcription> & { error?: string };
  if (!r.ok) throw new Error(`speech to text: ${j.error ?? r.status}`);
  return { text: (j.text ?? "").trim(), ms: j.ms ?? 0, audio_s: j.audio_s ?? 0 };
}

export const liveApp = new Hono();
const err = (e: unknown) => ({ error: (e as Error).message ?? String(e) });

/** The defaults the Live tab starts with (echo.yaml `live`). */
liveApp.get("/config", (c) => {
  const live = config.echo.live ?? {};
  const model = config.models.main.find((m) => m.id === liveModelId());
  return c.json({ effort: live.effort ?? "off", voice: live.voice ?? "piper:en_US-lessac-medium", sttModel: live.stt_model ?? "base.en", model: model?.name, modelId: model?.id });
});

/** One voice turn. Body: the utterance as a WAV. Query: session (keeps the conversation), effort, voice, persona,
 *  model (a models.yaml main model; default: the persona's, then echo.yaml live.model).
 *  Answers with server-sent events: stt {text, ms} · delta {text} · audio {seq, text, wav (base64)} ·
 *  done {text, model, timings} · error {message}. Timings are milliseconds from the moment the audio had arrived. */
liveApp.post("/turn", async (c) => {
  // The browser may have transcribed the utterance already, during its end-of-speech wait: then it sends the text
  const json = (c.req.header("content-type") ?? "").includes("application/json");
  const given = json ? ((await c.req.json<{ text?: string; sttMs?: number }>().catch(() => ({}))) as { text?: string; sttMs?: number }) : undefined;
  const wav = json ? new Uint8Array() : new Uint8Array(await c.req.arrayBuffer());
  const t0 = performance.now();
  const sessionId = c.req.query("session") || randomUUID();
  const effort = (c.req.query("effort") || config.echo.live?.effort || "off") as Effort;
  const voice = c.req.query("voice") || config.echo.live?.voice;
  const persona = getPersona(c.req.query("persona"));
  const pick = c.req.query("model") || persona?.model || undefined;
  return streamSSE(c, async (stream) => {
    const ac = new AbortController();
    stream.onAbort(() => ac.abort());
    const at = () => Math.round(performance.now() - t0);
    const send = (event: string, data: unknown) => stream.writeSSE({ event, data: JSON.stringify(data) });
    const timings: Record<string, number> = {};
    try {
      let heard: Transcription;
      if (given) heard = { text: (given.text ?? "").trim(), ms: 0, audio_s: 0 };
      else if (!wav.length) throw new Error("no audio");
      else heard = await transcribe(wav, ac.signal);
      Object.assign(timings, { stt: heard.ms, sttDone: at(), speechS: heard.audio_s });
      await send("stt", { text: heard.text, ms: heard.ms, early: !!given });
      if (!heard.text) return void (await send("done", { text: "", sessionId, timings }));
      const m = await mainModel(pick);
      const s = session(sessionId);
      s.messages.push({ role: "user", content: heard.text });
      // Each chunk goes to TTS as soon as it is complete; chunks are spoken in order, one after another
      let seq = 0;
      let speaking: Promise<void> = Promise.resolve();
      const speak = (chunk: string) => {
        const text = speakable(chunk);
        if (!text) return;
        const i = seq++;
        speaking = speaking.then(async () => {
          const t = performance.now();
          const audio = await synth(text, voice, ac.signal, persona?.speed);
          if (i === 0) Object.assign(timings, { tts: Math.round(performance.now() - t), firstAudio: at() });
          await send("audio", { seq: i, text, wav: Buffer.from(audio).toString("base64") });
        });
        // A failed chunk is reported by `await speaking` below, once the reply is written. Until then nothing awaits it,
        // and Node ends the whole server on an unhandled rejection (Qwen3-TTS Fast refusing a full GPU did that).
        speaking.catch(() => {});
      };
      let chunker = new Chunker();
      const llm0 = performance.now();
      const onDelta = (d: { content?: string }) => {
        if (!d.content) return;
        timings.firstToken ??= Math.round(performance.now() - llm0);
        void send("delta", { text: d.content });
        for (const chunk of chunker.push(d.content)) speak(chunk);
      };
      const history = [{ role: "system", content: systemPrompt(persona) }, ...s.messages];
      let res = await streamChat(m, {
        messages: history, ...liveTools(persona),
        ...effortFields(m, effort), ...replyFields(persona, effort), cache_prompt: true,
      }, onDelta, ac.signal, "live");
      if (res.stopped) throw new Error(`Stopped: ${res.stopped}.`);
      const call = res.toolCalls[0];
      if (call?.function.name && !res.aborted) {
        // say it is thinking right away, ask the other model, then come back with a summary that names it
        const said = chunker.flush();
        if (said) speak(said);
        if (seq === 0) speak(call.function.name === "decide" ? "Let me weigh that up." : "Let me think about that.");
        await send("tool", { name: call.function.name, model: call.function.name === "decide" ? "decide" : "chat" });
        const used = await runTool(call, heard.text, ac.signal, m.id);
        timings.tool = used.ms;
        await send("tool", { name: call.function.name, model: used.model, ms: used.ms, ...used.detail });
        chunker = new Chunker();
        res = await streamChat(m, {
          messages: [...history, { role: "assistant", content: res.content, tool_calls: [{ ...call, id: call.id || "call_0" }] },
            { role: "tool", tool_call_id: call.id || "call_0", content: used.result }],
          ...effortFields(m, "off"), ...replyFields(persona, "off"), cache_prompt: true,
        }, onDelta, ac.signal, "live");
        if (res.stopped) throw new Error(`Stopped: ${res.stopped}.`);
        const rest = chunker.flush();
        if (rest) speak(rest);
        if (!mentionsModel(res.content, used.model)) {
          const note = `I checked the ${used.model} model.`;
          speak(note);
          void send("delta", { text: ` ${note}` });
          res.content = `${res.content.trim()} ${note}`;
        }
      } else {
        const rest = chunker.flush();
        if (rest) speak(rest);
      }
      timings.llm = Math.round(performance.now() - llm0);
      await speaking;
      timings.total = at();
      const text = res.content.trim();
      if (res.aborted) s.messages.pop(); // the user stopped it: forget the question too
      else s.messages.push({ role: "assistant", content: text });
      s.messages.splice(0, Math.max(0, s.messages.length - MAX_MESSAGES));
      await send("done", { text, sessionId, effort, model: m.name, timings, tokens: res.timings?.predicted_n, thinkingChars: res.reasoning.length });
    } catch (e) {
      if (!ac.signal.aborted) await send("error", { message: (e as Error).message, timings });
    }
  });
});

/** Get the GPU up to speed and the system prompt into the model's cache, so the first turn is as quick as the rest. */
liveApp.post("/warm", async (c) => {
  try {
    const persona = getPersona(c.req.query("persona"));
    const m = await mainModel(c.req.query("model") || persona?.model || undefined);
    await startStt();
    const t = performance.now();
    const voice = c.req.query("voice") || config.echo.live?.voice;
    await Promise.all([
      streamChat(m, { messages: [{ role: "system", content: systemPrompt(persona) }, { role: "user", content: "Hello." }], ...liveTools(persona), ...effortFields(m, "off"), max_tokens: 1, cache_prompt: true }, () => {}, new AbortController().signal, "live"),
      synth("Ready.", voice, AbortSignal.timeout(60_000)), // loads the voice (a cold first sentence took ~0.9 s)
    ]);
    return c.json({ ok: true, ms: Math.round(performance.now() - t) });
  } catch (e) {
    return c.json(err(e), 503);
  }
});

/** Called the moment the user starts speaking: the conversation so far goes through the model (1 token), which
 *  wakes the GPU from its idle clocks and puts this session's history in the prompt cache. When the user stops,
 *  only their new words are left to read: the first word comes sooner. */
liveApp.post("/prime", async (c) => {
  try {
    const persona = getPersona(c.req.query("persona"));
    const m = await mainModel(c.req.query("model") || persona?.model || undefined);
    const s = sessions.get(c.req.query("session") ?? "");
    const t = performance.now();
    await streamChat(m, {
      messages: [{ role: "system", content: systemPrompt(persona) }, ...(s?.messages ?? []), { role: "user", content: "…" }], ...liveTools(persona),
      ...effortFields(m, "off"), max_tokens: 1, cache_prompt: true,
    }, () => {}, new AbortController().signal, "live");
    return c.json({ ok: true, ms: Math.round(performance.now() - t) });
  } catch (e) {
    return c.json(err(e), 503);
  }
});

/** A persona's greeting, said when Live starts a conversation with it: {text, wav (base64)}, or {text: ""} when it has
 *  none or the conversation has begun. The greeting joins the conversation, so the model knows it said it. */
liveApp.post("/greet", async (c) => {
  const persona = getPersona(c.req.query("persona"));
  const s = session(c.req.query("session") || randomUUID());
  const text = persona ? speakable(persona.greeting) : "";
  if (!persona || !text || s.messages.length) return c.json({ text: "" });
  try {
    const wav = await synth(text, persona.voice, AbortSignal.timeout(90_000), persona.speed);
    s.messages.push({ role: "assistant", content: text });
    return c.json({ text, wav: Buffer.from(wav).toString("base64") });
  } catch (e) {
    return c.json(err(e), 502);
  }
});

liveApp.post("/reset", (c) => {
  sessions.delete(c.req.query("session") ?? "");
  return c.json({ ok: true });
});

/** Speech to text only, for tests: the WAV as the request body. */
liveApp.post("/stt", async (c) => {
  const wav = new Uint8Array(await c.req.arrayBuffer());
  if (!wav.length) return c.json({ error: "no audio" }, 400);
  try {
    return c.json(await transcribe(wav));
  } catch (e) {
    return c.json(err(e), 502);
  }
});
