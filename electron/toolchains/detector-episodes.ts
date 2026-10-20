// Episode half of the repeated-work detector (detector.ts): turns the tool-use events of chat runs into stored episodes.
//
// Why a store: the 3-day run-detail trim (storage/run-detail-retention.ts) deletes the tool-call rows of settled chat runs, so
// an operation repeated over weeks can only be counted from what was kept at the time. Each harvest reads the runs that
// have new tool events since the last one, rebuilds their episodes (shared/tool-use-episodes.ts) and keeps a compact row per
// run and surface: the flow tokens the comparison needs and the readable, secret-free steps the judgment shows.
// Automation runs are not read: their tool steps are already a saved graph.

import { createHash } from "node:crypto";
import { getDb } from "../store/db";
import { buildToolUseEpisodes, toolUseCallsFromEvents } from "../../shared/tool-use-episodes";
import type { StoredToolUseEpisode } from "../../shared/tool-use-signals";

export const TOOL_USE_EPISODE_PREFIX = "toolchain.detector.episode.v1:";
/**
 * The whole scripts of a surface's newest runs, kept apart from the compact episode rows: what the generalizer builds a Toolchain
 * from. Keyed by surface first, so keeping the newest few per surface is one range read.
 */
const EPISODE_CODE_PREFIX = "toolchain.detector.episode-code.v1:";
const CODE_EXEMPLARS_PER_SURFACE = 3;
const RETIRED_GRAPH_PREFIX = "toolchain.detector.graph.v1:";
const CURSOR_KEY = "toolchain.detector.episodes.cursor.v1";
const RETENTION_DAYS = 30;
const INITIAL_WINDOW_DAYS = 21;
const MAX_ROWS = 6000;
const MAX_RUNS_PER_HARVEST = 400;
const MAX_STORED_STEPS = 24;
const STORED_DETAIL_CHARS = 220;

function surfaceId(surface: string): string { return createHash("sha256").update(surface, "utf8").digest("hex").slice(0, 8); }

export interface HarvestResult { runs: number; stored: number; pruned: number }

/** Reads the chat runs with tool events newer than the last harvest, oldest first, and keeps their episodes. Never throws. */
export function harvestToolUseEpisodes(now = new Date()): HarvestResult {
  const result: HarvestResult = { runs: 0, stored: 0, pruned: 0 };
  try {
    const db = getDb();
    // Graph-structure observations fed this detector until a recurring graph structure was understood to
    // be a Graph, not a Toolchain. Their rows are inert now.
    db.prepare("DELETE FROM meta WHERE key >= ? AND key < ?").run(RETIRED_GRAPH_PREFIX, `${RETIRED_GRAPH_PREFIX}\uffff`);
    const cursor = (db.prepare("SELECT value FROM meta WHERE key=?").get(CURSOR_KEY) as { value: string } | undefined)?.value
      ?? new Date(now.getTime() - INITIAL_WINDOW_DAYS * 86_400_000).toISOString();
    const runs = db.prepare(`SELECT run_id AS runId, chat_id AS chatId, MAX(ts) AS last FROM run_events
      WHERE kind = 'mcp_tool-use' AND automation_id IS NULL AND node_id IS NULL AND ts > ? GROUP BY run_id ORDER BY last ASC LIMIT ?`)
      .all(cursor, MAX_RUNS_PER_HARVEST) as Array<{ runId: string; chatId: string | null; last: string }>;
    if (!runs.length) return result;
    const events = db.prepare("SELECT ts, payload_json AS payload FROM run_events WHERE run_id = ? AND kind = 'mcp_tool-use' ORDER BY seq ASC");
    const put = db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)");
    db.transaction(() => {
      for (const run of runs) {
        const calls = toolUseCallsFromEvents(events.all(run.runId) as Array<{ ts: string; payload: string }>);
        for (const episode of buildToolUseEpisodes({ runId: run.runId, chatId: run.chatId }, calls)) {
          const stored: StoredToolUseEpisode = { id: `${episode.runId}:${surfaceId(episode.surface)}`, runId: episode.runId, chatId: episode.chatId,
            surface: episode.surface, at: episode.startedAt, tokens: episode.tokens, actionSteps: episode.actionSteps, failed: episode.failed,
            steps: episode.steps.slice(0, MAX_STORED_STEPS).map(step => ({ op: step.op, template: step.template, detail: step.detail.slice(0, STORED_DETAIL_CHARS), count: step.count })) };
          put.run(`${TOOL_USE_EPISODE_PREFIX}${episode.startedAt}:${stored.id}`, JSON.stringify(stored));
          result.stored++;
          const coded = episode.failed ? [] : episode.steps.filter(step => step.code);
          if (coded.length) keepCodeExemplar(db, episode.surface, episode.runId, episode.startedAt, episode.steps);
        }
      }
      put.run(CURSOR_KEY, runs[runs.length - 1].last);
    })();
    result.runs = runs.length;
    const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86_400_000).toISOString();
    result.pruned += db.prepare("DELETE FROM meta WHERE key >= ? AND key < ?").run(TOOL_USE_EPISODE_PREFIX, `${TOOL_USE_EPISODE_PREFIX}${cutoff}`).changes;
    const over = (db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key >= ? AND key < ?").get(TOOL_USE_EPISODE_PREFIX, `${TOOL_USE_EPISODE_PREFIX}￿`) as { n: number }).n - MAX_ROWS;
    if (over > 0) result.pruned += db.prepare(`DELETE FROM meta WHERE key IN (SELECT key FROM meta WHERE key >= ? AND key < ? ORDER BY key ASC LIMIT ?)`)
      .run(TOOL_USE_EPISODE_PREFIX, `${TOOL_USE_EPISODE_PREFIX}￿`, over).changes;
  } catch (error) {
    console.warn("[toolchain-detector] episode harvest skipped:", error instanceof Error ? error.message : error);
  }
  return result;
}

interface CodeExemplar { surface: string; runId: string; at: string; steps: Array<{ op: string; detail: string; code?: string }> }

function keepCodeExemplar(db: ReturnType<typeof getDb>, surface: string, runId: string, at: string, steps: ReadonlyArray<{ op: string; detail: string; code?: string }>): void {
  const base = `${EPISODE_CODE_PREFIX}${surfaceId(surface)}:`;
  db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)").run(`${base}${at}:${runId}`, JSON.stringify({ surface, runId, at,
    steps: steps.slice(0, MAX_STORED_STEPS).map(step => ({ op: step.op, detail: step.detail.slice(0, STORED_DETAIL_CHARS), ...(step.code ? { code: step.code } : {}) })) } satisfies CodeExemplar));
  const keys = db.prepare("SELECT key FROM meta WHERE key >= ? AND key < ? ORDER BY key DESC").all(base, `${base}\uffff`) as Array<{ key: string }>;
  for (const row of keys.slice(CODE_EXEMPLARS_PER_SURFACE)) db.prepare("DELETE FROM meta WHERE key=?").run(row.key);
}

/** The newest successful runs of a surface with their whole scripts, newest first. */
export function readCodeExemplars(surface: string, limit = CODE_EXEMPLARS_PER_SURFACE): CodeExemplar[] {
  const base = `${EPISODE_CODE_PREFIX}${surfaceId(surface)}:`;
  const rows = getDb().prepare("SELECT value FROM meta WHERE key >= ? AND key < ? ORDER BY key DESC LIMIT ?").all(base, `${base}\uffff`, limit) as Array<{ value: string }>;
  return rows.flatMap(row => { try { const value = JSON.parse(row.value) as CodeExemplar; return value.surface === surface ? [value] : []; } catch { return []; } });
}

export function readToolUseEpisodes(since: string): StoredToolUseEpisode[] {
  const rows = getDb().prepare("SELECT value FROM meta WHERE key >= ? AND key < ? ORDER BY key DESC")
    .all(`${TOOL_USE_EPISODE_PREFIX}${since}`, `${TOOL_USE_EPISODE_PREFIX}￿`) as Array<{ value: string }>;
  return rows.flatMap(row => {
    try {
      const value = JSON.parse(row.value) as StoredToolUseEpisode;
      return typeof value.surface === "string" && typeof value.runId === "string" && Array.isArray(value.tokens) && Array.isArray(value.steps) ? [value] : [];
    } catch { return []; }
  });
}
