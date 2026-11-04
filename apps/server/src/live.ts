// Live tab: hands-free voice chat (docs/live-chat.md). One turn: the user's utterance (WAV) → speech to text
// (services/stt, faster-whisper on the CPU) → the main model, streamed → speakable chunks → text to speech (Piper)
// per chunk, each sent back the moment it is ready, so Echo starts talking while the model is still writing.
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { config, type MainModel } from "./config.ts";
import { activeMain, activeMainId, startStt, useMainModel } from "./engines.ts";
import { type Effort, effortFields, streamChat } from "./llm.ts";

const SYSTEM = `You are Echo, talking with the user by voice: everything you write is spoken aloud.
- Answer in one to three short sentences of plain spoken English, starting with the answer itself.
- No markdown, lists, headings, code, emoji or links. Write numbers, units and symbols the way they are said.
- If a full answer would be long, give the gist and offer to say more.
- If the user's words make no sense (a speech recognition slip), say what you heard and ask them to repeat.`;

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
async function synth(text: string, voice: string | undefined, signal: AbortSignal): Promise<Uint8Array> {
  const r = await fetch(`http://127.0.0.1:${config.echo.ports.tts}/tts`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, voice, speed: 1 }), signal,
  });
  if (!r.ok) throw new Error(`text to speech: ${((await r.json().catch(() => ({}))) as { error?: string }).error ?? r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

async function mainModel(): Promise<MainModel> {
  if (activeMain()?.engine.status !== "ready") await useMainModel(activeMainId ?? config.echo.default_model);
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
  return c.json({ effort: live.effort ?? "off", voice: live.voice ?? "piper:en_US-lessac-medium", sttModel: live.stt_model ?? "base.en" });
});

/** One voice turn. Body: the utterance as a WAV. Query: session (keeps the conversation), effort, voice.
 *  Answers with server-sent events: stt {text, ms} · delta {text} · audio {seq, text, wav (base64)} ·
 *  done {text, timings} · error {message}. Timings are milliseconds from the moment the audio had arrived. */
liveApp.post("/turn", async (c) => {
  // The browser may have transcribed the utterance already, during its end-of-speech wait: then it sends the text
  const json = (c.req.header("content-type") ?? "").includes("application/json");
  const given = json ? ((await c.req.json<{ text?: string; sttMs?: number }>().catch(() => ({}))) as { text?: string; sttMs?: number }) : undefined;
  const wav = json ? new Uint8Array() : new Uint8Array(await c.req.arrayBuffer());
  const t0 = performance.now();
  const sessionId = c.req.query("session") || randomUUID();
  const effort = (c.req.query("effort") || config.echo.live?.effort || "off") as Effort;
  const voice = c.req.query("voice") || config.echo.live?.voice;
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
      const m = await mainModel();
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
          const audio = await synth(text, voice, ac.signal);
          if (i === 0) Object.assign(timings, { tts: Math.round(performance.now() - t), firstAudio: at() });
          await send("audio", { seq: i, text, wav: Buffer.from(audio).toString("base64") });
        });
      };
      const chunker = new Chunker();
      const llm0 = performance.now();
      const res = await streamChat(m, {
        messages: [{ role: "system", content: SYSTEM }, ...s.messages],
        ...effortFields(m, effort), max_tokens: effort === "off" ? 400 : 1500, cache_prompt: true,
      }, (d) => {
        if (!d.content) return;
        timings.firstToken ??= Math.round(performance.now() - llm0);
        void send("delta", { text: d.content });
        for (const chunk of chunker.push(d.content)) speak(chunk);
      }, ac.signal, "live");
      const rest = chunker.flush();
      if (rest) speak(rest);
      timings.llm = Math.round(performance.now() - llm0);
      await speaking;
      timings.total = at();
      const text = res.content.trim();
      if (res.aborted) s.messages.pop(); // the user stopped it: forget the question too
      else s.messages.push({ role: "assistant", content: text });
      s.messages.splice(0, Math.max(0, s.messages.length - MAX_MESSAGES));
      await send("done", { text, sessionId, effort, timings, tokens: res.timings?.predicted_n, thinkingChars: res.reasoning.length });
    } catch (e) {
      if (!ac.signal.aborted) await send("error", { message: (e as Error).message, timings });
    }
  });
});

/** Get the GPU up to speed and the system prompt into the model's cache, so the first turn is as quick as the rest. */
liveApp.post("/warm", async (c) => {
  try {
    const m = await mainModel();
    await startStt();
    const t = performance.now();
    const voice = c.req.query("voice") || config.echo.live?.voice;
    await Promise.all([
      streamChat(m, { messages: [{ role: "system", content: SYSTEM }, { role: "user", content: "Hello." }], ...effortFields(m, "off"), max_tokens: 1, cache_prompt: true }, () => {}, new AbortController().signal, "live"),
      synth("Ready.", voice, AbortSignal.timeout(60_000)), // loads the voice (a cold first sentence took ~0.9 s)
    ]);
    return c.json({ ok: true, ms: Math.round(performance.now() - t) });
  } catch (e) {
    return c.json(err(e), 503);
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
