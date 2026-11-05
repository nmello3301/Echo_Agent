import { useEffect, useRef, useState } from "react";
import { api, toDataUrl } from "../api.ts";
import { Badge, Button, InfoBubble } from "./ui.tsx";

export type Engine = "piper" | "pocket" | "kokoro" | "qwen3" | "voxcpm";

export interface Voice {
  id: string;
  name: string;
  engine: Engine;
  /** Made from a recording */
  clone?: boolean;
  accent?: string;
  installed?: boolean;
  /** The engine follows the speed setting itself; otherwise the audio is played faster or slower */
  speed?: boolean;
}

/** A text-to-speech model, as the TTS service describes it */
export interface TtsModel {
  id: Engine;
  name: string;
  about: string;
  /** How fast it makes speech on this machine, in words */
  pace: string;
  /** Too slow to answer in Live without a pause */
  slow?: boolean;
  installed: boolean;
  /** Can this model clone at all, and can it right now (null: not known until it has loaded once) */
  canClone: boolean;
  cloning: boolean | null;
  /** Cloning works best with the recording's words; Echo transcribes it when they are left out */
  transcript?: boolean;
  sample?: { min: number; max: number; ideal: [number, number]; tip: string };
}

interface VoiceList {
  voices: Voice[];
  models: TtsModel[];
  default: string;
}

const DEFAULT_SENTENCE = "Hello! This is how I sound when Echo reads to you.";
const SAMPLE_RATE = 24_000; // all the cloning models work at 24 kHz or resample to it

/** The voices the TTS service offers, and the one picked on this tab (saved in the browser under `key`). */
export function useVoices(key = "echo.read.voice", fallback?: string) {
  const [list, setList] = useState<VoiceList>();
  const [error, setError] = useState("");
  const [picked, setPicked] = useState(() => {
    try {
      return localStorage.getItem(key) ?? "";
    } catch {
      return "";
    }
  });
  const reload = () => api<VoiceList>("/api/read/voices").then((l) => { setList(l); setError(""); }).catch((e) => setError(e.message));
  useEffect(() => {
    reload();
  }, []);
  const pick = (id: string) => {
    setPicked(id);
    try {
      localStorage.setItem(key, id);
    } catch {}
  };
  // a deleted voice falls back to the tab's default
  const find = (id?: string) => (id ? list?.voices.find((v) => v.id === id) : undefined);
  const voice = find(picked) ?? find(fallback) ?? find(list?.default);
  return { list, error, voice, pick, reload };
}

/** Speech for `text` as an object URL. Engines with a speed control use it; for the others the audio is played at
 * `rate` instead. */
export async function synthesize(text: string, voice: Voice | undefined, speed: number): Promise<{ url: string; rate: number }> {
  const own = !voice || voice.speed !== false;
  const r = await fetch("/api/read/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, voice: voice?.id, speed: own ? speed : 1 }) });
  if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`);
  return { url: URL.createObjectURL(await r.blob()), rate: own ? 1 : speed };
}

// One player for voice tests, so starting a test (or the Read tab's own audio) stops the one before.
const tester = new Audio();
export const stopVoiceTest = () => tester.pause();

/** Pick a model, then one of its voices after hearing it, or clone one from a recording when the model can.
 * `live`: the picker sits in the Live tab, where a slow model delays every answer. */
export function ChangeVoice({ voices, speed, onTest, live = false }: { voices: ReturnType<typeof useVoices>; speed: number; onTest: () => void; live?: boolean }) {
  const { list, voice, pick, reload } = voices;
  const [open, setOpen] = useState(false);
  const [engine, setEngine] = useState<Engine>();
  const [sentence, setSentence] = useState(DEFAULT_SENTENCE);
  const [testing, setTesting] = useState<{ id: string; state: "making" | "playing" }>();
  const [error, setError] = useState("");
  const cache = useRef(new Map<string, { url: string; rate: number }>());
  const run = useRef(0); // a newer test (or stopping one) drops the clip an older one is still making

  useEffect(() => {
    // The pause event arrives after a newer test may have started playing: only a paused player means stopped
    const stopped = () => tester.paused && setTesting((t) => (t?.state === "playing" ? undefined : t));
    tester.addEventListener("pause", stopped);
    tester.addEventListener("ended", stopped);
    return () => {
      tester.removeEventListener("pause", stopped);
      tester.removeEventListener("ended", stopped);
      for (const c of cache.current.values()) URL.revokeObjectURL(c.url);
    };
  }, []);

  const test = async (v: Voice) => {
    const id = ++run.current;
    stopVoiceTest();
    if (testing?.id === v.id) return setTesting(undefined);
    onTest();
    setError("");
    const text = sentence.trim() || DEFAULT_SENTENCE;
    const key = `${v.id}|${speed}|${text}`;
    try {
      let clip = cache.current.get(key);
      if (!clip) {
        setTesting({ id: v.id, state: "making" });
        clip = await synthesize(text, v, speed);
        cache.current.set(key, clip);
        reload(); // a first use downloads the voice or loads the model: show what changed
        if (id !== run.current) return;
      }
      tester.src = clip.url;
      tester.defaultPlaybackRate = tester.playbackRate = clip.rate;
      setTesting({ id: v.id, state: "playing" });
      await tester.play();
    } catch (e) {
      if (id !== run.current) return;
      setTesting(undefined);
      setError(`${v.name}: ${(e as Error).message}`);
    }
  };

  const card = (v: Voice, onDelete?: () => void) => {
    const selected = v.id === voice?.id;
    const t = testing?.id === v.id ? testing.state : undefined;
    return (
      <div key={v.id} className={`flex items-center gap-1.5 rounded-md border pl-1 pr-1.5 py-1 ${selected ? "border-accent bg-accent/10" : "border-line"}`}>
        <button onClick={() => test(v)} aria-label={t ? `Stop testing ${v.name}` : `Test ${v.name}`} title={t === "making" ? "Making speech…" : t ? "Stop" : "Test this voice"}
          className="w-7 h-7 shrink-0 rounded-full text-xs text-dim hover:text-accent hover:bg-panel-2">
          {t === "making" ? "…" : t ? "■" : "▶"}
        </button>
        <button onClick={() => pick(v.id)} aria-pressed={selected} title={v.name} className="flex-1 min-w-0 text-left text-sm truncate py-0.5">
          {v.name}
          {v.accent && <span className="text-xs text-dim"> · {v.accent}</span>}
        </button>
        {selected ? <Badge tone="accent">in use</Badge> : v.installed === false && <span className="text-[11px] text-dim" title="Downloads the first time you use it">download</span>}
        {onDelete && (
          <button onClick={onDelete} aria-label={`Delete ${v.name}`} title="Delete this voice" className="w-6 h-6 shrink-0 rounded text-xs text-dim hover:text-bad">✕</button>
        )}
      </div>
    );
  };

  const remove = async (v: Voice) => {
    if (!confirm(`Delete the voice "${v.name}"?`)) return;
    try {
      await api(`/api/read/voices/${encodeURIComponent(v.id)}`, { method: "DELETE" });
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const grid = (vs: Voice[], deletable = false) => (
    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-1.5">{vs.map((v) => card(v, deletable ? () => remove(v) : undefined))}</div>
  );
  const model = (id?: Engine) => list?.models.find((m) => m.id === id);
  const shown = model(engine) ?? model(voice?.engine) ?? list?.models[0];
  const presets = list?.voices.filter((v) => v.engine === shown?.id && !v.clone) ?? [];
  const clones = list?.voices.filter((v) => v.engine === shown?.id && v.clone) ?? [];
  const current = model(voice?.engine);

  return (
    <section className="border border-line rounded-md">
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="text-sm text-dim">Voice</span>
        {voice ? <span className="text-sm font-medium truncate">{voice.name}</span> : <span className="text-sm text-dim">{voices.error ? "" : "loading…"}</span>}
        {voice && <Badge>{current?.name ?? voice.engine}{voice.clone ? " · cloned" : voice.accent ? ` · ${voice.accent}` : ""}</Badge>}
        {live && current?.slow && <Badge tone="warn">slow: answers start later</Badge>}
        {voices.error && <span className="text-sm text-bad truncate">{voices.error}</span>}
        {list || !voices.error ? (
          <Button kind={open ? "ghost" : "default"} className="ml-auto" onClick={() => { setOpen(!open); if (open) stopVoiceTest(); }} disabled={!list}>
            {open ? "Done" : "Change voice"}
          </Button>
        ) : (
          <Button className="ml-auto" onClick={reload}>Retry</Button>
        )}
      </div>

      {open && list && shown && (
        <div className="border-t border-line p-3 space-y-4">
          <div className="space-y-1.5">
            <div className="text-xs text-dim">Model</div>
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Text-to-speech model">
              {list.models.map((m) => (
                <button key={m.id} role="radio" aria-checked={m.id === shown.id} onClick={() => setEngine(m.id)}
                  className={`rounded-md border px-2.5 py-1 text-sm ${m.id === shown.id ? "border-accent bg-accent/15 text-accent" : "border-line hover:border-dim"} ${m.installed ? "" : "opacity-70"}`}>
                  {m.name}
                  {!m.installed && <span className="text-[11px] text-dim"> · not downloaded</span>}
                  {m.id === current?.id && <span className="text-[11px]" title="The voice in use is from this model"> ●</span>}
                </button>
              ))}
            </div>
            <p className="text-xs text-dim">
              {shown.about} <span className="text-text/80">{shown.pace}.</span>
              {live && shown.slow && <span className="text-warn"> Live speaks each sentence as soon as it is written, so with this model answers start later.</span>}
            </p>
          </div>

          {!shown.installed ? (
            <p className="text-sm">
              {shown.name} isn't downloaded yet. <a href="#models/tts" className="text-accent underline">Download it on the Models page</a>, then come back to pick a voice.
            </p>
          ) : (
            <>
              <label className="flex items-center gap-2 text-sm text-dim">
                Test with
                <input value={sentence} onChange={(e) => setSentence(e.target.value)} placeholder={DEFAULT_SENTENCE} aria-label="Test sentence"
                  className="flex-1 bg-panel-2 border border-line rounded-md px-2 py-1.5 text-sm text-text" />
              </label>
              {error && <div className="text-sm text-bad">{error}</div>}
              {presets.length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-sm font-medium">{shown.name} voices</h3>
                  {grid(presets)}
                </div>
              )}
              {shown.canClone && (
                <div className="space-y-2">
                  <h3 className="text-sm font-medium">Your {shown.name} voices</h3>
                  {clones.length ? grid(clones, true) : <p className="text-xs text-dim">No cloned voices yet. Add one below.</p>}
                </div>
              )}
            </>
          )}
          {shown.canClone && (shown.installed || shown.id === "pocket") && (
            <CloneForm model={shown} onCloned={async (v) => { await reload(); pick(v.id); test(v); }} onFailed={reload} />
          )}
        </div>
      )}
    </section>
  );
}

/** Upload a recording, hear what will be used, name it, clone it with `model`. The browser decodes the file (any
 * format it can play), so the server always gets a 24 kHz mono WAV no longer than the model uses. */
function CloneForm({ model, onCloned, onFailed }: { model: TtsModel; onCloned: (v: Voice) => void; onFailed: () => void }) {
  const [sample, setSample] = useState<{ wav: Blob; url: string; seconds: number; trimmed: boolean }>();
  const [name, setName] = useState("");
  const [transcript, setTranscript] = useState("");
  const [busy, setBusy] = useState<"reading" | "cloning">();
  const [error, setError] = useState("");
  const [over, setOver] = useState(false);
  const range = model.sample ?? { min: 3, max: 30, ideal: [10, 20] as [number, number], tip: "" };
  const ideal = `${range.ideal[0]}–${range.ideal[1]} seconds`;

  useEffect(() => () => { if (sample) URL.revokeObjectURL(sample.url); }, [sample]);

  const choose = async (file: File | undefined) => {
    if (!file) return;
    setError("");
    setBusy("reading");
    try {
      const s = await prepareSample(file, range.min, range.max, ideal);
      setSample({ ...s, url: URL.createObjectURL(s.wav) });
      if (!name.trim()) setName(file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").slice(0, 40));
    } catch (e) {
      setSample(undefined);
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  const clone = async () => {
    if (!sample || !name.trim()) return;
    setError("");
    setBusy("cloning");
    try {
      const v = await api<Voice>("/api/read/voices", {
        method: "POST", json: { name: name.trim(), engine: model.id, audio: await toDataUrl(sample.wav), transcript: transcript.trim() || undefined },
      });
      setSample(undefined);
      setName("");
      setTranscript("");
      onCloned(v);
    } catch (e) {
      setError((e as Error).message);
      onFailed(); // a first try loads the model, which tells whether cloning is available at all
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium flex items-center gap-1.5">
        Clone a voice with {model.name}
        <InfoBubble label={`Ideal sample length for ${model.name}`}>
          <span className="block font-medium mb-0.5">Ideal sample: {ideal}</span>
          One person speaking clearly, no music or background noise. {model.name} works from {range.min} s and uses at most {range.max} s
          (longer recordings are cut). {range.tip}
        </InfoBubble>
      </h3>
      {model.cloning !== false && (
        <>
          <label
            onDragOver={(e) => { e.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); choose(e.dataTransfer.files[0]); }}
            className={`flex flex-col items-center gap-1 rounded-md border border-dashed px-3 py-5 text-sm text-center cursor-pointer ${over ? "border-accent bg-accent/10" : "border-line hover:border-dim"}`}>
            <input type="file" accept="audio/*,.wav,.mp3,.m4a,.ogg,.oga,.opus,.flac,.webm" className="hidden"
              onChange={(e) => { choose(e.target.files?.[0]); e.target.value = ""; }} />
            <span>{busy === "reading" ? "Reading the recording…" : <>Drop a voice recording here, or <span className="text-accent underline">choose a file</span></>}</span>
            <span className="text-xs text-dim">WAV, MP3, M4A, OGG or FLAC. {ideal} of one person speaking clearly: noise and room echo get copied too.</span>
          </label>

          {sample && (
            <div className="space-y-2 bg-panel-2 border border-line rounded-md p-3">
              <div className="flex items-center gap-2">
                <audio src={sample.url} controls className="flex-1 h-9" />
                <span className="text-xs text-dim whitespace-nowrap">{sample.seconds.toFixed(1)} s{sample.trimmed ? ` (first ${range.max} s)` : ""}</span>
              </div>
              {model.transcript && (
                <textarea value={transcript} onChange={(e) => setTranscript(e.target.value)} rows={2} aria-label="What the recording says"
                  placeholder="What the recording says, word for word (optional: Echo transcribes English recordings itself)"
                  className="w-full bg-panel border border-line rounded-md px-2 py-1.5 text-sm" />
              )}
              <div className="flex flex-wrap items-center gap-2">
                <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="Name this voice" aria-label="Voice name"
                  onKeyDown={(e) => { if (e.key === "Enter") clone(); }}
                  className="flex-1 min-w-40 bg-panel border border-line rounded-md px-2 py-1.5 text-sm" />
                <Button kind="primary" onClick={clone} disabled={!!busy || !name.trim()}>{busy === "cloning" ? "Cloning…" : "Clone voice"}</Button>
                <Button kind="ghost" onClick={() => setSample(undefined)} disabled={!!busy}>Discard</Button>
              </div>
              {sample.seconds < range.ideal[0] && <div className="text-xs text-warn">Short samples work, but {ideal} usually sounds closer.</div>}
            </div>
          )}
          {error && <div className="text-sm text-bad whitespace-pre-wrap">{error}</div>}
        </>
      )}
      {model.id === "pocket" && model.cloning !== true && (
        <p className={`text-xs ${model.cloning === false ? "text-warn" : "text-dim"}`}>
          {model.cloning === false ? "Cloning isn't available yet. " : "Cloning needs a one-time step: "}
          Kyutai's cloning model is free but gated. Sign in at <a href="https://huggingface.co/kyutai/pocket-tts" target="_blank" rel="noreferrer" className="text-accent underline">huggingface.co/kyutai/pocket-tts</a> and
          accept the terms, and create a read token at <a href="https://huggingface.co/settings/tokens" target="_blank" rel="noreferrer" className="text-accent underline">huggingface.co/settings/tokens</a>.
          Docker: add <code>HF_TOKEN=…</code> to <code>.env</code> and run <code>docker compose up -d</code>. Native: run <code>services/tts/.venv/bin/hf auth login</code>, then <code>./echo restart</code>.
          The default voices work without it.
        </p>
      )}
      <p className="text-xs text-dim">Only clone voices you have permission to use. Cloned voices stay on this machine, in <code>data/tts/voices</code>.</p>
    </div>
  );
}

/** Decode any audio the browser can play into a 24 kHz mono 16-bit WAV: silence trimmed from both ends, level
 * normalized, at most `maxS` seconds. */
async function prepareSample(file: Blob, minS: number, maxS: number, ideal: string): Promise<{ wav: Blob; seconds: number; trimmed: boolean }> {
  const ctx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(await file.arrayBuffer());
  } catch {
    throw new Error("This file couldn't be read as audio. Try a WAV, MP3, M4A, OGG or FLAC file.");
  } finally {
    ctx.close();
  }
  // Rendering into a 1-channel context at 24 kHz mixes down to mono and resamples
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * SAMPLE_RATE)), SAMPLE_RATE);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const pcm = (await off.startRendering()).getChannelData(0);

  let peak = 0;
  for (const x of pcm) peak = Math.max(peak, Math.abs(x));
  if (peak < 1e-3) throw new Error("This recording is silent.");
  const floor = peak * 0.03; // about -30 dB below the loudest point
  const pad = SAMPLE_RATE / 5;
  let start = 0;
  let end = pcm.length;
  while (start < end && Math.abs(pcm[start]) < floor) start++;
  while (end > start && Math.abs(pcm[end - 1]) < floor) end--;
  start = Math.max(0, start - pad);
  end = Math.min(pcm.length, end + pad);
  const trimmed = end - start > maxS * SAMPLE_RATE;
  if (trimmed) end = start + maxS * SAMPLE_RATE;
  const seconds = (end - start) / SAMPLE_RATE;
  if (seconds < minS) throw new Error(`This recording has only ${seconds.toFixed(1)} s of sound: use ${ideal} of speech.`);

  const gain = 0.95 / peak;
  const n = end - start;
  const view = new DataView(new ArrayBuffer(44 + n * 2));
  const ascii = (at: number, s: string) => [...s].forEach((ch, i) => view.setUint8(at + i, ch.charCodeAt(0)));
  ascii(0, "RIFF");
  view.setUint32(4, 36 + n * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true); // bytes per second
  view.setUint16(32, 2, true); // bytes per frame
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, pcm[start + i] * gain)) * 0x7fff), true);
  return { wav: new Blob([view], { type: "audio/wav" }), seconds, trimmed };
}
