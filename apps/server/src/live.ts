// Live tab: hands-free voice chat (docs/live-chat.md). One turn: the user's utterance (WAV) → speech to text
// (services/stt, faster-whisper on the CPU) → the main model, streamed → speakable chunks → text to speech (Piper)
// per chunk, each sent back the moment it is ready, so Echo starts talking while the model is still writing.
import { Hono } from "hono";
import { config } from "./config.ts";
import { startStt } from "./engines.ts";

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
