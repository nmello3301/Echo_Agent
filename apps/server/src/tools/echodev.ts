// Tools for runs whose working folder is a working copy of Echo: verify it, run it as a dev instance, call it.
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { config } from "../config.ts";
import { dev, type VerifyStep, verify } from "../selfdev.ts";
import { clip, text } from "./util.ts";

const ms = (t0: number) => Math.round(performance.now() - t0);

/** Duration of a PCM WAV body, from its header (or the byte count when a streamed header leaves the size open). */
export function wavInfo(b: Buffer): string | undefined {
  if (b.length < 44 || b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE") return undefined;
  let i = 12;
  let rate = 0;
  let channels = 0;
  let bits = 0;
  while (i + 8 <= b.length) {
    const id = b.toString("ascii", i, i + 4);
    const size = b.readUInt32LE(i + 4);
    if (id === "fmt ") {
      channels = b.readUInt16LE(i + 10);
      rate = b.readUInt32LE(i + 12);
      bits = b.readUInt16LE(i + 22);
    } else if (id === "data") {
      const bytes = size === 0 || size === 0xffffffff || i + 8 + size > b.length ? b.length - i - 8 : size;
      const secs = rate && channels && bits ? bytes / (rate * channels * (bits / 8)) : 0;
      return `WAV ${rate} Hz, ${channels} ch, ${bits}-bit, ${secs.toFixed(2)} s of audio`;
    }
    i += 8 + size + (size % 2);
  }
  return undefined;
}

function inside(root: string, p: string): string {
  const full = path.resolve(root, p);
  if (full !== root && !full.startsWith(`${root}/`)) throw new Error(`${p} is outside the working copy`);
  return full;
}

export function echoDevTools(root: string) {
  return [
    {
      name: "echo_verify",
      label: "Verify Echo",
      description:
        "Check your working copy of Echo: typecheck the server and the web UI (tsc), run the server tests (node --test) and " +
        "syntax-check the Python services. Returns a one-line result per step and only the failures. Run it after each batch " +
        "of edits and before saying a change works. `only` limits it to some steps.",
      parameters: Type.Object({
        only: Type.Optional(Type.Array(Type.Union([Type.Literal("server"), Type.Literal("web"), Type.Literal("tests"), Type.Literal("python")]))),
      }),
      execute: async (_id: string, p: { only?: VerifyStep[] }) => {
        const r = await verify(root, p.only);
        return text(`${r.ok ? "All checks passed." : "Some checks failed."}\n${r.report}`);
      },
    },
    {
      name: "echo_dev",
      label: "Echo dev instance",
      description:
        "Run your working copy of Echo as a dev instance beside the live Echo: sandboxed, on its own ports (UI 8777, TTS 9095, " +
        "every port in echo.yaml + 1000) and using the live Echo's model, decision model and notes search. " +
        "action: start or restart (rebuilds the web UI unless build_ui is false, ~10-20 s, then starts the server), stop, status, " +
        "logs (its output; `lines`, default 60). Restart after changing server or service code. The user opens it at " +
        `http://dev.localhost:${config.echo.ports.ui}. Never start Echo or other servers with bash: bash waits for them to exit.`,
      parameters: Type.Object({
        action: Type.Union([Type.Literal("start"), Type.Literal("restart"), Type.Literal("stop"), Type.Literal("status"), Type.Literal("logs")]),
        build_ui: Type.Optional(Type.Boolean({ description: "Rebuild the web UI first (default true)" })),
        lines: Type.Optional(Type.Number()),
      }),
      execute: async (_id: string, p: { action: string; build_ui?: boolean; lines?: number }) => {
        if (p.action === "stop") {
          await dev.stop();
          return text("Dev instance stopped.");
        }
        if (p.action === "status") return text(JSON.stringify(dev.info(), null, 1));
        if (p.action === "logs") return text(clip(dev.tail(p.lines ?? 60) || "(no output yet)", 8000));
        try {
          const info = await dev.start(root, { buildUi: p.build_ui });
          return text(
            `Dev instance ready in ${((info.readyMs ?? 0) / 1000).toFixed(1)} s on port ${info.port} (call it with echo_dev_request; ` +
            `the user sees it at ${info.url}).\nLast log lines:\n${dev.tail(15)}`,
          );
        } catch (e) {
          throw new Error(`Dev instance failed to start: ${(e as Error).message}`);
        }
      },
    },
    {
      name: "echo_dev_request",
      label: "Call the dev instance",
      description:
        "Send an HTTP request to your running dev instance (see echo_dev) and time it. Reports the status, time to the response " +
        "headers, time to the first body bytes and total time, then the body: JSON or text (clipped), server-sent events with the " +
        "time each arrived, audio as its size and length. Use it to test endpoints you add and to measure latency. body_file sends " +
        "a file from the working copy (e.g. a WAV recording); save_to writes the response body into the working copy (e.g. TTS " +
        "audio to feed into a speech-to-text test).",
      parameters: Type.Object({
        path: Type.String({ description: "Path and query string, e.g. /api/models" }),
        method: Type.Optional(Type.String({ description: "GET (default), POST, PUT, PATCH or DELETE" })),
        json: Type.Optional(Type.Any({ description: "JSON body (sets Content-Type: application/json)" })),
        body_file: Type.Optional(Type.String({ description: "Path in the working copy to send as the body" })),
        content_type: Type.Optional(Type.String({ description: "Content-Type for body_file" })),
        save_to: Type.Optional(Type.String({ description: "Path in the working copy to write the response body to" })),
        timeout_s: Type.Optional(Type.Number({ description: "Give up after this many seconds (default 120)" })),
        max_chars: Type.Optional(Type.Number({ description: "Clip text bodies to this many characters (default 3000)" })),
      }),
      execute: async (_id: string, p: { path: string; method?: string; json?: unknown; body_file?: string; content_type?: string; save_to?: string; timeout_s?: number; max_chars?: number }) => {
        if (dev.status !== "ready") throw new Error(`The dev instance is not running (status: ${dev.status}). Start it with echo_dev.`);
        const method = (p.method ?? (p.json !== undefined || p.body_file ? "POST" : "GET")).toUpperCase();
        const headers: Record<string, string> = {};
        let body: Uint8Array<ArrayBuffer> | string | undefined;
        if (p.json !== undefined) {
          headers["Content-Type"] = "application/json";
          body = JSON.stringify(p.json);
        } else if (p.body_file) {
          body = new Uint8Array(readFileSync(inside(root, p.body_file)));
          headers["Content-Type"] = p.content_type ?? "application/octet-stream";
        }
        const url = `http://127.0.0.1:${dev.port}${p.path.startsWith("/") ? p.path : `/${p.path}`}`;
        const t0 = performance.now();
        let res: Response;
        try {
          res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout((p.timeout_s ?? 120) * 1000) });
        } catch (e) {
          throw new Error(`${method} ${p.path} failed after ${ms(t0)} ms: ${(e as Error).message}`);
        }
        const headersMs = ms(t0);
        const type = res.headers.get("content-type") ?? "";
        const sse = type.includes("text/event-stream");
        const chunks: Buffer[] = [];
        const events: string[] = [];
        let firstByteMs: number | undefined;
        let size = 0;
        let pending = "";
        let timedOut = false;
        try {
          const reader = res.body?.getReader();
          for (;;) {
            if (!reader) break;
            const { value, done } = await reader.read();
            if (done) break;
            firstByteMs ??= ms(t0);
            size += value.length;
            if (size < 64 * 1024 * 1024) chunks.push(Buffer.from(value));
            if (sse) {
              pending += Buffer.from(value).toString();
              let i: number;
              while ((i = pending.indexOf("\n\n")) >= 0) {
                const block = pending.slice(0, i).replace(/\n/g, " ");
                pending = pending.slice(i + 2);
                if (block.trim()) events.push(`+${ms(t0)} ms  ${block.length > 220 ? `${block.slice(0, 220)}…` : block}`);
              }
            }
          }
        } catch (e) {
          timedOut = (e as Error).name === "TimeoutError" || (e as Error).name === "AbortError";
          if (!timedOut) throw e;
        }
        const totalMs = ms(t0);
        const buf = Buffer.concat(chunks);
        const lines = [
          `${method} ${p.path} → ${res.status} ${res.statusText} (${type || "no content type"})`,
          `headers after ${headersMs} ms, first body bytes after ${firstByteMs ?? "-"} ms, done after ${totalMs} ms${timedOut ? " (timed out, body incomplete)" : ""}; ${size} bytes in ${chunks.length} chunks`,
        ];
        if (p.save_to) {
          const out = inside(root, p.save_to);
          mkdirSync(path.dirname(out), { recursive: true });
          writeFileSync(out, buf);
          lines.push(`saved to ${p.save_to} (${statSync(out).size} bytes)`);
        }
        const max = p.max_chars ?? 3000;
        if (sse) {
          lines.push(`${events.length} events:`);
          lines.push(...(events.length > 40 ? [...events.slice(0, 30), `… ${events.length - 40} more …`, ...events.slice(-10)] : events));
        } else if (/^audio\//.test(type) || wavInfo(buf)) {
          lines.push(wavInfo(buf) ?? `audio, ${size} bytes`);
        } else if (/json|text|xml|javascript/.test(type) || !type) {
          let s = buf.toString("utf8");
          if (type.includes("json")) {
            try {
              s = JSON.stringify(JSON.parse(s), null, 1);
            } catch {}
          }
          lines.push(clip(s, max));
        } else lines.push(`(binary body, ${size} bytes)`);
        return text(lines.join("\n"));
      },
    },
  ];
}
