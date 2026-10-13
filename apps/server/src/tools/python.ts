import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { Type } from "typebox";
import { ROOT } from "../config.ts";
import { bwrapArgs, clip, withImages } from "./util.ts";

const PY = path.join(ROOT, "services/pyworkspace/.venv/bin/python");
const KERNEL = path.join(ROOT, "services/pyworkspace/kernel.py");

interface Reply { stdout: string; stderr: string; result: string | null; error: string | null; figures: string[] }

/** One persistent Python process per agent run, sandboxed to the working folder. */
export class PythonWorkspace {
  private proc: ChildProcess | undefined;
  private buf = "";
  private waiting: ((r: Reply) => void) | undefined;
  private cwd: string;
  constructor(cwd: string) {
    this.cwd = cwd;
  }

  private start() {
    const plots = path.join(this.cwd, ".echo", "plots");
    this.proc = spawn("bwrap", [...bwrapArgs(this.cwd), PY, "-u", KERNEL, plots], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, MPLBACKEND: "Agg", MPLCONFIGDIR: "/tmp/mpl" },
    });
    this.proc.stdout!.on("data", (b: Buffer) => {
      this.buf += b.toString();
      let i: number;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        try {
          const r = JSON.parse(line) as Reply;
          const w = this.waiting;
          this.waiting = undefined;
          w?.(r);
        } catch {}
      }
    });
    let err = "";
    this.proc.stderr!.on("data", (b: Buffer) => (err += b.toString()).length > 20000 && (err = err.slice(-10000)));
    this.proc.on("exit", () => {
      this.proc = undefined;
      const w = this.waiting;
      this.waiting = undefined;
      w?.({ stdout: "", stderr: err, result: null, error: "The Python workspace stopped (state was lost). It restarts on the next call.", figures: [] });
    });
  }

  exec(code: string, signal?: AbortSignal): Promise<Reply> {
    if (!this.proc) this.start();
    return new Promise((resolve) => {
      this.waiting = resolve;
      signal?.addEventListener("abort", () => this.reset(), { once: true });
      this.proc!.stdin!.write(`${JSON.stringify({ code })}\n`);
    });
  }

  reset() {
    this.proc?.kill("SIGKILL");
    this.proc = undefined;
  }
}

export function pythonTools(ws: PythonWorkspace) {
  return [
    {
      name: "python",
      label: "Python",
      description:
        "Run Python in a persistent workspace (variables survive between calls). Preloaded: np (numpy), scipy, sp (sympy), " +
        "ureg/Q_ (pint units), plt (matplotlib). Use it for every calculation instead of doing math in your head. " +
        "The value of the last expression is returned; open matplotlib figures are saved and shown to you.",
      parameters: Type.Object({
        code: Type.String(),
        reset: Type.Optional(Type.Boolean({ description: "Start a fresh workspace first" })),
      }),
      execute: async (_id: string, p: { code: string; reset?: boolean }, signal?: AbortSignal) => {
        if (p.reset) ws.reset();
        const r = await ws.exec(p.code, signal);
        const parts = [
          r.stdout && `stdout:\n${clip(r.stdout, 4000)}`,
          r.result !== null && `result: ${clip(r.result, 2000)}`,
          r.stderr && `stderr:\n${clip(r.stderr, 1500)}`,
          r.error && `error:\n${clip(r.error, 2500)}`,
          r.figures.length && `figures: ${r.figures.join(", ")}`,
        ].filter(Boolean);
        return withImages(parts.join("\n\n") || "(no output)", r.figures.slice(0, 3));
      },
    },
  ];
}
