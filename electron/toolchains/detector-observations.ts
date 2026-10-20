// Observation half of the repeated-work detector (detector.ts). Kept free of authoring imports because the One team
// dispatch that records it runs in Desktop Main and in agentlasd; both write the same shared SQLite rows.

import { randomUUID } from "node:crypto";
import { getDb } from "../store/db";

export const TOOLCHAIN_DETECTOR_MISS_PREFIX = "toolchain.detector.miss.v1:";
const RETENTION_DAYS = 30;

export interface ToolchainSearchMiss { task: string; chatId: string | null; at: string }

/** Called by the One team dispatch when toolchain_search returned nothing. Never throws into the caller. */
export function recordToolchainSearchMiss(input: { task: unknown; chatId: string | null }, now = new Date()): void {
  try {
    const task = typeof input.task === "string" ? input.task.trim().slice(0, 1000) : "";
    if (task.length < 8) return;
    const at = now.toISOString();
    const db = getDb();
    db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)")
      .run(`${TOOLCHAIN_DETECTOR_MISS_PREFIX}${at}:${randomUUID().slice(0, 8)}`, JSON.stringify({ task, chatId: input.chatId, at } satisfies ToolchainSearchMiss));
    // Keys sort by time, so retention is one range delete on the primary key.
    const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86_400_000).toISOString();
    db.prepare("DELETE FROM meta WHERE key >= ? AND key < ?").run(TOOLCHAIN_DETECTOR_MISS_PREFIX, `${TOOLCHAIN_DETECTOR_MISS_PREFIX}${cutoff}`);
  } catch (error) {
    console.warn("[toolchain-detector] miss not recorded:", error instanceof Error ? error.message : error);
  }
}

export function readToolchainSearchMisses(since: string, limit: number): Array<ToolchainSearchMiss & { id: string }> {
  const rows = getDb().prepare("SELECT key, value FROM meta WHERE key >= ? AND key < ? ORDER BY key DESC LIMIT ?")
    .all(`${TOOLCHAIN_DETECTOR_MISS_PREFIX}${since}`, `${TOOLCHAIN_DETECTOR_MISS_PREFIX}￿`, limit) as Array<{ key: string; value: string }>;
  return rows.flatMap(row => {
    try {
      const value = JSON.parse(row.value) as ToolchainSearchMiss;
      return typeof value.task === "string" && typeof value.at === "string" ? [{ ...value, id: row.key.slice(TOOLCHAIN_DETECTOR_MISS_PREFIX.length) }] : [];
    } catch { return []; }
  });
}
