import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";

/**
 * Removes CLI resume transcripts (Codex rollouts, Claude Code session files)
 * that Agentlas product runs wrote, for chats unused for `idleDays`. Owner
 * decision 2026-10-16: on the owner's Mac the Codex product store alone held
 * 6.9 GB.
 *
 * The Agentlas conversation is untouched. The chat's runtime-session binding
 * is cleared together with its files: an attended Codex turn that fails to
 * resume a missing thread surfaces an error, so a binding must never outlive
 * its transcript. With no binding, the next turn starts a fresh CLI session.
 *
 * Kept:
 * - any session a binding used within the window
 * - any transcript written within the window (a file in use is newer than its
 *   binding)
 * Transcripts no binding names (archived and unbound threads) go once their
 * files are older than the window.
 */

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

interface TranscriptStore {
  kind: string;
  /** Folders under userData that hold this runtime's transcripts. */
  roots: string[][];
  /** Session id named by a transcript entry (file or same-named folder). */
  sessionIdOf(name: string): string | null;
  maxDepth: number;
}

export const CLI_TRANSCRIPT_STORES: TranscriptStore[] = [
  {
    kind: "codex",
    roots: [["codex-product-home", "store", "sessions"], ["codex-product-home", "store", "archived_sessions"]],
    sessionIdOf: (name) => new RegExp(`^rollout-.*-(${UUID})\\.jsonl$`, "i").exec(name)?.[1]?.toLowerCase() ?? null,
    maxDepth: 4,
  },
  {
    kind: "claude-code",
    roots: [["claude-product-home", "projects"]],
    sessionIdOf: (name) => new RegExp(`^(${UUID})(?:\\.jsonl)?$`, "i").exec(name)?.[1]?.toLowerCase() ?? null,
    maxDepth: 1,
  },
];

interface TranscriptEntry { paths: string[]; newestMs: number; bytes: number }

// Asynchronous file access: this runs in the Desktop main process.
async function treeStat(target: string): Promise<{ newestMs: number; bytes: number }> {
  let newestMs = 0;
  let bytes = 0;
  const stack = [target];
  while (stack.length) {
    const current = stack.pop()!;
    let stat: fs.Stats;
    try { stat = await fs.promises.lstat(current); } catch { continue; }
    if (stat.isSymbolicLink()) continue;
    newestMs = Math.max(newestMs, stat.mtimeMs);
    if (!stat.isDirectory()) { bytes += stat.size; continue; }
    try { for (const name of await fs.promises.readdir(current)) stack.push(path.join(current, name)); } catch { /* unreadable */ }
  }
  return { newestMs, bytes };
}

async function indexStore(userDataRoot: string, store: TranscriptStore): Promise<Map<string, TranscriptEntry>> {
  const index = new Map<string, TranscriptEntry>();
  const visit = async (dir: string, depth: number): Promise<void> => {
    let entries: fs.Dirent[] = [];
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      const id = store.sessionIdOf(entry.name);
      if (id && (entry.isFile() || (entry.isDirectory() && store.kind === "claude-code"))) {
        const stat = await treeStat(full);
        const current = index.get(id) ?? { paths: [], newestMs: 0, bytes: 0 };
        current.paths.push(full);
        current.newestMs = Math.max(current.newestMs, stat.newestMs);
        current.bytes += stat.bytes;
        index.set(id, current);
      } else if (entry.isDirectory() && depth < store.maxDepth) {
        await visit(full, depth + 1);
      }
    }
  };
  for (const segments of store.roots) await visit(path.join(userDataRoot, ...segments), 0);
  return index;
}

export interface CliTranscriptRetentionResult {
  sessions: number;
  orphans: number;
  files: number;
  bytes: number;
}

export async function retireIdleCliTranscripts(input: {
  db: Database.Database;
  userDataRoot: string;
  idleDays: number;
  now?: number;
  dryRun?: boolean;
  clearSession: (chatId: string, kind: string, agentId: string) => void;
}): Promise<CliTranscriptRetentionResult> {
  const result: CliTranscriptRetentionResult = { sessions: 0, orphans: 0, files: 0, bytes: 0 };
  const now = input.now ?? Date.now();
  const cutoffMs = now - input.idleDays * 86_400_000;
  const cutoffIso = new Date(cutoffMs).toISOString();
  const rows = input.db.prepare(
    "SELECT chat_id, kind, agent_id, session_id, updated_at FROM chat_runtime_sessions",
  ).all() as Array<{ chat_id: string; kind: string; agent_id: string | null; session_id: string; updated_at: string | null }>;

  for (const store of CLI_TRANSCRIPT_STORES) {
    const index = await indexStore(input.userDataRoot, store);
    const storeRows = rows.filter((row) => row.kind === store.kind);
    // A session any binding used inside the window, or whose binding has no timestamp, is live.
    const live = new Set(storeRows
      .filter((row) => row.updated_at === null || row.updated_at >= cutoffIso)
      .map((row) => row.session_id.toLowerCase()));
    const bound = new Set(storeRows.map((row) => row.session_id.toLowerCase()));
    const removeEntry = async (entry: TranscriptEntry): Promise<void> => {
      for (const target of entry.paths) {
        if (!input.dryRun) {
          try { await fs.promises.rm(target, { recursive: true, force: true }); } catch { continue; }
        }
        result.files += 1;
      }
      result.bytes += entry.bytes;
    };

    // The index was read asynchronously: right before removing, confirm that no binding
    // used the session since and that its files were not written since.
    const latestUse = input.db.prepare(
      "SELECT max(updated_at) AS used FROM chat_runtime_sessions WHERE kind = ? AND lower(session_id) = ?",
    );
    const stillIdle = async (id: string, entry: TranscriptEntry): Promise<boolean> => {
      const used = (latestUse.get(store.kind, id) as { used: string | null } | undefined)?.used ?? null;
      if (used !== null && used >= cutoffIso) return false;
      for (const target of entry.paths) {
        try { if ((await fs.promises.lstat(target)).mtimeMs >= cutoffMs) return false; } catch { /* gone */ }
      }
      return true;
    };
    const retired = new Set<string>();
    for (const row of storeRows) {
      const id = row.session_id.toLowerCase();
      if (live.has(id)) continue;
      const entry = index.get(id);
      if (entry && entry.newestMs < cutoffMs && await stillIdle(id, entry)) {
        await removeEntry(entry);
        index.delete(id);
        retired.add(id);
        result.sessions += 1;
      }
      // Every binding of a removed transcript goes, including a second chat sharing the thread.
      if (retired.has(id) && !input.dryRun) input.clearSession(row.chat_id, row.kind, row.agent_id ?? "");
    }
    for (const [id, entry] of index) {
      if (bound.has(id) || entry.newestMs >= cutoffMs) continue;
      const nowBound = latestUse.get(store.kind, id) as { used: string | null } | undefined;
      if (nowBound?.used || !(await stillIdle(id, entry))) continue;
      await removeEntry(entry);
      result.orphans += 1;
    }
  }
  return result;
}
