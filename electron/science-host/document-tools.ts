import fs from "node:fs";
import path from "node:path";
import type { ToolPermission } from "../../shared/builtin-tools";
import { recordRunProducedFiles } from "../harness/run-produced-files";
import { registerDeclaredPromptModule, type PromptOrderingMetadata } from "../runtime/prompt-order";
import {
  documentApply, documentCreate, documentList, documentOpen, documentRead, documentSave, LIVE_DOCUMENT_PORT_SCHEMAS,
} from "../live-document/ports";

/*
 * Live office documents (live-document/ports.ts, the harness document.* ports) for Science turns.
 *
 * Science turns carry no harness_call, so the six ports are offered as one more server of the lazy Desktop catalogue
 * (list_desktop_tools -> call_desktop_tool). Nothing is reimplemented: each tool is the port itself, called with the
 * turn's own authority:
 *   chatId     the Science runtime chat (ensureScienceRuntimeChat), so sessions are that conversation's and no other chat's
 *   runId      the turn's invocation run, written to the journal as the AI actor's run
 *   permission the turn's real tool permission; the ports refuse create/apply/save under "read" (permission_read_only)
 * The only addition is the workspace fence: Science's own file tools see the project folder alone, so a document path
 * must resolve (symlinks included) inside it. No electron import (the daemon loads the Science host).
 */

export const SCIENCE_DOCUMENT_SERVER_ID = "desktop-documents";

export const SCIENCE_DOCUMENT_SERVER_DESCRIPTION = "Open, read, edit and save xlsx/docx/pptx/hwpx/hwp files in the project folder in their own format. Edits change that file only; a Science manuscript's Markdown source is not updated.";

export interface ScienceDocumentToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ScienceDocumentToolContext {
  chatId: string;
  runId: string;
  permission: ToolPermission;
  /** The turn's project folder; a document path outside it is refused. */
  cwd: string;
}

type PortOutcome = Awaited<ReturnType<typeof documentList>>;
type Port = (args: Record<string, unknown>, ctx: { chatId: string; runId: string; permission: ToolPermission; dryRun: false }) => Promise<PortOutcome>;

export const SCIENCE_DOCUMENT_PUBLIC_RESULT_MODULE = {
  id: "science.document.public-result", revision: 1, stability: "turn-context",
  changeTriggers: ["owner-input", "validation-result", "child-result"], order: 0,
} as const satisfies PromptOrderingMetadata;

export function serializeScienceDocumentResult(outcome: PortOutcome): string {
  registerDeclaredPromptModule(SCIENCE_DOCUMENT_PUBLIC_RESULT_MODULE);
  const { produced: _produced, ...result } = outcome as PortOutcome & { produced?: readonly string[] };
  return JSON.stringify(result);
}

const PATH_PROPERTY = { type: "string", description: "file path inside the project folder (relative to it, or absolute)" };
const withProjectPath = (schema: { properties: Record<string, unknown> }): Record<string, unknown> =>
  ({ ...schema, properties: { ...schema.properties, path: PATH_PROPERTY } });

const TOOLS: ReadonlyArray<ScienceDocumentToolDescriptor & { port: Port; fenced?: true }> = [
  { name: "document_list", port: documentList, description: "Documents open in this conversation: sessionId, name, path, format, savedRevision.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "document_open", port: documentOpen, fenced: true, description: "Open an existing document for editing; returns sessionId, an outline with the ids edits address, and the ops its format supports.",
    inputSchema: withProjectPath(LIVE_DOCUMENT_PORT_SCHEMAS.open) },
  { name: "document_create", port: documentCreate, fenced: true, description: "Create a blank A4 docx/xlsx/pptx/hwpx at a path that does not exist yet and open it (Hangul documents are .hwpx). Needs write permission.",
    inputSchema: withProjectPath(LIVE_DOCUMENT_PORT_SCHEMAS.create) },
  { name: "document_read", port: documentRead, description: "Current outline of an open document with the ids edits address, and its revision.",
    inputSchema: { ...LIVE_DOCUMENT_PORT_SCHEMAS.read } },
  { name: "document_apply", port: documentApply, description: "Edit an open document, all-or-nothing (set_cell, add_sheet, rename_sheet, delete_sheet, set_number_format, add_chart, set_text, insert_text, insert_paragraph, insert_table (a pptx slide too: after = the slide id), delete_block, add_slide, delete_slide, set_notes (pptx speaker notes), set_format). Needs write permission; pass baseRevision from document_read or document_apply.",
    inputSchema: { ...LIVE_DOCUMENT_PORT_SCHEMAS.apply } },
  { name: "document_save", port: documentSave, description: "Write an open document back to its file in the original format; refused if the file changed on disk meanwhile. Needs write permission.",
    inputSchema: { ...LIVE_DOCUMENT_PORT_SCHEMAS.save } },
];

export function scienceDocumentToolDescriptors(): ScienceDocumentToolDescriptor[] {
  return TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

const refused = (reason: string, next?: string): PortOutcome => ({ status: "refused", reason, ...(next ? { next } : {}) });

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** The nearest existing ancestor's real path plus the not-yet-existing tail (a created file's folder is real, its name is not). */
function realWithTail(target: string): string | null {
  let head = target;
  const tail: string[] = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(head), ...tail); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") return null;
      const parent = path.dirname(head);
      if (parent === head) return null;
      tail.unshift(path.basename(head));
      head = parent;
    }
  }
}

/** Resolves a model-named path against the project folder; null means it leaves the folder (lexically or through a symlink). */
function fencedPath(cwd: string, raw: unknown): { path: string } | { outside: true } | { passthrough: true } {
  if (typeof raw !== "string" || !raw.trim()) return { passthrough: true };
  const root = path.resolve(cwd);
  const target = path.resolve(root, raw.trim());
  if (!inside(root, target)) return { outside: true };
  // A dangling symlink has no real path, so a create through it would write wherever it points.
  try { fs.lstatSync(target); try { fs.realpathSync.native(target); } catch { return { outside: true }; } } catch { /* no entry at this path */ }
  const realRoot = realWithTail(root);
  const realTarget = realWithTail(target);
  if (!realRoot || !realTarget || !inside(realRoot, realTarget)) return { outside: true };
  return { path: target };
}

/**
 * Runs one document tool. The result is the port's own outcome (status ok | refused | unavailable, reason, next, data)
 * serialized as text; `isError` is true for anything but ok, so Science records a refusal as a refusal. An exception
 * that is not a typed refusal becomes document_port_failed: the file may or may not have changed, so the model is told
 * to read before it retries.
 */
export async function runScienceDocumentTool(name: string, args: Record<string, unknown>, ctx: ScienceDocumentToolContext): Promise<{ content: string; isError: boolean }> {
  const tool = TOOLS.find(candidate => candidate.name === name);
  if (!tool) throw new Error("science_document_tool_unknown");
  let outcome: PortOutcome;
  let portArgs = args;
  const fenced = tool.fenced ? fencedPath(ctx.cwd, args.path) : null;
  if (fenced && "outside" in fenced) {
    outcome = refused("path_outside_workspace", "documents are opened and created inside the project folder; copy the file into it first");
  } else {
    if (fenced && "path" in fenced) portArgs = { ...args, path: fenced.path };
    try {
      outcome = await tool.port(portArgs, { chatId: ctx.chatId, runId: ctx.runId, permission: ctx.permission, dryRun: false });
    } catch {
      outcome = { status: "unavailable", reason: "document_port_failed", next: "document_read shows the document's current state; check it before repeating the call" };
    }
  }
  // The same host-produced-file ledger that One/Work consumes seals the saved
  // bytes at the next outer tool completion. Producer metadata is never model
  // text and a read/open or a refused save cannot manufacture an output.
  const { produced } = outcome as PortOutcome & { produced?: readonly string[] };
  if (outcome.status === "ok" && produced?.length) recordRunProducedFiles(ctx.runId, `document.${name.replace(/^document_/, "")}`, produced);
  return { content: serializeScienceDocumentResult(outcome), isError: outcome.status !== "ok" };
}
