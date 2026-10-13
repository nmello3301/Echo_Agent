import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { promisify } from "node:util";
import { publish } from "./bus.ts";
import { config } from "./config.ts";
import { activeMain, activeMainId, allEngines } from "./engines.ts";
import { live } from "./stats.ts";

const run = promisify(execFile);

let prevCpu: number[][] = [];
function cpu(): { total: number; cores: number[] } {
  const lines = readFileSync("/proc/stat", "utf8").split("\n").filter((l) => /^cpu\d* /.test(l));
  const now = lines.map((l) => l.trim().split(/\s+/).slice(1).map(Number));
  const pct = now.map((v, i) => {
    const p = prevCpu[i];
    if (!p) return 0;
    const idle = v[3] + v[4] - (p[3] + p[4]);
    const total = v.reduce((a, b) => a + b, 0) - p.reduce((a, b) => a + b, 0);
    return total > 0 ? Math.round((1 - idle / total) * 100) : 0;
  });
  prevCpu = now;
  return { total: pct[0] ?? 0, cores: pct.slice(1) };
}

function meminfo() {
  const m: Record<string, number> = {};
  for (const l of readFileSync("/proc/meminfo", "utf8").split("\n")) {
    const [k, v] = l.split(":");
    if (v) m[k] = parseInt(v) * 1024;
  }
  return { total: m.MemTotal, used: m.MemTotal - m.MemAvailable, available: m.MemAvailable };
}

/** Resident and pinned (locked) memory of every process in each engine's process group. */
function engineMemory(): { resident: number; pinned: number } {
  const groups = new Set(allEngines().map((e) => e.pid).filter(Boolean) as number[]);
  let resident = 0;
  let pinned = 0;
  if (!groups.size) return { resident, pinned };
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = readFileSync(`/proc/${d}/stat`, "utf8");
      const pgrp = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
      if (!groups.has(pgrp)) continue;
      const st = readFileSync(`/proc/${d}/status`, "utf8");
      resident += Number(/VmRSS:\s+(\d+)/.exec(st)?.[1] ?? 0) * 1024;
      pinned += Number(/VmLck:\s+(\d+)/.exec(st)?.[1] ?? 0) * 1024 + Number(/VmPin:\s+(\d+)/.exec(st)?.[1] ?? 0) * 1024;
    } catch {}
  }
  return { resident, pinned };
}

async function gpu() {
  try {
    const { stdout } = await run("nvidia-smi", [
      "--query-gpu=name,memory.used,memory.total,utilization.gpu,temperature.gpu,power.draw,clocks_event_reasons.hw_thermal_slowdown,clocks_event_reasons.sw_thermal_slowdown",
      "--format=csv,noheader,nounits",
    ], { timeout: 3000 });
    const [name, used, total, util, temp, power, hwT, swT] = stdout.trim().split("\n")[0].split(", ");
    return {
      name,
      vramUsed: Number(used) * 1048576,
      vramTotal: Number(total) * 1048576,
      util: Number(util),
      temp: Number(temp),
      power: Number(power) || null,
      throttled: hwT === "Active" || swT === "Active",
    };
  } catch {
    return null;
  }
}

function power(): { ac: boolean | null; battery: number | null } {
  let ac: boolean | null = null;
  let battery: number | null = null;
  try {
    for (const d of readdirSync("/sys/class/power_supply")) {
      const base = `/sys/class/power_supply/${d}`;
      const type = readFileSync(`${base}/type`, "utf8").trim();
      if (type === "Mains") ac = readFileSync(`${base}/online`, "utf8").trim() === "1";
      if (type === "Battery") battery = Number(readFileSync(`${base}/capacity`, "utf8"));
    }
  } catch {}
  return { ac, battery };
}

/** For requests that do not pass through Echo's chat proxy (Pi in the Agent tab), read llama-server's own
 *  Prometheus counters and turn their deltas into decode and prompt speeds. */
let prevCounters: Record<string, number> | undefined;
async function engineCounters() {
  const a = activeMain();
  if (!a || a.model.engine === "strata" || a.engine.status !== "ready" || (live.active && live.source === "chat")) {
    prevCounters = undefined;
    return;
  }
  try {
    const text = await (await fetch(`http://127.0.0.1:${a.model.port}/metrics`, { signal: AbortSignal.timeout(800) })).text();
    const c: Record<string, number> = {};
    for (const l of text.split("\n")) {
      const m = /^llamacpp:(\w+) ([\d.e+-]+)$/.exec(l);
      if (m) c[m[1]] = Number(m[2]);
    }
    const p = prevCounters;
    prevCounters = c;
    const busy = (c.requests_processing ?? 0) > 0;
    if (!p) return;
    const dTok = c.tokens_predicted_total - p.tokens_predicted_total;
    const dSec = c.tokens_predicted_seconds_total - p.tokens_predicted_seconds_total;
    const dPTok = c.prompt_tokens_total - p.prompt_tokens_total;
    const dPSec = c.prompt_seconds_total - p.prompt_seconds_total;
    if (dTok > 0 && dSec > 0) live.decodeTps = dTok / dSec;
    if (dPTok > 0 && dPSec > 0) live.promptTps = dPTok / dPSec;
    if (busy || dTok > 0) {
      live.active = busy;
      live.source = "agent";
      live.contextLimit = a.model.context ?? live.contextLimit;
      if (c.n_tokens_max) live.contextUsed = c.n_tokens_max;
    } else if (live.source === "agent") live.active = false;
  } catch {}
}

export type Sample = Awaited<ReturnType<typeof sample>>;
export const history: { ts: number; decodeTps: number | null }[] = [];
export let lastSample: Sample | undefined;

async function sample() {
  const [g] = await Promise.all([gpu(), engineCounters()]);
  const ts = Date.now();
  const tps = live.active ? live.decodeTps : null;
  history.push({ ts, decodeTps: tps });
  while (history.length && history[0].ts < ts - 60_000) history.shift();
  return {
    ts,
    cpu: cpu(),
    ram: { ...meminfo(), engine: engineMemory() },
    gpu: g,
    power: power(),
    stream: { ...live },
    sparkline: history.map((h) => h.decodeTps),
    engines: allEngines().map((e) => e.info()),
    activeModel: activeMainId ?? null,
  };
}

export function startMonitor() {
  cpu();
  const tick = async () => {
    try {
      lastSample = await sample();
      publish({ type: "metrics", ...lastSample });
    } catch (e) {
      console.error("[monitor]", e);
    }
    setTimeout(tick, config.echo.monitor.interval_ms);
  };
  setTimeout(tick, 500);
}
