import { mkdirSync } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { run, withImages } from "./util.ts";

interface Client { class: string; title: string; at: [number, number]; size: [number, number]; mapped: boolean; hidden: boolean; workspace: { id: number } }

const NO_FRAME = "the screen produced no frame in 15 s (it is probably locked or switched off); try again when the display is on";

async function hypr<T>(what: string): Promise<T> {
  const r = await run("hyprctl", [what, "-j"]);
  return JSON.parse(r.stdout) as T;
}

/** Capture the screen, the active window, or a window matched by class/title. Scaled so the long side ≤ maxSide. */
export async function screenshot(outDir: string, target = "screen", maxSide = 1280): Promise<{ file: string; what: string }> {
  mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `shot-${Date.now()}.png`);
  let geom: string | undefined;
  let what = "focused monitor";
  let w = 0;
  let h = 0;
  if (target === "active") {
    const c = await hypr<Client>("activewindow");
    geom = `${c.at[0]},${c.at[1]} ${c.size[0]}x${c.size[1]}`;
    [w, h] = c.size;
    what = `active window: ${c.class} — ${c.title}`;
  } else if (target !== "screen") {
    const needle = target.toLowerCase();
    const clients = (await hypr<Client[]>("clients")).filter((c) => c.mapped && !c.hidden);
    const c = clients.find((x) => x.class.toLowerCase() === needle) ?? clients.find((x) => `${x.class} ${x.title}`.toLowerCase().includes(needle));
    if (!c) throw new Error(`no window matches "${target}". Open windows: ${clients.map((x) => `${x.class} (${x.title.slice(0, 40)})`).join("; ")}`);
    const active = await hypr<{ id: number }>("activeworkspace");
    if (c.workspace.id !== active.id) throw new Error(`"${c.class}" is on workspace ${c.workspace.id}, not the visible one; it cannot be captured without switching workspaces.`);
    geom = `${c.at[0]},${c.at[1]} ${c.size[0]}x${c.size[1]}`;
    [w, h] = c.size;
    what = `window: ${c.class} — ${c.title}`;
  } else {
    const mons = await hypr<{ name: string; focused: boolean; width: number; height: number; scale: number }[]>("monitors");
    const m = mons.find((x) => x.focused) ?? mons[0];
    w = m.width / m.scale;
    h = m.height / m.scale;
    what = `monitor ${m.name}`;
    const scale = Math.min(1, maxSide / Math.max(w, h));
    const r = await run("grim", ["-o", m.name, "-s", scale.toFixed(3), file], { timeoutMs: 15_000 });
    if (r.timedOut) throw new Error(NO_FRAME);
    if (r.code !== 0) throw new Error(r.stderr);
    return { file, what };
  }
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const r = await run("grim", ["-g", geom!, "-s", scale.toFixed(3), file], { timeoutMs: 15_000 });
  if (r.timedOut) throw new Error(NO_FRAME);
  if (r.code !== 0) throw new Error(r.stderr);
  return { file, what };
}

export function visionTools(cwd: string) {
  return [
    {
      name: "screenshot",
      label: "Screenshot",
      description:
        "Take a screenshot and look at it. target: 'screen' (focused monitor), 'active' (focused window), or part of a " +
        "window's class or title (e.g. 'blender', 'godot', 'firefox'). Use it to check UIs, renders and running apps " +
        "instead of assuming. To look at an image file, use read on it.",
      parameters: Type.Object({ target: Type.Optional(Type.String({ description: "screen | active | window class/title" })) }),
      execute: async (_id: string, p: { target?: string }) => {
        const s = await screenshot(path.join(cwd, ".echo", "shots"), p.target ?? "screen");
        return withImages(`Screenshot of the ${s.what}, saved to ${s.file}.`, [s.file]);
      },
    },
  ];
}
