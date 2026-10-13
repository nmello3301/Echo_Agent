import { blenderTools } from "./blender.ts";
import { cadTools } from "./cad.ts";
import { codeTools } from "./code.ts";
import { godotTools } from "./godot.ts";
import { notesTools } from "./notes.ts";
import { pdfTools } from "./pdf.ts";
import { PythonWorkspace, pythonTools } from "./python.ts";
import { visionTools } from "./vision.ts";
import { webTools } from "./web.ts";

export interface EchoTool {
  name: string;
  label: string;
  description: string;
  parameters: any;
  execute: (id: string, params: any, signal?: AbortSignal) => Promise<any>;
}

/** Echo's tools for one agent run. `core` are always in the prompt; `deferred` are found with tool_search,
 *  so they cost no prompt tokens until a task needs them. */
export function echoTools(cwd: string) {
  const py = new PythonWorkspace(cwd);
  const notes = notesTools();
  const core: EchoTool[] = [...webTools(), ...pythonTools(py), ...visionTools(cwd), ...notes.core];
  const deferred: { namespace: { name: string; description: string }; tools: EchoTool[] }[] = [
    { namespace: { name: "blender", description: "Blender: run bpy (live or headless), scene summary, render preview, API lookup" }, tools: blenderTools(cwd) },
    { namespace: { name: "godot", description: "Godot 4: check GDScript, run scenes headless, screenshot a scene, export" }, tools: godotTools(cwd) },
    { namespace: { name: "cad", description: "CAD: build123d parts to STL/STEP with measurements and preview; mesh checks" }, tools: cadTools(cwd) },
    { namespace: { name: "documents", description: "PDF text with automatic OCR, OCR for images" }, tools: pdfTools(cwd) },
    { namespace: { name: "notes", description: "The user's notes: read a whole note, list notes by date" }, tools: notes.deferred },
    { namespace: { name: "code", description: "Repo map (tree-sitter) and type/lint diagnostics (tsc, pyright, ruff, clangd, Godot)" }, tools: codeTools(cwd) },
  ];
  return { core, deferred, dispose: () => py.reset() };
}

export const DEFERRED_HINT =
  "More tools are loaded on demand with tool_search: blender_* (bpy live/headless, scene summary, preview render, API lookup), " +
  "godot_* (check, run, screenshot, export), cad_build and mesh_check (build123d, STL/STEP), pdf_text and ocr_image, " +
  "repo_map and code_diagnostics, notes_read and notes_list. Search for them by name when the task needs them.";
