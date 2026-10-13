import { useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ModelInfo } from "../api.ts";

export function Button({ children, onClick, kind = "default", disabled, title, type = "button", className = "" }: {
  children: ReactNode; onClick?: () => void; kind?: "default" | "primary" | "danger" | "ghost"; disabled?: boolean; title?: string; type?: "button" | "submit"; className?: string;
}) {
  const styles = {
    default: "bg-panel-2 border border-line hover:border-dim",
    primary: "bg-accent text-bg font-medium hover:brightness-110",
    danger: "bg-bad/15 text-bad border border-bad/40 hover:bg-bad/25",
    ghost: "hover:bg-panel-2 text-dim hover:text-text",
  }[kind];
  return (
    <button type={type} title={title} disabled={disabled} onClick={onClick}
      className={`px-3 py-1.5 rounded-md text-sm disabled:opacity-40 disabled:pointer-events-none transition ${styles} ${className}`}>
      {children}
    </button>
  );
}

export function Badge({ children, tone = "dim" }: { children: ReactNode; tone?: "dim" | "good" | "warn" | "bad" | "accent" }) {
  const t = { dim: "text-dim border-line", good: "text-good border-good/40", warn: "text-warn border-warn/40", bad: "text-bad border-bad/40", accent: "text-accent border-accent/40" }[tone];
  return <span className={`text-[11px] px-1.5 py-0.5 rounded border ${t} whitespace-nowrap`}>{children}</span>;
}

export function Select<T extends string>({ value, onChange, options, className = "" }: {
  value: T; onChange: (v: T) => void; options: { value: T; label: string; disabled?: boolean }[]; className?: string;
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as T)}
      className={`bg-panel-2 border border-line rounded-md px-2 py-1.5 text-sm ${className}`}>
      {options.map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
    </select>
  );
}

/** Model picker: available models selectable; placeholders listed but disabled with "Coming soon". */
export function ModelSelect({ models, value, onChange }: { models: ModelInfo[]; value: string; onChange: (id: string) => void }) {
  return (
    <Select value={value} onChange={onChange} className="min-w-64"
      options={models.map((m) => ({
        value: m.id,
        label: m.comingSoon ? `${m.name} — Coming soon` : m.available === false ? `${m.name} — not installed` : m.name,
        disabled: m.comingSoon || m.available === false,
      }))} />
  );
}

export function EffortSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex rounded-md border border-line overflow-hidden text-xs" role="radiogroup" aria-label="Reasoning effort">
      {["off", "low", "medium", "high"].map((e) => (
        <button key={e} role="radio" aria-checked={value === e} onClick={() => onChange(e)}
          className={`px-2.5 py-1.5 ${value === e ? "bg-accent/20 text-accent" : "text-dim hover:text-text"}`}>{e}</button>
      ))}
    </div>
  );
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="prose-echo leading-relaxed break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ pre: ({ children }) => <CodeBlock>{children}</CodeBlock> }}>{text}</ReactMarkdown>
    </div>
  );
}

function CodeBlock({ children }: { children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const text = extractText(children);
  return (
    <div className="relative group my-2">
      <pre className="bg-[#0a0c10] border border-line rounded-md p-3 overflow-x-auto text-[13px] font-mono">{children}</pre>
      <button onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
        className="absolute top-1.5 right-1.5 text-xs px-2 py-0.5 rounded bg-panel-2 border border-line opacity-0 group-hover:opacity-100 focus:opacity-100">
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function extractText(n: ReactNode): string {
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(extractText).join("");
  if (n && typeof n === "object" && "props" in n) return extractText((n as any).props.children);
  return "";
}

export function Collapsible({ title, children, open: initial = false, className = "" }: { title: ReactNode; children: ReactNode; open?: boolean; className?: string }) {
  const [open, setOpen] = useState(initial);
  return (
    <div className={`border border-line rounded-md ${className}`}>
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="w-full text-left px-2.5 py-1.5 text-xs text-dim hover:text-text flex items-center gap-1.5">
        <span className="inline-block w-3">{open ? "▾" : "▸"}</span>{title}
      </button>
      {open && <div className="px-2.5 pb-2">{children}</div>}
    </div>
  );
}

export function Bar({ value, max = 1, tone = "accent" }: { value: number; max?: number; tone?: "accent" | "good" | "warn" | "bad" }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const c = { accent: "bg-accent", good: "bg-good", warn: "bg-warn", bad: "bg-bad" }[tone];
  return <div className="h-1.5 bg-line rounded-full overflow-hidden"><div className={`h-full ${c} transition-all`} style={{ width: `${pct}%` }} /></div>;
}
