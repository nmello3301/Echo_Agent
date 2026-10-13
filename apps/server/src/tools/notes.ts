import path from "node:path";
import { Type } from "typebox";
import { formatSources, listNotes, readNote, searchNotes } from "../rag.ts";
import { clip, text } from "./util.ts";

const dateHint = "ISO date, e.g. 2026-10-01";

export function notesTools() {
  return {
    core: [
      {
        name: "notes_search",
        label: "Search my notes",
        description:
          "Search the user's personal notes (Hugin voice notes, meetings and other Markdown notes) by meaning and keywords. " +
          "Returns the best passages with title, date and file, most relevant first. Use it whenever the user refers to " +
          "something they said, noted, decided or recorded. Cite what you use as (title, date). Narrow with since/until " +
          "for time questions ('last week', 'in September').",
        parameters: Type.Object({
          query: Type.String({ description: "What to look for, in natural language" }),
          k: Type.Optional(Type.Number({ description: "Passages to return, default 6" })),
          since: Type.Optional(Type.String({ description: dateHint })),
          until: Type.Optional(Type.String({ description: dateHint })),
          type: Type.Optional(Type.String({ description: "note | meeting | dictation" })),
        }),
        execute: async (_id: string, p: { query: string; k?: number; since?: string; until?: string; type?: string }) => {
          const r = await searchNotes(p.query, { k: p.k ?? 6, since: p.since, until: p.until, type: p.type });
          if (!r.hits.length) return text("No matching notes.");
          return text(`${formatSources(r.hits)}\n\n(${r.hits.length} passages; relevance ${r.hits.map((h) => h.score.toFixed(2)).join(", ")}. Read a whole note with notes_read.)`);
        },
      },
    ],
    deferred: [
      {
        name: "notes_read",
        label: "Read a note",
        description: "Read one of the user's notes in full, by file name or path (as returned by notes_search or notes_list).",
        parameters: Type.Object({ note: Type.String() }),
        execute: async (_id: string, p: { note: string }) => text(clip(readNote(p.note), 12000)),
      },
      {
        name: "notes_list",
        label: "List notes",
        description: "List the user's notes (title, date, type, file), newest first, optionally within a date range or of one type.",
        parameters: Type.Object({
          since: Type.Optional(Type.String({ description: dateHint })),
          until: Type.Optional(Type.String({ description: dateHint })),
          type: Type.Optional(Type.String()),
          limit: Type.Optional(Type.Number({ description: "Default 30" })),
        }),
        execute: async (_id: string, p: { since?: string; until?: string; type?: string; limit?: number }) => {
          const rows = listNotes({ since: p.since, until: p.until, type: p.type, limit: p.limit ?? 30 });
          return text(rows.length ? rows.map((n) => `${n.created.slice(0, 16).replace("T", " ")}  [${n.type}]  ${n.title}  (${path.basename(n.path)})`).join("\n") : "No notes in that range.");
        },
      },
    ],
  };
}
