import { useEffect, useMemo, useRef, useState } from "react";
import { api, useModels, useServerEvent } from "../api.ts";
import { Badge, Bar, Button, Collapsible, EffortSelect, Markdown, ModelSelect } from "./ui.tsx";

interface Ev { kind: string; ts: number; [k: string]: any }
const RECENT_KEY = "echo.recentFolders";

function recentFolders(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
  } catch {
    return [];
  }
}

const statusTone = (s: string) =>
  (({ action: "accent", decision: "warn", waiting_human: "bad", waiting_approval: "bad", idle: "good", done: "good", error: "bad" } as Record<string, any>)[s] ?? "dim");

function DiffView({ diff }: { diff: string }) {
  if (!diff.trim()) return <p className="text-dim text-xs">No changes.</p>;
  return (
    <pre className="text-[12px] font-mono bg-[#0a0c10] border border-line rounded p-2 overflow-auto max-h-[60vh]">
      {diff.split("\n").map((l, i) => (
        <div key={i} className={l.startsWith("+") && !l.startsWith("+++") ? "text-good" : l.startsWith("-") && !l.startsWith("---") ? "text-bad" : l.startsWith("@@") ? "text-accent" : l.startsWith("diff ") ? "text-text font-semibold mt-2" : "text-dim"}>{l || " "}</div>
      ))}
    </pre>
  );
}

function ToolCard({ start, end }: { start: Ev; end?: Ev }) {
  const args = start.args ?? {};
  const headline = start.name === "bash" ? args.command : args.path ?? args.pattern ?? (start.name === "todo" ? `${args.items?.length ?? 0} items` : start.name === "checkpoint" ? args.summary : JSON.stringify(args).slice(0, 120));
  const status = !end ? "running" : end.isError ? "error" : "ok";
  return (
    <div className={`border rounded-md bg-panel ${status === "error" ? "border-bad/40" : "border-line"}`}>
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <Badge tone="accent">{start.name}</Badge>
        <span className="font-mono text-xs truncate flex-1" title={String(headline)}>{String(headline ?? "")}</span>
        {end?.ms != null && <span className="text-[11px] text-dim font-mono">{(end.ms / 1000).toFixed(1)} s</span>}
        <Badge tone={status === "ok" ? "good" : status === "error" ? "bad" : "warn"}>{status}</Badge>
      </div>
      <div className="px-2.5 pb-2 space-y-1.5">
        <Collapsible title="Arguments"><pre className="text-[11px] font-mono whitespace-pre-wrap">{JSON.stringify(args, null, 1)}</pre></Collapsible>
        {end && end.details?.diff && <Collapsible title="Diff" open><DiffView diff={end.details.diff} /></Collapsible>}
        {end && <Collapsible title="Output" open={!!end.isError}><pre className="text-[11px] font-mono whitespace-pre-wrap max-h-80 overflow-auto">{end.result}</pre></Collapsible>}
      </div>
    </div>
  );
}

function DecisionBlock({ ev }: { ev: Ev }) {
  const a = ev.answers ?? {};
  const ap = ev.applied ?? {};
  return (
    <div className="border border-warn/40 rounded-md p-2.5 bg-warn/5 space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium text-warn">Decision time</span>
        <Badge>next: {ap.next}</Badge>
        <Badge>progress: {ap.progress}</Badge>
        <Badge>effort: {ap.effort}</Badge>
        <Badge tone={ap.pHuman > 0.5 ? "bad" : "dim"}>P(needs human) {Number(ap.pHuman ?? 0).toFixed(2)}</Badge>
        <span className="text-[11px] text-dim font-mono">{(ev.latency_ms / 1000).toFixed(1)} s</span>
      </div>
      <Collapsible title="All answers and probabilities">
        <div className="grid sm:grid-cols-2 gap-2">
          {Object.entries(a).map(([name, x]: [string, any]) => (
            <div key={name} className="text-xs space-y-1">
              <div className="font-mono">{name}: {x.type === "noul" ? `P(true) ${x.noul.toFixed(2)}` : x.type === "choice" ? x.choice : x.score.toFixed(2)}</div>
              {x.probabilities && Object.entries(x.probabilities).map(([k, p]: [string, any]) => (
                <div key={k} className="flex items-center gap-2"><span className="w-20 truncate text-dim">{x.legend?.[k] ?? k}</span><div className="flex-1"><Bar value={p} /></div><span className="font-mono w-10 text-right">{(p * 100).toFixed(0)}%</span></div>
              ))}
            </div>
          ))}
        </div>
      </Collapsible>
    </div>
  );
}

function HitlCard({ ev, runId, answered, rowId }: { ev: Ev; runId: string; answered?: Ev; rowId?: number }) {
  const [reply, setReply] = useState("");
  const [verdict, setVerdict] = useState<boolean>();
  const send = (text: string) => api(`/api/agent/runs/${runId}/answer`, { method: "POST", json: { pendingId: ev.id, reply: text } });
  return (
    <div className="border border-bad/50 rounded-md p-3 bg-bad/5 space-y-2">
      <div className="font-medium text-bad">The agent needs you</div>
      <p className="text-sm">{ev.summary}</p>
      {answered ? (
        <div className="space-y-1.5">
          <p className="text-sm text-dim">You replied: “{answered.reply}”</p>
          {rowId != null && verdict === undefined && (
            <div className="flex items-center gap-2 text-xs text-dim">Was this interruption needed?
              <Button kind="ghost" onClick={() => api(`/api/agent/hitl/${rowId}/verdict`, { method: "POST", json: { agreed: true } }).then(() => setVerdict(true))}>Yes</Button>
              <Button kind="ghost" onClick={() => api(`/api/agent/hitl/${rowId}/verdict`, { method: "POST", json: { agreed: false } }).then(() => setVerdict(false))}>No</Button>
            </div>
          )}
          {verdict !== undefined && <p className="text-xs text-dim">Logged — thresholds are tuned from these answers.</p>}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5">
            {(ev.options ?? []).map((o: string) => <Button key={o} onClick={() => send(o)}>{o}</Button>)}
          </div>
          <div className="flex gap-2">
            <input value={reply} onChange={(e) => setReply(e.target.value)} onKeyDown={(e) => e.key === "Enter" && reply && send(reply)}
              placeholder="Or type instructions…" className="flex-1 bg-panel-2 border border-line rounded-md px-2 py-1.5 text-sm" aria-label="Reply to agent" />
            <Button kind="primary" disabled={!reply} onClick={() => send(reply)}>Reply</Button>
          </div>
        </>
      )}
    </div>
  );
}

function ApprovalCard({ ev, runId, answered }: { ev: Ev; runId: string; answered?: Ev }) {
  const answer = (approved: boolean, remember = false) => api(`/api/agent/runs/${runId}/answer`, { method: "POST", json: { pendingId: ev.id, approved, remember } });
  return (
    <div className="border border-bad/50 rounded-md p-3 bg-bad/5 space-y-2">
      <div className="flex items-center gap-2"><span className="font-medium text-bad">Approval needed</span><Badge tone="warn">{ev.reason}</Badge>
        {ev.decision && <Badge>P(safe) {Number(ev.decision.noul ?? 0).toFixed(2)}</Badge>}</div>
      <pre className="font-mono text-xs bg-[#0a0c10] rounded p-2 whitespace-pre-wrap">{ev.action}</pre>
      {answered ? <p className="text-sm text-dim">{answered.approved ? (answered.remember ? "Approved, folder always allowed from now on" : "Approved") : "Denied"}</p> : (
        <div className="flex flex-wrap gap-2">
          <Button kind="primary" onClick={() => answer(true)}>Approve</Button>
          {ev.folder && <Button onClick={() => answer(true, true)} title="Adds this folder to the extension folders in rules.md">Approve and always allow {ev.folder}</Button>}
          <Button kind="danger" onClick={() => answer(false)}>Deny</Button>
        </div>
      )}
      <p className="text-[11px] text-dim">Approved commands run outside the sandbox.</p>
    </div>
  );
}

export function Agent() {
  const models = useModels();
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("low");
  const [cwd, setCwd] = useState(recentFolders()[0] ?? "");
  const [task, setTask] = useState("");
  const [runs, setRuns] = useState<{ live: any[]; past: any[] }>({ live: [], past: [] });
  const [runId, setRunId] = useState<string>();
  const [summary, setSummary] = useState<any>();
  const [events, setEvents] = useState<Ev[]>([]);
  const [streamText, setStreamText] = useState("");
  const [streamThinking, setStreamThinking] = useState("");
  const [msg, setMsg] = useState("");
  const [diff, setDiff] = useState<string>();
  const [error, setError] = useState("");
  const [ctx, setCtx] = useState<{ used: number | null; limit: number | null }>({ used: null, limit: null });
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (models && !model) setModel(models.active ?? models.defaults.model);
  }, [models]);
  const loadRuns = () => api("/api/agent/runs").then(setRuns);
  useEffect(() => {
    loadRuns();
    const fromHash = location.hash.match(/^#agent\/([\w-]+)/)?.[1];
    if (fromHash) openRun(fromHash);
  }, []);
  const openRun = async (id: string) => {
    setRunId(id);
    history.replaceState(null, "", `#agent/${id}`);
    setStreamText("");
    setStreamThinking("");
    const r = await api(`/api/agent/runs/${id}`);
    setSummary(r.summary);
    setEvents(r.events);
  };
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [events.length, streamText.length > 0]);

  useServerEvent((e) => {
    if (e.type === "metrics" && e.stream) setCtx({ used: e.stream.contextUsed, limit: e.stream.contextLimit });
    if (e.type !== "agent" || e.runId !== runId) return;
    const ev: Ev = e.event;
    if (ev.kind === "text_delta") return setStreamText((t) => t + ev.delta);
    if (ev.kind === "thinking_delta") return setStreamThinking((t) => t + ev.delta);
    if (ev.kind === "message") {
      setStreamText("");
      setStreamThinking("");
    }
    setEvents((x) => [...x, ev]);
    if (ev.kind === "status") {
      setSummary((s: any) => (s ? { ...s, status: ev.status } : s));
      if (["idle", "stopped", "error"].includes(ev.status)) loadRuns();
    }
    if (ev.kind === "todo") setSummary((s: any) => (s ? { ...s, todo: ev.items } : s));
    if (ev.kind === "checkpoint") setSummary((s: any) => (s ? { ...s, checkpoints: [...(s.checkpoints ?? []), { sha: ev.sha, label: ev.label, ts: ev.ts }] } : s));
  }, [runId]);

  const start = async () => {
    setError("");
    try {
      const r = await api("/api/agent/runs", { method: "POST", json: { cwd, task, effort, model } });
      localStorage.setItem(RECENT_KEY, JSON.stringify([cwd, ...recentFolders().filter((f) => f !== cwd)].slice(0, 8)));
      setTask("");
      await loadRuns();
      setRunId(r.id);
      setSummary(r);
      setEvents([]);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const live = runs.live.some((r) => r.id === runId);
  const send = async () => {
    if (!msg.trim() || !runId) return;
    try {
      await api(`/api/agent/runs/${runId}/message`, { method: "POST", json: { text: msg } });
      setMsg("");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const showDiff = async (from?: string) => {
    try {
      setDiff((await api(`/api/agent/runs/${runId}/diff${from ? `?from=${from}` : ""}`)).diff);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const revert = async (sha: string) => {
    if (!confirm("Revert the working folder to this checkpoint? Files added since then are removed.")) return;
    await api(`/api/agent/runs/${runId}/revert`, { method: "POST", json: { sha } });
  };

  // pair tool starts with their ends, and cards with their answers
  const ends = useMemo(() => new Map(events.filter((e) => e.kind === "tool_end").map((e) => [e.id, e])), [events]);
  const answers = useMemo(() => new Map(events.filter((e) => e.kind === "hitl_reply" || e.kind === "approval_result").map((e) => [e.id, e])), [events]);
  const hitlRows = useMemo(() => {
    const m = new Map<string, number>();
    let lastHitl: string | undefined;
    for (const e of events) {
      if (e.kind === "hitl") lastHitl = e.id;
      if (e.kind === "hitl_logged" && lastHitl) m.set(lastHitl, e.rowId);
    }
    return m;
  }, [events]);

  return (
    <div className="flex h-full min-h-0">
      <aside className="w-60 border-r border-line flex flex-col min-h-0 shrink-0">
        <div className="p-2 text-xs text-dim uppercase tracking-wide">Runs</div>
        <ul className="flex-1 overflow-y-auto px-1 pb-2 space-y-0.5">
          <li><button onClick={() => { setRunId(undefined); setSummary(undefined); setEvents([]); }} className={`w-full text-left px-2 py-1.5 rounded-md text-sm ${!runId ? "bg-panel-2" : "hover:bg-panel-2/60"}`}>+ New run</button></li>
          {[...runs.live, ...runs.past.filter((p) => !runs.live.some((l) => l.id === p.id))].map((r) => (
            <li key={r.id}>
              <button onClick={() => openRun(r.id)} className={`w-full text-left px-2 py-1.5 rounded-md ${r.id === runId ? "bg-panel-2" : "hover:bg-panel-2/60"}`}>
                <div className="text-sm truncate">{r.task}</div>
                <div className="flex gap-1.5 items-center text-[11px] text-dim"><Badge tone={statusTone(r.status)}>{r.status}</Badge><span className="truncate">{r.cwd}</span></div>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="flex-1 flex flex-col min-w-0 min-h-0">
        {!runId ? (
          <div className="max-w-2xl w-full mx-auto p-6 space-y-4">
            <h2 className="text-lg font-semibold">New agent run</h2>
            <div className="flex flex-wrap gap-2">{models && <ModelSelect models={models.main} value={model} onChange={setModel} />}<EffortSelect value={effort} onChange={setEffort} /></div>
            <label className="block space-y-1">
              <span className="text-sm text-dim">Working folder (absolute path; bash is sandboxed to it)</span>
              <input value={cwd} onChange={(e) => setCwd(e.target.value)} list="recent-folders" placeholder="/home/you/projects/thing" className="w-full bg-panel-2 border border-line rounded-md px-3 py-2 font-mono text-sm" />
              <datalist id="recent-folders">{recentFolders().map((f) => <option key={f} value={f} />)}</datalist>
            </label>
            <label className="block space-y-1">
              <span className="text-sm text-dim">Task</span>
              <textarea value={task} onChange={(e) => setTask(e.target.value)} rows={5} className="w-full bg-panel-2 border border-line rounded-md px-3 py-2" placeholder="What should the agent do?" />
            </label>
            {error && <div className="text-bad text-sm">{error}</div>}
            <Button kind="primary" disabled={!cwd || !task.trim()} onClick={start}>Start run</Button>
            <p className="text-xs text-dim">Action time: the main model plans and uses tools. Every few tool calls, at a checkpoint, or before anything irreversible, decision time: Jebadiah judges the work and decides whether to continue, re-plan, revert, or ask you.</p>
          </div>
        ) : (
          <>
            <header className="flex flex-wrap items-center gap-2 p-2 border-b border-line">
              <Badge tone={statusTone(summary?.status ?? "")}>{summary?.status ?? "finished"}</Badge>
              <span className="text-sm truncate flex-1 font-mono" title={summary?.cwd}>{summary?.cwd}</span>
              <div className="w-40" title="Context usage"><Bar value={ctx.used ?? 0} max={ctx.limit ?? 1} /></div>
              <span className="text-[11px] text-dim font-mono">{ctx.used ?? "–"}/{ctx.limit ?? "–"}</span>
              {live && <Button onClick={() => showDiff()}>Diff since start</Button>}
              {live && !["stopped", "error"].includes(summary?.status) && <Button kind="danger" onClick={() => api(`/api/agent/runs/${runId}/stop`, { method: "POST" })}>Stop</Button>}
            </header>
            <div className="flex-1 flex min-h-0">
              <div className="flex-1 overflow-y-auto">
                <div className="max-w-3xl mx-auto p-4 space-y-3">
                  {events.map((ev, i) => {
                    switch (ev.kind) {
                      case "task": return <div key={i} className="bg-panel-2 border border-line rounded-lg px-3 py-2 whitespace-pre-wrap">{ev.task}</div>;
                      case "user": return <div key={i} className="flex justify-end"><div className="bg-panel-2 border border-line rounded-lg px-3 py-2 max-w-[85%] whitespace-pre-wrap">{ev.text}</div></div>;
                      case "message": return (
                        <div key={i} className="space-y-1.5">
                          {ev.thinking && <Collapsible title={`Thinking (${ev.thinking.length} chars)`}><div className="text-xs text-dim whitespace-pre-wrap">{ev.thinking}</div></Collapsible>}
                          {ev.text && <Markdown text={ev.text} />}
                        </div>
                      );
                      case "tool_start": return <ToolCard key={i} start={ev} end={ends.get(ev.id)} />;
                      case "decision": return <DecisionBlock key={i} ev={ev} />;
                      case "hitl": return <HitlCard key={i} ev={ev} runId={runId} answered={answers.get(ev.id)} rowId={hitlRows.get(ev.id)} />;
                      case "approval": return <ApprovalCard key={i} ev={ev} runId={runId} answered={answers.get(ev.id)} />;
                      case "phase": return ev.phase === "decision" ? <div key={i} className="text-[11px] text-warn">— decision time · {ev.trigger} —</div> : <div key={i} className="text-[11px] text-accent">— action time —</div>;
                      case "checkpoint": return (
                        <div key={i} className="flex items-center gap-2 text-[11px] text-dim">
                          <span>⛳ checkpoint: {ev.label} <span className="font-mono">{ev.sha.slice(0, 8)}</span></span>
                          {live && <><button className="hover:text-accent" onClick={() => showDiff(ev.sha)}>diff since</button><button className="hover:text-bad" onClick={() => revert(ev.sha)}>revert to</button></>}
                        </div>
                      );
                      case "revert": return <div key={i} className="text-xs text-warn">Reverted to {ev.sha.slice(0, 8)}{ev.removed?.length ? `; removed ${ev.removed.join(", ")}` : ""}</div>;
                      case "note": return <div key={i} className="text-xs text-dim">{ev.text}</div>;
                      case "error": return <div key={i} className="text-sm text-bad border border-bad/40 rounded p-2">{ev.message}</div>;
                      default: return null;
                    }
                  })}
                  {(streamText || streamThinking) && (
                    <div className="space-y-1.5">
                      {streamThinking && <Collapsible title={`Thinking… (${streamThinking.length} chars)`}><div className="text-xs text-dim whitespace-pre-wrap">{streamThinking}</div></Collapsible>}
                      {streamText && <Markdown text={streamText} />}
                    </div>
                  )}
                  <div ref={bottom} />
                </div>
              </div>
              <aside className="w-64 border-l border-line p-3 overflow-y-auto space-y-3 shrink-0">
                <h3 className="text-xs uppercase tracking-wide text-dim">Plan</h3>
                {summary?.todo?.length ? (
                  <ul className="space-y-1 text-sm">
                    {summary.todo.map((t: any, i: number) => (
                      <li key={i} className="flex gap-1.5"><span>{t.status === "done" ? "✓" : t.status === "in_progress" ? "▸" : "○"}</span><span className={t.status === "done" ? "line-through text-dim" : ""}>{t.text}</span></li>
                    ))}
                  </ul>
                ) : <p className="text-xs text-dim">No plan yet.</p>}
                <h3 className="text-xs uppercase tracking-wide text-dim pt-2">Checkpoints</h3>
                <ul className="space-y-1 text-xs">
                  {(summary?.checkpoints ?? []).map((c: any) => (
                    <li key={c.sha} className="flex items-center gap-1"><span className="font-mono">{c.sha.slice(0, 7)}</span><span className="truncate text-dim flex-1">{c.label}</span>
                      {live && <button className="text-dim hover:text-bad" onClick={() => revert(c.sha)} title="Revert">↺</button>}</li>
                  ))}
                </ul>
              </aside>
            </div>
            {live && (
              <footer className="border-t border-line p-3">
                <div className="max-w-3xl mx-auto flex gap-2">
                  <input value={msg} onChange={(e) => setMsg(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()}
                    placeholder={summary?.status === "idle" ? "Follow-up task or instructions (resumes the run)" : "Steer the running agent"} aria-label="Message to agent"
                    className="flex-1 bg-panel-2 border border-line rounded-md px-3 py-2" />
                  <Button kind="primary" onClick={send} disabled={!msg.trim()}>Send</Button>
                </div>
                {error && <div className="max-w-3xl mx-auto text-bad text-xs mt-1">{error}</div>}
              </footer>
            )}
          </>
        )}
      </section>

      {diff !== undefined && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-6 z-50" onClick={() => setDiff(undefined)}>
          <div className="bg-panel border border-line rounded-lg p-4 max-w-5xl w-full space-y-2" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center"><h3 className="font-medium">Diff</h3><Button kind="ghost" onClick={() => setDiff(undefined)}>Close</Button></div>
            <DiffView diff={diff} />
          </div>
        </div>
      )}
    </div>
  );
}
