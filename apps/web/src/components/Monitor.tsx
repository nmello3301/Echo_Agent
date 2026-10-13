import { useState } from "react";
import { api, fmtBytes, fmtNum, useMetrics, useServerEvent } from "../api.ts";
import { Badge, Bar, Button } from "./ui.tsx";

function Sparkline({ values }: { values: (number | null)[] }) {
  const w = 220;
  const h = 36;
  const nums = values.map((v) => v ?? 0);
  const max = Math.max(1, ...nums);
  const step = w / Math.max(1, 59);
  const pts = nums.slice(-60).map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * (h - 2) - 1).toFixed(1)}`).join(" ");
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="h-9" role="img" aria-label="Decode tokens per second, last 60 seconds">
      <polyline points={pts} fill="none" stroke="var(--color-accent)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="flex justify-between gap-2 text-xs"><span className="text-dim">{label}</span><span className="font-mono text-right">{children}</span></div>;
}

const statusTone = (s: string) => (s === "ready" ? "good" : s === "starting" ? "warn" : s === "error" ? "bad" : "dim") as "good" | "warn" | "bad" | "dim";

export function Monitor({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const m = useMetrics();
  const [phase, setPhase] = useState<{ phase: string; pHuman?: number }>({ phase: "idle" });
  const [logFor, setLogFor] = useState<string>();
  const [log, setLog] = useState<string[]>([]);
  useServerEvent((e) => {
    if (e.type === "agent" && e.event.kind === "phase") setPhase((p) => ({ ...p, phase: e.event.phase }));
    if (e.type === "agent" && e.event.kind === "status" && ["idle", "done", "stopped", "error"].includes(e.event.status)) setPhase((p) => ({ ...p, phase: "idle" }));
    if (e.type === "hitl_probability") setPhase((p) => ({ ...p, pHuman: e.p }));
    if (e.type === "engine_log" && e.id === logFor) setLog((l) => [...l.slice(-300), e.line]);
  }, [logFor]);

  const s = m?.stream;
  const g = m?.gpu;
  const vramPct = g ? g.vramUsed / g.vramTotal : 0;
  const ramPct = m ? m.ram.used / m.ram.total : 0;

  if (collapsed) {
    return (
      <button onClick={onToggle} className="h-full w-full flex flex-col items-center gap-3 py-3 text-[11px] font-mono text-dim hover:text-text" title="Expand monitor">
        <span className="text-accent">{fmtNum(s?.decodeTps)}<br />tok/s</span>
        <span>VRAM<br />{Math.round(vramPct * 100)}%</span>
        <span>RAM<br />{Math.round(ramPct * 100)}%</span>
      </button>
    );
  }

  const openLog = async (id: string) => {
    if (logFor === id) return setLogFor(undefined);
    setLogFor(id);
    setLog(await api(`/api/engines/${id}/log`));
  };

  return (
    <div className="h-full overflow-y-auto p-3 space-y-4 text-sm">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Monitor</h2>
        <Button kind="ghost" onClick={onToggle} title="Collapse">⟩</Button>
      </div>

      {m?.power && m.power.ac === false && <div className="text-xs text-warn border border-warn/40 rounded p-2">On battery ({m.power.battery}%): speed will drop.</div>}
      {g?.throttled && <div className="text-xs text-bad border border-bad/40 rounded p-2">GPU is thermally throttled ({g.temp} °C).</div>}

      <section className="space-y-1.5">
        <h3 className="text-xs uppercase tracking-wide text-dim">Tokens per second</h3>
        <div className="flex items-baseline gap-2"><span className="text-2xl font-mono text-accent">{fmtNum(s?.decodeTps)}</span><span className="text-xs text-dim">decode{s?.active ? " · live" : " · last"}</span></div>
        <Sparkline values={m?.sparkline ?? []} />
        <Row label="Prompt processing">{fmtNum(s?.promptTps)} tok/s</Row>
        <Row label="Time to first token">{s?.ttftMs != null ? `${(s.ttftMs / 1000).toFixed(1)} s` : "–"}</Row>
        <Row label="Prefix cache reuse">{s?.cachedTokens != null && s?.promptTokens != null ? `${s.cachedTokens} / ${s.cachedTokens + s.promptTokens}` : "–"}</Row>
      </section>

      <section className="space-y-1.5">
        <h3 className="text-xs uppercase tracking-wide text-dim">Context</h3>
        <Bar value={s?.contextUsed ?? 0} max={s?.contextLimit ?? 1} tone={(s?.contextUsed ?? 0) / (s?.contextLimit ?? 1) > 0.8 ? "warn" : "accent"} />
        <Row label="Used / limit">{s?.contextUsed ?? "–"} / {s?.contextLimit ?? "–"}</Row>
      </section>

      <section className="space-y-1.5">
        <h3 className="text-xs uppercase tracking-wide text-dim">GPU</h3>
        <Bar value={vramPct} tone={vramPct > 0.92 ? "bad" : vramPct > 0.8 ? "warn" : "accent"} />
        <Row label="VRAM">{fmtBytes(g?.vramUsed)} / {fmtBytes(g?.vramTotal)}</Row>
        <Row label="Utilisation">{g ? `${g.util}%` : "–"}</Row>
        <Row label="Temperature">{g ? `${g.temp} °C` : "–"}</Row>
        <Row label="Power">{g?.power ? `${g.power.toFixed(0)} W` : "–"}</Row>
      </section>

      <section className="space-y-1.5">
        <h3 className="text-xs uppercase tracking-wide text-dim">RAM</h3>
        <Bar value={ramPct} tone={ramPct > 0.92 ? "bad" : ramPct > 0.8 ? "warn" : "accent"} />
        <Row label="Used / total">{fmtBytes(m?.ram.used)} / {fmtBytes(m?.ram.total)}</Row>
        <Row label="Engines resident (incl. mapped model files)">{fmtBytes(m?.ram.engine.resident)}</Row>
        <Row label="Engines pinned">{fmtBytes(m?.ram.engine.pinned)}</Row>
      </section>

      <section className="space-y-1.5">
        <h3 className="text-xs uppercase tracking-wide text-dim">CPU · {m?.cpu.total ?? 0}%</h3>
        <div className="flex gap-0.5 h-6 items-end" aria-label="Per-core load">
          {(m?.cpu.cores ?? []).map((c: number, i: number) => (
            <div key={i} className="flex-1 bg-line rounded-sm overflow-hidden h-full flex items-end" title={`core ${i}: ${c}%`}>
              <div className="w-full bg-accent/70" style={{ height: `${c}%` }} />
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-1.5">
        <h3 className="text-xs uppercase tracking-wide text-dim">Engines</h3>
        <Row label="Agent phase">
          <Badge tone={phase.phase === "decision" ? "warn" : phase.phase === "action" ? "accent" : "dim"}>{phase.phase === "decision" ? "decision time" : phase.phase === "action" ? "action time" : "idle"}</Badge>
        </Row>
        <Row label="Last P(needs human)">{phase.pHuman != null ? phase.pHuman.toFixed(2) : "–"}</Row>
        <Row label="Queue">{s?.active ? `1 running (${s.source})` : "empty"}</Row>
        {(m?.engines ?? []).map((e: any) => (
          <div key={e.id} className="border border-line rounded p-2 space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs truncate" title={e.name}>{e.name}</span>
              <Badge tone={statusTone(e.status)}>{e.status}</Badge>
            </div>
            {e.error && <div className="text-[11px] text-bad">{e.error}</div>}
            {e.loadMs > 0 && <div className="text-[11px] text-dim">loaded in {(e.loadMs / 1000).toFixed(1)} s</div>}
            <button className="text-[11px] text-dim hover:text-accent" onClick={() => openLog(e.id)}>{logFor === e.id ? "hide log" : "show log"}</button>
            {logFor === e.id && <pre className="text-[10px] font-mono bg-[#0a0c10] p-1.5 rounded max-h-52 overflow-auto whitespace-pre-wrap">{log.slice(-120).join("\n")}</pre>}
          </div>
        ))}
      </section>
    </div>
  );
}
