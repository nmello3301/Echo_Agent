import type { MainModel } from "./config.ts";
import { type StreamResult, streamChat } from "./llm.ts";
import { fetchPage, webSearch } from "./tools/web.ts";

export interface WebSource {
  n: number;
  title: string;
  url: string;
}

// Chat's own definitions of the agent's web tools (tools/web.ts), in the OpenAI format llama-server and Strata take
const TOOLS = [
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web. Returns numbered results with title, URL and snippet.",
      parameters: { type: "object", properties: { query: { type: "string", description: "Search terms" } }, required: ["query"] },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_page",
      description: "Read a web page or PDF as clean text. Pass `question` to get only the parts relevant to it.",
      parameters: {
        type: "object",
        properties: { url: { type: "string" }, question: { type: "string", description: "What you are looking for on the page" } },
        required: ["url"],
      },
    },
  },
];

const MAX_ROUNDS = 6; // model turns that may call tools; the next one must answer

function systemPrompt() {
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  return `Today is ${today}. You can search the web with web_search and read pages with fetch_page.
- Search when the question needs current, local or specific facts you are not sure of; answer directly when it does not.
- Snippets are often stale or partial: read the best one or two pages before answering.
- Cite sources inline by their numbers, like [1] or [2][3]. Never cite a number you were not given.`;
}

/** Cited source numbers in an answer: [3], [2][3] and [2, 3] all count. */
function citedNumbers(text: string): Set<number> {
  const out = new Set<number>();
  for (const m of text.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) for (const n of m[1].split(",")) out.add(Number(n));
  return out;
}

/** Chat with web_search and fetch_page. The model decides when to search; Echo runs the tools and feeds the results
 *  back until the model answers without a tool call. Sources are numbered from `firstSource` (after any notes
 *  sources) and keep their number for the whole answer. Content from every round is joined, as the user saw it. */
export async function chatWithWeb(
  model: MainModel,
  body: { messages: any[] } & Record<string, unknown>,
  onDelta: (d: { content?: string; reasoning?: string }) => void,
  onStatus: (text: string) => void,
  signal: AbortSignal,
  firstSource = 1,
): Promise<StreamResult & { sources: WebSource[]; searches: string[] }> {
  const messages: any[] = [{ role: "system", content: systemPrompt() }, ...body.messages];
  const sources = new Map<string, WebSource>();
  const read = new Set<number>();
  const searches: string[] = [];
  const num = (title: string, url: string) => {
    let s = sources.get(url);
    if (!s) sources.set(url, (s = { n: firstSource + sources.size, title, url }));
    return s.n;
  };
  let content = "";
  let reasoning = "";
  let ttftMs: number | null = null;
  let res: StreamResult;
  for (let round = 0; ; round++) {
    const last = round === MAX_ROUNDS;
    if (last) messages.push({ role: "user", content: "Search limit reached: answer now from the results above." });
    let gap = !!content; // separate this round's text from the previous round's
    res = await streamChat(model, { ...body, messages, ...(last ? {} : { tools: TOOLS }) }, (d) => {
      if (d.content && gap) {
        onDelta({ content: "\n\n" });
        gap = false;
      }
      onDelta(d);
    }, signal, "chat");
    ttftMs ??= res.ttftMs;
    if (res.content) content = content ? `${content}\n\n${res.content}` : res.content;
    if (res.reasoning) reasoning = reasoning ? `${reasoning}\n\n${res.reasoning}` : res.reasoning;
    if (res.aborted || !res.toolCalls.length) break;

    messages.push({ role: "assistant", content: res.content || null, reasoning_content: res.reasoning || undefined, tool_calls: res.toolCalls });
    for (const tc of res.toolCalls) {
      let args: { query?: string; url?: string; question?: string } = {};
      try {
        args = JSON.parse(tc.function.arguments || "{}");
      } catch {}
      let out: string;
      try {
        if (tc.function.name === "web_search") {
          const q = String(args.query ?? "");
          onStatus(`Searching: ${q}`);
          searches.push(q);
          const hits = await webSearch(q, 6);
          out = hits.length ? hits.map((h) => `[${num(h.title, h.url)}] ${h.title}\n${h.url}\n${(h.content ?? "").slice(0, 300)}`).join("\n\n") : "No results.";
        } else if (tc.function.name === "fetch_page") {
          const url = String(args.url ?? "");
          onStatus(`Reading ${URL.canParse(url) ? new URL(url).hostname : url}`);
          const page = await fetchPage(url, args.question, 6000);
          const n = num(page.title, url);
          read.add(n);
          out = `[${n}] ${page.title}\n${url}\n\n${page.text}`;
        } else out = `Unknown tool: ${tc.function.name}`;
      } catch (e) {
        out = `Error: ${(e as Error).message}`;
      }
      messages.push({ role: "tool", tool_call_id: tc.id, content: out });
    }
    if (signal.aborted) break;
  }
  // list the sources the answer cites; if it cites none, the pages it read
  const cited = citedNumbers(content);
  const shown = [...sources.values()].filter((s) => (cited.size ? cited.has(s.n) : read.has(s.n)));
  return { ...res, content, reasoning, ttftMs, toolCalls: [], sources: shown, searches };
}
