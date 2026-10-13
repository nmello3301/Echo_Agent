import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { focus } from "./web.ts";
import { run, text } from "./util.ts";

async function ocrFile(img: string, lang: string) {
  if (!existsSync(img)) throw new Error(`no such file: ${img}`);
  const r = await run("tesseract", [img, "-", "-l", lang, "--psm", "3"]);
  return r.stdout;
}

/** Text of a PDF; scanned pages (no text layer) are OCR'd with Tesseract. */
export async function pdfText(file: string, opts: { first?: number; last?: number; ocr?: "auto" | "on" | "off"; lang?: string } = {}) {
  if (!existsSync(file)) throw new Error(`no such file: ${file}`);
  const range = [...(opts.first ? ["-f", String(opts.first)] : []), ...(opts.last ? ["-l", String(opts.last)] : [])];
  const info = await run("pdfinfo", [file]);
  const pages = Number(/Pages:\s+(\d+)/.exec(info.stdout)?.[1] ?? 0);
  let body = opts.ocr === "on" ? "" : (await run("pdftotext", ["-layout", ...range, file, "-"])).stdout;
  const n = (opts.last ?? pages) - (opts.first ?? 1) + 1;
  const sparse = body.replace(/\s/g, "").length < 80 * Math.max(1, n);
  let ocrUsed = false;
  if (opts.ocr === "on" || (opts.ocr !== "off" && sparse)) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "echo-ocr-"));
    try {
      await run("pdftoppm", ["-r", "200", "-gray", "-png", ...range, file, path.join(dir, "p")]);
      const imgs = readdirSync(dir).filter((f) => f.endsWith(".png")).sort();
      const parts: string[] = [];
      for (const [i, f] of imgs.entries()) parts.push(`--- page ${(opts.first ?? 1) + i} (OCR) ---\n${await ocrFile(path.join(dir, f), opts.lang ?? "eng")}`);
      body = parts.join("\n");
      ocrUsed = true;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return { pages, text: body, ocrUsed };
}

export function pdfTools(cwd: string) {
  return [
    {
      name: "pdf_text",
      label: "PDF text",
      description:
        "Extract text from a PDF (datasheets, papers, manuals). Scanned pages are OCR'd automatically. " +
        "Pass `question` to get only the relevant parts; pass first/last to limit pages.",
      parameters: Type.Object({
        path: Type.String(),
        question: Type.Optional(Type.String()),
        first: Type.Optional(Type.Number()),
        last: Type.Optional(Type.Number()),
        ocr: Type.Optional(Type.String({ description: "auto (default) | on | off" })),
        max_chars: Type.Optional(Type.Number({ description: "Default 8000" })),
      }),
      execute: async (_id: string, p: { path: string; question?: string; first?: number; last?: number; ocr?: string; max_chars?: number }) => {
        const f = path.resolve(cwd, p.path);
        const r = await pdfText(f, { first: p.first, last: p.last, ocr: (p.ocr as any) ?? "auto" });
        return text(`${path.basename(f)}: ${r.pages} pages${r.ocrUsed ? " (OCR)" : ""}\n\n${focus(r.text, p.question, p.max_chars ?? 8000)}`);
      },
    },
    {
      name: "ocr_image",
      label: "OCR image",
      description: "Read the text in an image (photo of a label, scanned page, screenshot) with Tesseract. For understanding pictures, use read or screenshot instead.",
      parameters: Type.Object({ path: Type.String(), lang: Type.Optional(Type.String({ description: "Tesseract language, default eng" })) }),
      execute: async (_id: string, p: { path: string; lang?: string }) => text((await ocrFile(path.resolve(cwd, p.path), p.lang ?? "eng")).trim() || "(no text found)"),
    },
  ];
}
