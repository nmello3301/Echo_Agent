import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { clip, run, text, withImages } from "./util.ts";

const NOISE = /^(Godot Engine v|WARNING: .*(Vulkan|OpenGL|ALSA|PulseAudio|joypad)|\s*at: .*(drivers|platform)\/|OpenGL API|Vulkan \d|$)/;
const clean = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").split("\n").filter((l) => !NOISE.test(l)).join("\n").trim();

function project(cwd: string, p?: string): string {
  const dir = path.resolve(cwd, p ?? ".");
  if (!existsSync(path.join(dir, "project.godot"))) throw new Error(`${dir} has no project.godot`);
  return dir;
}

function gdFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") || e.name === "addons") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) gdFiles(p, out);
    else if (e.name.endsWith(".gd")) out.push(p);
  }
  return out;
}

/** Parse GDScript files and report errors. Also used by code_diagnostics. */
export async function godotCheck(dir: string, files?: string[]) {
  const list = (files ?? gdFiles(dir)).slice(0, 60);
  const problems: string[] = [];
  for (const f of list) {
    const r = await run("godot", ["--headless", "--path", dir, "--check-only", "--script", f], { timeoutMs: 60_000 });
    const out = clean(`${r.stdout}\n${r.stderr}`);
    if (r.code !== 0 || /ERROR|Parse Error/i.test(out)) problems.push(`${path.relative(dir, f)}:\n${clip(out, 1200)}`);
  }
  return { checked: list.length, problems };
}

export function godotTools(cwd: string) {
  return [
    {
      name: "godot_check",
      label: "Godot check",
      description: "Parse the project's GDScript files (or the given ones) and report errors, without running the game.",
      parameters: Type.Object({ project: Type.Optional(Type.String({ description: "Folder with project.godot; default the working folder" })), files: Type.Optional(Type.Array(Type.String())) }),
      execute: async (_id: string, p: { project?: string; files?: string[] }) => {
        const dir = project(cwd, p.project);
        const r = await godotCheck(dir, p.files?.map((f) => path.resolve(dir, f)));
        return text(r.problems.length ? `${r.problems.length} of ${r.checked} scripts have errors:\n\n${r.problems.join("\n\n")}` : `All ${r.checked} scripts parse cleanly.`);
      },
    },
    {
      name: "godot_run",
      label: "Godot run",
      description: "Run the project (or one scene) headless for some frames and return its output: prints, errors and warnings. Use it to test game logic.",
      parameters: Type.Object({
        project: Type.Optional(Type.String()),
        scene: Type.Optional(Type.String({ description: "res:// path or file path of a scene; default the main scene" })),
        frames: Type.Optional(Type.Number({ description: "Iterations before quitting, default 300 (~5 s at 60 fps)" })),
        script: Type.Optional(Type.String({ description: "Run this script instead (e.g. a test runner such as GUT's cli)" })),
        args: Type.Optional(Type.Array(Type.String(), { description: "Extra user arguments, passed after --" })),
      }),
      execute: async (_id: string, p: { project?: string; scene?: string; frames?: number; script?: string; args?: string[] }, signal?: AbortSignal) => {
        const dir = project(cwd, p.project);
        const a = ["--headless", "--path", dir];
        if (p.script) a.push("--script", p.script);
        else a.push("--quit-after", String(p.frames ?? 300));
        if (p.scene && !p.script) a.push(p.scene);
        if (p.args?.length) a.push("--", ...p.args);
        const r = await run("godot", a, { signal });
        return text(`exit code ${r.code}\n${clip(clean(`${r.stdout}\n${r.stderr}`), 7000) || "(no output)"}`);
      },
    },
    {
      name: "godot_screenshot",
      label: "Godot screenshot",
      description: "Render a scene for a moment and look at the final frame (uses Godot's movie writer; a game window opens briefly).",
      parameters: Type.Object({
        project: Type.Optional(Type.String()),
        scene: Type.Optional(Type.String()),
        frames: Type.Optional(Type.Number({ description: "Frames to simulate before the shot, default 60" })),
        resolution: Type.Optional(Type.String({ description: "WxH, default 1280x720" })),
      }),
      execute: async (_id: string, p: { project?: string; scene?: string; frames?: number; resolution?: string }, signal?: AbortSignal) => {
        const dir = project(cwd, p.project);
        const shots = path.join(cwd, ".echo", "godot", `run-${Date.now()}`);
        mkdirSync(shots, { recursive: true });
        const frames = Math.max(2, p.frames ?? 60);
        const a = ["--path", dir, "--write-movie", path.join(shots, "frame.png"), "--fixed-fps", "30", "--quit-after", String(frames),
          "--resolution", p.resolution ?? "1280x720", "--position", "0,0"];
        if (p.scene) a.push(p.scene);
        const r = await run("godot", a, { signal });
        const pngs = readdirSync(shots).filter((f) => f.endsWith(".png")).sort();
        if (!pngs.length) return text(`No frames were written (exit ${r.code}):\n${clip(clean(`${r.stdout}\n${r.stderr}`), 4000)}`);
        const last = path.join(shots, pngs[pngs.length - 1]);
        for (const f of readdirSync(shots)) if (path.join(shots, f) !== last) rmSync(path.join(shots, f));
        const log = clip(clean(`${r.stdout}\n${r.stderr}`), 2000);
        return withImages(`Frame ${pngs.length} of the scene (${last}).${log ? `\nOutput:\n${log}` : ""}`, [last]);
      },
    },
    {
      name: "godot_export",
      label: "Godot export",
      description: "Export the project with a preset from export_presets.cfg (release by default).",
      parameters: Type.Object({
        project: Type.Optional(Type.String()),
        preset: Type.String(),
        output: Type.String({ description: "Output file path, e.g. build/game.x86_64" }),
        debug: Type.Optional(Type.Boolean()),
      }),
      execute: async (_id: string, p: { project?: string; preset: string; output: string; debug?: boolean }, signal?: AbortSignal) => {
        const dir = project(cwd, p.project);
        const out = path.resolve(cwd, p.output);
        mkdirSync(path.dirname(out), { recursive: true });
        const r = await run("godot", ["--headless", "--path", dir, p.debug ? "--export-debug" : "--export-release", p.preset, out], { signal });
        const ok = existsSync(out) ? `Wrote ${out} (${(statSync(out).size / 1e6).toFixed(1)} MB).` : "No output file was written.";
        return text(`${ok}\nexit code ${r.code}\n${clip(clean(`${r.stdout}\n${r.stderr}`), 4000)}`);
      },
    },
  ];
}
