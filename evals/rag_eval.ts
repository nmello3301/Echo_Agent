// Retrieval eval: indexes evals/rag-notes into a throwaway database and checks the top hit for each question in
// evals/rag-set.jsonl. Needs Echo's embedding and reranker servers running (./echo up).
//   cd apps/server && node ../../evals/rag_eval.ts
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
const tmp = mkdtempSync(path.join(os.tmpdir(), "echo-rag-eval-"));
process.env.ECHO_RAG_DB = path.join(tmp, "rag.db");
const { config } = await import("../apps/server/src/config.ts");
config.echo.notes = { ...config.echo.notes, dirs: [path.resolve(import.meta.dirname, "rag-notes")] };
const rag = await import("../apps/server/src/rag.ts");
const st = await rag.syncIndex();
console.log(`indexed ${st.notes} notes, ${st.chunks} passages${st.error ? ` (error: ${st.error})` : ""}`);
const set = readFileSync(path.join(import.meta.dirname, "rag-set.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
let top1 = 0, top3 = 0, ms = 0;
for (const c of set) {
  const r = await rag.searchNotes(c.q, { k: 3, since: c.since, until: c.until });
  ms += r.ms;
  const names = r.hits.map((h) => path.basename(h.path));
  const hit1 = names[0]?.includes(c.want) ?? false;
  const hit3 = names.some((n) => n.includes(c.want));
  top1 += +hit1; top3 += +hit3;
  console.log(`${hit1 ? "PASS" : hit3 ? "TOP3" : "FAIL"}  ${String(r.ms).padStart(5)} ms  ${c.q.padEnd(58)} -> ${(names[0] ?? "-").slice(11, 45)} (${r.hits[0]?.score.toFixed(2) ?? "-"})`);
}
console.log(`\ntop-1 ${top1}/${set.length}, top-3 ${top3}/${set.length}, mean ${Math.round(ms / set.length)} ms per search`);
rmSync(tmp, { recursive: true, force: true });
process.exit(0);
