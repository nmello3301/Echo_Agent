import { useEffect, useState } from "react";

export async function api<T = any>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const r = await fetch(url, {
    ...init,
    headers: init?.json !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j as T;
}

/** Read a server-sent-event response, calling onEvent(name, data) per event. */
export async function readSSE(r: Response, onEvent: (event: string, data: any) => void) {
  const reader = r.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let ev = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) ev = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (data) onEvent(ev, JSON.parse(data));
    }
  }
}

// ---------- one WebSocket shared by the whole app ----------
type Listener = (e: any) => void;
const listeners = new Set<Listener>();
let ws: WebSocket | undefined;

function connect() {
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.onmessage = (m) => {
    const e = JSON.parse(m.data);
    for (const l of listeners) l(e);
  };
  ws.onclose = () => setTimeout(connect, 1500);
}
connect();

export function onServerEvent(l: Listener) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useServerEvent(l: Listener, deps: unknown[] = []) {
  useEffect(() => onServerEvent(l), deps);
}

export function useMetrics() {
  const [m, setM] = useState<any>();
  useServerEvent((e) => e.type === "metrics" && setM(e));
  return m;
}

export interface ModelInfo {
  id: string;
  name: string;
  comingSoon: boolean;
  vision?: boolean;
  reasoning?: string[];
  context?: number | null;
  available?: boolean;
}

export function useModels() {
  const [models, setModels] = useState<{ main: ModelInfo[]; decision: ModelInfo[]; active: string | null; defaults: { model: string; effort: string } }>();
  const reload = () => api("/api/models").then(setModels).catch(() => {});
  useEffect(() => {
    reload();
  }, []);
  useServerEvent((e) => {
    if (e.type === "active_model") reload();
  });
  return models;
}

export const toDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const rd = new FileReader();
    rd.onload = () => resolve(rd.result as string);
    rd.onerror = () => reject(rd.error);
    rd.readAsDataURL(blob);
  });

export const fmtBytes =(b?: number | null) => (b == null ? "–" : b >= 1e9 ? `${(b / 1073741824).toFixed(1)} GB` : `${(b / 1048576).toFixed(0)} MB`);
export const fmtNum = (n?: number | null, d = 1) => (n == null || Number.isNaN(n) ? "–" : n.toFixed(d));
