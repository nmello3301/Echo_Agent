import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { abs, config } from "./config.ts";
import { db, now } from "./db.ts";
import { engineById, startDecision } from "./engines.ts";
import { engineFetch } from "./llm.ts";

export type QuestionType = "choice" | "noul" | "score";
export interface Question {
  type: QuestionType;
  instructions: string;
  /** choice: {key: description}; noul: {true: meaning, false: meaning}; score: ordered level labels */
  criteria: Record<string, string | null> | string[];
}
export type Questions = Record<string, Question>;

export interface Answer {
  type: QuestionType;
  choice?: string;
  noul?: number;
  score?: number;
  confidence?: number;
  probabilities?: Record<string, number>;
  legend?: Record<string, string>;
}
export interface Decision {
  answers: Record<string, Answer>;
  latency_ms: number;
  latency_per_question_ms: Record<string, number>;
  truncated: string[];
}

export class DecisionClient {
  model = config.models.decision.find((d) => !d.coming_soon)?.id ?? "none";

  async healthy(): Promise<boolean> {
    try {
      const r = await fetch(`http://127.0.0.1:${config.echo.ports.decision}/health`, { signal: AbortSignal.timeout(1500) });
      return r.ok && ((await r.json()) as { llama?: boolean }).llama === true;
    } catch {
      return false;
    }
  }

  async decide(state: unknown, questions: Questions, meta: { source: string; runId?: string } = { source: "api" }): Promise<Decision> {
    const ready = engineById("decision-server")?.status === "ready" && engineById(this.model)?.status === "ready";
    if (!ready && !(await this.healthy())) await startDecision();
    const t0 = Date.now();
    let result: Decision | undefined;
    let error: string | undefined;
    try {
      const r = await engineFetch(`http://127.0.0.1:${config.echo.ports.decision}/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state, questions }),
        signal: AbortSignal.timeout(15 * 60_000),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `decision server answered ${r.status}`);
      result = j as Decision;
      return result;
    } catch (e) {
      error = (e as Error).message;
      throw e;
    } finally {
      const latency = result?.latency_ms ?? Date.now() - t0;
      db.prepare(
        "INSERT INTO decisions (source, run_id, model, state, questions, answers, error, latency_ms, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      ).run(meta.source, meta.runId ?? null, this.model, JSON.stringify(state), JSON.stringify(questions),
        result ? JSON.stringify(result.answers) : null, error ?? null, latency, now());
      const dir = abs(config.echo.paths.evals);
      mkdirSync(dir, { recursive: true });
      appendFileSync(path.join(dir, "decisions.jsonl"), JSON.stringify({
        ts: new Date().toISOString(), source: meta.source, run_id: meta.runId, model: this.model,
        state, questions, answers: result?.answers, error, latency_ms: latency,
      }) + "\n");
    }
  }
}

export const decisions = new DecisionClient();
