import { getDb as getProductDb } from "../store/db";
import { getMemoryDb, getMemoryStoreInfo, memoryRoot } from "../memory/database";
import { openSetFor, readsUnion } from "../memory/stores";
import type Database from "better-sqlite3";
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
  /** Turns captured without a run id (Terminal session turns), one per chat and day when the ticket names its chat: separate observations, with no ledger rows. */
  turns: Set<string>;
  /**
   * How many separate times the lesson came back. One chat on one day is one observation however many of its turns recorded the lesson (the same conversation
   * repeating itself is not the lesson recurring: Agentlas 2.0); runs of other chats or other days, and runs whose chat is unknown, count one each.
   */
  observations: number;
}
const chatDayKey = (chatId: string, createdAt: string): string => `chat:${chatId}@${String(createdAt).slice(0, 10)}`;

interface OriginLinkRow { source_kind: string; source_id: string; relation: string }

/**
 * 분리 스위치가 켜진 기기에서 근거를 따라갈 저장소들: 이 에이전트의 저장소 — 기억 행·근거·출처 링크는 이사 뒤 거기에 있고 영수증(티켓·실행 번호)은 뿌리에
 * 남는다. 에이전트를 모르면(`agentId` 없음) 저장소를 찾을 수 없으므로 뿌리만 본다 — 호출자가 에이전트를 넘겨야 한다(예전의 "최근 16개 저장소" 추측은
 * 그 밖의 에이전트를 0으로 만들었다). 꺼져 있으면 빈 배열(= 이 묶음 전과 같은 읽기).
 */
export function agentStoreHandles(agentId: string | null | undefined): Database.Database[] {
  try {
    if (!agentId) return [];
    const root = getMemoryDb();
    if (!readsUnion(root)) return [];
    const info = getMemoryStoreInfo();
    return openSetFor({ memoryRoot: memoryRoot(), owner: info.ownerNamespace, rootDb: root }, { agentId }).stores;
  } catch { return []; }
}

function lessonOrigins(memoryIds: readonly string[], agentId?: string | null): LessonOrigins {
  const db = getMemoryDb();
  const extra = agentStoreHandles(agentId);
  const runs = new Set<string>();
  const turns = new Set<string>();
  const seen = new Set<string>();
  const full = (): boolean => runs.size + turns.size >= AGENT_LEARNING_POLICY.maxRunsTracked;
  const entryRoot = db.prepare("SELECT evidence_json FROM memory_entries WHERE id = ?");
  const entryExtra = extra.flatMap(sub => { try { return [sub.prepare("SELECT evidence_json FROM memory_entries WHERE id = ?")]; } catch { return []; } });
  // The root row answers first; a row that has moved into an agent store answers from there.
  const entry = { get: (id: string) => { const found = entryRoot.get(id); if (found) return found; for (const q of entryExtra) { try { const row = q.get(id); if (row) return row; } catch { /* next store */ } } return undefined; } };
  const ticket = db.prepare("SELECT run_id, turn_id, chat_id, created_at FROM memory_tickets WHERE ticket_id = ?");
  // The chat a run belongs to, from its receipt: turn_key is `run:<id>:node:<node>` and unique, so this is an index range, not a scan.
  const ticketOfRun = db.prepare("SELECT chat_id, created_at FROM memory_tickets WHERE turn_key >= ? AND turn_key < ? LIMIT 1");
  // A store without the origin graph still answers from evidence alone.
  let links: { all(...params: string[]): unknown[] } | null = null;
  let replaced: { all(...params: string[]): unknown[] } | null = null;
  try {
    links = db.prepare("SELECT source_kind, source_id, relation FROM memory_origin_links WHERE memory_id = ?");
    replaced = db.prepare("SELECT to_memory_id AS id FROM memory_relation_edges WHERE from_memory_id = ? AND relation_type = 'supersedes'");
  } catch { /* evidence lines only */ }
  // Links and edges are read from every store the lesson may live in (its rows moved, the receipts did not).
  if (extra.length && links && replaced) {
    const linkQueries = [links, ...extra.flatMap(sub => { try { return [sub.prepare("SELECT source_kind, source_id, relation FROM memory_origin_links WHERE memory_id = ?")]; } catch { return []; } })];
    const edgeQueries = [replaced, ...extra.flatMap(sub => { try { return [sub.prepare("SELECT to_memory_id AS id FROM memory_relation_edges WHERE from_memory_id = ? AND relation_type = 'supersedes'")]; } catch { return []; } })];
    links = { all: (...params: string[]) => linkQueries.flatMap(q => { try { return q.all(...params) as unknown[]; } catch { return []; } }) };
    replaced = { all: (...params: string[]) => edgeQueries.flatMap(q => { try { return q.all(...params) as unknown[]; } catch { return []; } }) };
  }
  const fromTicket = (ticketId: string): void => {
    const found = ticket.get(ticketId) as { run_id: string | null; turn_id: string | null; chat_id: string | null; created_at: string } | undefined;
    if (!found) return;
    if (found.run_id) runs.add(found.run_id);
    else turns.add(found.chat_id ? chatDayKey(found.chat_id, found.created_at) : found.turn_id || ticketId);
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
  const keys = new Set<string>(turns);
  for (const run of runs) {
    let key = `run:${run}`;
    try {
      const found = ticketOfRun.get(`run:${run}:`, `run:${run};`) as { chat_id: string | null; created_at: string } | undefined;
      if (found?.chat_id) key = chatDayKey(found.chat_id, found.created_at);
    } catch { /* the run counts for itself */ }
    keys.add(key);
  }
  return { runs, turns, observations: keys.size };
}

/**
 * Distinct observations behind the given learnings: run ids, plus (as `turn:<id>`) turns captured without a run id.
 * Each element is one separate time the lesson came back.
 */
export function lessonRunIds(memoryIds: readonly string[], options: { agentId?: string | null } = {}): Set<string> {
  const origins = lessonOrigins(memoryIds, options.agentId);
  return new Set([...origins.runs, ...[...origins.turns].map(turn => `turn:${turn}`)]);
}

const CHUNK = 200;

/**
 * What the host recorded in those runs. Never throws: a store that cannot answer leaves the counts at zero.
 * `events: false` counts the runs only (memory store lookups); the run ledger is read when the owner opens the agent or a
 * change is prepared, not for every roster row.
 */
export function lessonEvidence(memoryIds: readonly string[], options: { events?: boolean; agentId?: string | null } = {}): LessonEvidence {
  const origins = lessonOrigins(memoryIds, options.agentId);
  // Run-less turns count as observations but have no ledger rows to read.
  const runIds = [...origins.runs];
  const evidence: LessonEvidence = { runs: origins.observations, ownerCorrections: 0, failures: 0, samples: [] };
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
