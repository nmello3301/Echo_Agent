import { useEffect, useRef, useState } from "react";
import { api, toDataUrl } from "../api.ts";
import { Badge, Button, Select } from "./ui.tsx";
import { ChangeVoice, stopVoiceTest, synthesize, useVoices } from "./Voices.tsx";

type Step = "idle" | "ocr" | "summarize" | "speak";
const STEP_LABEL: Record<Step, string> = { idle: "", ocr: "Reading the screenshot…", summarize: "Summarizing…", speak: "Making speech…" };
const SPEEDS = ["0.8", "1", "1.25", "1.5", "1.75"] as const;

function load<T>(k: string, d: T): T {
  try {
    const v = localStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : d;
  } catch {
    return d;
  }
}
function save(k: string, v: unknown) {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {}
}

/** Paste a screenshot (Ctrl+V anywhere on this tab), read its text with OCR and speak it, or a summary of it. */
export function Read({ active }: { active: boolean }) {
  const [image, setImage] = useState<string>();
  const [text, setText] = useState("");
  const [summary, setSummary] = useState("");
  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState("");
  const [auto, setAuto] = useState(load("echo.read.autoSummarize", false));
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(load("echo.read.speed", "1"));
  const [audioUrl, setAudioUrl] = useState<string>();
  const [speaking, setSpeaking] = useState<"text" | "summary">();
  const audio = useRef<HTMLAudioElement>(null);
  const run = useRef(0); // a newer paste cancels the pipeline of an older one
  const voices = useVoices();

  useEffect(() => save("echo.read.autoSummarize", auto), [auto]);
  useEffect(() => save("echo.read.speed", speed), [speed]);
  useEffect(() => () => { if (audioUrl) URL.revokeObjectURL(audioUrl); }, [audioUrl]);

  const speak = async (what: "text" | "summary", body: string, id = run.current) => {
    if (!body.trim()) return;
    setStep("speak");
    const { url, rate } = await synthesize(body, voices.voice, Number(speed));
    if (id !== run.current) return URL.revokeObjectURL(url);
    setAudioUrl(url);
    setSpeaking(what);
    setStep("idle");
    // play() needs the new src on the element first; loading it resets the rate to the default one
    requestAnimationFrame(() => {
      const a = audio.current;
      if (!a) return;
      a.defaultPlaybackRate = a.playbackRate = rate;
      a.play().catch(() => {});
    });
  };

  const summarizeAndSpeak = async (body: string, id = run.current) => {
    setStep("summarize");
    const r = await api<{ summary: string }>("/api/read/summarize", { method: "POST", json: { text: body } });
    if (id !== run.current) return;
    setSummary(r.summary);
    await speak("summary", r.summary, id);
  };

  /** Each step's errors land in one place; a newer paste makes an older pipeline drop its results. */
  const pipeline = async (fn: (id: number) => Promise<void>) => {
    const id = ++run.current;
    audio.current?.pause();
    setError("");
    try {
      await fn(id);
    } catch (e) {
      if (id === run.current) setError((e as Error).message);
    } finally {
      if (id === run.current) setStep("idle");
    }
  };

  const fromImage = (blob: Blob) =>
    pipeline(async (id) => {
      const url = await toDataUrl(blob);
      setImage(url);
      setText("");
      setSummary("");
      setStep("ocr");
      const r = await api<{ text: string }>("/api/read/ocr", { method: "POST", json: { image: url } });
      if (id !== run.current) return;
      setText(r.text);
      if (!r.text.trim()) throw new Error("No text found in the image.");
      if (auto) await summarizeAndSpeak(r.text, id);
      else await speak("text", r.text, id);
    });

  const fromText = (t: string) =>
    pipeline(async (id) => {
      setImage(undefined);
      setText(t);
      setSummary("");
      if (auto) await summarizeAndSpeak(t, id);
      else await speak("text", t, id);
    });

  // Ctrl+V anywhere on this tab. In the text box an image is still read as a screenshot, but pasted text
  // just edits the box (so you can paste, fix and then read).
  useEffect(() => {
    if (!active) return;
    const h = (e: ClipboardEvent) => {
      const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith("image/"));
      if (file) {
        e.preventDefault();
        fromImage(file);
        return;
      }
      if ((e.target as HTMLElement)?.closest?.("textarea, input")) return;
      const t = e.clipboardData?.getData("text/plain");
      if (t?.trim()) {
        e.preventDefault();
        fromText(t);
      }
    };
    window.addEventListener("paste", h);
    return () => window.removeEventListener("paste", h);
  });

  const pasteButton = async () => {
    try {
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find((t) => t.startsWith("image/"));
        if (type) return fromImage(await item.getType(type));
      }
      const t = await navigator.clipboard.readText();
      if (t.trim()) return fromText(t);
      setError("The clipboard has no image or text.");
    } catch {
      setError("The browser didn't allow reading the clipboard: press Ctrl+V on this page instead.");
    }
  };

  const stop = () => {
    run.current++;
    audio.current?.pause();
    setStep("idle");
  };
  const busy = step !== "idle";

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto p-4 space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button kind="primary" onClick={pasteButton} disabled={busy}>Paste from clipboard</Button>
          <label className="flex items-center gap-2 text-sm cursor-pointer select-none ml-2">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} className="accent-[var(--color-accent)]" />
            Auto summarize + read
          </label>
          <span className="flex items-center gap-1.5 text-sm text-dim ml-auto">
            Speed
            <Select value={speed} onChange={setSpeed} options={SPEEDS.map((s) => ({ value: s, label: `${s}×` }))} />
          </span>
        </div>

        <ChangeVoice voices={voices} speed={Number(speed)} onTest={() => audio.current?.pause()} />

        <div className="text-sm text-dim">
          Press <kbd className="px-1 border border-line rounded">Ctrl</kbd>+<kbd className="px-1 border border-line rounded">V</kbd> on this tab to read a screenshot or copied text out loud, or type in the box below.
          {auto ? " With auto summarize on, you hear a short summary instead of the full text." : ""}
        </div>

        {(busy || error) && (
          <div className="flex items-center gap-2 text-sm">
            {busy && <><Badge tone="accent">{STEP_LABEL[step]}</Badge><Button kind="ghost" onClick={stop}>Cancel</Button></>}
            {error && <span className="text-bad">{error}</span>}
          </div>
        )}

        <div className={`flex items-center gap-2 ${audioUrl ? "" : "hidden"}`}>
          <audio ref={audio} src={audioUrl} controls className="flex-1" onPlay={stopVoiceTest} onEnded={() => setSpeaking(undefined)} />
          {speaking && <Badge>{speaking === "summary" ? "summary" : "full text"}</Badge>}
        </div>

        {image && <img src={image} alt="Pasted screenshot" className="max-h-64 rounded-md border border-line" />}

        {summary && (
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium">Summary</h2>
              <Button onClick={() => pipeline((id) => speak("summary", summary, id))} disabled={busy}>Read summary</Button>
            </div>
            <p className="bg-panel-2 border border-line rounded-md p-3 text-sm leading-relaxed">{summary}</p>
          </section>
        )}

        <section className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-medium">Text {image ? "from the screenshot" : ""}</h2>
            <div className="flex gap-2">
              <Button onClick={() => pipeline((id) => speak("text", text, id))} disabled={busy || !text.trim()}>Read aloud</Button>
              <Button onClick={() => pipeline((id) => summarizeAndSpeak(text, id))} disabled={busy || !text.trim()}>Summarize + read</Button>
            </div>
          </div>
          <textarea value={text} onChange={(e) => setText(e.target.value)} aria-label="Text to read" rows={12}
            placeholder="Type or paste text here, then press Ctrl+Enter to hear it."
            onKeyDown={(e) => {
              if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey) || busy || !text.trim()) return;
              e.preventDefault();
              pipeline((id) => (auto ? summarizeAndSpeak(text, id) : speak("text", text, id)));
            }}
            className="w-full bg-panel-2 border border-line rounded-md p-3 text-sm leading-relaxed" />
          <div className="text-xs text-dim">
            Ctrl+Enter reads it {auto ? "as a summary" : "aloud"}. You can fix OCR mistakes here before reading it again.
          </div>
        </section>
      </div>
    </div>
  );
}
