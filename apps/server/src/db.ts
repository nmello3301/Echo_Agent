import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { abs, config } from "./config.ts";

const dir = abs(config.echo.paths.data);
mkdirSync(dir, { recursive: true });

export const db = new DatabaseSync(process.env.ECHO_DB ?? path.join(dir, "echo.db"));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  model TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,          -- JSON: string or OpenAI content parts
  reasoning TEXT,
  stats TEXT,                     -- JSON timings
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_conv ON messages(conversation_id, id);
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,           -- "decide-tab" | "agent"
  run_id TEXT,
  model TEXT NOT NULL,
  state TEXT NOT NULL,
  questions TEXT NOT NULL,
  answers TEXT,
  error TEXT,
  latency_ms INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS presets (
  name TEXT PRIMARY KEY,
  questions TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  cwd TEXT NOT NULL,
  task TEXT NOT NULL,
  model TEXT,
  status TEXT NOT NULL,
  events TEXT NOT NULL DEFAULT '[]', -- JSON timeline for replay
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS hitl (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  probability REAL NOT NULL,
  summary TEXT NOT NULL,
  reply TEXT,
  agreed_needed INTEGER,          -- your verdict: was the interruption needed?
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS metrics (
  ts INTEGER NOT NULL,
  data TEXT NOT NULL
);
`);

export const now = () => Date.now();
