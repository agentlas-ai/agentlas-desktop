import { getDb as getProductDb } from "../store/db";
import { getMemoryDb } from "../memory/database";
import { AGENT_LEARNING_POLICY, type LessonEvidence } from "../../shared/agent-learning-policy";

/**
 * Which runs a lesson came from, and what the host recorded in them.
 *
 * Each learning names its origin in evidence: a memory ticket id (mtk_…, the ticket knows its run), a run reference
 * (run:<id>), or consolidation pointers (supersedes:<id>) to the learnings a rule replaced. Following those pointers gives
 * the distinct runs behind a rule even after dreaming merged its sources. Only counts leave this module.
 *
 * The evidence list is only the writer's first sight of the lesson. When the same lesson comes back, the curator folds it
 * into the live row instead: an exact repeat appends its run/ticket to the row's origin links, and a restatement retires
 * the older row behind a `supersedes` link and edge. Those are read here too, so a lesson that returns is counted once per
 * run it came back from rather than collapsing to the single run the surviving row was first written in.
 */
const POINTER_DEPTH = 6;

function parseEvidence(json: string | null): string[] {
  try { const value: unknown = JSON.parse(json ?? "[]"); return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
  catch { return []; }
}

interface LessonOrigins {
  /** Run ids the host recorded; the run ledger can be asked about these. */
  runs: Set<string>;
  /** Turns captured without a run id (Terminal session turns): each is one separate observation, with no ledger rows. */
  turns: Set<string>;
}

interface OriginLinkRow { source_kind: string; source_id: string; relation: string }

function lessonOrigins(memoryIds: readonly string[]): LessonOrigins {
  const db = getMemoryDb();
  const runs = new Set<string>();
  const turns = new Set<string>();
  const seen = new Set<string>();
  const full = (): boolean => runs.size + turns.size >= AGENT_LEARNING_POLICY.maxRunsTracked;
  const entry = db.prepare("SELECT evidence_json FROM memory_entries WHERE id = ?");
  const ticket = db.prepare("SELECT run_id, turn_id FROM memory_tickets WHERE ticket_id = ?");
  // A store without the origin graph still answers from evidence alone.
  let links: { all(...params: string[]): unknown[] } | null = null;
  let replaced: { all(...params: string[]): unknown[] } | null = null;
  try {
    links = db.prepare("SELECT source_kind, source_id, relation FROM memory_origin_links WHERE memory_id = ?");
    replaced = db.prepare("SELECT to_memory_id AS id FROM memory_relation_edges WHERE from_memory_id = ? AND relation_type = 'supersedes'");
  } catch { /* evidence lines only */ }
  const fromTicket = (ticketId: string): void => {
    const found = ticket.get(ticketId) as { run_id: string | null; turn_id: string | null } | undefined;
    if (!found) return;
    if (found.run_id) runs.add(found.run_id);
    else turns.add(found.turn_id || ticketId);
  };
  const walk = (id: string, depth: number): void => {
    if (seen.has(id) || depth > POINTER_DEPTH || full()) return;
    seen.add(id);
    const row = entry.get(id) as { evidence_json: string | null } | undefined;
    if (!row) return;
    for (const line of parseEvidence(row.evidence_json)) {
      if (line.startsWith("run:")) runs.add(line.slice(4));
      else if (line.startsWith("mtk_")) fromTicket(line);
      else if (line.startsWith("supersedes:")) walk(line.slice("supersedes:".length), depth + 1);
    }
    if (links) {
      for (const link of links.all(id) as OriginLinkRow[]) {
        const source = typeof link.source_id === "string" ? link.source_id.trim() : "";
        if (!source) continue;
        if (link.source_kind === "run") runs.add(source);
        else if (link.source_kind === "ticket" || link.source_kind === "memory-ticket") fromTicket(source);
        else if (link.source_kind === "terminal-turn") turns.add(source);
        else if (link.source_kind === "memory" && link.relation === "supersedes") walk(source, depth + 1);
      }
    }
    // Restatements retired before the provenance link existed carry only the relation edge.
    if (replaced) for (const edge of replaced.all(id) as Array<{ id: string }>) walk(edge.id, depth + 1);
  };
  for (const id of memoryIds) walk(id, 0);
  return { runs, turns };
}

/**
 * Distinct observations behind the given learnings: run ids, plus (as `turn:<id>`) turns captured without a run id.
 * Each element is one separate time the lesson came back.
 */
export function lessonRunIds(memoryIds: readonly string[]): Set<string> {
  const origins = lessonOrigins(memoryIds);
  return new Set([...origins.runs, ...[...origins.turns].map(turn => `turn:${turn}`)]);
}

const CHUNK = 200;

/**
 * What the host recorded in those runs. Never throws: a store that cannot answer leaves the counts at zero.
 * `events: false` counts the runs only (memory store lookups); the run ledger is read when the owner opens the agent or a
 * change is prepared, not for every roster row.
 */
export function lessonEvidence(memoryIds: readonly string[], options: { events?: boolean } = {}): LessonEvidence {
  const origins = lessonOrigins(memoryIds);
  // Run-less turns count as observations but have no ledger rows to read.
  const runIds = [...origins.runs];
  const evidence: LessonEvidence = { runs: runIds.length + origins.turns.size, ownerCorrections: 0, failures: 0, samples: [] };
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
