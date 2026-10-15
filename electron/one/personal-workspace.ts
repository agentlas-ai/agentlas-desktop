import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { userDataPath } from "../runtime-paths";
import { getDb } from "../store/db";

/*
 * The personal One's own folder (docs native-harness 21 G2):
 *   <userData>/one/<oneId>/personal/output/<chatId>/   the personal conversation's working folder (its runs' files)
 *   <userData>/one/<oneId>/personal/sessions/<chatId>/ the raw conversation export (transcript.jsonl + manifest.json)
 * SQLite stays the authority for execution and recovery; the export is a revisioned copy that archive, compaction or
 * closing a window never deletes. ~/.agentlas/one stays the rebuildable, transcript-free view.
 */

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/;
const EXPORT_SCHEMA = "agentlas.personal-session-export.v1";

function safeId(value: string, label: string): string {
  if (!SAFE_ID.test(value)) throw new Error(`personal_workspace_${label}_invalid`);
  return value;
}

export function personalOneRoot(oneId: string): string {
  return userDataPath("one", safeId(oneId, "one_id"), "personal");
}

export interface PersonalOneWorkspace { root: string; output: string; sessions: string }

export function ensurePersonalOneWorkspace(oneId: string, chatId: string): PersonalOneWorkspace {
  const root = personalOneRoot(oneId);
  const id = safeId(chatId, "chat_id");
  const workspace = { root, output: path.join(root, "output", id), sessions: path.join(root, "sessions", id) };
  for (const dir of [workspace.output, workspace.sessions]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return workspace;
}

/**
 * Writes the conversation's messages as transcript.jsonl with a manifest (revision = message count, sha256 digest).
 * Unchanged content is not rewritten; a crash mid-write leaves the previous export (temp file + rename).
 */
export function exportPersonalSession(oneId: string, chatId: string): { revision: number; digest: string; written: boolean } {
  const { sessions } = ensurePersonalOneWorkspace(oneId, chatId);
  const rows = getDb().prepare("SELECT id, role, text, created_at AS createdAt FROM chat_messages WHERE chat_id = ? ORDER BY created_at, rowid")
    .all(chatId) as Array<{ id: string; role: string; text: string; createdAt: string }>;
  const body = rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : "");
  const digest = createHash("sha256").update(body).digest("hex");
  const manifestPath = path.join(sessions, "manifest.json");
  try {
    const prior = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { digest?: string };
    if (prior.digest === digest) return { revision: rows.length, digest, written: false };
  } catch { /* first export */ }
  const write = (file: string, content: string) => {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  write(path.join(sessions, "transcript.jsonl"), body);
  write(manifestPath, JSON.stringify({ schema: EXPORT_SCHEMA, chatId, revision: rows.length, digest, exportedAt: new Date().toISOString() }, null, 2));
  return { revision: rows.length, digest, written: true };
}
