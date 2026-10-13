// Live generation numbers for the Monitor. Speeds come from the engine's own timing fields
// (llama-server `timings`); decode speed is never tokens divided by total request time.
export interface StreamStats {
  active: boolean;
  source: string;            // "chat" | "agent"
  decodeTps: number | null;  // tokens/s while generating
  promptTps: number | null;  // prompt-processing tokens/s
  ttftMs: number | null;
  promptTokens: number | null;
  cachedTokens: number | null;
  generated: number;
  contextUsed: number | null;
  contextLimit: number | null;
}

export const live: StreamStats = {
  active: false,
  source: "",
  decodeTps: null,
  promptTps: null,
  ttftMs: null,
  promptTokens: null,
  cachedTokens: null,
  generated: 0,
  contextUsed: null,
  contextLimit: null,
};

export interface Timings {
  prompt_n?: number;
  prompt_ms?: number;
  prompt_per_second?: number;
  predicted_n?: number;
  predicted_ms?: number;
  predicted_per_second?: number;
  cache_n?: number;
  draft_n?: number;
  draft_n_accepted?: number;
}

export function applyTimings(t: Timings | undefined, contextLimit?: number) {
  if (!t) return;
  if (t.predicted_per_second && t.predicted_n && t.predicted_n > 1) live.decodeTps = t.predicted_per_second;
  if (t.prompt_per_second && t.prompt_n && t.prompt_n > 0) live.promptTps = t.prompt_per_second;
  if (t.prompt_n !== undefined) live.promptTokens = t.prompt_n;
  if (t.cache_n !== undefined) live.cachedTokens = t.cache_n;
  if (t.predicted_n !== undefined) live.generated = t.predicted_n;
  const used = (t.cache_n ?? 0) + (t.prompt_n ?? 0) + (t.predicted_n ?? 0);
  if (used) live.contextUsed = used;
  if (contextLimit) live.contextLimit = contextLimit;
}

/** Decode speed from token arrival times, for engines that do not report timings per token:
 *  generated tokens over the time between the first and the latest token (excludes prompt time). */
export class ArrivalRate {
  private first = 0;
  private n = 0;
  tick(tokens = 1): number | null {
    const t = performance.now();
    if (!this.first) {
      this.first = t;
      return null;
    }
    this.n += tokens;
    const dt = (t - this.first) / 1000;
    return dt > 0.25 ? this.n / dt : null;
  }
}
