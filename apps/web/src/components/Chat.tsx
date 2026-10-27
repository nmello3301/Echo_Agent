import { useEffect, useRef, useState } from "react";
import { api, readSSE, useModels } from "../api.ts";
import { Badge, Button, Collapsible, EffortSelect, Markdown, ModelSelect } from "./ui.tsx";

type Part = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
interface Msg { role: "user" | "assistant"; content: string | Part[]; reasoning?: string | null; stats?: any }
interface Conv { id: string; title: string; updated_at: number }

function textOf(c: Msg["content"]) {
  return typeof c === "string" ? c : c.filter((p) => p.type === "text").map((p) => (p as any).text).join("\n");
}

export function Chat() {
  const models = useModels();
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("low");
  const [useNotes, setUseNotes] = useState(false);
  const [useWeb, setUseWeb] = useState(false);
  const [convs, setConvs] = useState<Conv[]>([]);
  const [search, setSearch] = useState("");
  const [convId, setConvId] = useState<string>();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (models && !model) setModel(models.active ?? models.defaults.model);
  }, [models]);
  const loadConvs = () => api<Conv[]>(`/api/conversations${search ? `?q=${encodeURIComponent(search)}` : ""}`).then(setConvs);
  useEffect(() => {
    loadConvs();
  }, [search]);
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [msgs]);

  const open = async (id?: string) => {
    if (busy) return;
    setConvId(id);
    setError("");
    setMsgs(id ? (await api(`/api/conversations/${id}`)).messages : []);
    inputRef.current?.focus();
  };

  const send = async () => {
    if (busy || (!input.trim() && !images.length)) return;
    const content: Msg["content"] = images.length ? [{ type: "text", text: input }, ...images.map((url) => ({ type: "image_url" as const, image_url: { url } }))] : input;
    setMsgs((m) => [...m, { role: "user", content }, { role: "assistant", content: "", reasoning: "" }]);
    setInput("");
    setImages([]);
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversationId: convId, model, effort, content, notes: useNotes, web: useWeb }) });
      await readSSE(r, (ev, d) => {
        if (ev === "meta") {
          setConvId(d.conversationId);
          loadConvs();
        } else if (ev === "status") setStatus(d.text);
        else if (ev === "sources") setMsgs((m) => [...m.slice(0, -1), { ...m[m.length - 1], stats: { ...(m[m.length - 1].stats ?? {}), sources: d.sources } }]);
        else if (ev === "delta") {
          setStatus("");
          setMsgs((m) => {
            const last = { ...m[m.length - 1] };
            if (d.content) last.content = (last.content as string) + d.content;
            if (d.reasoning) last.reasoning = (last.reasoning ?? "") + d.reasoning;
            return [...m.slice(0, -1), last];
          });
        } else if (ev === "done") setMsgs((m) => [...m.slice(0, -1), { ...m[m.length - 1], stats: d.stats }]);
        else if (ev === "error") setError(d.error);
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setStatus("");
      loadConvs();
    }
  };

  const stop = () => convId && api(`/api/chat/${convId}/stop`, { method: "POST" });

  const attach = (files: FileList | null) => {
    for (const f of Array.from(files ?? [])) {
      const rd = new FileReader();
      rd.onload = () => setImages((im) => [...im, rd.result as string]);
      rd.readAsDataURL(f);
    }
  };

  const rename = async (c: Conv) => {
    const t = prompt("Rename conversation", c.title);
    if (t) {
      await api(`/api/conversations/${c.id}`, { method: "PATCH", json: { title: t } });
      loadConvs();
    }
  };
  const del = async (c: Conv) => {
    if (!confirm(`Delete "${c.title}"?`)) return;
    await api(`/api/conversations/${c.id}`, { method: "DELETE" });
    if (c.id === convId) open(undefined);
    loadConvs();
  };

  const current = models?.main.find((m) => m.id === model);

  return (
    <div className="flex h-full min-h-0">
      <aside className="w-60 border-r border-line flex flex-col min-h-0 shrink-0">
        <div className="p-2 space-y-2">
          <Button kind="primary" className="w-full" onClick={() => open(undefined)}>New chat</Button>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search" aria-label="Search conversations"
            className="w-full bg-panel-2 border border-line rounded-md px-2 py-1.5 text-sm" />
        </div>
        <ul className="flex-1 overflow-y-auto px-1 pb-2">
          {convs.map((c) => (
            <li key={c.id} className={`group flex items-center rounded-md ${c.id === convId ? "bg-panel-2" : "hover:bg-panel-2/60"}`}>
              <button onClick={() => open(c.id)} className="flex-1 text-left truncate px-2 py-1.5 text-sm">{c.title}</button>
              <button onClick={() => rename(c)} className="opacity-0 group-hover:opacity-100 focus:opacity-100 text-dim hover:text-text text-xs px-1" aria-label="Rename">✎</button>
              <button onClick={() => del(c)} className="opacity-0 group-hover:opacity-100 focus:opacity-100 text-dim hover:text-bad text-xs px-1.5" aria-label="Delete">✕</button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="flex-1 flex flex-col min-w-0 min-h-0">
        <header className="flex flex-wrap items-center gap-2 p-2 border-b border-line">
          {models && <ModelSelect models={models.main} value={model} onChange={setModel} />}
          <EffortSelect value={effort} onChange={setEffort} />
          <label className="flex items-center gap-1.5 text-sm text-dim cursor-pointer select-none" title="Search your notes for each question and answer from them, with sources">
            <input type="checkbox" checked={useNotes} onChange={(e) => setUseNotes(e.target.checked)} className="accent-[var(--color-accent)]" />
            Use my notes
          </label>
          <label className="flex items-center gap-1.5 text-sm text-dim cursor-pointer select-none" title="Let the model search the web and read pages when it needs to, and cite them">
            <input type="checkbox" checked={useWeb} onChange={(e) => setUseWeb(e.target.checked)} className="accent-[var(--color-accent)]" />
            Search the web
          </label>
          {status && <Badge tone="warn">{status}</Badge>}
        </header>

        <div ref={scroller} className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto p-4 space-y-5">
            {!msgs.length && <p className="text-dim text-center mt-24">Ask anything. It all runs on this laptop.</p>}
            {msgs.map((m, i) => (
              <div key={i} className={m.role === "user" ? "flex justify-end" : ""}>
                {m.role === "user" ? (
                  <div className="bg-panel-2 border border-line rounded-lg px-3 py-2 max-w-[85%] whitespace-pre-wrap">
                    {textOf(m.content)}
                    {Array.isArray(m.content) && m.content.filter((p) => p.type === "image_url").map((p, j) => (
                      <img key={j} src={(p as any).image_url.url} alt="attachment" className="mt-2 max-h-48 rounded" />
                    ))}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {m.reasoning && <Collapsible title={`Thinking (${m.reasoning.length} chars)`}><div className="text-xs text-dim whitespace-pre-wrap">{m.reasoning}</div></Collapsible>}
                    <Markdown text={textOf(m.content)} />
                    {busy && i === msgs.length - 1 && !textOf(m.content) && !m.reasoning && <span className="text-dim animate-pulse">…</span>}
                    {m.stats?.searches?.length > 0 && (
                      <div className="text-[11px] text-dim">Searched: {m.stats.searches.map((q: string) => `“${q}”`).join(" · ")}</div>
                    )}
                    {m.stats?.sources?.length > 0 && (
                      <div className="text-[11px] text-dim space-y-0.5 border-l-2 border-line pl-2">
                        {m.stats.sources.map((s: any, k: number) => s.url ? (
                          <div key={k} className="truncate">[{s.n}] <a href={s.url} target="_blank" rel="noreferrer" className="hover:text-text underline decoration-line">{s.title}</a> <span className="opacity-60">· {new URL(s.url).hostname}</span></div>
                        ) : (
                          <div key={k}>[{k + 1}] {s.title} · {String(s.created).slice(0, 10)}{s.heading ? ` · ${s.heading}` : ""} <span className="opacity-60">({s.score.toFixed(2)})</span></div>
                        ))}
                      </div>
                    )}
                    {m.stats && (
                      <div className="text-[11px] text-dim font-mono flex gap-3 flex-wrap">
                        {m.stats.predicted_per_second != null && <span>{m.stats.predicted_per_second.toFixed(2)} tok/s</span>}
                        {m.stats.predicted_n != null && <span>{m.stats.predicted_n} tokens</span>}
                        {m.stats.ttft_ms != null && <span>TTFT {(m.stats.ttft_ms / 1000).toFixed(1)} s</span>}
                        {m.stats.draft_n ? <span>MTP {m.stats.draft_n_accepted}/{m.stats.draft_n}</span> : null}
                        {m.stats.aborted && <span className="text-warn">stopped</span>}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
            {error && <div className="text-bad text-sm border border-bad/40 rounded p-2">{error}</div>}
          </div>
        </div>

        <footer className="border-t border-line p-3">
          <div className="max-w-3xl mx-auto">
            {!!images.length && (
              <div className="flex gap-2 mb-2">
                {images.map((src, i) => (
                  <div key={i} className="relative">
                    <img src={src} alt="" className="h-14 rounded border border-line" />
                    <button onClick={() => setImages((im) => im.filter((_, j) => j !== i))} className="absolute -top-1.5 -right-1.5 bg-panel border border-line rounded-full w-5 h-5 text-xs" aria-label="Remove image">✕</button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex gap-2 items-end">
              <label className={`px-2 py-2 rounded-md border border-line text-dim hover:text-text cursor-pointer ${current?.vision ? "" : "opacity-40 pointer-events-none"}`} title={current?.vision ? "Attach image" : "This model does not read images"}>
                <input type="file" accept="image/*" multiple className="hidden" onChange={(e) => attach(e.target.files)} />📎
              </label>
              <textarea ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)} rows={Math.min(8, input.split("\n").length)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                onPaste={(e) => attach(e.clipboardData.files)}
                placeholder="Message (Enter to send, Shift+Enter for a new line)" aria-label="Message"
                className="flex-1 resize-none bg-panel-2 border border-line rounded-md px-3 py-2" />
              {busy ? <Button kind="danger" onClick={stop}>Stop</Button> : <Button kind="primary" onClick={send} disabled={!model}>Send</Button>}
            </div>
          </div>
        </footer>
      </section>
    </div>
  );
}
