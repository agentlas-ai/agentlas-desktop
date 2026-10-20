import { getDb as getProductDb } from "../store/db";
import { getMemoryDb } from "../memory/database";
import { AGENT_LEARNING_POLICY, type LessonEvidence } from "../../shared/agent-learning-policy";

/**
 * Which runs a lesson came from, and what the host recorded in them.
 *
 * Each learning names its origin in evidence: a memory ticket id (mtk_…, the ticket knows its run), a run reference
 * (run:<id>), or consolidation pointers (supersedes:<id>) to the learnings a rule replaced. Following those pointers gives
 * the distinct runs behind a rule even after dreaming merged its sources. Only counts leave this module.
 */
const POINTER_DEPTH = 6;

function parseEvidence(json: string | null): string[] {
  try { const value: unknown = JSON.parse(json ?? "[]"); return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
  catch { return []; }
}

/** Distinct run ids behind the given learnings. */
export function lessonRunIds(memoryIds: readonly string[]): Set<string> {
  const db = getMemoryDb();
  const runs = new Set<string>();
  const seen = new Set<string>();
  const entry = db.prepare("SELECT evidence_json FROM memory_entries WHERE id = ?");
  const ticket = db.prepare("SELECT run_id FROM memory_tickets WHERE ticket_id = ?");
  const walk = (id: string, depth: number): void => {
    if (seen.has(id) || depth > POINTER_DEPTH || runs.size >= AGENT_LEARNING_POLICY.maxRunsTracked) return;
    seen.add(id);
    const row = entry.get(id) as { evidence_json: string | null } | undefined;
    if (!row) return;
    for (const line of parseEvidence(row.evidence_json)) {
      if (line.startsWith("run:")) runs.add(line.slice(4));
      else if (line.startsWith("mtk_")) { const found = ticket.get(line) as { run_id: string | null } | undefined; if (found?.run_id) runs.add(found.run_id); }
      else if (line.startsWith("supersedes:")) walk(line.slice("supersedes:".length), depth + 1);
    }
  };
  for (const id of memoryIds) walk(id, 0);
  return runs;
}

const CHUNK = 200;

/**
 * What the host recorded in those runs. Never throws: a store that cannot answer leaves the counts at zero.
 * `events: false` counts the runs only (memory store lookups); the run ledger is read when the owner opens the agent or a
 * change is prepared, not for every roster row.
 */
export function lessonEvidence(memoryIds: readonly string[], options: { events?: boolean } = {}): LessonEvidence {
  const runIds = [...lessonRunIds(memoryIds)];
  const evidence: LessonEvidence = { runs: runIds.length, ownerCorrections: 0, failures: 0, samples: [] };
  if (!runIds.length || options.events === false) return evidence;
  try {
    const db = getProductDb();
    for (let start = 0; start < runIds.length; start += CHUNK) {
      const part = runIds.slice(start, start + CHUNK);
      const marks = part.map(() => "?").join(",");
      const rows = db.prepare(`SELECT kind, ts, json_extract(payload_json, '$.errorCode') AS code FROM run_events
        WHERE run_id IN (${marks}) AND kind IN ('user_steering', 'invoke_failed', 'mcp_error') ORDER BY ts DESC`)
        .all(...part) as Array<{ kind: string; ts: string; code: string | null }>;
      for (const row of rows) {
        if (row.kind === "user_steering") evidence.ownerCorrections += 1;
        else {
          evidence.failures += 1;
          if (evidence.samples.length < 5) evidence.samples.push({ at: row.ts, kind: row.kind, code: typeof row.code === "string" ? row.code.slice(0, 80) : null });
        }
      }
    }
  } catch { /* Counts stay as far as they got. */ }
  return evidence;
}
