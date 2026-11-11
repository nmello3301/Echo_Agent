/** Live: hands-free voice chat with the main model. Listens on the microphone, detects the end of speech, sends the
 *  utterance to /api/live/turn and plays the spoken answer as it streams back; then listens again. */
import { useEffect, useRef, useState } from "react";
import { api, readSSE, useModels } from "../api.ts";
import { Badge, Button, ModelSelect, Select } from "./ui.tsx";
import { type Persona, PersonaBar, usePersonas } from "./LivePersonas.tsx";
import { ChangeVoice, stopVoiceTest, useVoices } from "./Voices.tsx";

type Phase = "off" | "listening" | "hearing" | "thinking" | "speaking";
interface Turn {
  id: number;
  /** The persona it was said with ("echo": Echo's own); each one keeps its own conversation */
  key: string;
  /** The persona's greeting, said when the conversation started */
  greeting?: boolean;
  user: string;
  echo: string;
  /** From the end of your speech to the first sound of the answer */
  delayMs?: number;
  timings?: Record<string, number>;
  early?: boolean;
  /** The voice model handed the question to the chat model or the decide model */
  tool?: { model: "chat" | "decide"; ms?: number; answer?: string; web?: boolean };
  /** The main model that answered */
  model?: string;
  error?: string;
}

const FRAME_MS = 20;
const PREROLL_MS = 300; // kept from before speech starts, so the first syllable is not cut
const START_FRAMES = 3; // 60 ms of voice starts an utterance
const MIN_VOICE_MS = 250; // shorter than this is a cough or a click
const MAX_UTTERANCE_MS = 20_000;
const EARLY_MS = 200; // after this much silence the utterance is transcribed early, while Echo waits to be sure
const GUARD_MS = 300; // after Echo stops talking, before listening again (its own echo)

// Copies microphone samples out of the audio thread
const WORKLET = `registerProcessor("tap", class extends AudioWorkletProcessor {
  process(inputs) { const c = inputs[0][0]; if (c) this.port.postMessage(c.slice(0)); return true; }
});`;

/** Float32 samples at `rate` as a 16 kHz mono 16-bit WAV: what the speech-to-text service reads fastest. */
export function toWav16k(chunks: Float32Array[], rate: number): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const src = new Float32Array(total);
  let o = 0;
  for (const c of chunks) {
    src.set(c, o);
    o += c.length;
  }
  const ratio = rate / 16000;
  const n = Math.floor(total / ratio);
  const out = new DataView(new ArrayBuffer(44 + n * 2));
  const str = (at: number, s: string) => [...s].forEach((ch, i) => out.setUint8(at + i, ch.charCodeAt(0)));
  str(0, "RIFF");
  out.setUint32(4, 36 + n * 2, true);
  str(8, "WAVEfmt ");
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, 1, true);
  out.setUint32(24, 16000, true);
  out.setUint32(28, 32000, true);
  out.setUint16(32, 2, true);
  out.setUint16(34, 16, true);
  str(36, "data");
  out.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    // average the source samples that fall into this output sample (a simple low-pass before decimating)
    const a = Math.floor(i * ratio);
    const b = Math.max(a + 1, Math.floor((i + 1) * ratio));
    let s = 0;
    for (let j = a; j < b && j < total; j++) s += src[j];
    const v = Math.max(-1, Math.min(1, s / (b - a)));
    out.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return new Uint8Array(out.buffer);
}

interface Settings {
  /** The persona's id, "" for Echo's own; `key` names its conversation */
  persona: string;
  key: string;
  session: string;
  effort: string;
  voice: string;
  /** The main model it answers with (models.yaml id) */
  model: string;
  silenceMs: number;
}

/** The audio side: microphone, end-of-speech detection, the turn request and playback. */
class LiveEngine {
  phase: Phase = "off";
  level = 0;
  private ctx?: AudioContext;
  private stream?: MediaStream;
  private node?: AudioWorkletNode;
  private pending = new Float32Array(0);
  private frameLen = 960;
  private noise = 0;
  private preroll: Float32Array[] = [];
  private utter: Float32Array[] = [];
  private voicedRun = 0;
  private voiceMs = 0;
  private startAt = 0;
  private lastVoiceAt = 0;
  private early?: { frames: number; text: Promise<{ text: string; ms: number } | undefined> };
  private abort?: AbortController;
  private sources: AudioBufferSourceNode[] = [];
  private nextPlayAt = 0;
  private turnId = 0;
  settings: () => Settings;
  onPhase: (p: Phase) => void;
  onTurn: (t: Turn) => void;

  constructor(settings: () => Settings, onPhase: (p: Phase) => void, onTurn: (t: Turn) => void) {
    this.settings = settings;
    this.onPhase = onPhase;
    this.onTurn = onTurn;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    this.ctx = new AudioContext();
    this.frameLen = Math.round((this.ctx.sampleRate * FRAME_MS) / 1000);
    await this.ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" })));
    this.node = new AudioWorkletNode(this.ctx, "tap");
    this.node.port.onmessage = (e) => this.samples(e.data as Float32Array);
    this.ctx.createMediaStreamSource(this.stream).connect(this.node);
    this.noise = 0;
    this.listen();
    void this.greet(); // the tab warms the model up (Live's warm())
  }

  /** A persona's greeting, when it has one and this is the start of its conversation (the server checks both). */
  async greet() {
    const s = this.settings();
    if (!s.persona || !this.ctx) return;
    const id = ++this.turnId;
    this.abort?.abort();
    this.silence();
    this.set("thinking");
    const resume = () => this.turnId === id && this.phase !== "off" && this.listen();
    try {
      const g = await api<{ text: string; wav?: string }>(`/api/live/greet?session=${s.session}&persona=${s.persona}`, { method: "POST" });
      if (!g.wav || !this.ctx || this.turnId !== id) return resume();
      this.onTurn({ id, key: s.key, user: "", echo: g.text, greeting: true });
      const buf = await this.ctx.decodeAudioData(Uint8Array.from(atob(g.wav), (c) => c.charCodeAt(0)).buffer);
      if (!this.ctx || this.turnId !== id) return;
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.ctx.destination);
      src.start();
      this.sources.push(src);
      this.set("speaking");
      src.onended = () => setTimeout(resume, GUARD_MS);
    } catch (e) {
      if (this.turnId === id) this.onTurn({ id, key: s.key, user: "", echo: "", greeting: true, error: `Greeting: ${(e as Error).message}` });
      resume();
    }
  }

  stop() {
    this.abort?.abort();
    this.silence();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.node?.disconnect();
    void this.ctx?.close();
    this.ctx = undefined;
    this.set("off");
  }

  private set(p: Phase) {
    this.phase = p;
    this.onPhase(p);
  }

  private listen() {
    this.utter = [];
    this.preroll = [];
    this.voicedRun = 0;
    this.early = undefined;
    this.set("listening");
  }

  private samples(s: Float32Array) {
    const merged = new Float32Array(this.pending.length + s.length);
    merged.set(this.pending);
    merged.set(s, this.pending.length);
    let o = 0;
    for (; o + this.frameLen <= merged.length; o += this.frameLen) this.frame(merged.slice(o, o + this.frameLen));
    this.pending = merged.slice(o);
  }

  private frame(f: Float32Array) {
    let sum = 0;
    for (const x of f) sum += x * x;
    const rms = Math.sqrt(sum / f.length);
    this.level = rms;
    if (this.phase !== "listening" && this.phase !== "hearing") return; // half-duplex: not while Echo thinks or talks
    const now = performance.now();
    if (this.phase === "listening") this.noise = this.noise ? this.noise * 0.97 + rms * 0.03 : rms;
    const voiced = rms > Math.max(0.006, this.noise * 3);
    if (this.phase === "listening") {
      this.preroll.push(f);
      if (this.preroll.length > PREROLL_MS / FRAME_MS) this.preroll.shift();
      this.voicedRun = voiced ? this.voicedRun + 1 : 0;
      if (this.voicedRun >= START_FRAMES) {
        this.utter = [...this.preroll];
        this.voiceMs = this.voicedRun * FRAME_MS;
        this.startAt = this.lastVoiceAt = now;
        this.set("hearing");
        // while they talk, wake the model and cache the conversation so far (see /api/live/prime)
        const s = this.settings();
        void fetch(`/api/live/prime?session=${s.session}&persona=${s.persona}&model=${encodeURIComponent(s.model)}`, { method: "POST" }).catch(() => {});
      }
      return;
    }
    this.utter.push(f);
    if (voiced) {
      this.lastVoiceAt = now;
      this.voiceMs += FRAME_MS;
      this.early = undefined; // they went on talking: an early transcription is out of date
    }
    const silent = now - this.lastVoiceAt;
    if (silent >= EARLY_MS && !this.early && this.voiceMs >= MIN_VOICE_MS) {
      const wav = toWav16k(this.utter, this.ctx!.sampleRate);
      this.early = {
        frames: this.utter.length,
        text: fetch("/api/live/stt", { method: "POST", body: wav as Uint8Array<ArrayBuffer> }).then((r) => (r.ok ? r.json() : undefined)).catch(() => undefined),
      };
    }
    if (silent >= this.settings().silenceMs || now - this.startAt > MAX_UTTERANCE_MS) {
      if (this.voiceMs < MIN_VOICE_MS) return this.listen();
      void this.turn(this.lastVoiceAt);
    }
  }

  private async turn(speechEnd: number) {
    const s = this.settings();
    const id = ++this.turnId;
    const t: Turn = { id, key: s.key, user: "…", echo: "" };
    this.onTurn({ ...t });
    this.set("thinking");
    const early = this.early;
    const wav = toWav16k(this.utter, this.ctx!.sampleRate);
    this.abort = new AbortController();
    this.nextPlayAt = 0;
    let firstSound = 0;
    let pendingAudio = 0;
    let done = false;
    const maybeListen = () => {
      if (done && pendingAudio === 0 && this.turnId === id && this.phase !== "off") setTimeout(() => this.phase !== "off" && this.listen(), GUARD_MS);
    };
    try {
      const pre = early && (await early.text);
      const q = `session=${s.session}&effort=${s.effort}&voice=${encodeURIComponent(s.voice)}&persona=${s.persona}&model=${encodeURIComponent(s.model)}`;
      const r = await fetch(`/api/live/turn?${q}`, pre
        ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: pre.text }), signal: this.abort.signal }
        : { method: "POST", body: wav as Uint8Array<ArrayBuffer>, signal: this.abort.signal });
      if (pre) Object.assign(t, { early: true });
      await readSSE(r, (event, data) => {
        if (event === "stt") {
          t.user = data.text || "(nothing heard)";
          if (!data.text) done = true;
        } else if (event === "delta") t.echo += data.text;
        else if (event === "tool") t.tool = { model: data.model, ms: data.ms, answer: data.answer, web: data.web };
        else if (event === "audio") {
          pendingAudio++;
          const bytes = Uint8Array.from(atob(data.wav), (c) => c.charCodeAt(0));
          void this.ctx?.decodeAudioData(bytes.buffer).then((buf) => {
            if (!this.ctx || this.turnId !== id) return;
            const src = this.ctx.createBufferSource();
            src.buffer = buf;
            src.connect(this.ctx.destination);
            const at = Math.max(this.ctx.currentTime + 0.01, this.nextPlayAt);
            src.start(at);
            this.nextPlayAt = at + buf.duration;
            this.sources.push(src);
            if (!firstSound) {
              firstSound = performance.now() + (at - this.ctx.currentTime + (this.ctx.outputLatency || 0)) * 1000;
              t.delayMs = Math.round(firstSound - speechEnd);
              this.set("speaking");
              this.onTurn({ ...t });
            }
            src.onended = () => {
              pendingAudio--;
              maybeListen();
            };
          });
        } else if (event === "done") {
          t.timings = { ...data.timings, ...(pre ? { stt: pre.ms } : {}) };
          t.model = data.model;
          done = true;
        } else if (event === "error") {
          t.error = data.message;
          done = true;
        }
        this.onTurn({ ...t });
      });
    } catch (e) {
      if (!this.abort.signal.aborted) t.error = (e as Error).message;
      done = true;
    }
    this.onTurn({ ...t });
    done = true;
    maybeListen();
  }

  /** Stop talking now (Echo's audio and the turn in flight), then listen again. */
  interrupt() {
    this.turnId++; // a greeting still being made is dropped too
    this.abort?.abort();
    this.silence();
    if (this.phase !== "off") this.listen();
  }

  private silence() {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {}
    }
    this.sources = [];
  }
}

const PHASE_TEXT: Record<Phase, string> = {
  off: "Press Start and talk. Echo answers out loud, then listens again.",
  listening: "Listening…",
  hearing: "Hearing you…",
  thinking: "Thinking…",
  speaking: "Speaking…",
};

export function Live({ active }: { active: boolean }) {
  const [phase, setPhase] = useState<Phase>("off");
  const [turnsBy, setTurnsBy] = useState<Record<string, Turn[]>>({});
  const [echoEffort, setEchoEffort] = useState("off");
  const [defaultVoice, setDefaultVoice] = useState<string>(); // echo.yaml live.voice
  const [defaultModel, setDefaultModel] = useState<string>(); // echo.yaml live.model, or the loaded main model
  const [echoModel, setEchoModel] = useState(() => {
    try {
      return localStorage.getItem("echo.live.model") ?? "";
    } catch {
      return "";
    }
  });
  const models = useModels();
  const echoVoices = useVoices("echo.live.voice", defaultVoice);
  const personas = usePersonas();
  const [personaId, setPersonaId] = useState(() => {
    try {
      return localStorage.getItem("echo.live.persona") ?? "";
    } catch {
      return "";
    }
  });
  const persona: Persona | undefined = personas.list.find((p) => p.id === personaId);
  const key = persona?.id ?? "echo";
  // With a persona chosen, the voice picker and the thinking switch are its own settings, saved as they change
  const savePersona = (patch: Partial<Persona>) => persona && void personas.save({ ...persona, ...patch }).catch((e) => setError(e.message));
  const voices = persona
    ? { ...echoVoices, voice: echoVoices.list?.voices.find((v) => v.id === persona.voice) ?? echoVoices.voice, pick: (id: string) => savePersona({ voice: id }) }
    : echoVoices;
  const voice = persona?.voice ?? echoVoices.voice?.id ?? defaultVoice ?? "piper:en_US-lessac-medium";
  const effort = persona?.effort ?? echoEffort;
  const setEffort = (e: string) => (persona ? savePersona({ effort: e === "low" ? "low" : "off" }) : setEchoEffort(e));
  // The model: the persona's, else the one picked for Echo in this browser, else echo.yaml's (a pick that is no longer
  // downloaded falls back too)
  const usable = (id?: string | null) => !!id && !!models?.main.some((m) => m.id === id && m.available && !m.comingSoon);
  const model = [persona?.model, echoModel].find(usable) ?? defaultModel ?? "";
  const modelName = (id: string) => models?.main.find((m) => m.id === id)?.name ?? id;
  const [loading, setLoading] = useState<string>(); // what warm() is waiting for, once it takes a while
  const warming = useRef(0);
  const [silenceMs, setSilenceMs] = useState(500);
  // one conversation per persona, so switching back resumes it
  const sessionsBy = useRef(new Map<string, string>());
  if (!sessionsBy.current.has(key)) sessionsBy.current.set(key, crypto.randomUUID());
  const session = sessionsBy.current.get(key)!;
  const turns = turnsBy[key] ?? [];
  const [level, setLevel] = useState(0);
  const [error, setError] = useState("");
  const settings = useRef<Settings>({ persona: persona?.id ?? "", key, session, effort, voice, model, silenceMs });
  settings.current = { persona: persona?.id ?? "", key, session, effort, voice, model, silenceMs };
  const engine = useRef<LiveEngine>(undefined);

  useEffect(() => {
    api<{ effort: string; voice: string; modelId?: string }>("/api/live/config").then((c) => {
      setEchoEffort(c.effort);
      setDefaultVoice(c.voice);
      setDefaultModel(c.modelId);
    }).catch(() => {});
  }, []);
  useEffect(() => {
    if (phase === "off") return;
    const t = setInterval(() => setLevel(engine.current?.level ?? 0), 100);
    return () => clearInterval(t);
  }, [phase]);
  // leaving the tab stops listening: an open microphone nobody watches is a surprise
  useEffect(() => {
    if (!active) {
      engine.current?.stop();
      stopVoiceTest();
    }
  }, [active]);
  useEffect(() => () => engine.current?.stop(), []);

  async function start() {
    setError("");
    const e = new LiveEngine(() => settings.current, setPhase, (t) => setTurnsBy((all) => {
      const ts = all[t.key] ?? [];
      const i = ts.findIndex((x) => x.id === t.id);
      return { ...all, [t.key]: i < 0 ? [...ts, t] : ts.map((x) => (x.id === t.id ? t : x)) };
    }));
    engine.current = e;
    try {
      await e.start();
    } catch (err) {
      setError(`Microphone: ${(err as Error).message}`);
      e.stop();
      return;
    }
    warm();
  }
  /** Load the model if another one is in, and put the system prompt in its cache and the voice in memory. Only one
   *  main model fits on the GPU, so a switch takes a minute or two: the status line says so. */
  function warm(id = settings.current.model) {
    const s = settings.current;
    const n = ++warming.current;
    const text = models?.active !== id ? `loading ${modelName(id)} in place of the current model (a minute or two)…` : "getting ready…";
    const slow = setTimeout(() => warming.current === n && setLoading(text), 1500);
    api(`/api/live/warm?voice=${encodeURIComponent(s.voice)}&persona=${s.persona}&model=${encodeURIComponent(id)}`, { method: "POST" })
      .catch((e) => warming.current === n && setError(`Getting ready: ${(e as Error).message}`))
      .finally(() => {
        clearTimeout(slow);
        if (warming.current === n) setLoading(undefined);
      });
  }
  function pickModel(id: string) {
    if (persona) savePersona({ model: id });
    else {
      setEchoModel(id);
      try {
        localStorage.setItem("echo.live.model", id);
      } catch {}
    }
    if (engine.current && phase !== "off") warm(id);
  }
  function newSession() {
    void api(`/api/live/reset?session=${session}`, { method: "POST" }).catch(() => {});
    sessionsBy.current.set(key, crypto.randomUUID());
    setTurnsBy((all) => ({ ...all, [key]: [] }));
    if (engine.current && phase !== "off") setTimeout(() => void engine.current?.greet(), 0); // after settings.current has the new session
  }
  function choose(id: string) {
    setPersonaId(id);
    try {
      localStorage.setItem("echo.live.persona", id);
    } catch {}
    // talking already: the persona greets you when its conversation is new, and its model loads if it has its own
    // (after the settings have switched)
    if (engine.current && phase !== "off") {
      setTimeout(() => {
        void engine.current?.greet();
        warm();
      }, 0);
    }
  }

  const delays = turns.map((t) => t.delayMs).filter((d): d is number => d !== undefined);
  return (
    <div className="h-full flex flex-col max-w-3xl mx-auto p-4 gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {phase === "off" ? <Button kind="primary" onClick={start}>Start</Button> : <Button kind="danger" onClick={() => engine.current?.stop()}>Stop</Button>}
        {phase === "speaking" || phase === "thinking" ? <Button onClick={() => engine.current?.interrupt()}>Interrupt</Button> : null}
        <div className="flex rounded-md border border-line overflow-hidden text-xs" role="radiogroup" aria-label="Thinking">
          {["off", "low"].map((e) => (
            <button key={e} role="radio" aria-checked={effort === e} onClick={() => setEffort(e)} title={e === "off" ? "Answers start soonest" : "Thinks first: better on hard questions, ~1 s+ slower"}
              className={`px-2.5 py-1.5 ${effort === e ? "bg-accent/20 text-accent" : "text-dim hover:text-text"}`}>thinking {e}</button>
          ))}
        </div>
        <Select value={String(silenceMs)} onChange={(v) => setSilenceMs(Number(v))} options={[
          { value: "400", label: "Reply after 0.4 s pause" }, { value: "500", label: "Reply after 0.5 s pause" }, { value: "700", label: "Reply after 0.7 s pause" },
        ]} />
        {models && model && (
          <span className="flex items-center gap-1.5 text-xs text-dim"
            title={"The main model that answers" + (persona ? ` as ${persona.name} (saved with the persona)` : "") + ". Only one fits on the GPU, so the first " +
              "answer loads it in place of the current one (a minute or two). A large model can leave no room for a GPU voice such as Qwen3-TTS Fast."}>
            answers with
            <ModelSelect models={models.main} value={model} onChange={pickModel} />
          </span>
        )}
        <div className="flex-1" />
        <Button kind="ghost" onClick={newSession}>New conversation</Button>
      </div>
      <PersonaBar personas={personas} selected={persona} onSelect={choose} voiceName={voices.voice?.name} modelName={modelName}
        newDefaults={() => ({ voice, effort: effort === "low" ? "low" : "off" })} />
      <ChangeVoice voices={voices} speed={persona?.speed ?? 1} live onTest={() => engine.current?.interrupt()} />
      <div className="flex items-center gap-3 text-sm">
        <span className={phase === "hearing" ? "text-good" : phase === "off" ? "text-dim" : "text-accent"}>{PHASE_TEXT[phase]}</span>
        {phase !== "off" && <div className="w-32 h-1.5 bg-line rounded-full overflow-hidden"><div className="h-full bg-good" style={{ width: `${Math.min(100, level * 600)}%` }} /></div>}
        <div className="flex-1" />
        {loading && <span className="text-xs text-warn">{loading}</span>}
        {delays.length > 0 && <span className="text-xs text-dim">median delay {(delays.sort((a, b) => a - b)[Math.floor(delays.length / 2)] / 1000).toFixed(2)} s over {delays.length}</span>}
      </div>
      {error && <div className="text-sm text-bad border border-bad/40 rounded p-2">{error}</div>}
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-3" aria-live="polite">
        {turns.map((t) => (
          <div key={t.id} className="flex flex-col gap-1">
            {!t.greeting && <div className="self-end bg-panel-2 border border-line rounded-lg px-3 py-1.5 max-w-[85%]">{t.user}</div>}
            <div className="self-start max-w-[85%]">{t.echo || (t.error ? "" : "…")}</div>
            {t.error && <div className="text-sm text-bad">{t.error}</div>}
            {t.tool && t.delayMs === undefined && !t.timings && <div className="flex text-[11px]"><ToolBadge tool={t.tool} /></div>}
            {(t.delayMs !== undefined || t.timings) && (
              <div className="flex flex-wrap gap-1 text-[11px]" title="From the end of your speech to the first sound of the answer, and where the time went">
                {t.delayMs !== undefined && <Badge tone={t.delayMs <= 1500 ? "good" : "warn"}>{(t.delayMs / 1000).toFixed(2)} s to first sound</Badge>}
                <Badge>pause {silenceMs} ms</Badge>
                {t.timings?.stt !== undefined && <Badge>speech to text {t.timings.stt} ms{t.early ? " (during the pause)" : ""}</Badge>}
                {t.timings?.firstToken !== undefined && <Badge>first word {t.timings.firstToken} ms</Badge>}
                {t.timings?.tts !== undefined && <Badge>voice {t.timings.tts} ms</Badge>}
                {t.tool && <ToolBadge tool={t.tool} />}
                {t.model && <Badge>{t.model}</Badge>}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function ToolBadge({ tool }: { tool: NonNullable<Turn["tool"]> }) {
  const name = tool.model === "decide" ? "decide model" : tool.web ? "chat model (with the web)" : "chat model";
  if (tool.ms === undefined) return <Badge tone="warn">asking the {name}…</Badge>;
  const took = `${(tool.ms / 1000).toFixed(1)} s`;
  return tool.model === "decide"
    ? <Badge tone="good">checked the {name} in {took}: {tool.answer}</Badge>
    : <span title="The full answer is saved as a conversation in the Chat tab"><Badge tone="good">checked the {name} in {took}: full answer in Chat</Badge></span>;
}
