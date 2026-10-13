/**
 * Notes RAG: a growable index of the user's Markdown notes (Hugin's voice notes, and any other folders listed in
 * echo.yaml `notes.dirs`). Retrieval is hybrid: BM25 keywords (SQLite FTS5) + embeddings (Qwen3-Embedding-0.6B),
 * fused with reciprocal rank fusion, then reranked by a cross-encoder (Qwen3-Reranker-0.6B).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, watch } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import YAML from "yaml";
import { publish } from "./bus.ts";
import { abs, config } from "./config.ts";
import { engineFetch } from "./llm.ts";

export interface NoteMeta {
  path: string;
  title: string;
  type: string;
  created: string; // ISO date or "" when unknown
  tags: string[];
}

export interface Hit {
  path: string;
  title: string;
  created: string;
  type: string;
  heading: string;
  text: string;
  score: number; // reranker relevance 0..1
}

const EMBED_URL = () => `http://127.0.0.1:${config.echo.ports.embed ?? 8093}/v1/embeddings`;
const RERANK_URL = () => `http://127.0.0.1:${config.echo.ports.rerank ?? 8094}/v1/rerank`;
const QUERY_INSTRUCTION = "Instruct: Given a question or topic, retrieve passages from the user's personal notes that answer or discuss it\nQuery: ";
const CHUNK_CHARS = 900; // ~220 tokens: small enough to rerank quickly, big enough to carry context

let db: DatabaseSync | undefined;
function open(): DatabaseSync {
  if (db) return db;
  const dir = abs(config.echo.paths.data);
  mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(process.env.ECHO_RAG_DB ?? path.join(dir, "notes-rag.db"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS docs (
      path TEXT PRIMARY KEY, title TEXT, type TEXT, created TEXT, tags TEXT,
      mtime REAL, size INTEGER, hash TEXT, indexed_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL REFERENCES docs(path) ON DELETE CASCADE,
      idx INTEGER, heading TEXT, text TEXT, embedding BLOB
    );
    CREATE INDEX IF NOT EXISTS chunks_path ON chunks(path);
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, title, heading, content='', contentless_delete=1,
      tokenize='unicode61 remove_diacritics 2');
  `);
  return db;
}

export function noteDirs(): string[] {
  const dirs = config.echo.notes?.dirs ?? ["data/hugin/notes"];
  return (dirs as string[]).map((d) => abs(d.replace(/^~(?=\/)/, process.env.HOME ?? "~")));
}

// ---------- parsing and chunking ----------

export function parseNote(file: string, raw: string): { meta: NoteMeta; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  let fm: Record<string, any> = {};
  let body = raw;
  if (m) {
    try {
      fm = (YAML.parse(m[1]) as Record<string, any>) ?? {};
    } catch {}
    body = m[2];
  }
  const fromName = /^(\d{4}-\d{2}-\d{2})/.exec(path.basename(file))?.[1] ?? "";
  const created = String(fm.created ?? fm.date ?? fromName ?? "").slice(0, 19);
  const h1 = /^#\s+(.+)$/m.exec(body)?.[1];
  return {
    meta: {
      path: file,
      title: String(fm.title ?? h1 ?? path.basename(file, ".md").replace(/^\d{4}-\d{2}-\d{2}_?/, "").replace(/[-_]/g, " ")),
      type: String(fm.type ?? "note"),
      created: created || new Date(statSync(file).mtimeMs).toISOString().slice(0, 19),
      tags: Array.isArray(fm.tags) ? fm.tags.map(String) : typeof fm.tags === "string" ? fm.tags.split(/[,\s]+/).filter(Boolean) : [],
    },
    body,
  };
}

/** Split by headings, then by paragraphs into ~CHUNK_CHARS pieces with one paragraph of overlap. */
export function chunkNote(body: string): { heading: string; text: string }[] {
  const sections: { heading: string; lines: string[] }[] = [{ heading: "", lines: [] }];
  for (const line of body.split("\n")) {
    const h = /^#{1,4}\s+(.+)$/.exec(line);
    if (h) sections.push({ heading: h[1].trim(), lines: [] });
    else sections[sections.length - 1].lines.push(line);
  }
  const out: { heading: string; text: string }[] = [];
  for (const s of sections) {
    const paras = s.lines.join("\n").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
      .flatMap((p) => (p.length <= CHUNK_CHARS ? [p] : p.match(new RegExp(`[\\s\\S]{1,${CHUNK_CHARS}}(?=\\s|$)`, "g")) ?? [p]));
    let cur: string[] = [];
    const flush = () => {
      if (cur.length) out.push({ heading: s.heading, text: cur.join("\n\n") });
    };
    for (const p of paras) {
      if (cur.length && cur.join("\n\n").length + p.length > CHUNK_CHARS) {
        flush();
        cur = cur.length > 1 && cur[cur.length - 1].length < CHUNK_CHARS / 3 ? [cur[cur.length - 1]] : [];
      }
      cur.push(p);
    }
    flush();
  }
  return out.filter((c) => c.text.replace(/\s/g, "").length > 15);
}

/** The text that gets embedded: the passage with its note's title, date and section, so it stands on its own. */
const contextual = (meta: NoteMeta, heading: string, text: string) =>
  `${meta.title} (${meta.type}, ${meta.created.slice(0, 10)})${heading ? ` — ${heading}` : ""}\n${text}`;

// ---------- model calls ----------

async function embed(texts: string[]): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += 16) {
    const r = await engineFetch(EMBED_URL(), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input: texts.slice(i, i + 16) }) });
    if (!r.ok) throw new Error(`embedding server answered ${r.status}`);
    const j = (await r.json()) as { data: { index: number; embedding: number[] }[] };
    for (const d of j.data.sort((a, b) => a.index - b.index)) {
      const v = Float32Array.from(d.embedding);
      let n = 0;
      for (const x of v) n += x * x;
      n = Math.sqrt(n) || 1;
      for (let k = 0; k < v.length; k++) v[k] /= n; // store unit vectors: cosine = dot product
      out.push(v);
    }
  }
  return out;
}

async function rerank(query: string, docs: string[]): Promise<number[]> {
  const r = await engineFetch(RERANK_URL(), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, documents: docs }) });
  if (!r.ok) throw new Error(`reranker answered ${r.status}`);
  const j = (await r.json()) as { results: { index: number; relevance_score: number }[] };
  const scores = new Array(docs.length).fill(0);
  for (const x of j.results) scores[x.index] = x.relevance_score;
  return scores;
}

// ---------- indexing ----------

export interface IndexStatus { notes: number; chunks: number; dirs: string[]; lastRun: number; indexing: boolean; error?: string }
const status: IndexStatus = { notes: 0, chunks: 0, dirs: [], lastRun: 0, indexing: false };

function listMarkdown(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listMarkdown(p, out);
    else if (e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

async function indexFile(d: DatabaseSync, file: string) {
  const raw = readFileSync(file, "utf8");
  const hash = createHash("sha1").update(raw).digest("hex");
  const st = statSync(file);
  const prev = d.prepare("SELECT hash FROM docs WHERE path=?").get(file) as { hash: string } | undefined;
  if (prev?.hash === hash) {
    d.prepare("UPDATE docs SET mtime=?, size=? WHERE path=?").run(st.mtimeMs, st.size, file);
    return false;
  }
  const { meta, body } = parseNote(file, raw);
  const chunks = chunkNote(body);
  const vectors = chunks.length ? await embed(chunks.map((c) => contextual(meta, c.heading, c.text))) : [];
  removeDoc(d, file);
  d.prepare("INSERT INTO docs (path,title,type,created,tags,mtime,size,hash,indexed_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(file, meta.title, meta.type, meta.created, meta.tags.join(","), st.mtimeMs, st.size, hash, Date.now());
  const ins = d.prepare("INSERT INTO chunks (path,idx,heading,text,embedding) VALUES (?,?,?,?,?)");
  const fts = d.prepare("INSERT INTO chunks_fts (rowid,text,title,heading) VALUES (?,?,?,?)");
  chunks.forEach((c, i) => {
    const r = ins.run(file, i, c.heading, c.text, Buffer.from(vectors[i].buffer));
    fts.run(Number(r.lastInsertRowid), c.text, meta.title, c.heading);
  });
  return true;
}

function removeDoc(d: DatabaseSync, file: string) {
  for (const row of d.prepare("SELECT id FROM chunks WHERE path=?").all(file) as { id: number }[]) {
    d.prepare("DELETE FROM chunks_fts WHERE rowid=?").run(row.id);
  }
  d.prepare("DELETE FROM chunks WHERE path=?").run(file);
  d.prepare("DELETE FROM docs WHERE path=?").run(file);
}

let running: Promise<IndexStatus> | undefined;
let again = false;

/** Bring the index up to date with the note folders: new and changed notes are (re)embedded, deleted ones removed. */
export function syncIndex(): Promise<IndexStatus> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    const d = open();
    status.indexing = true;
    status.dirs = noteDirs();
    let changed = 0;
    try {
      const files = status.dirs.flatMap((dir) => listMarkdown(dir));
      const known = new Map((d.prepare("SELECT path, mtime, size FROM docs").all() as { path: string; mtime: number; size: number }[]).map((r) => [r.path, r]));
      for (const f of files) {
        const st = statSync(f);
        const k = known.get(f);
        known.delete(f);
        if (k && k.mtime === st.mtimeMs && k.size === st.size) continue;
        if (await indexFile(d, f)) changed++;
      }
      for (const gone of known.keys()) {
        removeDoc(d, gone);
        changed++;
      }
      status.error = undefined;
    } catch (e) {
      status.error = (e as Error).message;
    } finally {
      status.notes = (d.prepare("SELECT count(*) n FROM docs").get() as { n: number }).n;
      status.chunks = (d.prepare("SELECT count(*) n FROM chunks").get() as { n: number }).n;
      status.lastRun = Date.now();
      status.indexing = false;
    }
    if (changed) publish({ type: "notes_index", ...status, changed });
    return { ...status };
  })().finally(() => {
    running = undefined;
    if (again) {
      again = false;
      void syncIndex();
    }
  });
  return running;
}

export function indexStatus(): IndexStatus {
  return { ...status };
}

/** Index now, then keep up with the folders: file events plus a periodic rescan as a safety net. */
export function startIndexer() {
  for (const dir of noteDirs()) mkdirSync(dir, { recursive: true });
  const kick = debounce(() => void syncIndex(), 1500);
  for (const dir of noteDirs()) {
    try {
      watch(dir, { recursive: true }, (_e, f) => f && String(f).endsWith(".md") && kick()).unref();
    } catch {}
  }
  setInterval(() => void syncIndex(), 5 * 60_000).unref();
  void syncIndex();
}

function debounce(fn: () => void, ms: number) {
  let t: NodeJS.Timeout | undefined;
  return () => {
    clearTimeout(t);
    t = setTimeout(fn, ms);
  };
}

// ---------- retrieval ----------

export interface SearchOptions { k?: number; since?: string; until?: string; type?: string; tags?: string[] }

function ftsQuery(q: string): string {
  const words = q.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  const stop = new Set(["the", "and", "for", "what", "when", "where", "who", "how", "did", "does", "was", "were", "about", "with", "that", "this", "from", "into", "have", "has", "my", "me", "is", "are", "of", "to", "in", "on", "a", "an", "o", "a", "os", "as", "de", "do", "da", "dos", "das", "que", "e", "em", "um", "uma", "para", "com", "por", "no", "na"]);
  const terms = [...new Set(words.filter((w) => !stop.has(w)))].slice(0, 16);
  return terms.map((t) => `"${t}"*`).join(" OR ");
}

export async function searchNotes(query: string, opts: SearchOptions = {}): Promise<{ hits: Hit[]; considered: number; ms: number }> {
  const t0 = Date.now();
  const d = open();
  const k = Math.min(opts.k ?? 6, 20);
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (opts.since) where.push("d.created >= ?"), args.push(opts.since);
  if (opts.until) where.push("d.created <= ?"), args.push(opts.until.length === 10 ? `${opts.until}T23:59:59` : opts.until);
  if (opts.type) where.push("d.type = ?"), args.push(opts.type);
  for (const tag of opts.tags ?? []) where.push("(',' || d.tags || ',') LIKE ?"), args.push(`%,${tag},%`);
  const filter = where.length ? `AND ${where.join(" AND ")}` : "";

  // 1. keywords
  const fq = ftsQuery(query);
  const kw = fq
    ? (d.prepare(`SELECT c.id FROM chunks_fts f JOIN chunks c ON c.id = f.rowid JOIN docs d ON d.path = c.path
        WHERE chunks_fts MATCH ? ${filter} ORDER BY bm25(chunks_fts, 1.0, 2.0, 1.5) LIMIT 40`).all(fq, ...args) as { id: number }[]).map((r) => r.id)
    : [];
  // 2. meaning
  const [qv] = await embed([QUERY_INSTRUCTION + query]);
  const rows = d.prepare(`SELECT c.id, c.embedding FROM chunks c JOIN docs d ON d.path = c.path WHERE 1=1 ${filter}`).all(...args) as { id: number; embedding: Uint8Array }[];
  const sims = rows.map((r) => {
    const v = new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4);
    let s = 0;
    for (let i = 0; i < v.length; i++) s += v[i] * qv[i];
    return { id: r.id, s };
  }).sort((a, b) => b.s - a.s).slice(0, 40).map((x) => x.id);
  // 3. reciprocal rank fusion
  const fused = new Map<number, number>();
  kw.forEach((id, i) => fused.set(id, (fused.get(id) ?? 0) + 1 / (60 + i)));
  sims.forEach((id, i) => fused.set(id, (fused.get(id) ?? 0) + 1 / (60 + i)));
  const candidates = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([id]) => id);
  if (!candidates.length) return { hits: [], considered: 0, ms: Date.now() - t0 };
  const cand = d.prepare(`SELECT c.id, c.path, c.heading, c.text, d.title, d.created, d.type FROM chunks c JOIN docs d ON d.path = c.path
    WHERE c.id IN (${candidates.map(() => "?").join(",")})`).all(...candidates) as any[];
  // 4. rerank with the cross-encoder
  const scores = await rerank(query, cand.map((c) => contextual({ path: c.path, title: c.title, type: c.type, created: c.created, tags: [] }, c.heading, c.text)));
  const hits = cand.map((c, i) => ({ path: c.path, title: c.title, created: c.created, type: c.type, heading: c.heading, text: c.text, score: scores[i] }))
    // equally relevant passages (the reranker saturates near 1.0): the newer note wins, since a later note
    // usually supersedes an earlier one (revision B's torque over the first prototype's)
    .sort((a, b) => Math.round(b.score * 50) - Math.round(a.score * 50) || b.created.localeCompare(a.created))
    .filter((h, i) => i < 2 || h.score >= 0.05) // keep the best two even when weak; drop clear misses
    .slice(0, k);
  return { hits, considered: cand.length, ms: Date.now() - t0 };
}

export function listNotes(opts: { since?: string; until?: string; type?: string; limit?: number } = {}) {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (opts.since) where.push("created >= ?"), args.push(opts.since);
  if (opts.until) where.push("created <= ?"), args.push(opts.until.length === 10 ? `${opts.until}T23:59:59` : opts.until);
  if (opts.type) where.push("type = ?"), args.push(opts.type);
  return open().prepare(`SELECT path, title, type, created, tags FROM docs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created DESC LIMIT ?`)
    .all(...args, Math.min(opts.limit ?? 50, 500)) as { path: string; title: string; type: string; created: string; tags: string }[];
}

/** A note's full text; only files inside the note folders can be read. */
export function readNote(p: string): string {
  const full = path.resolve(p);
  if (!noteDirs().some((d) => full.startsWith(d + path.sep))) {
    const byName = listNotes({ limit: 500 }).find((n) => path.basename(n.path) === p || n.title.toLowerCase() === p.toLowerCase());
    if (!byName) throw new Error(`not a note: ${p}`);
    return readFileSync(byName.path, "utf8");
  }
  return readFileSync(full, "utf8");
}

/** Hits as numbered sources for a prompt; the model cites them as [1], [2]. */
export function formatSources(hits: Hit[]): string {
  return hits.map((h, i) => `[${i + 1}] ${h.title} — ${h.created.slice(0, 10)}${h.heading ? ` — ${h.heading}` : ""} (${path.basename(h.path)})\n${h.text}`).join("\n\n");
}
