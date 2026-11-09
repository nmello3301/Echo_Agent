/** Live personas: named characters to talk to, each with its own voice, instructions and settings (server side:
 *  apps/server/src/personas.ts). The bar picks one; its voice is whatever Change voice picks while it is chosen. */
import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { Button, Select } from "./ui.tsx";

export interface Persona {
  id: string;
  name: string;
  voice: string;
  prompt: string;
  effort: "off" | "low";
  length: "short" | "medium" | "long";
  temperature: number | null;
  speed: number;
  greeting: string;
  helpers: { chat: boolean; decide: boolean };
}

export function usePersonas() {
  const [list, setList] = useState<Persona[]>([]);
  const [error, setError] = useState("");
  const reload = () => api<Persona[]>("/api/live/personas").then((l) => { setList(l); setError(""); }).catch((e) => setError(e.message));
  useEffect(() => {
    reload();
  }, []);
  const save = async (p: Partial<Persona>): Promise<Persona> => {
    const saved = await api<Persona>(p.id ? `/api/live/personas/${encodeURIComponent(p.id)}` : "/api/live/personas", { method: p.id ? "PUT" : "POST", json: p });
    setList((l) => [...l.filter((x) => x.id !== saved.id), saved].sort((a, b) => a.name.localeCompare(b.name)));
    return saved;
  };
  const remove = async (id: string) => {
    await api(`/api/live/personas/${encodeURIComponent(id)}`, { method: "DELETE" });
    setList((l) => l.filter((x) => x.id !== id));
  };
  return { list, error, save, remove };
}

const LENGTHS = [
  { value: "short", label: "Short replies (1-3 sentences)" },
  { value: "medium", label: "Medium replies (up to 6)" },
  { value: "long", label: "Long replies (as needed)" },
] as const;
const SPEEDS = ["0.8", "0.9", "1", "1.1", "1.2", "1.3"].map((v) => ({ value: v, label: `Speech ${v}x` }));

/** The persona picker, and the editor for the one being made or changed. `selected` undefined: Echo's own. */
export function PersonaBar({ personas, selected, onSelect, newDefaults, voiceName, disabled }: {
  personas: ReturnType<typeof usePersonas>;
  selected?: Persona;
  onSelect: (id: string) => void;
  /** What a new persona starts with: the voice and thinking in use now */
  newDefaults: () => Pick<Persona, "voice" | "effort">;
  voiceName?: string;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState<Partial<Persona>>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const chip = (id: string, name: string) => (
    <button key={id || "echo"} role="radio" aria-checked={(selected?.id ?? "") === id} disabled={disabled}
      onClick={() => { setDraft(undefined); onSelect(id); }}
      className={`rounded-md border px-2.5 py-1 text-sm disabled:opacity-50 ${(selected?.id ?? "") === id ? "border-accent bg-accent/15 text-accent" : "border-line hover:border-dim"}`}>
      {name}
    </button>
  );
  const set = (patch: Partial<Persona>) => setDraft((d) => ({ ...d, ...patch }));
  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setError("");
    try {
      const saved = await personas.save(draft);
      setDraft(undefined);
      onSelect(saved.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!draft?.id || !confirm(`Delete the persona "${draft.name}"?`)) return;
    try {
      await personas.remove(draft.id);
      setDraft(undefined);
      onSelect("");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <section className="border border-line rounded-md">
      <div className="flex flex-wrap items-center gap-1.5 px-3 py-2" role="radiogroup" aria-label="Persona">
        <span className="text-sm text-dim mr-1">Talk to</span>
        {chip("", "Echo")}
        {personas.list.map((p) => chip(p.id, p.name))}
        <div className="flex-1" />
        {selected && !draft && <Button kind="ghost" onClick={() => setDraft({ ...selected })} disabled={disabled}>Edit {selected.name}</Button>}
        {!draft && (
          <Button onClick={() => setDraft({ name: "", prompt: "", greeting: "", length: "short", temperature: null, speed: 1, helpers: { chat: true, decide: true }, ...newDefaults() })}
            disabled={disabled} title="A named character with its own voice, instructions and settings">+ New persona</Button>
        )}
      </div>
      {personas.error && <div className="px-3 pb-2 text-sm text-bad">{personas.error}</div>}
      {draft && (
        <div className="border-t border-line p-3 space-y-3 text-sm">
          <label className="flex items-center gap-2">
            <span className="w-24 text-dim">Name</span>
            <input value={draft.name ?? ""} onChange={(e) => set({ name: e.target.value })} placeholder="Lambda" maxLength={40} autoFocus
              className="flex-1 bg-panel-2 border border-line rounded-md px-2 py-1.5" />
          </label>
          <label className="flex gap-2">
            <span className="w-24 text-dim pt-1.5">Instructions</span>
            <textarea value={draft.prompt ?? ""} onChange={(e) => set({ prompt: e.target.value })} rows={6}
              placeholder="Who it is and how it talks. For example: You are Lambda, a dry-witted engineer. You answer briefly, tease a little, and never pretend to know what you don't."
              className="flex-1 bg-panel-2 border border-line rounded-md px-2 py-1.5 font-mono text-xs leading-relaxed" />
          </label>
          <p className="text-xs text-dim" style={{ marginLeft: "6.5rem" }}>
            Echo adds its spoken-style rules after these (short spoken sentences, no lists or emoji), so whatever it says can be read aloud.
          </p>
          <label className="flex items-center gap-2">
            <span className="w-24 text-dim">Greeting</span>
            <input value={draft.greeting ?? ""} onChange={(e) => set({ greeting: e.target.value })} placeholder="Said when a conversation starts, e.g. Hey, Lambda here. What's up?" maxLength={300}
              className="flex-1 bg-panel-2 border border-line rounded-md px-2 py-1.5" />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-24 text-dim">Replies</span>
            <div className="flex rounded-md border border-line overflow-hidden text-xs" role="radiogroup" aria-label="Thinking">
              {(["off", "low"] as const).map((e) => (
                <button key={e} role="radio" aria-checked={draft.effort === e} onClick={() => set({ effort: e })}
                  className={`px-2.5 py-1.5 ${draft.effort === e ? "bg-accent/20 text-accent" : "text-dim hover:text-text"}`}>thinking {e}</button>
              ))}
            </div>
            <Select value={draft.length ?? "short"} onChange={(v) => set({ length: v })} options={[...LENGTHS]} />
            <Select value={String(draft.speed ?? 1)} onChange={(v) => set({ speed: Number(v) })} options={SPEEDS} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-24 text-dim">Temperature</span>
            <label className="flex items-center gap-1.5 text-dim cursor-pointer select-none">
              <input type="checkbox" checked={draft.temperature == null} onChange={(e) => set({ temperature: e.target.checked ? null : 0.7 })} />
              the model's own
            </label>
            {draft.temperature != null && (
              <>
                <input type="range" min={0} max={1.5} step={0.05} value={draft.temperature} onChange={(e) => set({ temperature: Number(e.target.value) })} aria-label="Temperature" />
                <span className="tabular-nums w-10">{draft.temperature.toFixed(2)}</span>
                <span className="text-xs text-dim">lower: steadier wording · higher: more varied</span>
              </>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="w-24 text-dim">May ask</span>
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <input type="checkbox" checked={draft.helpers?.chat !== false} onChange={(e) => set({ helpers: { chat: e.target.checked, decide: draft.helpers?.decide !== false } })} />
              the chat model (thinks, searches the web)
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <input type="checkbox" checked={draft.helpers?.decide !== false} onChange={(e) => set({ helpers: { chat: draft.helpers?.chat !== false, decide: e.target.checked } })} />
              the decide model
            </label>
          </div>
          <p className="text-xs text-dim" style={{ marginLeft: "6.5rem" }}>
            Voice: {draft.id && selected?.id === draft.id ? voiceName ?? draft.voice : "the one picked now"}. With the persona chosen, Change voice below sets its voice.
          </p>
          {error && <div className="text-bad">{error}</div>}
          <div className="flex gap-2" style={{ marginLeft: "6.5rem" }}>
            <Button kind="primary" onClick={save} disabled={busy || !draft.name?.trim()}>{draft.id ? "Save" : "Create"}</Button>
            <Button kind="ghost" onClick={() => { setDraft(undefined); setError(""); }}>Cancel</Button>
            {draft.id && <Button kind="danger" className="ml-auto" onClick={remove}>Delete</Button>}
          </div>
        </div>
      )}
    </section>
  );
}
