// Live personas: named characters to talk to in the Live tab, each with its own voice, instructions and settings.
// Live (live.ts) puts a persona's instructions above its own spoken-style rules, so whatever the persona is told,
// its answers stay speakable. Routes are mounted at /api/live/personas.
import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { db, now } from "./db.ts";

export type ReplyLength = "short" | "medium" | "long";

export interface Persona {
  id: string;
  name: string;
  /** TTS voice id, as the voice pickers use ("piper:...", "clone:...", "fast:clone:...") */
  voice: string;
  /** Who it is and how it talks, in the user's words */
  prompt: string;
  effort: "off" | "low";
  length: ReplyLength;
  /** Sampling temperature; null keeps the model's own */
  temperature: number | null;
  /** Playback speed of its voice, 0.8-1.3 */
  speed: number;
  /** Said when Live starts a new conversation with it; empty: none */
  greeting: string;
  /** Which other models it may hand questions to */
  helpers: { chat: boolean; decide: boolean };
  /** The main model it answers with (models.yaml id); null: the one picked for Echo in the Live tab */
  model: string | null;
}

db.exec(`CREATE TABLE IF NOT EXISTS live_personas (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);`);

const clamp = (n: unknown, lo: number, hi: number, fallback: number) => {
  const x = Number(n);
  return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : fallback;
};

/** A persona as sent by the UI, with every field checked and filled in. */
export function cleanPersona(input: Partial<Persona>, id: string): Persona {
  const name = String(input.name ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
  if (!name) throw new Error("give the persona a name");
  const t = input.temperature;
  return {
    id,
    name,
    voice: String(input.voice ?? "").trim() || "piper:en_US-lessac-medium",
    prompt: String(input.prompt ?? "").trim().slice(0, 8000),
    effort: input.effort === "low" ? "low" : "off",
    length: input.length === "medium" || input.length === "long" ? input.length : "short",
    temperature: t === null || t === undefined || (t as unknown) === "" ? null : clamp(t, 0, 1.5, 0.7),
    speed: Math.round(clamp(input.speed, 0.8, 1.3, 1) * 100) / 100,
    greeting: String(input.greeting ?? "").replace(/\s+/g, " ").trim().slice(0, 300),
    helpers: { chat: input.helpers?.chat !== false, decide: input.helpers?.decide !== false },
    model: typeof input.model === "string" && input.model.trim() ? input.model.trim().slice(0, 100) : null,
  };
}

export function listPersonas(): Persona[] {
  return (db.prepare("SELECT id, data FROM live_personas").all() as { id: string; data: string }[])
    .map((r) => ({ ...JSON.parse(r.data), id: r.id }) as Persona)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getPersona(id: string | undefined): Persona | undefined {
  if (!id) return undefined;
  const r = db.prepare("SELECT data FROM live_personas WHERE id=?").get(id) as { data: string } | undefined;
  return r ? { ...JSON.parse(r.data), id } : undefined;
}

function save(p: Persona): Persona {
  db.prepare("INSERT INTO live_personas (id, data, updated_at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at")
    .run(p.id, JSON.stringify(p), now());
  return p;
}

const newId = (name: string) => `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "persona"}-${randomBytes(3).toString("hex")}`;
const err = (e: unknown) => ({ error: (e as Error).message ?? String(e) });

export const personasApp = new Hono();

personasApp.get("/", (c) => c.json(listPersonas()));

personasApp.post("/", async (c) => {
  try {
    const body = await c.req.json<Partial<Persona>>();
    return c.json(save(cleanPersona(body, newId(String(body.name ?? "")))));
  } catch (e) {
    return c.json(err(e), 400);
  }
});

personasApp.put("/:id", async (c) => {
  const id = c.req.param("id");
  if (!getPersona(id)) return c.json({ error: "no such persona" }, 404);
  try {
    return c.json(save(cleanPersona(await c.req.json<Partial<Persona>>(), id)));
  } catch (e) {
    return c.json(err(e), 400);
  }
});

personasApp.delete("/:id", (c) => {
  db.prepare("DELETE FROM live_personas WHERE id=?").run(c.req.param("id"));
  return c.json({ ok: true });
});
