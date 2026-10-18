import { LIVE_DOCUMENT_OPS_BY_FORMAT, liveDocumentOutline } from "../../shared/live-document";

/*
 * Harness ports for live documents (document.*). The model edits an open office file through the same journal the
 * person's Document tab writes to; the tab replays each AI entry with a typing cursor. Opening and reading are
 * inert for the file on disk; apply and save need the run's write permission (apply changes the shared session the
 * owner is looking at, save overwrites the file).
 *
 * No electron import (the daemon loads the harness).
 */

type Outcome =
  | { status: "ok"; data: unknown }
  | { status: "refused" | "unavailable"; reason: string; next?: string; data?: unknown };

interface Ctx { chatId: string; runId: string; dryRun?: boolean; permission?: "read" | "write" | "full" }

const str = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const refused = (reason: string, next?: string, data?: unknown): Outcome => ({ status: "refused", reason, ...(next ? { next } : {}), ...(data !== undefined ? { data } : {}) });
const writable = (ctx: Ctx) => ctx.permission === "write" || ctx.permission === "full";

const OP_SCHEMA = {
  type: "object",
  required: ["op"],
  properties: {
    op: { type: "string", enum: ["set_cell", "set_text", "insert_text", "insert_paragraph", "insert_table", "delete_block", "add_slide", "delete_slide", "add_sheet", "rename_sheet", "delete_sheet", "set_format", "set_number_format", "add_chart"] },
    sheet: { type: "string" }, cell: { type: "string", description: "A1" }, value: { type: "string", description: "leading = makes a formula" },
    target: { type: "string", description: "id from document.read" }, text: { type: "string" }, at: { type: "integer", minimum: 0 },
    after: { type: "string", description: "block/slide id, or start" }, heading: { type: "integer", minimum: 0, maximum: 6 },
    rows: { type: "array", items: { type: "array", items: { type: "string" } } }, title: { type: "string" }, body: { type: "string" }, name: { type: "string" },
    format: {
      type: "object", additionalProperties: false, description: "set_format: whole paragraph, table cell, slide shape or sheet cell (target <sheet>!A1)",
      properties: { bold: { type: "boolean" }, italic: { type: "boolean" }, underline: { type: "boolean" }, size: { type: "number", minimum: 1, maximum: 400 },
        color: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" }, align: { type: "string", enum: ["left", "center", "right", "justify"] },
        fill: { type: "string", pattern: "^#[0-9a-fA-F]{6}$", description: "background (cell shading)" } },
    },
    widths: { type: "array", items: { type: "number", exclusiveMinimum: 0 }, description: "insert_table column width ratios" },
    merges: { type: "array", items: { type: "object", required: ["cell"], properties: { cell: { type: "string", description: "anchor r1c2" }, rowSpan: { type: "integer", minimum: 1 }, colSpan: { type: "integer", minimum: 1 } } }, description: "insert_table merged ranges" },
    pageBreak: { type: "boolean", description: "insert_paragraph starts a new page" },
    numberFormat: { type: "string", description: "set_number_format: Excel code (#,##0 / 0.0% / #,##0\"원\" / yyyy-mm-dd), \"\" = General; target <sheet>!A1 or <sheet>!B2:B9" },
    type: { type: "string", enum: ["bar", "line", "pie"], description: "add_chart kind" },
    categories: { type: "string", description: "add_chart: label range, one row or column (A2:A4 or 'Sheet'!A2:A4)" },
    values: { type: "array", items: { type: "string" }, maxItems: 8, description: "add_chart: one range per series, same shape as categories (pie: 1)" },
    anchor: { type: "string", description: "add_chart: top-left cell of the chart (default: right of the data)" },
  },
};

export const LIVE_DOCUMENT_PORT_SCHEMAS = {
  open: { type: "object", required: ["path"], properties: { path: { type: "string", description: "absolute path of a .xlsx .docx .pptx .hwpx .hwp file" } } },
  create: { type: "object", required: ["path"], properties: { path: { type: "string", description: "absolute path of a new .docx .xlsx .pptx .hwpx file (must not exist; Hangul = .hwpx)" }, title: { type: "string" } } },
  read: { type: "object", required: ["sessionId"], properties: { sessionId: { type: "string" }, maxChars: { type: "integer", minimum: 1000, maximum: 200000 } } },
  apply: { type: "object", required: ["sessionId", "ops"], properties: { sessionId: { type: "string" }, baseRevision: { type: "integer", minimum: 0 }, ops: { type: "array", minItems: 1, maxItems: 400, items: OP_SCHEMA } } },
  save: { type: "object", required: ["sessionId"], properties: { sessionId: { type: "string" } } },
} as const;

async function store() {
  return import("./store");
}

function errorOutcome(error: unknown): Outcome {
  const reason = (error as { reason?: unknown })?.reason;
  if (typeof reason === "string") return refused(reason, (error as { detail?: string }).detail);
  throw error;
}

export async function documentList(_args: Record<string, unknown>, ctx: Ctx): Promise<Outcome> {
  const sessions = await (await store()).listLiveDocuments(ctx.chatId);
  return { status: "ok", data: { sessions: sessions.map(({ sessionId, name, path, format, savedRevision }) => ({ sessionId, name, path, format, savedRevision })) } };
}

export async function documentOpen(args: Record<string, unknown>, ctx: Ctx): Promise<Outcome> {
  try {
    const live = await store();
    const meta = await live.openLiveDocument({ chatId: ctx.chatId, path: str(args.path) });
    const snapshot = await live.liveDocumentSnapshot(meta.sessionId);
    const outline = liveDocumentOutline(snapshot.model, { maxChars: 20_000 });
    return { status: "ok", data: {
      sessionId: meta.sessionId, name: meta.name, format: meta.format, revision: snapshot.revision,
      ops: LIVE_DOCUMENT_OPS_BY_FORMAT[meta.format], outline: outline.text, truncated: outline.truncated,
      next: "edit with document.apply (ids from the outline); the owner watches it in the Document tab; document.save writes the file",
    } };
  } catch (error) { return errorOutcome(error); }
}

export async function documentCreate(args: Record<string, unknown>, ctx: Ctx): Promise<Outcome> {
  if (ctx.dryRun) return refused("dry_run");
  if (!writable(ctx)) return refused("permission_read_only", "creating writes a new file; this run may not write");
  try {
    const live = await store();
    const meta = await live.createLiveDocument({ chatId: ctx.chatId, path: str(args.path), title: str(args.title) });
    const snapshot = await live.liveDocumentSnapshot(meta.sessionId);
    const outline = liveDocumentOutline(snapshot.model, { maxChars: 20_000 });
    return { status: "ok", data: {
      sessionId: meta.sessionId, name: meta.name, path: meta.path, format: meta.format, revision: snapshot.revision,
      ops: LIVE_DOCUMENT_OPS_BY_FORMAT[meta.format], outline: outline.text,
      next: "blank A4 document is open in the Document tab; fill it with document.apply, then document.save",
      ...(meta.format === "hwpx" ? { note: "a .hwpx file is a Hangul (한글) document: Hancom Office opens it and can save it as .hwp, so a request for a Hangul/hwp file is complete with this file" } : {}),
    } };
  } catch (error) { return errorOutcome(error); }
}

export async function documentRead(args: Record<string, unknown>, ctx: Ctx): Promise<Outcome> {
  try {
    const snapshot = await (await store()).liveDocumentSnapshot(str(args.sessionId));
    if (snapshot.meta.chatId !== ctx.chatId) return refused("session_not_in_this_chat", "document.list shows this conversation's sessions");
    const max = Number.isSafeInteger(args.maxChars) ? Number(args.maxChars) : 60_000;
    const outline = liveDocumentOutline(snapshot.model, { maxChars: Math.min(200_000, Math.max(1_000, max)) });
    return { status: "ok", data: {
      sessionId: snapshot.meta.sessionId, name: snapshot.meta.name, format: snapshot.meta.format, revision: snapshot.revision,
      unsaved: snapshot.revision > snapshot.meta.savedRevision, ops: LIVE_DOCUMENT_OPS_BY_FORMAT[snapshot.meta.format],
      outline: outline.text, truncated: outline.truncated,
    } };
  } catch (error) { return errorOutcome(error); }
}

export async function documentApply(args: Record<string, unknown>, ctx: Ctx): Promise<Outcome> {
  if (ctx.dryRun) return refused("dry_run");
  if (!writable(ctx)) return refused("permission_read_only", "this run may read documents but not edit them");
  const result = await (await store()).applyLiveDocument({
    sessionId: str(args.sessionId), chatId: ctx.chatId,
    ...(Number.isSafeInteger(args.baseRevision) ? { baseRevision: Number(args.baseRevision) } : {}),
    ops: args.ops, actor: { kind: "ai", label: "AI", runId: ctx.runId },
  });
  if (!result.ok) return refused(result.reason, result.detail ?? (result.reason === "revision_conflict" ? "document.read, then apply against the new revision" : undefined), result.revision !== undefined ? { revision: result.revision } : undefined);
  return { status: "ok", data: { revision: result.revision, created: result.created } };
}

export async function documentSave(args: Record<string, unknown>, ctx: Ctx): Promise<Outcome> {
  if (ctx.dryRun) return refused("dry_run");
  if (!writable(ctx)) return refused("permission_read_only", "saving overwrites the file; this run may not write");
  const result = await (await store()).saveLiveDocument({ sessionId: str(args.sessionId), chatId: ctx.chatId });
  if (!result.ok) return refused(result.reason, result.detail);
  return { status: "ok", data: result };
}
