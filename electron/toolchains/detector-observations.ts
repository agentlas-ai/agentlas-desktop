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

export const TOOLCHAIN_DETECTOR_GRAPH_PREFIX = "toolchain.detector.graph.v1:";

/** A graph One saved for one piece of work: its purpose sentence and its structure (shared/graph-structure.ts). */
export interface GraphStructureObservation { graphId: string; task: string; chatId: string | null; at: string; fingerprint: string; steps: string[] }

/**
 * Called when One saves a new input-triggered graph (one/graph-dispatch.ts) and once for graphs saved before this
 * existed (one/ephemeral-graphs.ts). Keyed by the save time, one row per graph. Never throws into the caller.
 */
export function recordGraphStructureObservation(input: GraphStructureObservation, now = new Date()): boolean {
  try {
    const task = input.task.trim().slice(0, 1000);
    if (task.length < 8 || !input.graphId || !/^[a-f0-9]{24}$/.test(input.fingerprint)) return false;
    const db = getDb();
    const key = `${TOOLCHAIN_DETECTOR_GRAPH_PREFIX}${input.at}:${input.graphId}`;
    const value = JSON.stringify({ ...input, task, steps: input.steps.slice(0, 32) } satisfies GraphStructureObservation);
    const inserted = db.prepare("INSERT OR IGNORE INTO meta(key,value) VALUES(?,?)").run(key, value).changes === 1;
    const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86_400_000).toISOString();
    db.prepare("DELETE FROM meta WHERE key >= ? AND key < ?").run(TOOLCHAIN_DETECTOR_GRAPH_PREFIX, `${TOOLCHAIN_DETECTOR_GRAPH_PREFIX}${cutoff}`);
    return inserted;
  } catch (error) {
    console.warn("[toolchain-detector] graph observation not recorded:", error instanceof Error ? error.message : error);
    return false;
  }
}

export function readGraphStructureObservations(since: string, limit: number): Array<GraphStructureObservation & { id: string }> {
  const rows = getDb().prepare("SELECT key, value FROM meta WHERE key >= ? AND key < ? ORDER BY key DESC LIMIT ?")
    .all(`${TOOLCHAIN_DETECTOR_GRAPH_PREFIX}${since}`, `${TOOLCHAIN_DETECTOR_GRAPH_PREFIX}\uffff`, limit) as Array<{ key: string; value: string }>;
  return rows.flatMap(row => {
    try {
      const value = JSON.parse(row.value) as GraphStructureObservation;
      return typeof value.task === "string" && typeof value.at === "string" && typeof value.fingerprint === "string" && Array.isArray(value.steps)
        ? [{ ...value, id: `graph:${value.graphId}` }] : [];
    } catch { return []; }
  });
}

const PAIR_WINDOW_MS = 30 * 60_000;

/**
 * One occurrence must count once. A graph saved within 30 minutes after an empty search in the same conversation is that
 * search's work: the graph (with its structure) stays and the nearest such search is dropped. Each graph absorbs at most
 * one search.
 */
export function pairGraphObservations<M extends ToolchainSearchMiss, G extends GraphStructureObservation>(misses: readonly M[], graphs: readonly G[]):
  { misses: M[]; graphs: G[] } {
  const absorbed = new Set<M>();
  for (const graph of [...graphs].sort((a, b) => a.at.localeCompare(b.at))) {
    if (!graph.chatId) continue;
    const at = Date.parse(graph.at);
    const nearest = misses.filter(miss => !absorbed.has(miss) && miss.chatId === graph.chatId
      && at - Date.parse(miss.at) >= 0 && at - Date.parse(miss.at) <= PAIR_WINDOW_MS)
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
    if (nearest) absorbed.add(nearest);
  }
  return { misses: misses.filter(miss => !absorbed.has(miss)), graphs: [...graphs] };
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
