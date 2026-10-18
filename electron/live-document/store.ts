import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  applyLiveDocumentOps, assignLiveDocumentIds, inferLiveDocumentFormat, LIVE_DOCUMENT_VERSION, LiveDocumentOpError,
  liveDocumentOpTargets, validateLiveDocumentOps,
  type LiveDocumentActor, type LiveDocumentApplyResult, type LiveDocumentDelta, type LiveDocumentEntry, type LiveDocumentMeta,
  type LiveDocumentModel, type LiveDocumentOp, type LiveDocumentSnapshot,
} from "../../shared/live-document";
import { LIVE_DOCUMENT_CODECS, LiveDocumentCodecError } from "./codecs";

/*
 * Live document sessions: userData/live-documents/<sessionId>/{meta.json, source.bin, journal.jsonl}.
 *
 * source.bin is the file as opened; journal.jsonl is append-only, one entry (actor + ops) per line, folded over the
 * parsed source. Main (person's edits, the rail) and the daemon (harness ports) both append under a directory lock
 * and fold the same file, so they agree on revisions without talking to each other. Saving writes the codec output
 * next to the target and renames it into place, after the output re-parses to the same text. Never auto-deleted;
 * source.bin is the pre-edit original.
 *
 * No electron import (the daemon loads this).
 */

const MAX_FILE_BYTES = 60 * 1024 * 1024;
const SNAPSHOT_ENTRIES = 40;
/** A tab that mounts this soon after the file was opened replays the whole journal instead of starting at its end. */
const REPLAY_WINDOW_MS = 120_000;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const lockfile = require("proper-lockfile") as { lock(file: string, options: Record<string, unknown>): Promise<() => Promise<void>> };

export class LiveDocumentError extends Error {
  constructor(readonly reason: string, readonly detail?: string) { super(detail ? `${reason}: ${detail}` : reason); }
}

async function root(): Promise<string> {
  const { userDataPath } = await import("../runtime-paths");
  return userDataPath("live-documents");
}

const SESSION_RE = /^ld_[0-9a-f-]{36}$/;
const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

async function sessionDir(sessionId: string): Promise<string> {
  if (!SESSION_RE.test(sessionId)) throw new LiveDocumentError("session_unknown");
  const dir = path.join(await root(), sessionId);
  if (!fs.existsSync(path.join(dir, "meta.json"))) throw new LiveDocumentError("session_unknown");
  return dir;
}

function readMeta(dir: string): LiveDocumentMeta {
  return JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")) as LiveDocumentMeta;
}

function writeMeta(dir: string, meta: LiveDocumentMeta): void {
  const tmp = path.join(dir, `meta.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, path.join(dir, "meta.json"));
}

// ── fold cache (per process) ────────────────────────────────────────────────────────────────────────────────────

interface Folded {
  meta: LiveDocumentMeta;
  original: LiveDocumentModel;
  model: LiveDocumentModel;
  entries: LiveDocumentEntry[];
  journalBytes: number;
}

const cache = new Map<string, Folded>();

function readJournal(dir: string, fromByte: number): { entries: LiveDocumentEntry[]; bytes: number } {
  const file = path.join(dir, "journal.jsonl");
  if (!fs.existsSync(file)) return { entries: [], bytes: 0 };
  const size = fs.statSync(file).size;
  if (size <= fromByte) return { entries: [], bytes: fromByte };
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(size - fromByte);
    fs.readSync(fd, buffer, 0, buffer.length, fromByte);
    const text = buffer.toString("utf8");
    const complete = text.lastIndexOf("\n") + 1; // a half-written last line waits for the next read
    const entries = text.slice(0, complete).split("\n").filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line) as LiveDocumentEntry]; } catch { return []; }
    });
    return { entries, bytes: fromByte + Buffer.byteLength(text.slice(0, complete)) };
  } finally {
    fs.closeSync(fd);
  }
}

function fold(sessionId: string, dir: string): Folded {
  let state = cache.get(sessionId);
  const meta = readMeta(dir);
  if (!state) {
    const source = fs.readFileSync(path.join(dir, "source.bin"));
    const original = LIVE_DOCUMENT_CODECS[meta.format].parse(source);
    state = { meta, original, model: original, entries: [], journalBytes: 0 };
    cache.set(sessionId, state);
  }
  state.meta = meta;
  const { entries, bytes } = readJournal(dir, state.journalBytes);
  for (const entry of entries) {
    if (entry.seq !== state.entries.length + 1) continue;
    try { state.model = applyLiveDocumentOps(state.model, entry.ops); } catch { /* an entry that no longer applies is skipped by every reader alike */ }
    state.entries.push(entry);
  }
  state.journalBytes = bytes;
  return state;
}

async function withLock<T>(dir: string, body: () => T | Promise<T>): Promise<T> {
  const release = await lockfile.lock(dir, { realpath: false, stale: 15_000, retries: { retries: 40, minTimeout: 20, maxTimeout: 250 } });
  try { return await body(); } finally { await release().catch(() => undefined); }
}

// ── public API ──────────────────────────────────────────────────────────────────────────────────────────────────

export async function listLiveDocuments(chatId: string): Promise<LiveDocumentMeta[]> {
  const base = await root();
  if (!fs.existsSync(base)) return [];
  const out: LiveDocumentMeta[] = [];
  for (const name of fs.readdirSync(base)) {
    if (!SESSION_RE.test(name)) continue;
    try {
      const meta = readMeta(path.join(base, name));
      if (meta.chatId === chatId && !meta.closed) out.push(meta);
    } catch { /* unreadable session: skip */ }
  }
  return out.sort((a, b) => a.openedAt.localeCompare(b.openedAt));
}

export async function openLiveDocument(input: { chatId: string; path: string }): Promise<LiveDocumentMeta> {
  const target = path.resolve(input.path);
  if (!path.isAbsolute(input.path)) throw new LiveDocumentError("path_not_absolute");
  const format = inferLiveDocumentFormat(target);
  if (!format) throw new LiveDocumentError("format_unsupported", "xlsx, docx, pptx, hwpx or hwp");
  let stat: fs.Stats;
  try { stat = fs.statSync(target); } catch { throw new LiveDocumentError("file_missing", target); }
  if (!stat.isFile()) throw new LiveDocumentError("file_missing", target);
  if (stat.size > MAX_FILE_BYTES) throw new LiveDocumentError("file_too_large", `${stat.size} bytes`);
  const bytes = fs.readFileSync(target);
  const digest = sha256(bytes);
  const real = fs.realpathSync(target);

  // Reuse this conversation's open session of the same file when it still matches the disk.
  for (const meta of await listLiveDocuments(input.chatId)) {
    if (meta.path !== real) continue;
    if (meta.savedSha256 === digest) return meta;
    const dir = await sessionDir(meta.sessionId);
    const state = fold(meta.sessionId, dir);
    if (state.entries.length > meta.savedRevision) throw new LiveDocumentError("unsaved_session_exists", `${meta.sessionId} has unsaved edits and the file changed on disk`);
    await closeLiveDocument(meta.sessionId);
  }

  try { LIVE_DOCUMENT_CODECS[format].parse(bytes); } catch (error) {
    if (error instanceof LiveDocumentCodecError) throw new LiveDocumentError("file_unreadable", error.message);
    throw new LiveDocumentError("file_unreadable", error instanceof Error ? error.message.slice(0, 200) : "parse failed");
  }
  const sessionId = `ld_${randomUUID()}`;
  const dir = path.join(await root(), sessionId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, "source.bin"), bytes, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, "journal.jsonl"), "", { mode: 0o600 });
  const meta: LiveDocumentMeta = {
    schemaVersion: LIVE_DOCUMENT_VERSION, sessionId, chatId: input.chatId, path: real, name: path.basename(real), format,
    openedAt: new Date().toISOString(), sourceSha256: digest, savedRevision: 0, savedSha256: digest,
  };
  writeMeta(dir, meta);
  return meta;
}

/** Writes a blank document at a path that does not exist yet and opens it. A Hangul document is created as .hwpx. */
export async function createLiveDocument(input: { chatId: string; path: string; title?: string }): Promise<LiveDocumentMeta> {
  if (!path.isAbsolute(input.path)) throw new LiveDocumentError("path_not_absolute");
  const target = path.resolve(input.path);
  const format = inferLiveDocumentFormat(target);
  if (format === "hwp") throw new LiveDocumentError("format_not_creatable", "HWP binary cannot be created; create the same name with .hwpx instead — it is a Hangul document that Hancom Office opens and can save as .hwp, so it fulfils a request for a Hangul/hwp file");
  const { blankDocument, CREATABLE_FORMATS } = await import("./templates");
  if (!format || !(CREATABLE_FORMATS as readonly string[]).includes(format)) throw new LiveDocumentError("format_unsupported", "docx, xlsx, pptx or hwpx");
  if (fs.existsSync(target)) throw new LiveDocumentError("file_exists", "document.open edits an existing file; pick a new name to create one");
  const parent = path.dirname(target);
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) throw new LiveDocumentError("folder_missing", parent);
  const title = (input.title ?? "").trim() || path.basename(target, path.extname(target));
  const bytes = blankDocument(format as "docx" | "xlsx" | "pptx" | "hwpx", title.slice(0, 200));
  fs.writeFileSync(target, bytes, { flag: "wx", mode: 0o644 });
  return openLiveDocument({ chatId: input.chatId, path: target });
}

export async function liveDocumentSnapshot(sessionId: string): Promise<LiveDocumentSnapshot> {
  const dir = await sessionDir(sessionId);
  const state = fold(sessionId, dir);
  const fresh = Date.now() - Date.parse(state.meta.openedAt) < REPLAY_WINDOW_MS && state.entries.length > 0 && state.entries.length <= SNAPSHOT_ENTRIES;
  return { meta: state.meta, revision: state.entries.length, model: state.model, entries: state.entries.slice(-SNAPSHOT_ENTRIES), ...(fresh ? { replayFrom: state.original } : {}) };
}

export async function liveDocumentDelta(sessionId: string, sinceRevision: number): Promise<LiveDocumentDelta> {
  const dir = await sessionDir(sessionId);
  const state = fold(sessionId, dir);
  const revision = state.entries.length;
  if (!Number.isSafeInteger(sinceRevision) || sinceRevision < 0 || sinceRevision > revision || revision - sinceRevision > 200) {
    return { sessionId, revision, entries: [], reset: true };
  }
  return { sessionId, revision, entries: state.entries.slice(sinceRevision) };
}

/** A slide body placeholder draws its own bullets; a typed "• " in front of each line would show two (real run 2026-10-17). */
function withoutTypedBullets(model: LiveDocumentModel, ops: LiveDocumentOp[]): LiveDocumentOp[] {
  if (model.kind !== "slides") return ops;
  const bodies = new Set(model.slides.flatMap((slide) => slide.shapes.filter((shape) => shape.role === "body").map((shape) => shape.id)));
  const strip = (text: string) => text.split("\n").map((line) => line.replace(/^\s*[•·▪‣◦\-*]\s+/, "")).join("\n");
  return ops.map((op) => {
    if (op.op === "add_slide" && op.body !== undefined) return { ...op, body: strip(op.body) };
    if (op.op === "set_text" && bodies.has(op.target)) return { ...op, text: strip(op.text) };
    return op;
  });
}

export async function applyLiveDocument(input: { sessionId: string; chatId?: string; baseRevision?: number; ops: unknown; actor: LiveDocumentActor }): Promise<LiveDocumentApplyResult> {
  let dir: string;
  try { dir = await sessionDir(input.sessionId); } catch { return { ok: false, reason: "session_unknown" }; }
  return withLock(dir, () => {
    const state = fold(input.sessionId, dir);
    if (input.chatId !== undefined && state.meta.chatId !== input.chatId) return { ok: false, reason: "session_not_in_this_chat" };
    if (state.meta.closed) return { ok: false, reason: "session_closed" };
    const checked = validateLiveDocumentOps(input.ops, state.meta.format);
    if (!checked.ok) return { ok: false, reason: checked.reason, ...(checked.detail ? { detail: checked.detail } : {}), revision: state.entries.length };
    // HWP binary keeps the template paragraph's shape: a heading cannot be expressed, so the model never claims one.
    const ops: LiveDocumentOp[] = state.meta.format === "hwp"
      ? checked.ops.map((op) => op.op === "insert_paragraph" || op.op === "set_format" ? (({ heading: _heading, ...rest }) => rest)(op) as LiveDocumentOp : op)
      : state.meta.format === "pptx" ? withoutTypedBullets(state.model, checked.ops) : checked.ops;
    if (state.meta.format === "hwp" && ops.some((op) => op.op === "set_format" && op.format.fill !== undefined)) {
      return { ok: false, reason: "op_unsupported_for_format", detail: "background colours are not written to HWP binary; create an .hwpx copy with document.create for that", revision: state.entries.length };
    }
    if (state.meta.format === "hwp" && ops.some((op) => op.op === "insert_paragraph" && op.pageBreak)) {
      return { ok: false, reason: "op_unsupported_for_format", detail: "page breaks are not written to HWP binary; create an .hwpx copy with document.create for that", revision: state.entries.length };
    }
    if (ops.some((op) => op.op === "set_format" && !Object.keys(op.format).length && op.heading === undefined)) {
      return { ok: false, reason: "op_unsupported_for_format", detail: "headings are not available in HWP binary; set size/bold instead", revision: state.entries.length };
    }
    const revision = state.entries.length;
    if (input.baseRevision !== undefined && input.baseRevision < revision) {
      const newer = new Set(state.entries.slice(input.baseRevision).flatMap((entry) => entry.ops.flatMap(liveDocumentOpTargets)));
      const clash = ops.flatMap(liveDocumentOpTargets).filter((target) => newer.has(target));
      if (clash.length) return { ok: false, reason: "revision_conflict", detail: `changed since revision ${input.baseRevision}: ${[...new Set(clash)].slice(0, 10).join(", ")}`, revision };
    }
    const seq = revision + 1;
    const assigned = assignLiveDocumentIds(ops, seq);
    let model: LiveDocumentModel;
    try { model = applyLiveDocumentOps(state.model, assigned.ops); } catch (error) {
      if (error instanceof LiveDocumentOpError) return { ok: false, reason: error.reason, ...(error.detail ? { detail: error.detail } : {}), revision };
      throw error;
    }
    const entry: LiveDocumentEntry = { seq, at: new Date().toISOString(), actor: input.actor, ops: assigned.ops };
    fs.appendFileSync(path.join(dir, "journal.jsonl"), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    state.entries.push(entry);
    state.model = model;
    state.journalBytes = fs.statSync(path.join(dir, "journal.jsonl")).size;
    return { ok: true, revision: seq, created: assigned.created };
  });
}

/** Text fingerprint used to verify a save: the written file must read back as the model it was written from. */
export function liveDocumentFingerprint(model: LiveDocumentModel): string {
  // Numbers are compared by presence only: the file shows them through its number format (1,234 / 50% / 45,000원), the
  // model holds what was typed. A cell that holds a number (n) is a number whatever its display.
  if (model.kind === "sheet") return JSON.stringify(model.sheets.map((sheet) => [sheet.name, Object.entries(sheet.cells)
    .filter(([, cell]) => cell.v !== "" || cell.f)
    .map(([address, cell]) => [address, cell.f !== undefined ? `=${cell.f}` : cell.n !== undefined || /^[-+]?[\d.,]+%?$|^\d{4}-\d{2}-\d{2}/.test(cell.v.trim()) ? "#" : cell.v]).sort()]));
  if (model.kind === "slides") return JSON.stringify(model.slides.map((slide) => slide.shapes.filter((shape) => shape.role !== "object").map((shape) => shape.text)));
  // Empty paragraphs are layout (Word needs one after a table that ends the body), not content.
  return JSON.stringify(model.blocks.filter((block) => block.type !== "paragraph" || block.text !== "").map((block) => block.type === "paragraph" ? block.text : block.type === "table" ? block.rows.map((row) => row.map((cell) => cell?.text ?? null)) : block.type));
}

export async function saveLiveDocument(input: { sessionId: string; chatId?: string }): Promise<{ ok: true; revision: number; sha256: string; path: string } | { ok: false; reason: string; detail?: string }> {
  const result = await saveLiveDocumentReportingWrite(input);
  if (!result.ok) return result;
  const { written: _written, ...saved } = result;
  return saved;
}

/** saveLiveDocument, also saying whether this call put bytes on disk (false: nothing new since the last save, file present). */
export async function saveLiveDocumentReportingWrite(input: { sessionId: string; chatId?: string }): Promise<{ ok: true; revision: number; sha256: string; path: string; written: boolean } | { ok: false; reason: string; detail?: string }> {
  let dir: string;
  try { dir = await sessionDir(input.sessionId); } catch { return { ok: false, reason: "session_unknown" }; }
  return withLock(dir, () => {
    const state = fold(input.sessionId, dir);
    const meta = state.meta;
    if (input.chatId !== undefined && meta.chatId !== input.chatId) return { ok: false, reason: "session_not_in_this_chat" };
    const revision = state.entries.length;
    let onDisk: Buffer | null = null;
    try { onDisk = fs.readFileSync(meta.path); } catch { /* deleted: writing recreates it */ }
    if (onDisk && sha256(onDisk) !== meta.savedSha256) return { ok: false, reason: "file_changed_on_disk", detail: "the file was changed outside this session since it was opened or last saved" };
    if (revision === meta.savedRevision && onDisk) return { ok: true, revision, sha256: meta.savedSha256, path: meta.path, written: false };
    const codec = LIVE_DOCUMENT_CODECS[meta.format];
    const source = fs.readFileSync(path.join(dir, "source.bin"));
    let output: Uint8Array;
    try { output = codec.write(source, state.original, state.model); } catch (error) {
      return { ok: false, reason: "save_failed", detail: error instanceof Error ? error.message.slice(0, 300) : "codec failed" };
    }
    try {
      const reread = codec.parse(output);
      if (liveDocumentFingerprint(reread) !== liveDocumentFingerprint(state.model)) return { ok: false, reason: "save_verification_failed", detail: "the written file does not read back as the edited document; nothing was written" };
    } catch (error) {
      return { ok: false, reason: "save_verification_failed", detail: error instanceof Error ? error.message.slice(0, 300) : "re-read failed" };
    }
    const tmp = path.join(path.dirname(meta.path), `.${path.basename(meta.path)}.agentlas-${process.pid}.tmp`);
    try {
      fs.writeFileSync(tmp, output);
      fs.renameSync(tmp, meta.path);
    } catch (error) {
      // Windows: Excel/Word/Hancom keep the file locked while it is open (EBUSY/EPERM); a read-only folder lands here too.
      try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
      const code = (error as NodeJS.ErrnoException).code ?? "";
      return { ok: false, reason: ["EBUSY", "EPERM", "EACCES"].includes(code) ? "file_locked" : "save_failed", detail: code || (error instanceof Error ? error.message.slice(0, 200) : "write failed") };
    }
    const digest = sha256(output);
    writeMeta(dir, { ...meta, savedRevision: revision, savedSha256: digest });
    return { ok: true, revision, sha256: digest, path: meta.path, written: true };
  });
}

export async function closeLiveDocument(sessionId: string): Promise<boolean> {
  let dir: string;
  try { dir = await sessionDir(sessionId); } catch { return false; }
  return withLock(dir, () => {
    const meta = readMeta(dir);
    if (!meta.closed) writeMeta(dir, { ...meta, closed: true });
    cache.delete(sessionId);
    return true;
  });
}

export async function liveDocumentRoot(): Promise<string> {
  return root();
}

/** Test seam: forget folded state so the next read starts from disk. */
export function resetLiveDocumentCacheForTests(): void {
  cache.clear();
}
