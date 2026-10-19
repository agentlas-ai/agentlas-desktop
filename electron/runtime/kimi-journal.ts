

















import fs from "node:fs";
import path from "node:path";

const KIMI_SESSION_ID_RE = /^session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Journal layouts this reader was measured against; any other version is never attested. */
const KIMI_JOURNAL_VERSIONS: ReadonlySet<string> = new Set(["1.4"]);

/** The session directory under <home>/sessions/<workspace>/, or null when none holds it. */
function kimiSessionDir(home: string, sessionId: string): string | null {
  const root = path.join(home, "sessions");
  let workspaces: string[];
  try { workspaces = fs.readdirSync(root); } catch { return null; }
  for (const workspace of workspaces) {
    const dir = path.join(root, workspace, sessionId);
    try { if (fs.statSync(dir).isDirectory()) return dir; } catch { /* not this workspace */ }
  }
  return null;
}

/**
 * Whether Kimi no longer holds a stored session, from the filesystem only: the sessions store exists and no workspace
 * folder in it has the session directory. An id of another shape, or a store this build cannot read, answers false.
 */
export function kimiSessionGone(home: string, sessionId: string): boolean {
  if (!KIMI_SESSION_ID_RE.test(sessionId)) return false;
  try { if (!fs.statSync(path.join(home, "sessions")).isDirectory()) return false; } catch { return false; }
  return kimiSessionDir(home, sessionId) === null;
}

export interface KimiJournalCursor { home: string; sessionId: string; offset: number }

/** Where this turn's records will start: the journal's current size (0 before the session wrote one). */
export function kimiJournalCursor(home: string, sessionId: string): KimiJournalCursor | null {
  if (!KIMI_SESSION_ID_RE.test(sessionId)) return null;
  const dir = kimiSessionDir(home, sessionId);
  let offset = 0;
  if (dir) { try { offset = fs.statSync(path.join(dir, "agents", "main", "wire.jsonl")).size; } catch { offset = 0; } }
  return { home, sessionId, offset };
}

/**
 * completed: the turn's last step ended with finishReason "end_turn".
 * truncated: its last step ended with "max_tokens" (the reply was cut at the output limit).
 * failed: its last step began and never ended.
 * unattested: no journal of a known layout, no turn record after the cursor (a local slash command), or a last step
 *             that ended some other way; the caller keeps the conservative reading.
 */
export type KimiTurnOutcome = "completed" | "truncated" | "failed" | "unattested";

function readTurn(cursor: KimiJournalCursor): { outcome: KimiTurnOutcome; settled: boolean } {
  const dir = kimiSessionDir(cursor.home, cursor.sessionId);
  if (!dir) return { outcome: "unattested", settled: false };
  let bytes: Buffer;
  try { bytes = fs.readFileSync(path.join(dir, "agents", "main", "wire.jsonl")); } catch { return { outcome: "unattested", settled: false }; }
  const firstLine = bytes.subarray(0, Math.max(0, bytes.indexOf(0x0a))).toString("utf8");
  try {
    const meta = JSON.parse(firstLine) as { type?: unknown; protocol_version?: unknown };
    if (meta.type !== "metadata" || typeof meta.protocol_version !== "string" || !KIMI_JOURNAL_VERSIONS.has(meta.protocol_version)) {
      return { outcome: "unattested", settled: true };
    }
  } catch { return { outcome: "unattested", settled: false }; }
  const lines = bytes.subarray(Math.min(cursor.offset, bytes.length)).toString("utf8").split("\n");
  let promptSeen = false;
  let last: { type: string; finishReason?: unknown } | null = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    let record: { type?: unknown; event?: { type?: unknown; finishReason?: unknown } };
    try { record = JSON.parse(line); } catch { continue; } // a torn last line is still being written
    if (record.type === "turn.prompt") { promptSeen = true; last = null; continue; }
    if (!promptSeen || record.type !== "context.append_loop_event") continue;
    const type = record.event?.type;
    if (type === "step.begin" || type === "step.end") last = { type, finishReason: record.event?.finishReason };
  }
  if (!promptSeen || !last) return { outcome: "unattested", settled: false };
  if (last.type === "step.begin") return { outcome: "failed", settled: false };
  if (last.finishReason === "end_turn") return { outcome: "completed", settled: true };
  if (last.finishReason === "max_tokens") return { outcome: "truncated", settled: true };
  return { outcome: "unattested", settled: false };
}

/**
 * How the turn after `cursor` ended, read from Kimi's journal once the ACP response said end_turn. The journal lands
 * asynchronously, so an unsettled reading is re-read until `waitMs`: a finished step settles at once; a step that began
 * and is still open at the deadline is a failed turn (Kimi wrote no step end for it).
 */
export async function attestKimiTurn(cursor: KimiJournalCursor, opts: { waitMs?: number; pollMs?: number; signal?: AbortSignal } = {}): Promise<KimiTurnOutcome> {
  const deadline = Date.now() + (opts.waitMs ?? 3_000);
  for (;;) {
    const reading = readTurn(cursor);
    if (reading.settled || Date.now() >= deadline || opts.signal?.aborted) return reading.outcome;
    await new Promise((resolve) => setTimeout(resolve, opts.pollMs ?? 50));
  }
}
