import { useEffect, useState } from "react";
import { api, useModels } from "../api.ts";
import { Badge, Bar, Button, Collapsible, ModelSelect, Select } from "./ui.tsx";

type QType = "choice" | "noul" | "score";
interface Opt { key: string; description: string }
interface QDraft { name: string; type: QType; instructions: string; options: Opt[]; trueMeaning: string; falseMeaning: string; levels: string[] }

const blank = (n: number): QDraft => ({
  name: `q${n}`, type: "choice", instructions: "", options: [{ key: "", description: "" }, { key: "", description: "" }],
  trueMeaning: "", falseMeaning: "", levels: ["low", "medium", "high"],
});

const EXAMPLE: { state: string; questions: QDraft[] } = {
  state: JSON.stringify({ ticket: "Customer says the invoice total does not match the quote." }, null, 1),
  questions: [
    { ...blank(1), name: "route", instructions: "Which team should take this ticket?", options: [
      { key: "billing", description: "an invoice, a charge or a refund" },
      { key: "support", description: "a product question" },
      { key: "sales", description: "a quote or a renewal" }] },
    { ...blank(2), name: "urgent", type: "noul", instructions: "The customer is blocked from working.", trueMeaning: "work has stopped", falseMeaning: "it can wait" },
  ],
};

function toWire(qs: QDraft[]) {
  const out: Record<string, unknown> = {};
  for (const q of qs) {
    const criteria = q.type === "choice"
      ? Object.fromEntries(q.options.filter((o) => o.key.trim()).map((o) => [o.key.trim(), o.description.trim() || null]))
      : q.type === "noul"
        ? { true: q.trueMeaning || "yes", false: q.falseMeaning || "no" }
        : q.levels.filter((l) => l.trim());
    out[q.name] = { type: q.type, instructions: q.instructions, criteria };
  }
  return out;
}

function fromWire(w: Record<string, any>): QDraft[] {
  return Object.entries(w).map(([name, q], i) => ({
    ...blank(i + 1), name, type: q.type, instructions: q.instructions,
    options: q.type === "choice" ? Object.entries(q.criteria).map(([key, d]) => ({ key, description: (d as string) ?? "" })) : blank(0).options,
    trueMeaning: q.type === "noul" ? q.criteria.true ?? "" : "", falseMeaning: q.type === "noul" ? q.criteria.false ?? "" : "",
    levels: q.type === "score" ? q.criteria : blank(0).levels,
  }));
}

const input = "w-full bg-panel-2 border border-line rounded-md px-2 py-1.5 text-sm";

export function Decide() {
  const models = useModels();
  const [model, setModel] = useState("");
  const [state, setState] = useState(EXAMPLE.state);
  const [qs, setQs] = useState<QDraft[]>(EXAMPLE.questions);
  const [result, setResult] = useState<any>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [presets, setPresets] = useState<{ name: string; questions: any }[]>([]);

  useEffect(() => {
    if (models && !model) setModel(models.decision.find((d) => !d.comingSoon)?.id ?? "");
  }, [models]);
  const loadPresets = () => api("/api/presets").then(setPresets);
  useEffect(() => {
    loadPresets();
  }, []);

  const upd = (i: number, p: Partial<QDraft>) => setQs((q) => q.map((x, j) => (j === i ? { ...x, ...p } : x)));

  const run = async () => {
    setBusy(true);
    setError("");
    setResult(undefined);
    let parsed: unknown = state;
    try {
      parsed = JSON.parse(state);
    } catch {}
    try {
      setResult(await api("/api/decide", { method: "POST", json: { state: parsed, questions: toWire(qs) } }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const savePreset = async () => {
    const name = prompt("Preset name");
    if (!name) return;
    await api(`/api/presets/${encodeURIComponent(name)}`, { method: "PUT", json: { questions: toWire(qs) } });
    loadPresets();
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto p-4 space-y-4">
        <header className="flex flex-wrap items-center gap-2">
          {models && <ModelSelect models={models.decision} value={model} onChange={setModel} />}
          <Select value="" onChange={(n) => { const p = presets.find((x) => x.name === n); if (p) setQs(fromWire(p.questions)); }}
            options={[{ value: "", label: presets.length ? "Load preset…" : "No presets yet" }, ...presets.map((p) => ({ value: p.name, label: p.name }))]} />
          <Button onClick={savePreset}>Save as preset</Button>
          <span className="text-xs text-dim">Answers are read from option probabilities in one forward pass per question; nothing is generated.</span>
        </header>

        <div className="grid md:grid-cols-2 gap-4">
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="font-medium">State</h3>
              <label className="text-xs text-dim hover:text-text cursor-pointer">
                Load file
                <input type="file" className="hidden" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setState(await f.text()); }} />
              </label>
            </div>
            <textarea value={state} onChange={(e) => setState(e.target.value)} rows={14} aria-label="State" className={`${input} font-mono text-xs`}
              placeholder="Plain text or JSON" />
          </section>

          <section className="space-y-2">
            <h3 className="font-medium">Questions</h3>
            {qs.map((q, i) => (
              <div key={i} className="border border-line rounded-md p-2 space-y-2 bg-panel">
                <div className="flex gap-2">
                  <input value={q.name} onChange={(e) => upd(i, { name: e.target.value })} className={`${input} w-32 font-mono`} aria-label="Question name" />
                  <Select value={q.type} onChange={(t) => upd(i, { type: t })} options={[{ value: "choice", label: "choice" }, { value: "noul", label: "yes-no" }, { value: "score", label: "score" }]} />
                  <Button kind="ghost" onClick={() => setQs((x) => x.filter((_, j) => j !== i))} title="Remove question">✕</Button>
                </div>
                <input value={q.instructions} onChange={(e) => upd(i, { instructions: e.target.value })} placeholder="Instructions (the question)" className={input} aria-label="Instructions" />
                {q.type === "choice" && (
                  <div className="space-y-1">
                    {q.options.map((o, k) => (
                      <div key={k} className="flex gap-1">
                        <input value={o.key} placeholder="option" onChange={(e) => upd(i, { options: q.options.map((x, j) => (j === k ? { ...x, key: e.target.value } : x)) })} className={`${input} w-32`} aria-label="Option" />
                        <input value={o.description} placeholder="description (optional)" onChange={(e) => upd(i, { options: q.options.map((x, j) => (j === k ? { ...x, description: e.target.value } : x)) })} className={input} aria-label="Option description" />
                        <Button kind="ghost" disabled={q.options.length <= 2} onClick={() => upd(i, { options: q.options.filter((_, j) => j !== k) })}>✕</Button>
                      </div>
                    ))}
                    <Button kind="ghost" disabled={q.options.length >= 50} onClick={() => upd(i, { options: [...q.options, { key: "", description: "" }] })}>+ option</Button>
                  </div>
                )}
                {q.type === "noul" && (
                  <div className="flex gap-1">
                    <input value={q.trueMeaning} placeholder="true means… (optional)" onChange={(e) => upd(i, { trueMeaning: e.target.value })} className={input} />
                    <input value={q.falseMeaning} placeholder="false means… (optional)" onChange={(e) => upd(i, { falseMeaning: e.target.value })} className={input} />
                  </div>
                )}
                {q.type === "score" && (
                  <div className="space-y-1">
                    {q.levels.map((l, k) => (
                      <div key={k} className="flex gap-1 items-center">
                        <span className="text-xs text-dim w-5">{k}</span>
                        <input value={l} onChange={(e) => upd(i, { levels: q.levels.map((x, j) => (j === k ? e.target.value : x)) })} className={input} aria-label={`Level ${k}`} />
                        <Button kind="ghost" disabled={q.levels.length <= 2} onClick={() => upd(i, { levels: q.levels.filter((_, j) => j !== k) })}>✕</Button>
                      </div>
                    ))}
                    <Button kind="ghost" onClick={() => upd(i, { levels: [...q.levels, ""] })}>+ level</Button>
                  </div>
                )}
              </div>
            ))}
            <div className="flex gap-2">
              <Button onClick={() => setQs((x) => [...x, blank(x.length + 1)])}>+ Question</Button>
              <Button kind="primary" onClick={run} disabled={busy || !qs.length}>{busy ? "Deciding…" : "Decide"}</Button>
            </div>
          </section>
        </div>

        {error && <div className="text-bad text-sm border border-bad/40 rounded p-2">{error}</div>}
        {busy && <p className="text-dim text-sm">The decision model runs on the CPU: a few seconds per question (longer the first time, while it loads).</p>}

        {result && (
          <section className="space-y-3">
            <div className="flex gap-2 items-center"><h3 className="font-medium">Results</h3><Badge>{result.latency_ms} ms total</Badge></div>
            <div className="grid md:grid-cols-2 gap-3">
              {Object.entries(result.answers).map(([name, a]: [string, any]) => (
                <div key={name} className="border border-line rounded-md p-3 bg-panel space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-sm">{name}</span>
                    <span className="flex gap-1.5">
                      {a.confidence != null && <Badge tone="accent">confidence {a.confidence.toFixed(2)}</Badge>}
                      <Badge>{result.latency_per_question_ms?.[name]} ms</Badge>
                      {result.truncated?.includes(name) && <Badge tone="warn">state truncated</Badge>}
                    </span>
                  </div>
                  {a.type === "noul" ? (
                    <div className="space-y-1">
                      <div className="text-lg font-mono">P(true) = {a.noul.toFixed(3)}</div>
                      <Bar value={a.noul} tone={a.noul > 0.5 ? "good" : "bad"} />
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      <div className="text-lg">{a.type === "choice" ? a.choice : `${a.score.toFixed(2)} (${a.legend?.[String(Math.round(a.score))] ?? ""})`}</div>
                      {Object.entries(a.probabilities).map(([k, p]: [string, any]) => {
                        const label = a.type === "score" ? `${k} · ${a.legend?.[k] ?? ""}` : k;
                        const win = a.type === "choice" ? k === a.choice : false;
                        return (
                          <div key={k} className="text-xs">
                            <div className="flex justify-between"><span className={win ? "text-accent" : ""}>{label}</span><span className="font-mono">{(p * 100).toFixed(1)}%</span></div>
                            <Bar value={p} tone={win ? "accent" : "good"} />
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <Collapsible title="Raw request and response JSON">
              <pre className="text-[11px] font-mono whitespace-pre-wrap overflow-x-auto">{JSON.stringify(result, null, 1)}</pre>
            </Collapsible>
          </section>
        )}
      </div>
    </div>
  );
}
