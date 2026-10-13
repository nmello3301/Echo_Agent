import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Agent } from "./components/Agent.tsx";
import { Chat } from "./components/Chat.tsx";
import { Decide } from "./components/Decide.tsx";
import { Hugin } from "./components/Hugin.tsx";
import { Models } from "./components/Models.tsx";
import { Monitor } from "./components/Monitor.tsx";
import { Read } from "./components/Read.tsx";
import "./index.css";

const TABS = [
  { id: "chat", label: "Chat", key: "1" },
  { id: "decide", label: "Decide", key: "2" },
  { id: "agent", label: "Agent", key: "3" },
  { id: "hugin", label: "Hugin", key: "4" },
  { id: "models", label: "Models", key: "5" },
  { id: "read", label: "Read", key: "6" },
] as const;
type Tab = (typeof TABS)[number]["id"];

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

function App() {
  const hashTab = location.hash.slice(1).split("/")[0] as Tab;
  const [tab, setTab] = useState<Tab>(TABS.some((t) => t.id === hashTab) ? hashTab : load("echo.tab", "chat"));
  const [monitorCollapsed, setMonitorCollapsed] = useState(load("echo.monitorCollapsed", false));
  useEffect(() => {
    save("echo.tab", tab);
    if (!location.hash.startsWith(`#${tab}`)) history.replaceState(null, "", `#${tab}`);
  }, [tab]);
  useEffect(() => save("echo.monitorCollapsed", monitorCollapsed), [monitorCollapsed]);

  // Alt+1..6 switch tabs, Alt+M toggles the monitor
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!e.altKey) return;
      const t = TABS.find((x) => x.key === e.key);
      if (t) {
        e.preventDefault();
        setTab(t.id);
      }
      if (e.key.toLowerCase() === "m") {
        e.preventDefault();
        setMonitorCollapsed((c) => !c);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  return (
    <div className="h-full flex flex-col">
      <nav className="flex items-center gap-1 px-3 h-11 border-b border-line bg-panel shrink-0" role="tablist">
        <span className="font-semibold mr-4 flex items-center gap-2"><img src="/echo.svg" alt="" className="w-5 h-5" />Echo</span>
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)} title={`Alt+${t.key}`}
            className={`px-3 py-1.5 rounded-md text-sm ${tab === t.id ? "bg-panel-2 text-text" : "text-dim hover:text-text"}`}>{t.label}</button>
        ))}
      </nav>
      <div className="flex-1 flex min-h-0">
        <main className="flex-1 min-w-0 min-h-0">
          {/* keep every tab mounted so a streaming chat or a running agent survives a tab switch */}
          <div className={tab === "chat" ? "h-full" : "hidden"}><Chat /></div>
          <div className={tab === "decide" ? "h-full" : "hidden"}><Decide /></div>
          <div className={tab === "agent" ? "h-full" : "hidden"}><Agent /></div>
          <div className={tab === "hugin" ? "h-full" : "hidden"}><Hugin /></div>
          <div className={tab === "read" ? "h-full" : "hidden"}><Read active={tab === "read"} /></div>
          {tab === "models" && <Models />}
        </main>
        <aside className={`border-l border-line bg-panel shrink-0 ${monitorCollapsed ? "w-14" : "w-72"}`}>
          <Monitor collapsed={monitorCollapsed} onToggle={() => setMonitorCollapsed((c) => !c)} />
        </aside>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
