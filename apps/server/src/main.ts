import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { serve } from "@hono/node-server";
import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { WebSocketServer } from "ws";
import { hitlVerdict, pastRuns, runEvents, runs, startRun } from "./agent.ts";
import { subscribe } from "./bus.ts";
import { config, dockerEnv, ROOT } from "./config.ts";
import { db, now } from "./db.ts";
import { decisions, type Questions } from "./decision.ts";
import { buildStrata, cancelDownload, catalogStatus, startDownload } from "./downloads.ts";
import { activeMain, activeMainId, allEngines, engineById, huginEnv, startDecision, startHugin, startRag, startSearch, startTts, stopAll, useMainModel } from "./engines.ts";
import { type Effort, effortFields, type StreamResult, streamChat } from "./llm.ts";
import { lastSample, startMonitor } from "./monitor.ts";
import { formatSources, indexStatus, listNotes, readNote, searchNotes, startIndexer, syncIndex } from "./rag.ts";
import { chatWithWeb, type WebSource } from "./webchat.ts";

const app = new Hono();
const chatAborts = new Map<string, AbortController>();

const err = (e: unknown) => ({ error: (e as Error).message ?? String(e) });

// ---------- models and engines ----------
app.get("/api/models", (c) =>
  c.json({
    main: config.models.main.map((m) => ({
      id: m.id, name: m.name, comingSoon: !!m.coming_soon, vision: !!m.supports_vision,
      reasoning: m.reasoning_levels ?? [], context: m.context ?? null,
      available: !m.coming_soon && (m.engine === "strata" ? existsSync(path.join(ROOT, m.command ?? "-")) : existsSync(path.join(ROOT, m.model ?? "-"))),
    })),
    decision: config.models.decision.map((d) => ({ id: d.id, name: d.name, comingSoon: !!d.coming_soon })),
    active: activeMainId ?? null,
    defaults: { model: config.echo.default_model, effort: config.echo.agent.default_effort },
  }),
);

app.post("/api/models/active", async (c) => {
  const { id } = await c.req.json<{ id: string }>();
  useMainModel(id).catch((e) => console.error("[engines]", e.message));
  return c.json({ ok: true });
});

app.get("/api/engines", (c) => c.json(allEngines().map((e) => e.info())));
app.get("/api/engines/:id/log", (c) => c.json(engineById(c.req.param("id"))?.log.slice(-400) ?? []));
app.post("/api/engines/:id/stop", async (c) => {
  await engineById(c.req.param("id"))?.stop();
  return c.json({ ok: true });
});
app.post("/api/engines/:id/start", async (c) => {
  const id = c.req.param("id");
  if (config.models.main.some((m) => m.id === id)) useMainModel(id).catch(() => {});
  else startDecision().catch(() => {});
  return c.json({ ok: true });
});
app.get("/api/metrics", (c) => c.json(lastSample ?? {}));

// ---------- conversations ----------
app.get("/api/conversations", (c) => {
  const q = c.req.query("q");
  const rows = q
    ? db.prepare(`SELECT DISTINCT c.* FROM conversations c LEFT JOIN messages m ON m.conversation_id=c.id
        WHERE c.title LIKE ? OR m.content LIKE ? ORDER BY c.updated_at DESC LIMIT 200`).all(`%${q}%`, `%${q}%`)
    : db.prepare("SELECT * FROM conversations ORDER BY updated_at DESC LIMIT 200").all();
  return c.json(rows);
});
app.get("/api/conversations/:id", (c) => {
  const conv = db.prepare("SELECT * FROM conversations WHERE id=?").get(c.req.param("id"));
  if (!conv) return c.json({ error: "not found" }, 404);
  const msgs = db.prepare("SELECT * FROM messages WHERE conversation_id=? ORDER BY id").all(c.req.param("id")) as any[];
  return c.json({ ...conv, messages: msgs.map((m) => ({ ...m, content: JSON.parse(m.content), stats: m.stats ? JSON.parse(m.stats) : null })) });
});
app.patch("/api/conversations/:id", async (c) => {
  const { title } = await c.req.json<{ title: string }>();
  db.prepare("UPDATE conversations SET title=? WHERE id=?").run(title, c.req.param("id"));
  return c.json({ ok: true });
});
app.delete("/api/conversations/:id", (c) => {
  db.prepare("DELETE FROM conversations WHERE id=?").run(c.req.param("id"));
  return c.json({ ok: true });
});

// ---------- chat ----------
app.post("/api/chat", async (c) => {
  const body = await c.req.json<{ conversationId?: string; model: string; effort: Effort; content: unknown; notes?: boolean; web?: boolean }>();
  let convId = body.conversationId;
  const text = typeof body.content === "string" ? body.content : (body.content as any[]).find((p) => p.type === "text")?.text ?? "Image";
  if (!convId) {
    convId = randomUUID();
    db.prepare("INSERT INTO conversations (id, title, model, created_at, updated_at) VALUES (?,?,?,?,?)")
      .run(convId, text.slice(0, 60) || "New chat", body.model, now(), now());
  }
  db.prepare("INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?,?,?,?)").run(convId, "user", JSON.stringify(body.content), now());
  db.prepare("UPDATE conversations SET updated_at=?, model=? WHERE id=?").run(now(), body.model, convId);
  const history = (db.prepare("SELECT role, content FROM messages WHERE conversation_id=? ORDER BY id").all(convId) as any[])
    .map((m) => ({ role: m.role, content: JSON.parse(m.content) }));
  const id = convId;

  return streamSSE(c, async (stream) => {
    const ac = new AbortController();
    chatAborts.set(id, ac);
    stream.onAbort(() => ac.abort());
    await stream.writeSSE({ event: "meta", data: JSON.stringify({ conversationId: id }) });
    try {
      if (activeMainId !== body.model || activeMain()?.engine.status !== "ready") {
        await stream.writeSSE({ event: "status", data: JSON.stringify({ text: "Loading model…" }) });
        await useMainModel(body.model);
      }
      const m = activeMain()!.model;
      // "Use my notes": retrieve passages for this question and put them in front of it (the earlier turns stay
      // byte-identical, so the engine's prompt cache still covers them).
      let sources: ({ title: string; created: string; path: string; heading: string; score: number } | WebSource)[] = [];
      let messages = history;
      if (body.notes) {
        await stream.writeSSE({ event: "status", data: JSON.stringify({ text: "Searching your notes…" }) });
        const r = await searchNotes(text, { k: 6 });
        sources = r.hits.map((h) => ({ title: h.title, created: h.created, path: h.path, heading: h.heading, score: h.score }));
        await stream.writeSSE({ event: "sources", data: JSON.stringify({ sources, ms: r.ms }) });
        const ctx = r.hits.length
          ? `Passages from my notes that may help (numbered sources):\n\n${formatSources(r.hits)}\n\nAnswer my question from these notes. Cite sources inline as [1], [2]. If the notes do not contain the answer, say so plainly instead of guessing.`
          : "I searched my notes and found nothing relevant. Say that the notes do not cover this, then answer from general knowledge only if that still helps.";
        const last = messages[messages.length - 1];
        const q = typeof last.content === "string" ? last.content : text;
        messages = [...messages.slice(0, -1), { role: "user", content: `${ctx}\n\nMy question: ${q}` }];
      }
      const req = { messages, ...effortFields(m, body.effort), cache_prompt: true };
      const relay = async (d: { content?: string; reasoning?: string }) => {
        await stream.writeSSE({ event: "delta", data: JSON.stringify(d) });
      };
      // "Search the web": the model gets web_search and fetch_page and decides when to use them
      let searches: string[] | undefined;
      let res: StreamResult;
      if (body.web) {
        const status = (t: string) => stream.writeSSE({ event: "status", data: JSON.stringify({ text: t }) });
        const r = await chatWithWeb(m, req, relay, status, ac.signal, sources.length + 1);
        sources = [...sources, ...r.sources];
        searches = r.searches.length ? r.searches : undefined;
        res = r;
      } else res = await streamChat(m, req, relay, ac.signal, "chat");
      const stats = { ...res.timings, ttft_ms: res.ttftMs, aborted: res.aborted, model: m.id, effort: body.effort, sources: sources.length ? sources : undefined, searches };
      db.prepare("INSERT INTO messages (conversation_id, role, content, reasoning, stats, created_at) VALUES (?,?,?,?,?,?)")
        .run(id, "assistant", JSON.stringify(res.content), res.reasoning || null, JSON.stringify(stats), now());
      await stream.writeSSE({ event: "done", data: JSON.stringify({ stats }) });
    } catch (e) {
      await stream.writeSSE({ event: "error", data: JSON.stringify(err(e)) });
    } finally {
      chatAborts.delete(id);
    }
  });
});
app.post("/api/chat/:id/stop", (c) => {
  chatAborts.get(c.req.param("id"))?.abort();
  return c.json({ ok: true });
});

// ---------- decide ----------
app.post("/api/decide", async (c) => {
  const { state, questions } = await c.req.json<{ state: unknown; questions: Questions }>();
  try {
    const t0 = Date.now();
    const result = await decisions.decide(state, questions, { source: "decide-tab" });
    return c.json({ ...result, request: { state, questions }, wall_ms: Date.now() - t0 });
  } catch (e) {
    return c.json(err(e), 500);
  }
});
app.get("/api/presets", (c) => c.json((db.prepare("SELECT * FROM presets ORDER BY name").all() as any[]).map((p) => ({ ...p, questions: JSON.parse(p.questions) }))));
app.put("/api/presets/:name", async (c) => {
  const { questions } = await c.req.json<{ questions: unknown }>();
  db.prepare("INSERT INTO presets (name, questions, updated_at) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET questions=excluded.questions, updated_at=excluded.updated_at")
    .run(c.req.param("name"), JSON.stringify(questions), now());
  return c.json({ ok: true });
});
app.delete("/api/presets/:name", (c) => {
  db.prepare("DELETE FROM presets WHERE name=?").run(c.req.param("name"));
  return c.json({ ok: true });
});

// ---------- agent ----------
app.get("/api/agent/runs", (c) => c.json({ live: [...runs.values()].map((r) => r.summary()), past: pastRuns() }));
app.post("/api/agent/runs", async (c) => {
  const b = await c.req.json<{ cwd: string; task: string; effort?: Effort; model?: string }>();
  if (!b.cwd || !existsSync(b.cwd) || !statSync(b.cwd).isDirectory()) return c.json({ error: `not a folder: ${b.cwd}` }, 400);
  const r = await startRun(b.cwd, b.task, b.effort ?? (config.echo.agent.default_effort as Effort), b.model);
  return c.json(r.summary());
});
app.get("/api/agent/runs/:id", (c) => {
  const r = runs.get(c.req.param("id"));
  return c.json({ summary: r?.summary() ?? null, events: runEvents(c.req.param("id")) });
});
const run = (id: string) => {
  const r = runs.get(id);
  if (!r) throw new Error("run is not live (finished runs can be viewed, not continued)");
  return r;
};
app.post("/api/agent/runs/:id/message", async (c) => {
  try {
    await run(c.req.param("id")).send((await c.req.json<{ text: string }>()).text);
    return c.json({ ok: true });
  } catch (e) {
    return c.json(err(e), 400);
  }
});
app.post("/api/agent/runs/:id/answer", async (c) => {
  try {
    const b = await c.req.json<{ pendingId: string; approved?: boolean; reply?: string; remember?: boolean }>();
    run(c.req.param("id")).answer(b.pendingId, { approved: b.approved, reply: b.reply, remember: b.remember });
    return c.json({ ok: true });
  } catch (e) {
    return c.json(err(e), 400);
  }
});
app.post("/api/agent/runs/:id/stop", async (c) => {
  await runs.get(c.req.param("id"))?.stop();
  return c.json({ ok: true });
});
app.get("/api/agent/runs/:id/diff", async (c) => {
  try {
    return c.json({ diff: await run(c.req.param("id")).diff(c.req.query("from")) });
  } catch (e) {
    return c.json(err(e), 400);
  }
});
app.post("/api/agent/runs/:id/revert", async (c) => {
  try {
    const { sha } = await c.req.json<{ sha: string }>();
    return c.json({ removed: await run(c.req.param("id")).revert(sha) });
  } catch (e) {
    return c.json(err(e), 400);
  }
});
app.post("/api/agent/hitl/:rowId/verdict", async (c) => {
  hitlVerdict(Number(c.req.param("rowId")), (await c.req.json<{ agreed: boolean }>()).agreed);
  return c.json({ ok: true });
});

// ---------- notes (RAG) and Hugin ----------
app.get("/api/notes/status", (c) => c.json(indexStatus()));
app.post("/api/notes/reindex", async (c) => c.json(await syncIndex()));
app.get("/api/notes/search", async (c) => {
  try {
    const q = c.req.query("q") ?? "";
    if (!q.trim()) return c.json({ hits: [], considered: 0, ms: 0 });
    return c.json(await searchNotes(q, { k: Number(c.req.query("k") ?? 8), since: c.req.query("since"), until: c.req.query("until"), type: c.req.query("type") || undefined }));
  } catch (e) {
    return c.json(err(e), 500);
  }
});
app.get("/api/notes", (c) => c.json(listNotes({ since: c.req.query("since"), until: c.req.query("until"), type: c.req.query("type") || undefined, limit: Number(c.req.query("limit") ?? 100) })));
app.get("/api/notes/read", (c) => {
  try {
    return c.json({ text: readNote(c.req.query("path") ?? "") });
  } catch (e) {
    return c.json(err(e), 404);
  }
});
/** Log the browser into Hugin's UI: Echo posts the password and hands the session cookie on. Cookies are
 *  per host, not per port, so the cookie set here is sent to Hugin's iframe at 127.0.0.1:8088 as well. */
app.post("/api/hugin/session", async (c) => {
  const pw = huginEnv().HUGIN_UI_PASSWORD;
  if (!pw) return c.json({ error: "Hugin is not configured (no .env)" }, 500);
  try {
    const r = await fetch(`${dockerEnv.huginUrl ?? `http://127.0.0.1:${config.echo.ports.hugin ?? 8088}`}/login`, {
      method: "POST", body: new URLSearchParams({ password: pw }), redirect: "manual",
    });
    const cookie = /hugin_ui=([^;]+)/.exec(r.headers.get("set-cookie") ?? "")?.[1];
    if (!cookie) return c.json({ error: `Hugin refused the login (${r.status})` }, 502);
    c.header("Set-Cookie", `hugin_ui=${cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
    return c.json({ ok: true, url: `http://127.0.0.1:${config.echo.ports.hugin ?? 8088}/notes` });
  } catch (e) {
    return c.json({ error: `Hugin is not reachable: ${(e as Error).message}` }, 503);
  }
});

// ---------- model downloader ----------
app.get("/api/downloads", async (c) => c.json(await catalogStatus()));
app.post("/api/downloads/:id", async (c) => {
  try {
    await startDownload(c.req.param("id"));
    return c.json({ ok: true });
  } catch (e) {
    return c.json(err(e), 400);
  }
});
app.delete("/api/downloads/:id", (c) => {
  cancelDownload(c.req.param("id"));
  return c.json({ ok: true });
});
app.post("/api/strata/build", (c) => {
  try {
    buildStrata();
    return c.json({ ok: true });
  } catch (e) {
    return c.json(err(e), 400);
  }
});
// ---------- Read tab: screenshot -> text -> (summary) -> speech ----------
/** Tesseract keeps the screenshot's line breaks; join lines within a paragraph and undo end-of-line hyphenation. */
function cleanOcr(t: string): string {
  return t.replace(/-\n(?=[a-z])/g, "").split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean).join("\n\n");
}

app.post("/api/read/ocr", async (c) => {
  const { image } = await c.req.json<{ image: string }>();
  const m = /^data:image\/[a-z+.-]+;base64,(.+)$/i.exec(image ?? "");
  if (!m) return c.json({ error: "expected an image as a data: URL" }, 400);
  try {
    const text = await new Promise<string>((resolve, reject) => {
      const p = spawn("tesseract", ["stdin", "stdout", "-l", "eng"], { stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let errOut = "";
      p.stdout.on("data", (b) => (out += b));
      p.stderr.on("data", (b) => (errOut += b));
      p.on("error", reject);
      p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`tesseract failed: ${errOut.trim().slice(0, 300)}`))));
      p.stdin.end(Buffer.from(m[1], "base64"));
    });
    return c.json({ text: cleanOcr(text) });
  } catch (e) {
    return c.json(err(e), 500);
  }
});

app.post("/api/read/summarize", async (c) => {
  const { text } = await c.req.json<{ text: string }>();
  if (!text?.trim()) return c.json({ error: "no text" }, 400);
  try {
    if (activeMain()?.engine.status !== "ready") await useMainModel(activeMainId ?? config.echo.default_model);
    const m = activeMain()!.model;
    const messages = [
      { role: "system", content: "Summarize text taken from a screenshot so it can be read aloud. Write 2-5 short plain sentences: no markdown, no lists, no headings. Skip menus, buttons and other screen clutter. Keep names, numbers and dates." },
      { role: "user", content: text.slice(0, 40_000) },
    ];
    const res = await streamChat(m, { messages, ...effortFields(m, "off"), max_tokens: 800 }, () => {}, new AbortController().signal, "read");
    return c.json({ summary: res.content.trim(), model: m.id });
  } catch (e) {
    return c.json(err(e), 500);
  }
});

/** A request to the TTS service (services/tts/server.py), started first when it isn't running. node:http, not
 * fetch: fetch gives up after 5 minutes without an answer, and a long text in a Pocket TTS voice takes longer. */
async function tts(pathname: string, method = "GET", body?: string): Promise<{ status: number; data: Buffer }> {
  await startTts(); // returns at once when it is already running
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: config.echo.ports.tts ?? 8095, path: pathname, method }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (b: Buffer) => chunks.push(b));
      res.on("end", () => resolve({ status: res.statusCode ?? 502, data: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body);
  });
}
const ttsJson = (r: { data: Buffer }) => JSON.parse(r.data.toString());
/** The service's own error message; a 400 (unknown voice, bad sample) is the caller's to fix, the rest is ours. */
function ttsFailed(c: Context, r: { status: number; data: Buffer }) {
  let error = `TTS answered ${r.status}`;
  try {
    error = ttsJson(r).error ?? error;
  } catch {}
  return c.json({ error }, r.status === 400 ? 400 : 502);
}

app.post("/api/read/tts", async (c) => {
  const body = await c.req.json<{ text: string; speed?: number; voice?: string }>();
  try {
    const r = await tts("/tts", "POST", JSON.stringify(body));
    if (r.status !== 200) return ttsFailed(c, r);
    return c.body(new Uint8Array(r.data), 200, { "Content-Type": "audio/wav" });
  } catch (e) {
    return c.json(err(e), 503);
  }
});

// The voices the Read tab can use: Piper and Pocket TTS defaults, plus voices cloned from a sample
app.get("/api/read/voices", async (c) => {
  try {
    const r = await tts("/voices");
    return r.status === 200 ? c.json(ttsJson(r)) : ttsFailed(c, r);
  } catch (e) {
    return c.json(err(e), 503);
  }
});

app.post("/api/read/voices", async (c) => {
  const { name, audio } = await c.req.json<{ name: string; audio: string }>();
  const m = /^data:audio\/(?:wav|x-wav|wave);base64,(.+)$/i.exec(audio ?? "");
  if (!m) return c.json({ error: "expected a WAV sample as a data: URL" }, 400);
  try {
    const r = await tts("/voices", "POST", JSON.stringify({ name, audio: m[1] }));
    return r.status === 200 ? c.json(ttsJson(r)) : ttsFailed(c, r);
  } catch (e) {
    return c.json(err(e), 503);
  }
});

app.delete("/api/read/voices/:id", async (c) => {
  try {
    const r = await tts(`/voices/${encodeURIComponent(c.req.param("id"))}`, "DELETE");
    return r.status === 200 ? c.json({ ok: true }) : ttsFailed(c, r);
  } catch (e) {
    return c.json(err(e), 503);
  }
});

app.get("/api/rules", (c) => c.json({ path: path.join(ROOT, "rules.md"), text: readFileSync(path.join(ROOT, "rules.md"), "utf8") }));

// ---------- static UI ----------
const dist = path.join(ROOT, "apps/web/dist");
const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2" };
app.get("*", (c) => {
  let p = path.join(dist, path.normalize(c.req.path));
  if (!p.startsWith(dist) || !existsSync(p) || statSync(p).isDirectory()) p = path.join(dist, "index.html");
  if (!existsSync(p)) return c.text("UI not built. Run: npm run build", 503);
  return c.body(readFileSync(p), 200, { "Content-Type": types[path.extname(p)] ?? "application/octet-stream" });
});

// ---------- server ----------
const server = serve({ fetch: app.fetch, hostname: dockerEnv.host ?? config.echo.host, port: config.echo.ports.ui }, (i) =>
  console.log(`[echo] UI on http://127.0.0.1:${i.port}`),
);
const wss = new WebSocketServer({ noServer: true });
(server as any).on("upgrade", (req: any, socket: any, head: any) => {
  if (req.url !== "/ws") return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});
wss.on("connection", (ws) => {
  if (lastSample) ws.send(JSON.stringify({ type: "metrics", ...lastSample }));
  const off = subscribe((e) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(e));
  });
  ws.on("close", off);
});

startMonitor();
startDecision().catch((e) => console.error("[decision]", e.message));
startSearch().catch((e) => console.error("[search]", e.message));
startRag().then(() => startIndexer()).catch((e) => console.error("[rag]", e.message));
startHugin().catch((e) => console.error("[hugin]", e.message));
startTts().catch((e) => console.error("[tts]", e.message));
useMainModel(process.env.ECHO_MODEL ?? config.echo.default_model).catch((e) => console.error("[engines]", e.message));

let shuttingDown = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("[echo] stopping engines…");
    for (const r of runs.values()) await r.stop().catch(() => {});
    await stopAll();
    process.exit(0);
  });
}
