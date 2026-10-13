import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { screenshot } from "./vision.ts";
import { clip, run, text, withImages } from "./util.ts";

const BRIDGE = { host: "127.0.0.1", port: 9876 }; // the Blender MCP Bridge add-on

/** Send one command to a running Blender through the MCP Bridge add-on (newline-delimited JSON). */
export function bridge(command: string, params: Record<string, unknown> = {}, timeoutMs = 0): Promise<any> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(BRIDGE);
    let buf = "";
    const done = (fn: () => void) => {
      sock.destroy();
      fn();
    };
    if (timeoutMs) sock.setTimeout(timeoutMs, () => done(() => reject(new Error("Blender did not answer in time"))));
    sock.on("connect", () => sock.write(`${JSON.stringify({ id: Date.now().toString(), command, params })}\n`));
    sock.on("data", (b) => {
      buf += b.toString();
      const i = buf.indexOf("\n");
      if (i < 0) return;
      const r = JSON.parse(buf.slice(0, i));
      done(() => (r.success ? resolve(r.result) : reject(new Error(r.error))));
    });
    sock.on("error", (e) => done(() => reject(e)));
  });
}

export async function liveBlender(): Promise<boolean> {
  try {
    await bridge("scene.get_info", {}, 1500);
    return true;
  } catch {
    return false;
  }
}

const WRAPPER = `
import bpy, json, sys, io, contextlib, traceback
code = open(sys.argv[sys.argv.index("--") + 1]).read()
ns = {"bpy": bpy, "__name__": "__main__"}
out, err = io.StringIO(), None
with contextlib.redirect_stdout(out):
    try:
        exec(compile(code, "<echo>", "exec"), ns)
    except Exception:
        err = traceback.format_exc(limit=-3)
res = ns.get("result")
try:
    res = json.dumps(res)
except Exception:
    res = repr(res)
print("@@ECHO@@" + json.dumps({"stdout": out.getvalue(), "error": err, "result": res if "result" in ns else None}))
`;

/** Run bpy code headless (blender -b), optionally on a .blend file. */
export async function headless(code: string, blendFile?: string, signal?: AbortSignal) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "echo-blender-"));
  try {
    writeFileSync(path.join(dir, "wrapper.py"), WRAPPER);
    writeFileSync(path.join(dir, "code.py"), code);
    const args = ["-b", ...(blendFile ? [blendFile] : ["--factory-startup"]), "--python", path.join(dir, "wrapper.py"), "--", path.join(dir, "code.py")];
    const r = await run("blender", args, { signal });
    const line = r.stdout.split("\n").find((l) => l.startsWith("@@ECHO@@"));
    if (!line) return { stdout: "", error: `Blender exited (code ${r.code}) before running the code:\n${clip(r.stderr || r.stdout, 3000)}`, result: null };
    return JSON.parse(line.slice(8)) as { stdout: string; error: string | null; result: string | null };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SCENE_SUMMARY = `
import bpy
s = bpy.context.scene
objs = []
for o in s.objects:
    d = {"name": o.name, "type": o.type, "loc": [round(v, 3) for v in o.location],
         "rot_deg": [round(v * 57.29578, 1) for v in o.rotation_euler], "scale": [round(v, 3) for v in o.scale]}
    if o.type == "MESH":
        d["dims"] = [round(v, 3) for v in o.dimensions]
        d["verts"] = len(o.data.vertices)
        d["materials"] = [m.name for m in o.data.materials if m]
        d["modifiers"] = [m.type for m in o.modifiers]
    if o.parent:
        d["parent"] = o.parent.name
    if not o.visible_get():
        d["hidden"] = True
    objs.append(d)
result = {"file": bpy.data.filepath or "(unsaved)", "scene": s.name, "engine": s.render.engine,
          "frames": [s.frame_start, s.frame_end], "fps": s.render.fps,
          "resolution": [s.render.resolution_x, s.render.resolution_y],
          "camera": s.camera.name if s.camera else None, "unit_scale": s.unit_settings.scale_length,
          "units": s.unit_settings.system, "objects": objs[:200], "object_count": len(objs)}
`;

export const RENDER_PREVIEW = (out: string, w: number, h: number, frameAll: boolean) => `
import bpy, mathutils
s = bpy.context.scene
s.render.engine = "BLENDER_WORKBENCH"
s.display.shading.light = "STUDIO"
s.display.shading.color_type = "MATERIAL"
s.display.shading.show_cavity = True
s.render.resolution_x, s.render.resolution_y, s.render.resolution_percentage = ${w}, ${h}, 100
s.render.film_transparent = False
if ${frameAll ? "True" : "False"} or s.camera is None:
    objs = [o for o in s.objects if o.type in {"MESH", "CURVE", "SURFACE", "META", "FONT"} and o.visible_get()]
    pts = [o.matrix_world @ mathutils.Vector(c) for o in objs for c in o.bound_box] or [mathutils.Vector((0, 0, 0))]
    mn = mathutils.Vector([min(p[i] for p in pts) for i in range(3)])
    mx = mathutils.Vector([max(p[i] for p in pts) for i in range(3)])
    center, size = (mn + mx) / 2, max((mx - mn).length, 1e-3)
    cd = bpy.data.cameras.new("EchoPreviewCam")
    cam = bpy.data.objects.new("EchoPreviewCam", cd)
    s.collection.objects.link(cam)
    cam.location = center + mathutils.Vector((1, -1, 0.8)).normalized() * size * 1.7
    cam.rotation_euler = (center - cam.location).to_track_quat("-Z", "Y").to_euler()
    cd.clip_start, cd.clip_end = size / 1000, size * 50
    s.camera = cam
s.render.filepath = ${JSON.stringify(out)}
bpy.ops.render.render(write_still=True)
result = s.render.filepath
`;

const API_LOOKUP = (name: string) => `
import bpy, inspect
name = ${JSON.stringify(name)}
obj = eval(name, {"bpy": bpy})
lines = [name]
if hasattr(obj, "get_rna_type"):  # an operator
    rna = obj.get_rna_type()
    lines.append(rna.description)
    for p in rna.properties:
        if p.identifier == "rna_type":
            continue
        default = getattr(p, "default_array", None) if getattr(p, "is_array", False) else getattr(p, "default", None)
        enum = f" one of {[i.identifier for i in p.enum_items]}" if p.type == "ENUM" else ""
        lines.append(f"  {p.identifier}: {p.type} = {list(default) if default is not None and getattr(p, 'is_array', False) else default}{enum} — {p.description}")
elif hasattr(obj, "bl_rna"):  # a type
    lines.append(obj.bl_rna.description)
    lines.append("properties:")
    for p in obj.bl_rna.properties:
        lines.append(f"  {p.identifier}: {p.type}{' (read-only)' if p.is_readonly else ''} — {p.description}")
    lines.append("functions:")
    for f in obj.bl_rna.functions:
        args = ", ".join(p.identifier for p in f.parameters if not p.is_output)
        lines.append(f"  {f.identifier}({args}) — {f.description}")
else:
    lines.append(inspect.getdoc(obj) or repr(obj))
    lines += [f"  {n}" for n in dir(obj) if not n.startswith("_")][:200]
result = "\\n".join(lines)
`;

/** The bridge returns the namespace's __result__; Echo's convention is `result`. */
const liveCode = (code: string) => `${code}\ntry:\n    __result__ = result\nexcept NameError:\n    pass\n`;

function fmt(r: { stdout?: string; error?: string | null; result?: unknown }) {
  return [
    r.stdout && `stdout:\n${clip(String(r.stdout), 4000)}`,
    r.result !== null && r.result !== undefined && `result: ${clip(typeof r.result === "string" ? r.result : JSON.stringify(r.result), 4000)}`,
    r.error && `error:\n${clip(String(r.error), 3000)}`,
  ].filter(Boolean).join("\n\n") || "(no output)";
}

export function blenderTools(cwd: string) {
  const renders = path.join(cwd, ".echo", "renders");
  return [
    {
      name: "blender_python",
      label: "Blender Python",
      description:
        "Run bpy code in Blender. With Blender open and the MCP Bridge add-on running it runs live in your scene " +
        "(undoable); otherwise headless, on blend_file if given. Set `result = ...` to return a value. " +
        "After changing a scene, check it with blender_preview.",
      parameters: Type.Object({
        code: Type.String(),
        blend_file: Type.Optional(Type.String({ description: "Path to a .blend (headless mode). Save with bpy.ops.wm.save_mainfile() if you change it." })),
        mode: Type.Optional(Type.String({ description: "auto (default) | live | headless" })),
      }),
      execute: async (_id: string, p: { code: string; blend_file?: string; mode?: string }, signal?: AbortSignal) => {
        const live = p.mode === "live" || (p.mode !== "headless" && !p.blend_file && (await liveBlender()));
        if (live) {
          const r = await bridge("python.execute", { code: liveCode(p.code), timeout_seconds: 600 });
          return text(`[live Blender]\n${fmt({ stdout: r.stdout, error: r.error, result: r.result })}`);
        }
        const file = p.blend_file ? path.resolve(cwd, p.blend_file) : undefined;
        return text(`[headless${file ? `: ${file}` : ", empty scene"}]\n${fmt(await headless(p.code, file, signal))}`);
      },
    },
    {
      name: "blender_scene",
      label: "Blender scene",
      description: "Summarise a Blender scene: objects with transforms, dimensions, materials and modifiers, camera, units, frame range.",
      parameters: Type.Object({ blend_file: Type.Optional(Type.String({ description: "Omit to use the open Blender (live)" })) }),
      execute: async (_id: string, p: { blend_file?: string }, signal?: AbortSignal) => {
        if (!p.blend_file && (await liveBlender())) {
          const r = await bridge("python.execute", { code: liveCode(SCENE_SUMMARY) });
          return text(`[live Blender]\n${fmt({ result: r.result, error: r.error })}`);
        }
        if (!p.blend_file) return text("No Blender with the MCP Bridge is running; pass blend_file to read a saved file.");
        return text(fmt(await headless(SCENE_SUMMARY, path.resolve(cwd, p.blend_file), signal)));
      },
    },
    {
      name: "blender_preview",
      label: "Blender preview",
      description:
        "Look at a Blender scene. Live (Blender open): a screenshot of the Blender window. With blend_file: a quick " +
        "Workbench render (frame_all=true frames every object from a 3/4 view; false uses the scene camera).",
      parameters: Type.Object({
        blend_file: Type.Optional(Type.String()),
        frame_all: Type.Optional(Type.Boolean()),
        width: Type.Optional(Type.Number({ description: "Default 960" })),
      }),
      execute: async (_id: string, p: { blend_file?: string; frame_all?: boolean; width?: number }, signal?: AbortSignal) => {
        if (!p.blend_file) {
          if (!(await liveBlender())) return text("No live Blender; pass blend_file to render a saved file.");
          const s = await screenshot(path.join(cwd, ".echo", "shots"), "blender");
          return withImages(`Screenshot of the live Blender window (${s.file}).`, [s.file]);
        }
        mkdirSync(renders, { recursive: true });
        const out = path.join(renders, `preview-${Date.now()}.png`);
        const w = Math.min(p.width ?? 960, 1600);
        const r = await headless(RENDER_PREVIEW(out, w, Math.round((w * 9) / 16), p.frame_all ?? true), path.resolve(cwd, p.blend_file), signal);
        if (r.error) return text(fmt(r));
        return withImages(`Workbench render of ${p.blend_file} (${out}). The file was not modified.`, [out]);
      },
    },
    {
      name: "blender_api",
      label: "Blender API lookup",
      description: "Look up the exact bpy API of this Blender version before using it: an operator (bpy.ops.mesh.primitive_cube_add), a type (bpy.types.Object) or a module. Avoids guessing names.",
      parameters: Type.Object({ name: Type.String({ description: "Dotted name, e.g. bpy.ops.object.modifier_add or bpy.types.BevelModifier" }) }),
      execute: async (_id: string, p: { name: string }, signal?: AbortSignal) => {
        if (!/^bpy(\.[A-Za-z_][\w]*)+$/.test(p.name)) return text("Give a dotted bpy name such as bpy.types.Object.");
        return text(fmt(await headless(API_LOOKUP(p.name), undefined, signal)));
      },
    },
    {
      name: "blender_bridge",
      label: "Blender bridge command",
      description:
        "Send a structured command to the live Blender MCP Bridge: scene.get_info, scene.list_objects, object.get_transform, " +
        "object.create_mesh, object.translate/rotate/scale/duplicate/delete, material.create/assign/set_color, " +
        "render.still, export.gltf/obj/fbx, history.undo/redo.",
      parameters: Type.Object({ command: Type.String(), params: Type.Optional(Type.Record(Type.String(), Type.Unknown())) }),
      execute: async (_id: string, p: { command: string; params?: Record<string, unknown> }) =>
        text(JSON.stringify(await bridge(p.command, p.params ?? {}), null, 1).slice(0, 8000)),
    },
  ];
}
