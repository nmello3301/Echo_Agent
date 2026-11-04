// Live chat: the server side of the voice turn loop (see docs/live-chat.md).
// A turn is one user utterance: STT text -> main model answer (streamed) -> Piper TTS per sentence,
// with the audio coming back to the browser as SSE events.
import { config, dockerEnv } from "./config.ts";

/** The speech-to-text service: Hugin's `stt` container (faster-whisper, distil-large-v3 int8 on CPU,
 * English). In Docker the compose file points STT_URL at the sibling service; on the host it is a
 * published port. */
export function sttUrl(): string {
  return dockerEnv.sttUrl ?? config.echo.stt_url ?? "http://stt:8089";
}

export interface Transcription {
  text: string;
  /** Milliseconds the /transcribe request took, model included. */
  ms: number;
}

/** Transcribe a WAV (any sample rate; faster-whisper resamples) against the stt service. */
export async function transcribe(wav: Uint8Array, name = "utterance.wav"): Promise<Transcription> {
  const form = new FormData();
  form.append("file", new Blob([Buffer.from(wav)], { type: "audio/wav" }), name);
  const t0 = performance.now();
  const r = await fetch(`${sttUrl()}/transcribe`, { method: "POST", body: form });
  const ms = Math.round(performance.now() - t0);
  if (!r.ok) throw new Error(`STT answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = (await r.json()) as { text?: string };
  return { text: (j.text ?? "").trim(), ms };
}
