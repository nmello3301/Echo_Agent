import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { Type } from "typebox";
import { config, dockerEnv } from "../config.ts";
import { clip, run, text } from "./util.ts";

export const SEARX_URL = () => dockerEnv.searchUrl ?? `http://127.0.0.1:${config.echo.ports.search ?? 8888}`;

export async function webSearch(query: string, n = 6) {
  const r = await fetch(`${SEARX_URL()}/search?q=${encodeURIComponent(query)}&format=json`, { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`search engine answered ${r.status}`);
  const j = (await r.json()) as { results: { title: string; url: string; content?: string }[] };
  const seen = new Set<string>();
  return j.results.filter((x) => !seen.has(x.url) && seen.add(x.url)).slice(0, n);
}

const words = (s: string) => s.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? [];

/** Split text into ~paragraph chunks and keep the ones that best match the question, in page order. */
export function focus(body: string, question: string | undefined, budget: number): string {
  if (body.length <= budget || !question) return clip(body, budget);
  // passage size follows the budget, so several passages fit; long paragraphs are split too
  const size = Math.max(200, Math.min(900, Math.floor(budget / 5)));
  const paras = body.split(/\n{2,}/).flatMap((p) => (p.length <= size ? [p] : p.match(new RegExp(`[\\s\\S]{1,${size}}(?=\\s|$)`, "g")) ?? [p]));
  const chunks: string[] = [];
  let cur = "";
  for (const para of paras) {
    if ((cur + para).length > size && cur) {
      chunks.push(cur);
      cur = "";
    }
    cur += `${para}\n\n`;
  }
  if (cur) chunks.push(cur);
  const q = new Set(words(question));
  const df = new Map<string, number>();
  for (const c of chunks) for (const w of new Set(words(c))) df.set(w, (df.get(w) ?? 0) + 1);
  const scored = chunks.map((c, i) => {
    const ws = words(c);
    let s = 0;
    for (const w of ws) if (q.has(w)) s += Math.log(1 + chunks.length / (df.get(w) ?? 1));
    return { i, c, s: s / Math.sqrt(ws.length + 10) };
  });
  chunks[0] = chunks[0].length > size / 2 ? `${chunks[0].slice(0, Math.floor(size / 2))}…` : chunks[0]; // the opening says what the page is
  const keep = new Set<number>([0]);
  let used = chunks[0].length;
  for (const x of [...scored].sort((a, b) => b.s - a.s)) {
    if (x.s <= 0 || used + x.c.length > budget) continue;
    keep.add(x.i);
    used += x.c.length;
  }
  const out: string[] = [];
  let prev = -1;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (prev >= 0 && i !== prev + 1) out.push("[…]");
    out.push(chunks[i].trim());
    prev = i;
  }
  return `${out.join("\n\n")}\n\n[Showing the parts most relevant to "${question}" — ${body.length} characters in the full page. Call again with another question for other parts.]`;
}

export function htmlToText(html: string, url: string): { title: string; text: string } {
  const { document } = parseHTML(html);
  const article = new Readability(document as any, { charThreshold: 200 }).parse();
  const root = parseHTML(`<html><body>${article?.content ?? html}</body></html>`).document;
  root.querySelectorAll("script,style,nav,footer,svg,noscript").forEach((n: any) => n.remove());
  // keep structure: headings, list items, code blocks and paragraphs on their own lines
  root.querySelectorAll("h1,h2,h3,h4").forEach((h: any) => (h.textContent = `\n\n## ${h.textContent.trim()}\n\n`));
  root.querySelectorAll("li").forEach((li: any) => (li.textContent = `\n- ${li.textContent.trim()}`));
  root.querySelectorAll("pre").forEach((p: any) => (p.textContent = `\n\n\`\`\`\n${p.textContent}\n\`\`\`\n\n`));
  root.querySelectorAll("p,div,br,tr").forEach((p: any) => p.append?.("\n\n"));
  const t = (root.body?.textContent ?? "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { title: article?.title ?? url, text: t };
}

export async function fetchPage(url: string, question?: string, budget = 6000) {
  const r = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) Echo/0.1", Accept: "text/html,application/pdf,text/plain;q=0.9,*/*;q=0.5" },
    redirect: "follow",
    signal: AbortSignal.timeout(45_000),
  });
  if (!r.ok) throw new Error(`${url} answered ${r.status}`);
  const type = r.headers.get("content-type") ?? "";
  if (type.includes("pdf") || url.toLowerCase().endsWith(".pdf")) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "echo-pdf-"));
    try {
      const f = path.join(dir, "doc.pdf");
      writeFileSync(f, Buffer.from(await r.arrayBuffer()));
      const t = await run("pdftotext", ["-layout", f, "-"]);
      return { title: url, text: focus(t.stdout, question, budget) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const body = await r.text();
  const page = type.includes("html") || /^\s*</.test(body) ? htmlToText(body, url) : { title: url, text: body };
  return { title: page.title, text: focus(page.text, question, budget) };
}

export function webTools() {
  return [
    {
      name: "web_search",
      label: "Web search",
      description: "Search the web (local SearXNG). Returns titles, URLs and snippets. Then use fetch_page on the best result.",
      parameters: Type.Object({
        query: Type.String({ description: "Search terms" }),
        count: Type.Optional(Type.Number({ description: "Results to return, default 6" })),
      }),
      execute: async (_id: string, p: { query: string; count?: number }) => {
        const res = await webSearch(p.query, p.count ?? 6);
        if (!res.length) return text("No results.");
        return text(res.map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${(x.content ?? "").slice(0, 220)}`).join("\n"));
      },
    },
    {
      name: "fetch_page",
      label: "Fetch page",
      description: "Read a web page or PDF URL as clean text. Pass `question` to get only the parts relevant to it (keeps context small).",
      parameters: Type.Object({
        url: Type.String(),
        question: Type.Optional(Type.String({ description: "What you are looking for on the page" })),
        max_chars: Type.Optional(Type.Number({ description: "Default 6000" })),
      }),
      execute: async (_id: string, p: { url: string; question?: string; max_chars?: number }) => {
        const page = await fetchPage(p.url, p.question, p.max_chars ?? 6000);
        return text(`# ${page.title}\n${p.url}\n\n${page.text}`);
      },
    },
  ];
}
