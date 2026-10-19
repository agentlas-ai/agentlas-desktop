import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";

/**

















 */

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

interface TranscriptStore {
  /** chat_runtime_sessions.kind of this runtime's bindings. */
  kind: string;
  /** Folders under userData that hold this runtime's transcripts. */
  roots: string[][];
  /** Session id named by a transcript entry (file or same-named folder). */
  sessionIdOf(name: string): string | null;
  maxDepth: number;
  /** A folder named by a session id belongs to that session (Claude subagents, Copilot session-state). */
  dirEntries: boolean;
}

export const CLI_TRANSCRIPT_STORES: TranscriptStore[] = [
  {
    kind: "codex",
    roots: [["codex-product-home", "store", "sessions"], ["codex-product-home", "store", "archived_sessions"]],
    sessionIdOf: (name) => new RegExp(`^rollout-.*-(${UUID})\\.jsonl$`, "i").exec(name)?.[1]?.toLowerCase() ?? null,
    maxDepth: 4,
    dirEntries: false,
  },
  {
    kind: "claude-code",
    roots: [["claude-product-home", "projects"]],
    sessionIdOf: (name) => new RegExp(`^(${UUID})(?:\\.jsonl)?$`, "i").exec(name)?.[1]?.toLowerCase() ?? null,
    maxDepth: 1,
    dirEntries: true,
  },
  {
    

    kind: "acp:github-copilot-cli",
    roots: [["copilot-product-home"]],
    sessionIdOf: (name) => new RegExp(`^(${UUID})$`, "i").exec(name)?.[1]?.toLowerCase() ?? null,
    maxDepth: 2,
    dirEntries: true,
  },
];

/**






 */
interface TranscriptEntry { paths: string[]; topMs: number; tree?: { newestMs: number; bytes: number } }

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

async function entryTree(entry: TranscriptEntry): Promise<{ newestMs: number; bytes: number }> {
  if (!entry.tree) {
    const tree = { newestMs: 0, bytes: 0 };
    for (const target of entry.paths) {
      const stat = await treeStat(target);
      tree.newestMs = Math.max(tree.newestMs, stat.newestMs);
      tree.bytes += stat.bytes;
    }
    entry.tree = tree;
  }
  return entry.tree;
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
      if (id && (entry.isFile() || (entry.isDirectory() && store.dirEntries))) {
        let topMs: number;
        try { topMs = (await fs.promises.lstat(full)).mtimeMs; } catch { continue; }
        const current = index.get(id) ?? { paths: [], topMs: 0 };
        current.paths.push(full);
        current.topMs = Math.max(current.topMs, topMs);
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
  /** Idle bindings whose transcript no longer exists anywhere we index; resuming them would fail. */
  staleBindings: number;
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
  const result: CliTranscriptRetentionResult = { sessions: 0, staleBindings: 0, orphans: 0, files: 0, bytes: 0 };
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
      result.bytes += (await entryTree(entry)).bytes;
    };

    // The index was read asynchronously: right before removing, confirm that no binding
    // used the session since and that nothing in its trees was written since (nested
    // files too: a folder's own mtime does not change when a file inside is rewritten).
    const latestUse = input.db.prepare(
      "SELECT max(updated_at) AS used FROM chat_runtime_sessions WHERE kind = ? AND lower(session_id) = ?",
    );
    const stillIdle = async (id: string, entry: TranscriptEntry): Promise<boolean> => {
      const used = (latestUse.get(store.kind, id) as { used: string | null } | undefined)?.used ?? null;
      if (used !== null && used >= cutoffIso) return false;
      for (const target of entry.paths) {
        if ((await treeStat(target)).newestMs >= cutoffMs) return false;
      }
      return true;
    };
    const retired = new Set<string>();
    for (const row of storeRows) {
      const id = row.session_id.toLowerCase();
      if (live.has(id)) continue;
      const entry = index.get(id);
      if (entry && entry.topMs < cutoffMs && (await entryTree(entry)).newestMs < cutoffMs && await stillIdle(id, entry)) {
        await removeEntry(entry);
        index.delete(id);
        retired.add(id);
        result.sessions += 1;
      }
      if (!entry && !retired.has(id)) {
        

        if (!input.dryRun) input.clearSession(row.chat_id, row.kind, row.agent_id ?? "");
        result.staleBindings += 1;
        continue;
      }
      // Every binding of a removed transcript goes, including a second chat sharing the thread.
      if (retired.has(id) && !input.dryRun) input.clearSession(row.chat_id, row.kind, row.agent_id ?? "");
    }
    for (const [id, entry] of index) {
      if (bound.has(id) || entry.topMs >= cutoffMs || (await entryTree(entry)).newestMs >= cutoffMs) continue;
      const nowBound = latestUse.get(store.kind, id) as { used: string | null } | undefined;
      if (nowBound?.used || !(await stillIdle(id, entry))) continue;
      await removeEntry(entry);
      result.orphans += 1;
    }
  }
  return result;
}
