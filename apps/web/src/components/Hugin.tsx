import { useEffect, useState } from "react";
import { api, useServerEvent } from "../api.ts";
import { Badge, Bar, Button, Markdown } from "./ui.tsx";

interface Hit { path: string; title: string; created: string; type: string; heading: string; text: string; score: number }
interface Note { path: string; title: string; type: string; created: string; tags: string }
interface Status { notes: number; chunks: number; dirs: string[]; lastRun: number; indexing: boolean; error?: string }

const base = (p: string) => p.split("/").pop() ?? p;
const day = (s: string) => s.slice(0, 16).replace("T", " ");
const stripFrontMatter = (t: string) => t.replace(/^---\n[\s\S]*?\n---\n?/, "");

function NotesView() {
  const [q, setQ] = useState("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [hits, setHits] = useState<Hit[]>();
  const [ms, setMs] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notes, setNotes] = useState<Note[]>([]);
  const [status, setStatus] = useState<Status>();
  const [open, setOpen] = useState<{ path: string; text: string; highlight?: string }>();

  const load = () => {
    api<Note[]>("/api/notes?limit=200").then(setNotes);
    api<Status>("/api/notes/status").then(setStatus);
  };
  useEffect(load, []);
  useServerEvent((e) => e.type === "notes_index" && load());

  const search = async () => {
    if (!q.trim()) return;
    setBusy(true);
    setError("");
    try {
      const params = new URLSearchParams({ q, k: "8", ...(since ? { since } : {}), ...(until ? { until } : {}) });
      const r = await api<{ hits: Hit[]; ms: number }>(`/api/notes/search?${params}`);
      setHits(r.hits);
      setMs(r.ms);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const read = async (path: string, highlight?: string) => setOpen({ path, highlight, text: (await api<{ text: string }>(`/api/notes/read?path=${encodeURIComponent(path)}`)).text });

  return (
    <div className="flex h-full min-h-0">
      <aside className="w-72 border-r border-line flex flex-col min-h-0 shrink-0">
        <div className="p-3 space-y-1 border-b border-line text-xs text-dim">
          <div className="flex items-center justify-between">
            <span>{status ? `${status.notes} notes · ${status.chunks} passages` : "…"}</span>
            {status?.indexing ? <Badge tone="accent">indexing</Badge> : <button className="hover:text-accent" onClick={() => api("/api/notes/reindex", { method: "POST" }).then(load)}>reindex</button>}
          </div>
          {status?.error && <div className="text-bad">{status.error}</div>}
          <div className="truncate" title={status?.dirs.join("\n")}>{status?.dirs.map(base).join(", ")}</div>
        </div>
        <ul className="flex-1 overflow-y-auto p-1">
          {!notes.length && <li className="p-3 text-sm text-dim">No notes yet. Record one in the Hugin app view.</li>}
          {notes.map((n) => (
            <li key={n.path}>
              <button onClick={() => read(n.path)} className={`w-full text-left px-2 py-1.5 rounded-md ${open?.path === n.path ? "bg-panel-2" : "hover:bg-panel-2/60"}`}>
                <div className="text-sm truncate">{n.title}</div>
                <div className="text-[11px] text-dim flex gap-1.5"><span>{day(n.created)}</span><span>· {n.type}</span></div>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="flex-1 min-w-0 overflow-y-auto">
        <div className="max-w-3xl mx-auto p-4 space-y-4">
          <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); search(); }}>
            <div className="flex gap-2">
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask your notes: what did I decide about the gearbox?" aria-label="Search notes"
                className="flex-1 bg-panel-2 border border-line rounded-md px-3 py-2" />
              <Button kind="primary" type="submit" disabled={busy || !q.trim()}>{busy ? "Searching…" : "Search"}</Button>
            </div>
            <div className="flex gap-3 text-xs text-dim items-center">
              <label className="flex items-center gap-1">from <input type="date" value={since} onChange={(e) => setSince(e.target.value)} className="bg-panel-2 border border-line rounded px-1 py-0.5" /></label>
              <label className="flex items-center gap-1">to <input type="date" value={until} onChange={(e) => setUntil(e.target.value)} className="bg-panel-2 border border-line rounded px-1 py-0.5" /></label>
              <span>Keywords + meaning, reranked. Works across English and Portuguese.</span>
            </div>
          </form>
          {error && <div className="text-bad text-sm border border-bad/40 rounded p-2">{error}</div>}

          {open ? (
            <article className="border border-line rounded-lg bg-panel p-4 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-dim font-mono truncate">{base(open.path)}</span>
                <Button kind="ghost" onClick={() => setOpen(undefined)}>Close</Button>
              </div>
              <Markdown text={stripFrontMatter(open.text)} />
            </article>
          ) : hits ? (
            <div className="space-y-2">
              <div className="text-xs text-dim">{hits.length ? `${hits.length} passages in ${(ms / 1000).toFixed(1)} s` : "Nothing in your notes matches that."}</div>
              {hits.map((h, i) => (
                <button key={i} onClick={() => read(h.path, h.text)} className="w-full text-left border border-line rounded-md bg-panel p-3 hover:border-dim space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm flex-1 truncate">{h.title}{h.heading ? <span className="text-dim"> — {h.heading}</span> : null}</span>
                    <span className="text-[11px] text-dim">{day(h.created)}</span>
                  </div>
                  <div className="w-24"><Bar value={h.score} tone={h.score > 0.5 ? "good" : "accent"} /></div>
                  <p className="text-sm text-dim whitespace-pre-wrap line-clamp-4">{h.text}</p>
                </button>
              ))}
            </div>
          ) : (
            <p className="text-dim text-sm">Search finds passages in your voice notes, meetings and any other note folders in echo.yaml. In Chat, turn on "Use my notes" to have Echo answer from them with sources; the agent can search them too.</p>
          )}
        </div>
      </section>
    </div>
  );
}

function HuginApp() {
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState("");
  const connect = () => {
    setError("");
    api<{ url: string }>("/api/hugin/session", { method: "POST" }).then((r) => setUrl(r.url)).catch((e) => setError(e.message));
  };
  useEffect(connect, []);
  if (error) return (
    <div className="p-6 space-y-2">
      <p className="text-bad text-sm">{error}</p>
      <p className="text-dim text-sm">Hugin starts with Echo; the first start downloads its Whisper and LLM models. Check its status in the Monitor.</p>
      <Button onClick={connect}>Retry</Button>
    </div>
  );
  if (!url) return <p className="p-6 text-dim text-sm">Connecting to Hugin…</p>;
  return <iframe title="Hugin" src={url} className="w-full h-full border-0 bg-white" allow="microphone; clipboard-write" />;
}

export function Hugin() {
  const [view, setView] = useState<"notes" | "app">("notes");
  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex gap-1 px-3 py-1.5 border-b border-line text-sm">
        <button onClick={() => setView("notes")} className={`px-3 py-1 rounded-md ${view === "notes" ? "bg-panel-2" : "text-dim hover:text-text"}`}>My notes</button>
        <button onClick={() => setView("app")} className={`px-3 py-1 rounded-md ${view === "app" ? "bg-panel-2" : "text-dim hover:text-text"}`}>Hugin app (record, settings)</button>
      </div>
      <div className="flex-1 min-h-0">{view === "notes" ? <NotesView /> : <HuginApp />}</div>
    </div>
  );
}
