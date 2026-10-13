import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { ROOT } from "../config.ts";
import { headless, RENDER_PREVIEW } from "./blender.ts";
import { bwrapArgs, clip, run, text, withImages } from "./util.ts";

const CAD_PY = path.join(ROOT, "services/cad/.venv/bin/python");

// Runs the model's build123d script, then exports and measures `result`.
const BUILD_WRAPPER = `
import json, sys, traceback, runpy
script, out_base = sys.argv[1], sys.argv[2]
report = {}
try:
    ns = runpy.run_path(script, run_name="__main__")
    part = ns.get("result")
    if part is None:
        raise SystemExit("The script must assign the final shape to a variable named result.")
    from build123d import export_stl, export_step
    export_stl(part, out_base + ".stl")
    export_step(part, out_base + ".step")
    bb = part.bounding_box()
    report.update({
        "volume_mm3": round(part.volume, 3),
        "area_mm2": round(part.area, 3),
        "bbox_mm": [round(bb.size.X, 3), round(bb.size.Y, 3), round(bb.size.Z, 3)],
        "solids": len(part.solids()), "faces": len(part.faces()), "edges": len(part.edges()),
        "valid": bool(part.is_valid() if callable(getattr(part, "is_valid", None)) else part.is_valid),
    })
    import trimesh
    m = trimesh.load(out_base + ".stl")
    report["mesh"] = {"watertight": bool(m.is_watertight), "triangles": int(len(m.faces)), "volume_mm3": round(float(m.volume), 3)}
except SystemExit as e:
    report["error"] = str(e)
except Exception:
    report["error"] = traceback.format_exc(limit=-4)
print("@@ECHO@@" + json.dumps(report))
`;

const MESH_CHECK = `
import json, sys, trimesh
m = trimesh.load(sys.argv[1], force="mesh")
bb = m.bounding_box.extents
print("@@ECHO@@" + json.dumps({"watertight": bool(m.is_watertight), "winding_consistent": bool(m.is_winding_consistent),
  "triangles": int(len(m.faces)), "vertices": int(len(m.vertices)), "bbox": [round(float(v), 3) for v in bb],
  "volume": round(float(m.volume), 3) if m.is_watertight else None, "area": round(float(m.area), 3),
  "bodies": len(m.split(only_watertight=False)), "euler_number": int(m.euler_number)}))
`;

async function pyJSON(args: string[], cwd: string, sandbox = true, signal?: AbortSignal) {
  const cmd = sandbox ? "bwrap" : CAD_PY;
  const a = sandbox ? [...bwrapArgs(cwd), CAD_PY, ...args] : args;
  const r = await run(cmd, a, { cwd, signal });
  const line = r.stdout.split("\n").find((l) => l.startsWith("@@ECHO@@"));
  if (!line) throw new Error(`the CAD process failed (exit ${r.code}):\n${clip(r.stderr || r.stdout, 3000)}`);
  return JSON.parse(line.slice(8));
}

/** Render a mesh with Blender headless (Workbench, framed 3/4 view). */
export async function previewMesh(meshFile: string, outPng: string, signal?: AbortSignal) {
  const ext = path.extname(meshFile).toLowerCase();
  const importer = ext === ".stl" ? "bpy.ops.wm.stl_import" : ext === ".obj" ? "bpy.ops.wm.obj_import" : ext === ".ply" ? "bpy.ops.wm.ply_import" : "bpy.ops.import_scene.gltf";
  const code = `import bpy\nfor o in list(bpy.data.objects): bpy.data.objects.remove(o)\n${importer}(filepath=${JSON.stringify(meshFile)})\n` +
    `for o in bpy.context.scene.objects:\n    o.data.materials.clear() if o.type == "MESH" else None\n` + RENDER_PREVIEW(outPng, 960, 720, true);
  const r = await headless(code, undefined, signal);
  if (r.error) throw new Error(r.error);
}

export function cadTools(cwd: string) {
  const outDir = path.join(cwd, "cad");
  return [
    {
      name: "cad_build",
      label: "CAD build (build123d)",
      description:
        "Build a part with build123d (Python, units mm). The script must assign the final shape to `result`. " +
        "Exports cad/<name>.stl and .step, reports volume, area, bounding box, validity and mesh checks, and shows a " +
        "rendered preview. Use `from build123d import *`.",
      parameters: Type.Object({ name: Type.String({ description: "File name without extension" }), script: Type.String() }),
      execute: async (_id: string, p: { name: string; script: string }, signal?: AbortSignal) => {
        const name = p.name.replace(/[^\w.-]+/g, "_");
        mkdirSync(outDir, { recursive: true });
        const scriptFile = path.join(outDir, `${name}.py`);
        writeFileSync(scriptFile, p.script);
        const tmp = mkdtempSync(path.join(cwd, ".echo-cad-"));
        try {
          writeFileSync(path.join(tmp, "wrap.py"), BUILD_WRAPPER);
          const base = path.join(outDir, name);
          const rep = await pyJSON([path.join(tmp, "wrap.py"), scriptFile, base], cwd, true, signal);
          if (rep.error) return text(`The build failed:\n${clip(rep.error, 4000)}\n(script saved to ${scriptFile})`);
          const png = `${base}.png`;
          let note = "";
          try {
            await previewMesh(`${base}.stl`, png, signal);
          } catch (e) {
            note = `\n(preview render failed: ${(e as Error).message.slice(0, 300)})`;
          }
          return withImages(`Built ${name}: ${base}.stl, ${base}.step (script ${scriptFile})\n${JSON.stringify(rep, null, 1)}${note}`, note ? [] : [png]);
        } finally {
          rmSync(tmp, { recursive: true, force: true });
        }
      },
    },
    {
      name: "mesh_check",
      label: "Mesh check",
      description: "Check a mesh file (STL, OBJ, PLY, GLB): watertight, winding, triangle count, bounding box, volume, number of bodies. preview=true also renders it.",
      parameters: Type.Object({ path: Type.String(), preview: Type.Optional(Type.Boolean()) }),
      execute: async (_id: string, p: { path: string; preview?: boolean }, signal?: AbortSignal) => {
        const f = path.resolve(cwd, p.path);
        const rep = await pyJSON(["-c", MESH_CHECK, f], cwd, false, signal);
        if (!p.preview) return text(JSON.stringify(rep, null, 1));
        const png = path.join(cwd, ".echo", "renders", `${path.basename(f)}-${Date.now()}.png`);
        mkdirSync(path.dirname(png), { recursive: true });
        await previewMesh(f, png, signal);
        return withImages(JSON.stringify(rep, null, 1), [png]);
      },
    },
  ];
}

