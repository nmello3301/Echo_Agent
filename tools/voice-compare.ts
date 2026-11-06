/**
 * Clone the same voice samples in several text-to-speech models and write a page to compare them side by side.
 *
 *   node tools/voice-compare.ts [--dir data/voice-compare] [--url http://127.0.0.1:7777] [--engines qwen3,voxcpm]
 *
 *   <dir>/samples/<voice>.wav   a recording per voice (MP3, M4A, OGG, FLAC, ... need ffmpeg)
 *   <dir>/samples/<voice>.txt   optional: what it says, word for word (Echo transcribes English recordings itself)
 *   <dir>/lines.txt             optional: the sentences every clone says, one per line
 *   <dir>/results/index.html    the comparison; reload it while this runs
 *
 * It goes through Echo's own API, so the clones also show up in the voice pickers of Read and Live. Running it again
 * only makes what is missing: a changed sample or sentence is redone, the rest is kept (results/state.json).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { parseArgs } from "node:util";

const RATE = 24_000;
const MAX_S = 30; // what the models use at most, and where the page's copy of a sample stops
const AUDIO = new Set([".wav", ".mp3", ".m4a", ".ogg", ".oga", ".opus", ".flac", ".webm"]);
// Fastest first: the page fills up early, and the slowest model isn't holding the others back
const ENGINES = ["qwen3", "voxcpm"];
// Plain narration, then numbers and names (where models slip), then a change of tone
const DEFAULT_LINES = [
  "The old lighthouse has guided ships along this coast for more than a hundred years, and on clear nights you can still see its beam from the town.",
  "Your appointment with Doctor Nakamura is on Tuesday, March 14th at 3:30 in the afternoon, and the total comes to $42.50.",
  "Wait, you actually finished it already? That's amazing! I honestly didn't think anyone could do that in one afternoon.",
];

type Model = { id: string; name: string; installed: boolean; canClone: boolean; sample?: { min: number; max: number; ideal: [number, number] } };
type Clip = { voice: string; text: string; seconds: number; took: number };
type State = { clones: Record<string, { id: string; key: string }>; clips: Record<string, Clip> };
type Sample = { slug: string; name: string; pcm: Float32Array; transcript: string; seconds: number };
export type Options = { dir: string; url: string; engines: string[]; log: (line: string) => void };
export type Outcome = { failed: Map<string, string>; skipped: Map<string, string>; page: string };

/** node:http, not fetch: fetch gives up after 5 minutes without an answer, and the slow models can take that long. */
function request(url: string, method = "GET", body?: unknown): Promise<{ status: number; data: Buffer }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {};
    const req = http.request(url, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (b: Buffer) => chunks.push(b));
      res.on("end", () => resolve({ status: res.statusCode ?? 502, data: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("error", (e) => reject(new Error(`Echo isn't answering at ${new URL(url).origin} (${e.message}): start it first`)));
    req.end(payload);
  });
}

function errorOf(r: { status: number; data: Buffer }): string {
  try {
    return (JSON.parse(r.data.toString()) as { error?: string }).error ?? `Echo answered ${r.status}`;
  } catch {
    return `Echo answered ${r.status}`;
  }
}

async function api<T>(url: string, method?: string, body?: unknown): Promise<T> {
  const r = await request(url, method, body);
  if (r.status !== 200) throw new Error(errorOf(r));
  return JSON.parse(r.data.toString()) as T;
}

export function readWav(b: Buffer): { format: number; channels: number; rate: number; bits: number; data: Buffer } | undefined {
  if (b.toString("latin1", 0, 4) !== "RIFF" || b.toString("latin1", 8, 12) !== "WAVE") return undefined;
  let fmt: { format: number; channels: number; rate: number; bits: number } | undefined;
  for (let at = 12; at + 8 <= b.length;) {
    const id = b.toString("latin1", at, at + 4);
    const size = b.readUInt32LE(at + 4);
    if (id === "fmt ") fmt = { format: b.readUInt16LE(at + 8), channels: b.readUInt16LE(at + 10), rate: b.readUInt32LE(at + 12), bits: b.readUInt16LE(at + 22) };
    if (id === "data") return fmt && { ...fmt, data: b.subarray(at + 8, Math.min(at + 8 + size, b.length)) };
    at += 8 + size + (size & 1);
  }
  return undefined;
}

function wavSeconds(b: Buffer): number {
  const w = readWav(b);
  return w ? w.data.length / (w.rate * w.channels * (w.bits / 8)) : 0;
}

function toFloat(pcm: Buffer): Float32Array {
  const out = new Float32Array(pcm.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = pcm.readInt16LE(i * 2) / 0x8000;
  return out;
}

/** Every ffmpeg on the PATH, in order: the first isn't always usable (conda's, on Windows, can die at start on a DLL). */
function ffmpegs(): string[] {
  const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  return (process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((d) => path.join(d, exe)).filter((f) => existsSync(f));
}

/** Any recording as 24 kHz mono. A WAV already in that shape needs no ffmpeg. */
function decode(file: string): Float32Array {
  const w = readWav(readFileSync(file));
  if (w && w.format === 1 && w.channels === 1 && w.bits === 16 && w.rate === RATE) return toFloat(w.data);
  const name = path.basename(file);
  const copies = ffmpegs();
  if (!copies.length) throw new Error(`${name} needs ffmpeg to be read: install it, or convert the file to a 24 kHz mono 16-bit WAV`);
  let why = "";
  for (const ffmpeg of copies) {
    const r = spawnSync(ffmpeg, ["-v", "error", "-i", file, "-ac", "1", "-ar", String(RATE), "-f", "s16le", "-"], { maxBuffer: 2 ** 31 - 1 });
    if (r.status === 0) return toFloat(r.stdout);
    why ||= r.stderr?.toString().trim() ?? "";
  }
  throw new Error(`ffmpeg couldn't read ${name}${why ? `: ${why}` : ` (tried ${copies.join(", ")})`}`);
}

export function encodeWav(pcm: Float32Array, gain = 1): Buffer {
  const b = Buffer.alloc(44 + pcm.length * 2);
  b.write("RIFF", 0, "latin1");
  b.writeUInt32LE(36 + pcm.length * 2, 4);
  b.write("WAVEfmt ", 8, "latin1");
  b.writeUInt32LE(16, 16); // fmt chunk size
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(RATE, 24);
  b.writeUInt32LE(RATE * 2, 28); // bytes per second
  b.writeUInt16LE(2, 32); // bytes per frame
  b.writeUInt16LE(16, 34); // bits per sample
  b.write("data", 36, "latin1");
  b.writeUInt32LE(pcm.length * 2, 40);
  for (let i = 0; i < pcm.length; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, pcm[i] * gain)) * 0x7fff), 44 + i * 2);
  return b;
}

/** The same treatment the Read and Live tabs give a sample (prepareSample in Voices.tsx), so a clone made here matches
 * one made there: silence trimmed from both ends, level normalized, at most `maxS` seconds. */
export function prepare(pcm: Float32Array, maxS: number): { wav: Buffer; seconds: number } {
  let peak = 0;
  for (const x of pcm) peak = Math.max(peak, Math.abs(x));
  if (peak < 1e-3) throw new Error("this recording is silent");
  const floor = peak * 0.03; // about -30 dB below the loudest point
  const pad = RATE / 5;
  let start = 0;
  let end = pcm.length;
  while (start < end && Math.abs(pcm[start]) < floor) start++;
  while (end > start && Math.abs(pcm[end - 1]) < floor) end--;
  start = Math.max(0, start - pad);
  end = Math.min(pcm.length, end + pad, start + maxS * RATE);
  return { wav: encodeWav(pcm.subarray(start, end), 0.95 / peak), seconds: (end - start) / RATE };
}

const readText = (file: string) => readFileSync(file, "utf8").replace(/^﻿/, "").trim();

/** Every recording is read before anything is cloned: a bad file should stop the run now, not an hour into it. */
function loadSamples(folder: string, log: (line: string) => void): Sample[] {
  mkdirSync(folder, { recursive: true });
  const files = readdirSync(folder).filter((f) => AUDIO.has(path.extname(f).toLowerCase())).sort();
  if (!files.length) throw new Error(`no recordings in ${folder}: add one per voice (WAV, MP3, M4A, OGG or FLAC), about 15 s each`);
  const seen = new Set<string>();
  return files.map((f) => {
    const stem = f.slice(0, -path.extname(f).length);
    const slug = stem.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "voice";
    if (seen.has(slug)) throw new Error(`two recordings share the name ${slug}: rename one of them`);
    seen.add(slug);
    const pcm = decode(path.join(folder, f));
    let seconds: number;
    try {
      seconds = prepare(pcm, MAX_S).seconds;
    } catch (e) {
      throw new Error(`${f}: ${(e as Error).message}`);
    }
    const words = path.join(folder, `${stem}.txt`);
    // Words the models can't hear in the audio are the main cause of glitches
    if (existsSync(words) && prepare(pcm, Infinity).seconds > MAX_S)
      log(`note: only the first ${MAX_S} s of ${f} are used, so ${stem}.txt should hold only the words in those ${MAX_S} s`);
    return { slug, name: stem.replace(/[_-]+/g, " ").slice(0, 40), pcm, transcript: existsSync(words) ? readText(words) : "", seconds };
  });
}

function loadLines(dir: string): string[] {
  const file = path.join(dir, "lines.txt");
  const lines = existsSync(file) ? readText(file).split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [];
  return lines.length ? lines : DEFAULT_LINES;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function page(samples: Sample[], lines: string[], columns: { id: string; label: string }[], state: State, notes: string[]): string {
  const cell = (file: string, text: string) => {
    const c = state.clips[file];
    if (c?.text !== text) return `<small>not made</small>`;
    return `<audio controls preload="metadata" src="${esc(file)}"></audio>` +
      `<small>${c.seconds.toFixed(1)} s of speech, made in ${c.took.toFixed(0)} s (${(c.seconds / c.took).toFixed(1)}x real time)</small>`;
  };
  const sections = samples.map((s) => `
<h2>${esc(s.name)}</h2>
<p><b>The original sample</b> (${s.seconds.toFixed(1)} s)<audio controls preload="metadata" src="${esc(s.slug)}/reference.wav"></audio>
<small>${s.transcript ? `Its words: ${esc(s.transcript)}` : "Its words: transcribed by Echo"}</small></p>
<div class="wrap"><table>
<tr><th>Sentence</th>${columns.map((c) => `<th>${esc(c.label)}</th>`).join("")}</tr>
${lines.map((text, i) => `<tr><td>${esc(text)}</td>${columns.map((c) =>
    `<td>${cell(`${s.slug}/${c.id}-${i + 1}.wav`, text)}</td>`).join("")}</tr>`).join("\n")}
</table></div>`).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Voice comparison</title>
<style>
:root { color-scheme: light dark; --line: #8886; --dim: #777; }
body { font: 15px/1.45 system-ui, sans-serif; max-width: 1300px; margin: 24px auto; padding: 0 16px; }
h2 { margin-top: 2em; }
.wrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; min-width: 900px; table-layout: fixed; }
th, td { border: 1px solid var(--line); padding: 8px; text-align: left; vertical-align: top; }
audio { display: block; width: 100%; max-width: 420px; height: 36px; margin-top: 4px; }
small { display: block; margin-top: 4px; color: var(--dim); }
</style></head><body>
<h1>Voice comparison</h1>
<p>Each voice, cloned from the same sample in each model, saying the same sentences. Updated ${esc(new Date().toLocaleString())}.</p>
${notes.length ? `<h3>Not made</h3><ul>${notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
${sections}
<script>document.addEventListener("play", (e) => { for (const a of document.querySelectorAll("audio")) if (a !== e.target) a.pause(); }, true);</script>
</body></html>
`;
}

export async function run(o: Options): Promise<Outcome> {
  const results = path.join(o.dir, "results");
  const samples = loadSamples(path.join(o.dir, "samples"), o.log);
  const lines = loadLines(o.dir);
  const echo = await api<{ models: Model[]; voices: { id: string }[] }>(`${o.url}/api/read/voices`);
  const existing = new Set(echo.voices.map((v) => v.id));

  mkdirSync(results, { recursive: true });
  const stateFile = path.join(results, "state.json");
  const state: State = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { clones: {}, clips: {} };
  const failed = new Map<string, string>();
  const skipped = new Map<string, string>();
  const nameOf = (id: string) => echo.models.find((m) => m.id === id)?.name ?? id;
  const columns = o.engines.map((id) => ({ id, label: nameOf(id) }));
  const pageFile = path.join(results, "index.html");
  const save = () => {
    writeFileSync(`${stateFile}.tmp`, JSON.stringify(state, null, 1));
    renameSync(`${stateFile}.tmp`, stateFile);
    const notes = [...new Set([...skipped.entries(), ...[...failed.entries()].map(([k, v]) => [k.split("/")[1], v] as [string, string])]
      .map(([engine, why]) => `${nameOf(engine)}: ${why}`))];
    writeFileSync(pageFile, page(samples, lines, columns, state, notes));
  };

  for (const s of samples) {
    mkdirSync(path.join(results, s.slug), { recursive: true });
    writeFileSync(path.join(results, s.slug, "reference.wav"), prepare(s.pcm, MAX_S).wav);
  }
  save();

  const say = async (file: string, voice: string, text: string, label: string) => {
    const have = state.clips[file];
    if (have?.voice === voice && have.text === text && existsSync(path.join(results, file))) return;
    const t0 = performance.now();
    const r = await request(`${o.url}/api/read/tts`, "POST", { text, voice });
    if (r.status !== 200) throw new Error(errorOf(r));
    const took = (performance.now() - t0) / 1000;
    mkdirSync(path.dirname(path.join(results, file)), { recursive: true });
    writeFileSync(path.join(results, file), r.data);
    state.clips[file] = { voice, text, seconds: wavSeconds(r.data), took };
    save();
    o.log(`${label}: ${state.clips[file].seconds.toFixed(1)} s of speech in ${took.toFixed(1)} s`);
  };

  const cloneOf = async (s: Sample, m: Model): Promise<string> => {
    const { wav, seconds } = prepare(s.pcm, m.sample?.max ?? MAX_S);
    const key = createHash("sha256").update(wav).update(s.transcript).digest("hex");
    const had = state.clones[`${s.slug}/${m.id}`];
    if (had?.key === key && existing.has(had.id)) return had.id;
    const min = m.sample?.min ?? 3;
    if (seconds < min) throw new Error(`the sample ${s.name} has ${seconds.toFixed(1)} s of speech, and at least ${min} s are needed`);
    if (had) {
      // Only ever a clone this tool made, of a sample that has since changed: its clips no longer belong on the page
      if (existing.has(had.id)) await api(`${o.url}/api/read/voices/${encodeURIComponent(had.id)}`, "DELETE");
      delete state.clones[`${s.slug}/${m.id}`];
      for (const [file, c] of Object.entries(state.clips)) if (c.voice === had.id) delete state.clips[file];
    }
    if (m.sample && seconds < m.sample.ideal[0]) o.log(`note: ${s.name} has ${seconds.toFixed(1)} s of speech; ${m.name} does best with ${m.sample.ideal[0]}-${m.sample.ideal[1]} s`);
    o.log(`${m.name} / ${s.name}: cloning from ${seconds.toFixed(1)} s (the first use of a model also loads it)`);
    const v = await api<{ id: string }>(`${o.url}/api/read/voices`, "POST", {
      name: s.name, engine: m.id, audio: `data:audio/wav;base64,${wav.toString("base64")}`, transcript: s.transcript || undefined,
    });
    state.clones[`${s.slug}/${m.id}`] = { id: v.id, key };
    save();
    return v.id;
  };

  const attempt = async (key: string, label: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      failed.set(key, (e as Error).message);
      o.log(`${label}: failed: ${(e as Error).message}`);
      save();
    }
  };

  for (const id of o.engines) {
    const m = echo.models.find((x) => x.id === id);
    const why = !m ? "Echo has no such model" : !m.canClone ? "this model can't clone voices" : !m.installed ? "not downloaded yet (Models tab)" : "";
    if (!m || why) {
      skipped.set(id, why);
      o.log(`${nameOf(id)}: skipped: ${why}`);
      save();
      continue;
    }
    for (const s of samples) {
      let voice = "";
      await attempt(`${s.slug}/${id}`, `${m.name} / ${s.name}`, async () => { voice = await cloneOf(s, m); });
      if (!voice) continue;
      for (const [i, text] of lines.entries()) {
        const label = `${m.name} / ${s.name} / line ${i + 1}`;
        await attempt(`${s.slug}/${id}/${i}`, label, () => say(`${s.slug}/${id}-${i + 1}.wav`, voice, text, label));
      }
    }
  }
  save();
  return { failed, skipped, page: pageFile };
}

if (process.argv[1]?.endsWith("voice-compare.ts")) {
  const { values: v } = parseArgs({ options: { dir: { type: "string", default: path.join("data", "voice-compare") }, url: { type: "string", default: "http://127.0.0.1:7777" }, engines: { type: "string", default: ENGINES.join(",") } } });
  try {
    const out = await run({ dir: v.dir, url: v.url.replace(/\/$/, ""), engines: v.engines.split(",").map((e) => e.trim()).filter(Boolean), log: (l) => console.log(l) });
    console.log(`\nOpen ${path.resolve(out.page)} to compare them.`);
    if (out.failed.size) process.exitCode = 1;
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
}
