import { useEffect, useRef, useState } from "react";
import { api, fmtBytes, useServerEvent } from "../api.ts";
import { Badge, Bar, Button, Collapsible } from "./ui.tsx";

interface FileStatus { name: string; dest: string; total: number; have: number; done: boolean }
interface Engine { cloned: boolean; cuda: boolean; built: boolean; building: boolean; log: string[]; installCommand: string }
type ModelType = "main" | "decision" | "tts";
interface ModelStatus {
  id: string; name: string; type: ModelType; role: string; error?: string; about: string; files: FileStatus[]; total: number; have: number;
  state: "installed" | "partial" | "missing" | "downloading";
  job: { file: string; have: number; total: number; bytesPerSec: number } | null;
  engine?: Engine;
}

const FILTERS: [ModelType | "all", string][] = [["all", "All"], ["main", "Language"], ["decision", "Decision"], ["tts", "Text to speech"]];
const isFilter = (f: string | undefined): f is ModelType | "all" => FILTERS.some(([id]) => id === f);

/** The filter shown first: from a link like #models/tts (the voice pickers link here), else the last one used. */
function startFilter(): ModelType | "all" {
  const fromHash = location.hash.match(/^#models\/(\w+)/)?.[1];
  if (isFilter(fromHash)) return fromHash;
  try {
    const saved = localStorage.getItem("echo.models.filter") ?? undefined;
    return isFilter(saved) ? saved : "all";
  } catch {
    return "all";
  }
}

const tone = { installed: "good", partial: "warn", missing: "dim", downloading: "accent" } as const;

function eta(left: number, bps: number) {
  if (!bps) return "";
  const s = left / bps;
  return s > 3600 ? `${(s / 3600).toFixed(1)} h` : s > 60 ? `${Math.round(s / 60)} min` : `${Math.round(s)} s`;
}

export function Models() {
  const [models, setModels] = useState<ModelStatus[]>();
  const [error, setError] = useState("");
  const [buildLog, setBuildLog] = useState<string[]>([]);
  const [filter, setFilter] = useState(startFilter);
  const chooseFilter = (f: ModelType | "all") => {
    setFilter(f);
    try {
      localStorage.setItem("echo.models.filter", f);
    } catch {}
  };
  const logRef = useRef<HTMLPreElement>(null);

  const load = () => api<ModelStatus[]>("/api/downloads").then((m) => {
    setModels(m);
    const e = m.find((x) => x.engine)?.engine;
    if (e?.building) setBuildLog(e.log);
  }).catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  useServerEvent((e) => {
    if (e.type === "download") {
      if (e.state) load();
      else setModels((ms) => ms?.map((m) => (m.id === e.id ? { ...m, state: "downloading", job: { file: e.file, have: e.have, total: e.total, bytesPerSec: e.bytesPerSec } } : m)));
      if (e.state === "error") setError(`${e.id}: ${e.error}`);
    }
    if (e.type === "strata_build") {
      if (e.line) setBuildLog((l) => [...l.slice(-400), e.line]);
      if (e.done) load();
    }
  });
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [buildLog]);

  const act = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto p-4 space-y-4">
        <header>
          <h2 className="text-lg font-semibold">Models</h2>
          <p className="text-sm text-dim">Downloads go straight to the folder each engine reads from (see models.yaml). Downloads resume where they stopped, and cancelling keeps what was downloaded.</p>
        </header>
        {error && <div className="text-bad text-sm border border-bad/40 rounded p-2">{error}</div>}
        {!models && <p className="text-dim text-sm">Checking sizes on Hugging Face…</p>}
        {models && (
          <div className="flex rounded-md border border-line overflow-hidden text-sm w-fit" role="tablist" aria-label="Model type">
            {FILTERS.map(([id, label]) => {
              const n = id === "all" ? models.length : models.filter((m) => m.type === id).length;
              return (
                <button key={id} role="tab" aria-selected={filter === id} onClick={() => chooseFilter(id)}
                  className={`px-3 py-1.5 ${filter === id ? "bg-accent/20 text-accent" : "text-dim hover:text-text"}`}>
                  {label} <span className="text-xs opacity-70">{n}</span>
                </button>
              );
            })}
          </div>
        )}

        {models?.filter((m) => filter === "all" || m.type === filter).map((m) => {
          const have = m.job?.have ?? m.have;
          const total = m.job?.total || m.total;
          return (
            <section key={m.id} className="border border-line rounded-lg bg-panel p-4 space-y-3">
              <div className="flex flex-wrap items-start gap-3">
                <div className="flex-1 min-w-60">
                  <div className="flex items-center gap-2"><h3 className="font-medium">{m.name}</h3><Badge tone={tone[m.state]}>{m.state}</Badge></div>
                  <div className="text-xs text-dim">{m.role} · {fmtBytes(m.total)}</div>
                  <p className="text-sm text-dim mt-1">{m.about}</p>
                  {m.error && <p className="text-xs text-bad mt-1">{m.error}</p>}
                </div>
                <div className="flex gap-2">
                  {m.state === "downloading" ? (
                    <Button kind="danger" onClick={() => act(() => api(`/api/downloads/${m.id}`, { method: "DELETE" }))}>Cancel</Button>
                  ) : m.state !== "installed" ? (
                    <Button kind="primary" onClick={() => act(() => api(`/api/downloads/${m.id}`, { method: "POST" }))}>{m.state === "partial" ? "Resume download" : `Download ${fmtBytes(m.total - m.have)}`}</Button>
                  ) : null}
                </div>
              </div>

              {m.state !== "installed" && (
                <div className="space-y-1">
                  <Bar value={have} max={total || 1} />
                  <div className="flex justify-between text-[11px] text-dim font-mono">
                    <span>{fmtBytes(have)} / {fmtBytes(total)}{m.job ? ` · ${m.job.file}` : ""}</span>
                    {m.job && <span>{fmtBytes(m.job.bytesPerSec)}/s · {eta(total - have, m.job.bytesPerSec)} left</span>}
                  </div>
                </div>
              )}

              <Collapsible title={`${m.files.length} files`}>
                <ul className="text-xs font-mono space-y-0.5">
                  {m.files.map((f) => (
                    <li key={f.dest} className="flex gap-2"><span className={f.done ? "text-good" : "text-dim"}>{f.done ? "✓" : "○"}</span><span className="flex-1 truncate" title={f.dest}>{f.dest}</span><span className="text-dim">{fmtBytes(f.total)}</span></li>
                  ))}
                </ul>
              </Collapsible>

              {m.engine && (
                <div className="border-t border-line pt-3 space-y-2">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-medium">Strata engine</span>
                    <Badge tone={m.engine.built ? "good" : m.engine.building ? "accent" : "warn"}>{m.engine.built ? "built" : m.engine.building ? "building" : "not built"}</Badge>
                  </div>
                  {!m.engine.built && !m.engine.cuda && (
                    <div className="text-sm space-y-1">
                      <p className="text-dim">Strata compiles its engine on Arch, which needs the CUDA toolkit (about 5 GB, needs your password). Run this in a terminal, then come back and press Build:</p>
                      <pre className="font-mono text-xs bg-[#0a0c10] border border-line rounded p-2 select-all">{m.engine.installCommand}</pre>
                    </div>
                  )}
                  {!m.engine.built && (
                    <Button disabled={!m.engine.cuda || m.engine.building || m.state !== "installed"} onClick={() => act(() => api("/api/strata/build", { method: "POST" }))}
                      title={m.state !== "installed" ? "Download the model first" : !m.engine.cuda ? "Install the CUDA toolkit first" : ""}>
                      {m.engine.building ? "Building… (20-40 min)" : "Build Strata engine"}
                    </Button>
                  )}
                  {(m.engine.building || buildLog.length > 0) && (
                    <pre ref={logRef} className="text-[11px] font-mono bg-[#0a0c10] border border-line rounded p-2 max-h-64 overflow-auto whitespace-pre-wrap">{buildLog.join("\n")}</pre>
                  )}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
