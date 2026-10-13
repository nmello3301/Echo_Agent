import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { Type } from "typebox";
import Parser from "web-tree-sitter";
import { ROOT } from "../config.ts";
import { godotCheck } from "./godot.ts";
import { clip, run, text } from "./util.ts";

const require = createRequire(import.meta.url);
const WASM_DIR = path.join(path.dirname(require.resolve("tree-sitter-wasms/package.json")), "out");
const BIN = (n: string) => path.join(ROOT, "node_modules/.bin", n);
const RUFF = path.join(ROOT, "services/pyworkspace/.venv/bin/ruff");

const LANGS: Record<string, string> = {
  ".py": "python", ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascript",
  ".ts": "typescript", ".mts": "typescript", ".tsx": "tsx", ".c": "c", ".h": "c", ".cpp": "cpp", ".cc": "cpp",
  ".hpp": "cpp", ".hh": "cpp", ".rs": "rust", ".go": "go", ".java": "java", ".cs": "c_sharp", ".lua": "lua",
  ".rb": "ruby", ".kt": "kotlin", ".swift": "swift", ".zig": "zig", ".php": "php", ".scala": "scala",
};

const DEFS = new Set([
  "class_definition", "function_definition", "decorated_definition",
  "class_declaration", "function_declaration", "method_definition", "interface_declaration", "type_alias_declaration",
  "enum_declaration", "abstract_class_declaration", "generator_function_declaration",
  "struct_specifier", "class_specifier", "namespace_definition",
  "function_item", "struct_item", "enum_item", "impl_item", "trait_item", "mod_item",
  "method_declaration", "type_declaration", "constructor_declaration", "record_declaration",
  "function_definition_statement", "method", "class", "module",
]);
// containers whose children we also list (methods inside classes)
const NEST = new Set(["class_definition", "class_declaration", "abstract_class_declaration", "class_specifier", "struct_specifier",
  "impl_item", "trait_item", "interface_declaration", "namespace_definition", "mod_item", "class", "module", "decorated_definition"]);
const BODIES = new Set(["block", "class_body", "declaration_list", "field_declaration_list", "body_statement", "interface_body", "enum_body"]);

let ready: Promise<void> | undefined;
const languages = new Map<string, Parser.Language | null>();
async function parserFor(lang: string): Promise<Parser | undefined> {
  ready ??= Parser.init();
  await ready;
  if (!languages.has(lang)) {
    const f = path.join(WASM_DIR, `tree-sitter-${lang}.wasm`);
    languages.set(lang, existsSync(f) ? await Parser.Language.load(f) : null);
  }
  const l = languages.get(lang);
  if (!l) return undefined;
  const p = new Parser();
  p.setLanguage(l);
  return p;
}

function signature(src: string, node: Parser.SyntaxNode): string {
  const first = src.slice(node.startIndex, node.endIndex).split("\n")[0].trim();
  return first.length > 140 ? `${first.slice(0, 137)}…` : first;
}

function collect(src: string, node: Parser.SyntaxNode, depth: number, out: string[]) {
  for (const c of node.namedChildren) {
    if (DEFS.has(c.type) || (c.type === "export_statement" && c.namedChildren.some((x) => DEFS.has(x.type)))) {
      const target = c.type === "export_statement" ? c.namedChildren.find((x) => DEFS.has(x.type))! : c;
      out.push(`${"  ".repeat(depth)}${c.startPosition.row + 1}: ${signature(src, c)}`);
      if (NEST.has(target.type) && depth < 2) {
        for (const b of target.namedChildren) if (BODIES.has(b.type) || NEST.has(b.type) || DEFS.has(b.type)) collect(src, BODIES.has(b.type) ? b : target, depth + 1, out);
      }
    } else if (["lexical_declaration", "variable_declaration"].includes(c.type) && depth === 0 && /=>|function/.test(src.slice(c.startIndex, Math.min(c.endIndex, c.startIndex + 200)))) {
      out.push(`${"  ".repeat(depth)}${c.startPosition.row + 1}: ${signature(src, c)}`);
    } else if (c.type === "export_statement" || c.type === "program" || c.type === "translation_unit") {
      collect(src, c, depth, out);
    }
  }
}

function gdscriptDefs(src: string): string[] {
  const out: string[] = [];
  src.split("\n").forEach((l, i) => {
    const m = /^(\s*)(class_name|class|func|static func|signal|enum|@export var|const)\b.*/.exec(l);
    if (m) out.push(`${"  ".repeat(Math.min(2, Math.floor(m[1].replace(/\t/g, "    ").length / 4)))}${i + 1}: ${l.trim().slice(0, 140)}`);
  });
  return out;
}

async function listFiles(dir: string): Promise<string[]> {
  const g = await run("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: dir });
  const files = g.code === 0 ? g.stdout.split("\n").filter(Boolean) : (await run("fd", ["--type", "f", "--hidden", "--exclude", ".git", "."], { cwd: dir })).stdout.split("\n").filter(Boolean);
  return files.filter((f) => !/(^|\/)(node_modules|dist|build|\.venv|vendor|\.godot|\.echo)\//.test(f));
}

export async function repoMap(dir: string, maxChars = 6000, focusPath?: string): Promise<string> {
  let files = (await listFiles(dir)).filter((f) => LANGS[path.extname(f)] || f.endsWith(".gd"));
  if (focusPath) files = files.filter((f) => f.startsWith(focusPath.replace(/^\.\//, "")));
  // most recently changed first: that is usually what the task is about
  files.sort((a, b) => statSync(path.join(dir, b)).mtimeMs - statSync(path.join(dir, a)).mtimeMs);
  const out: string[] = [];
  let used = 0;
  const skipped: string[] = [];
  for (const f of files) {
    const full = path.join(dir, f);
    if (statSync(full).size > 400_000) continue;
    const src = readFileSync(full, "utf8");
    let defs: string[] = [];
    if (f.endsWith(".gd")) defs = gdscriptDefs(src);
    else {
      const p = await parserFor(LANGS[path.extname(f)]);
      if (!p) continue;
      const tree = p.parse(src);
      collect(src, tree.rootNode, 0, defs);
      tree.delete();
      p.delete();
    }
    if (!defs.length) continue;
    const block = `${f}\n${defs.slice(0, 40).map((d) => `  ${d}`).join("\n")}${defs.length > 40 ? `\n  … ${defs.length - 40} more` : ""}`;
    if (used + block.length > maxChars) {
      skipped.push(f);
      continue;
    }
    out.push(block);
    used += block.length;
  }
  if (skipped.length) out.push(`(${skipped.length} more files not shown: ${skipped.slice(0, 30).join(", ")}${skipped.length > 30 ? ", …" : ""}; pass path to focus)`);
  return out.join("\n\n") || "No source files with definitions found.";
}

function up(start: string, stop: string, name: string): string | undefined {
  let d = start;
  for (;;) {
    if (existsSync(path.join(d, name))) return d;
    if (d === stop || d === path.dirname(d)) return undefined;
    d = path.dirname(d);
  }
}

export async function diagnostics(cwd: string, target?: string): Promise<string> {
  const t = path.resolve(cwd, target ?? ".");
  const isFile = existsSync(t) && statSync(t).isFile();
  const dir = isFile ? path.dirname(t) : t;
  const files = isFile ? [path.relative(cwd, t)] : (await listFiles(t)).map((f) => path.relative(cwd, path.join(t, f)));
  const has = (re: RegExp) => files.some((f) => re.test(f));
  const sections: string[] = [];

  const tsRoot = has(/\.(m|c)?tsx?$/) ? up(dir, cwd, "tsconfig.json") : undefined;
  if (tsRoot) {
    const tsc = existsSync(path.join(tsRoot, "node_modules/.bin/tsc")) ? path.join(tsRoot, "node_modules/.bin/tsc") : BIN("tsc");
    const r = await run(tsc, ["--noEmit", "--pretty", "false", "-p", tsRoot], { cwd: tsRoot });
    const errs = r.stdout.split("\n").filter((l) => / error TS\d+/.test(l));
    sections.push(`TypeScript (tsc): ${errs.length ? `${errs.length} errors\n${clip(errs.join("\n"), 3500)}` : "no errors"}`);
  }
  if (has(/\.py$/)) {
    const py = isFile ? [t] : [t];
    const r = await run(BIN("pyright"), ["--outputjson", ...py], { cwd });
    try {
      const j = JSON.parse(r.stdout) as { generalDiagnostics: { file: string; severity: string; message: string; range: { start: { line: number } } }[] };
      const d = j.generalDiagnostics.filter((x) => x.severity !== "information");
      sections.push(`Python (pyright): ${d.length ? `${d.length} problems\n${clip(d.map((x) => `${path.relative(cwd, x.file)}:${x.range.start.line + 1}: ${x.severity}: ${x.message.split("\n")[0]}`).join("\n"), 3500)}` : "no problems"}`);
    } catch {
      sections.push(`Python (pyright): could not run\n${clip(r.stderr || r.stdout, 600)}`);
    }
    const rf = await run(RUFF, ["check", "--output-format", "concise", "--quiet", ...py], { cwd });
    sections.push(`Python (ruff): ${rf.stdout.trim() ? clip(rf.stdout.trim(), 2500) : "clean"}`);
  }
  const cfiles = files.filter((f) => /\.(c|cc|cpp|cxx|h|hpp)$/.test(f)).slice(0, 8);
  if (cfiles.length) {
    const out: string[] = [];
    for (const f of cfiles) {
      const r = await run("clangd", [`--check=${path.join(cwd, f)}`, "--log=error"], { cwd });
      const errs = `${r.stderr}`.split("\n").filter((l) => /\[\w+\]|error|warning/i.test(l) && !/^I\[/.test(l)).slice(0, 15);
      if (errs.length) out.push(`${f}:\n${errs.join("\n")}`);
    }
    sections.push(`C/C++ (clangd): ${out.length ? clip(out.join("\n"), 3000) : `no problems in ${cfiles.length} files`}`);
  }
  const godotRoot = has(/\.gd$/) ? up(dir, cwd, "project.godot") ?? (existsSync(path.join(t, "project.godot")) ? t : undefined) : undefined;
  if (godotRoot) {
    const r = await godotCheck(godotRoot, isFile && t.endsWith(".gd") ? [t] : undefined);
    sections.push(`GDScript (godot --check-only): ${r.problems.length ? `${r.problems.length} of ${r.checked} scripts\n${clip(r.problems.join("\n"), 3000)}` : `${r.checked} scripts clean`}`);
  }
  return sections.join("\n\n") || "No supported languages found (TypeScript with tsconfig.json, Python, C/C++, GDScript).";
}

export function codeTools(cwd: string) {
  return [
    {
      name: "repo_map",
      label: "Repo map",
      description: "Map of the codebase: every file's classes, functions and methods with line numbers (tree-sitter). Read it before exploring a large project; then read only what you need.",
      parameters: Type.Object({ path: Type.Optional(Type.String({ description: "Sub-folder to focus on" })), max_chars: Type.Optional(Type.Number({ description: "Default 6000" })) }),
      execute: async (_id: string, p: { path?: string; max_chars?: number }) => text(await repoMap(cwd, p.max_chars ?? 6000, p.path)),
    },
    {
      name: "code_diagnostics",
      label: "Code diagnostics",
      description: "Type and lint errors for a file or folder: TypeScript (tsc), Python (pyright + ruff), C/C++ (clangd), GDScript (Godot). Run after edits, before saying code works.",
      parameters: Type.Object({ path: Type.Optional(Type.String({ description: "File or folder, default the working folder" })) }),
      execute: async (_id: string, p: { path?: string }) => text(await diagnostics(cwd, p.path)),
    },
  ];
}
