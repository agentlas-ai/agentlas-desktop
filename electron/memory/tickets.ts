// Every completed model turn enters this append-only observation boundary.
// A ticket is not durable semantic memory: it records that the turn was seen,
// then the Curator records a separate disposition for each proposed candidate.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getMemoryDb as getDb } from "./database";
import { layoutOf } from "./stores";
import { looksSecret } from "../../shared/secret-patterns";
import { memoryRunPredatesAnyForget } from "./revocations";
import { assertMemoryTicketSource } from "./source-custody";
import {
  autoLocalEmbedding,
  parseLocalEmbedding,
  type LocalMemoryEmbedding,
} from "./local-embedding";

export type MemoryEmitterStatus = "valid" | "empty" | "missing" | "malformed" | "read_only";
export type MemoryCuratorMode = "semantic" | "policy" | "policy_fallback" | "read_only";
export type MemoryDecisionAction =
  | "written"
  | "deduped"
  | "redacted"
  | "session"
  | "discarded"
  | "deferred";

export interface MemoryTicketContext {
  /** K3': the host facts the resting-time gathering reads from the turn record (see turnHostFacts). Every one is a plain fact the host minted; none is read from a model's output. */
  ownerSpoke?: boolean;
  personalConversation?: boolean;
  turnFacts?: { toolsRan?: boolean; inputsRead?: boolean };
  experienceIntake?: { taskHint?: string | null };
  /** Main-authored before model execution; preferred idempotency identity. */
  turnId?: string | null;
  runId?: string | null;
  nodeId?: string | null;
  chatId?: string | null;
  agentId?: string | null;
  projectId?: string | null;
  projectPath?: string | null;
}

export interface MemoryTicket {
  ticketId: string;
  turnKey: string;
  emitterStatus: MemoryEmitterStatus;
  candidateCount: number;
  created: boolean;
  resumed: boolean;
}

export interface MemoryTicketReport {
  written: number;
  deduped: number;
  redacted: number;
  sessionOnly: number;
  discarded: number;
}

export function readMemoryTicketReport(ticketId: string): MemoryTicketReport {
  const row = getDb().prepare(
    `SELECT written_count AS written, deduped_count AS deduped,
            redacted_count AS redacted, session_count AS sessionOnly,
            discarded_count AS discarded
       FROM memory_tickets WHERE ticket_id = ? LIMIT 1`,
  ).get(ticketId) as MemoryTicketReport | undefined;
  return row ?? { written: 0, deduped: 0, redacted: 0, sessionOnly: 0, discarded: 0 };
}

export interface MemoryDecisionInput {
  ticketId: string;
  candidateIndex: number;
  content: string;
  memoryKind: string;
  proposedScope: string;
  resolvedScope: string;
  action: MemoryDecisionAction;
  reasonCode: string;
  targetMemoryId?: string | null;
  confidence: string;
  sensitivity: string;
  curatorMode: MemoryCuratorMode;
}

interface EpisodeRow {
  episode_id: string;
  ticket_id: string;
  project_id: string | null;
  project_path_hash: string | null;
  agent_id: string | null;
  chat_id: string | null;
  summary: string | null;
  embedding_model: string | null;
  embedding_adapter: string | null;
  embedding_model_sha256: string | null;
  embedding_content_hash: string | null;
  embedding_dimensions: number | null;
  embedding_json: string | null;
  created_at: string;
}

export interface MemoryEpisode {
  id: string;
  ticketId: string;
  projectId: string | null;
  projectPathHash: string | null;
  agentId: string | null;
  chatId: string | null;
  summary: string;
  embedding: LocalMemoryEmbedding;
  createdAt: string;
}

const ABSOLUTE_PATH_RE = /(?:file:\/\/)?(?:\/(?:Users|home|private|var|opt)\/[^\s,;]+|[A-Za-z]:\\[^\s,;]+)/g;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Project timeline identity follows the filesystem object when it exists, so
 * symlink/relative aliases cannot split one project into several timelines.
 * Missing paths still receive a stable absolute spelling without creating or
 * probing any project-local file.
 */
function canonicalProjectPath(value: string | null | undefined): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const resolved = path.resolve(raw);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export function projectPathHash(value: string | null | undefined): string | null {
  const canonical = canonicalProjectPath(value);
  return canonical ? sha256(canonical) : null;
}

/** What `projectHashCandidates` asks the machine: injectable so the spellings of another OS can be reproduced (path.win32) and tested on this one. */
export interface ProjectHashProbe {
  resolve(value: string): string;
  realpath(value: string): string;
  realpathNative(value: string): string;
  platform: NodeJS.Platform;
}
const SYSTEM_PROBE: ProjectHashProbe = { resolve: (value) => path.resolve(value), realpath: (value) => fs.realpathSync(value), realpathNative: (value) => fs.realpathSync.native(value), platform: process.platform };

/**
 * The hashes the engine's hook could have written for this folder as `project_path_hash` of a turn record (K3'-2b; Agentlas-OS memory_runtime.py `_stamp_turn_project`: sha256 of the text of
 * `Path(folder).resolve()`, the folder being the hook's project root or its cwd). The desktop's own hash (`projectPathHash`: the filesystem's canonical spelling, Node's realpath.native) is one of them; the engine
 * can differ from it only in the SPELLING of the same folder:
 *   - Python's resolve() resolves links but keeps the case it was given, Node's native realpath returns the case the disk has (macOS, Windows): the as-given spelling (`realpath`) and the plain absolute one are also candidates;
 *   - on a case-insensitive disk (macOS, Windows) a shell that was typed in lower case hands the hook a lower-case folder: the lower-case spelling is a candidate;
 *   - on Windows the drive letter may come in either case: the other case is a candidate for every spelling.
 * Only a hash is compared and kept, never a path. A folder that is not a subfolder-or-root of the project the hook saw (the hook ran in a SUBFOLDER with no project marker) cannot be found this way: a hash cannot be
 * walked up to its parent - that is the engine's to stamp (see the K3'-2b report). Never throws; an unreadable folder gives the spellings that need no disk.
 */
export function projectHashCandidates(value: string | null | undefined, probe: ProjectHashProbe = SYSTEM_PROBE): string[] {
  const raw = String(value ?? "").trim();
  if (!raw) return [];
  const spellings = new Set<string>();
  let base: string;
  try { base = probe.resolve(raw); } catch { return []; }
  spellings.add(base);
  for (const read of [probe.realpathNative, probe.realpath]) { try { spellings.add(read(base)); } catch { /* a folder that is gone: the spellings that need no disk */ } }
  if (probe.platform === "darwin" || probe.platform === "win32") for (const spelling of [...spellings]) spellings.add(spelling.toLowerCase());
  if (probe.platform === "win32") for (const spelling of [...spellings]) spellings.add(spelling.replace(/^[A-Za-z](?=:)/, (letter) => letter === letter.toUpperCase() ? letter.toLowerCase() : letter.toUpperCase()));
  return [...new Set([...spellings].map((spelling) => sha256(spelling)))];
}

function compactTurnSummary(value: string | null | undefined): string | null {
  const summary = String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 360);
  if (!summary || looksSecret(summary)) return null;
  return summary.replace(ABSOLUTE_PATH_RE, "[local-path]");
}

/**
 * K3' - the host facts of one turn, written into the turn record's `detail_json` (the K1 column nobody read until now) so the resting-time gathering (gathering.ts) can tell what the OWNER wrote
 * and what the turn took in. `{v:1, own:1, pers:1, tl:1, in:1, req:"..."}`; every key is left out when it is not true, and `req` (the owner's own message, redacted like the summary) only when the owner wrote the turn.
 * Value: 600 characters = the ruleset's curator.input.requestMaxChars (the engine's input contract for a gathering call); a longer message is cut, a message that looks like a secret is left out.
 * Read by gathering.ts only; removed with the turn record (the 30 day housekeeping and every forget path that clears `summary` clears it too). Null when there is nothing to say (an engine hook turn, an automation turn).
 */
const REQUEST_MAX_CHARS = 600;
export function turnHostFacts(ctx: MemoryTicketContext): string | null {
  const facts: Record<string, unknown> = { v: 1 };
  if (ctx.ownerSpoke === true) {
    facts.own = 1;
    const request = String(ctx.experienceIntake?.taskHint ?? "").replace(/\s+/g, " ").trim().slice(0, REQUEST_MAX_CHARS);
    if (request && !looksSecret(request)) facts.req = request.replace(ABSOLUTE_PATH_RE, "[local-path]");
  }
  let personal = ctx.personalConversation === true;
  if (!personal && ctx.chatId) {
    try {
      const scope = require("../workspace-rules/scope") as typeof import("../workspace-rules/scope"); // eslint-disable-line @typescript-eslint/no-require-imports
      const db = require("../store/db") as typeof import("../store/db"); // eslint-disable-line @typescript-eslint/no-require-imports
      personal = scope.isPersonalAgentConversation(db.getDb(), ctx.chatId);
    } catch { /* no product store here (the engine's turns do not come through this function): not known = not personal */ }
  }
  if (personal) facts.pers = 1;
  if (ctx.turnFacts?.toolsRan === true) facts.tl = 1;
  if (ctx.turnFacts?.inputsRead === true) facts.in = 1;
  return Object.keys(facts).length > 1 ? JSON.stringify(facts) : null;
}

function turnKey(ctx: MemoryTicketContext): string {
  const turnId = String(ctx.turnId ?? "").trim();
  if (turnId) return `turn:${turnId}`;
  const runId = String(ctx.runId ?? "").trim();
  if (runId) return `run:${runId}:node:${String(ctx.nodeId ?? "root")}`;
  return `ephemeral:${randomUUID()}`;
}

const withDetailColumn = new WeakSet<object>();
/** True when the store has memory_episodes.detail_json (the K1 columns): a store that was locked when it was opened may not have them yet, and its turn records are then written as before, without the host facts. Only a positive answer is remembered. */
function episodesHaveDetail(db: ReturnType<typeof getDb>): boolean {
  if (withDetailColumn.has(db)) return true;
  try {
    if ((db.prepare("PRAGMA table_info(memory_episodes)").all() as Array<{ name: string }>).some(column => column.name === "detail_json")) { withDetailColumn.add(db); return true; }
  } catch { /* an unreadable file is written as before */ }
  return false;
}

const withFactsTrigger = new WeakSet<object>();
/**
 * The owner's own words sit in `detail_json.req`; a forget that empties the turn record's `summary` (six places, three files, the engine's own forget too) must empty them as well. One trigger on the one
 * column every forget path clears does it for all of them, so no forget path needs to know the column exists. Never throws (a store that cannot take it keeps the sweep at the top of every gathering pass).
 */
function ensureFactsForgetTrigger(db: ReturnType<typeof getDb>): void {
  if (withFactsTrigger.has(db)) return;
  try {
    db.exec(`CREATE TRIGGER IF NOT EXISTS memory_episode_facts_forget AFTER UPDATE OF summary ON memory_episodes
      WHEN NEW.summary IS NULL AND NEW.detail_json IS NOT NULL
      BEGIN UPDATE memory_episodes SET detail_json = NULL WHERE episode_id = NEW.episode_id; END`);
    withFactsTrigger.add(db);
  } catch { /* the sweep covers it */ }
}

function insertEpisode(
  ticketId: string,
  ctx: MemoryTicketContext,
  turnSummary: string | null | undefined,
  createdAt: string,
): void {
  const summary = compactTurnSummary(turnSummary);
  const embedding = summary ? autoLocalEmbedding(summary) : null;
  const episodeId = `mep_${randomUUID()}`;
  const db = getDb();
  const detail = summary && episodesHaveDetail(db) ? turnHostFacts(ctx) : null;
  if (detail) ensureFactsForgetTrigger(db);
  db.prepare(
    `INSERT OR IGNORE INTO memory_episodes (
       episode_id, ticket_id, project_id, project_path_hash, agent_id, chat_id, summary, summary_hash,
       embedding_model, embedding_adapter, embedding_model_sha256,
       embedding_content_hash, embedding_dimensions, embedding_json, created_at${detail ? ", detail_json" : ""}
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${detail ? ", ?" : ""})`,
  ).run(
    episodeId,
    ticketId,
    ctx.projectId ?? null,
    projectPathHash(ctx.projectPath),
    ctx.agentId ?? null,
    ctx.chatId ?? null,
    summary,
    summary ? sha256(summary) : null,
    embedding?.model ?? null,
    embedding?.adapter ?? null,
    embedding?.modelSha256 ?? null,
    embedding?.contentHash ?? null,
    embedding?.dimensions ?? null,
    embedding ? JSON.stringify(embedding.vector) : null,
    createdAt,
    ...(detail ? [detail] : []),
  );
}

/**
 * Idempotent for a runtime turn: retries reuse the same run+node ticket.
 * `reviveFailedTurn` is for the caller that holds a SUCCESSFUL reply: a retry (same run + node) whose first attempt only left
 * the receipt "the turn failed / was cancelled" is the same turn finally succeeding, so that receipt gives way to it instead of
 * swallowing the reply's learning. Any other terminal ticket (a completed one, a curation failure, a revoked source) is final.
 */
export function beginMemoryTicket(input: {
  context: MemoryTicketContext;
  emitterStatus: MemoryEmitterStatus;
  candidateCount: number;
  turnSummary?: string | null;
  reviveFailedTurn?: boolean;
}): MemoryTicket {
  assertMemoryTicketSource(input.context);
  const key = turnKey(input.context);
  const existing = getDb().prepare(
    `SELECT ticket_id AS ticketId, emitter_status AS emitterStatus,
            candidate_count AS candidateCount, state, failure_code AS failureCode
       FROM memory_tickets WHERE turn_key = ? LIMIT 1`,
  ).get(key) as {
    ticketId: string;
    emitterStatus: MemoryEmitterStatus;
    candidateCount: number;
    state: string;
    failureCode: string | null;
  } | undefined;
  if (existing && input.reviveFailedTurn && existing.state === "failed"
    && (existing.failureCode === "turn-failed" || existing.failureCode === "turn-cancelled")) {
    const now = new Date().toISOString();
    const candidateCount = Math.max(0, Math.floor(input.candidateCount));
    // The conditional UPDATE is the claim: of two processes reviving the same receipt, one sees changes = 1.
    const revived = getDb().transaction((): boolean => {
      const claimed = getDb().prepare(
        `UPDATE memory_tickets
            SET state = 'received', emitter_status = ?, candidate_count = ?, curator_mode = 'policy',
                curation_outcome = 'no_candidates', written_count = 0, deduped_count = 0, redacted_count = 0,
                session_count = 0, discarded_count = 0, failure_code = NULL, updated_at = ?
          WHERE ticket_id = ? AND state = 'failed' AND failure_code IN ('turn-failed', 'turn-cancelled')`,
      ).run(input.emitterStatus, candidateCount, now, existing.ticketId);
      if (claimed.changes !== 1) return false;
      // The failed attempt's episode says "the turn failed"; the turn that now stands succeeded.
      getDb().prepare("DELETE FROM memory_episodes WHERE ticket_id = ?").run(existing.ticketId);
      insertEpisode(
        existing.ticketId,
        input.context,
        memoryRunPredatesAnyForget(input.context.runId) ? null : input.turnSummary,
        now,
      );
      return true;
    })();
    if (revived) {
      return {
        ticketId: existing.ticketId,
        turnKey: key,
        emitterStatus: input.emitterStatus,
        candidateCount,
        created: true,
        resumed: true,
      };
    }
  }
  if (existing) {
    const terminal = existing.state === "completed" || existing.state === "read_only" || existing.state === "failed";
    return {
      ticketId: existing.ticketId,
      emitterStatus: existing.emitterStatus,
      candidateCount: existing.candidateCount,
      turnKey: key,
      created: !terminal,
      resumed: !terminal,
    };
  }

  const ticketId = `mtk_${randomUUID()}`;
  const now = new Date().toISOString();
  const candidateCount = Math.max(0, Math.floor(input.candidateCount));
  const insert = getDb().transaction(() => {
    getDb().prepare(
      `INSERT INTO memory_tickets (
       ticket_id, turn_key, turn_id, run_id, node_id, chat_id, agent_id, project_id,
       project_path_hash, emitter_status, candidate_count, state, curator_mode,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', 'policy', ?, ?)`,
    ).run(
      ticketId,
      key,
      input.context.turnId ?? null,
      input.context.runId ?? null,
      input.context.nodeId ?? null,
      input.context.chatId ?? null,
      input.context.agentId ?? null,
      input.context.projectId ?? null,
      projectPathHash(input.context.projectPath),
      input.emitterStatus,
      candidateCount,
      now,
      now,
    );
    insertEpisode(
      ticketId,
      input.context,
      memoryRunPredatesAnyForget(input.context.runId) ? null : input.turnSummary,
      now,
    );
  });
  insert();
  return {
    ticketId,
    turnKey: key,
    emitterStatus: input.emitterStatus,
    candidateCount,
    created: true,
    resumed: false,
  };
}

/** Rebuild counters from idempotent candidate decisions after a retry/restart. */
export function memoryDecisionReport(
  ticketId: string,
  fallback: MemoryTicketReport = { written: 0, deduped: 0, redacted: 0, sessionOnly: 0, discarded: 0 },
): MemoryTicketReport {
  const rows = getDb().prepare(
    `SELECT action, COUNT(*) AS count
       FROM memory_decisions WHERE ticket_id = ? GROUP BY action`,
  ).all(ticketId) as Array<{ action: MemoryDecisionAction; count: number }>;
  if (rows.length === 0) return fallback;
  const report: MemoryTicketReport = { written: 0, deduped: 0, redacted: 0, sessionOnly: 0, discarded: 0 };
  for (const row of rows) {
    if (row.action === "written") report.written += row.count;
    else if (row.action === "deduped") report.deduped += row.count;
    else if (row.action === "redacted") report.redacted += row.count;
    else if (row.action === "session" || row.action === "deferred") report.sessionOnly += row.count;
    else if (row.action === "discarded") report.discarded += row.count;
  }
  return report;
}

export function completeMemoryTicket(
  ticketId: string,
  report: MemoryTicketReport,
  curatorMode: MemoryCuratorMode,
  options: {
    readOnly?: boolean;
    failureCode?: string | null;
    outcome?: "decided" | "no_candidates" | "malformed_output" | "curator_failed" | "read_only";
  } = {},
): void {
  const state = options.failureCode ? "failed" : options.readOnly ? "read_only" : "completed";
  const outcome = options.outcome ?? (options.readOnly ? "read_only" : options.failureCode ? "curator_failed" : "decided");
  getDb().prepare(
    `UPDATE memory_tickets
        SET state = ?, curator_mode = ?, curation_outcome = ?, written_count = ?, deduped_count = ?,
            redacted_count = ?, session_count = ?, discarded_count = ?,
            failure_code = ?, updated_at = ?
      WHERE ticket_id = ?`,
  ).run(
    state,
    curatorMode,
    outcome,
    report.written,
    report.deduped,
    report.redacted,
    report.sessionOnly,
    report.discarded,
    options.failureCode ?? null,
    new Date().toISOString(),
    ticketId,
  );
}

export function recordMemoryDecision(input: MemoryDecisionInput): void {
  // `target_memory_id` points at a ROOT row (foreign key). A row written into another store has no root row — the target stays empty and the row's own origin link names the
  // ticket (engine canonical_writer does the same). With the layout switch OFF every target is a root row and this check is skipped.
  let target = input.targetMemoryId ?? null;
  if (target && layoutOf(getDb()) !== "central" && !getDb().prepare("SELECT 1 FROM memory_entries WHERE id = ?").get(target)) target = null;
  getDb().prepare(
    `INSERT INTO memory_decisions (
       decision_id, ticket_id, candidate_index, content_hash, memory_kind,
       proposed_scope, resolved_scope, action, reason_code, target_memory_id,
       confidence, sensitivity, curator_mode, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(ticket_id, candidate_index) DO UPDATE SET
       content_hash = excluded.content_hash,
       memory_kind = excluded.memory_kind,
       proposed_scope = excluded.proposed_scope,
       resolved_scope = excluded.resolved_scope,
       action = excluded.action,
       reason_code = excluded.reason_code,
       target_memory_id = excluded.target_memory_id,
       confidence = excluded.confidence,
       sensitivity = excluded.sensitivity,
       curator_mode = excluded.curator_mode`,
  ).run(
    `mdc_${randomUUID()}`,
    input.ticketId,
    input.candidateIndex,
    sha256(input.content),
    input.memoryKind,
    input.proposedScope,
    input.resolvedScope,
    input.action,
    input.reasonCode,
    target,
    input.confidence,
    input.sensitivity,
    input.curatorMode,
    new Date().toISOString(),
  );
}

/** Remove a ticket's derived recall text after one of its candidates is revoked. */
export function redactMemoryTicketEpisode(ticketId: string): void {
  getDb().prepare(
    `UPDATE memory_episodes
        SET summary = NULL, summary_hash = NULL,
            embedding_model = NULL, embedding_adapter = NULL,
            embedding_model_sha256 = NULL, embedding_content_hash = NULL,
            embedding_dimensions = NULL, embedding_json = NULL
      WHERE ticket_id = ?`,
  ).run(ticketId);
}

function toEpisode(row: EpisodeRow): MemoryEpisode | null {
  if (!row.summary) return null;
  const embedding = parseLocalEmbedding(
    row.embedding_model,
    row.embedding_dimensions,
    row.embedding_json,
    {
      adapter: row.embedding_adapter,
      modelSha256: row.embedding_model_sha256,
      contentHash: row.embedding_content_hash,
      text: row.summary,
    },
  ) ?? autoLocalEmbedding(row.summary);
  return {
    id: row.episode_id,
    ticketId: row.ticket_id,
    projectId: row.project_id,
    projectPathHash: row.project_path_hash,
    agentId: row.agent_id,
    chatId: row.chat_id,
    summary: row.summary,
    embedding,
    createdAt: row.created_at,
  };
}

export function listRecentMemoryEpisodes(limit = 80): MemoryEpisode[] {
  const capped = Math.max(1, Math.min(500, Math.floor(limit)));
  const rows = getDb().prepare(
    `SELECT episode.* FROM memory_episodes episode
      WHERE episode.summary IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM memory_episode_quarantines quarantine
           WHERE quarantine.ticket_id = episode.ticket_id
        )
      ORDER BY episode.created_at DESC LIMIT ?`,
  ).all(capped) as EpisodeRow[];
  return rows.map(toEpisode).filter((episode): episode is MemoryEpisode => episode !== null);
}

/**
 * Timeline reads are owner-local. When both project authorities exist they
 * must match as a pair; folder-only and id-only projects match their one exact
 * authority. Every project view may additionally see global observations.
 */
export function listMemoryEpisodesForContext(
  projectId: string | null,
  limit = 120,
  projectPath?: string | null,
): MemoryEpisode[] {
  const capped = Math.max(1, Math.min(500, Math.floor(limit)));
  const canonicalPathHash = projectPathHash(projectPath);
  const rows = projectId && canonicalPathHash
    ? getDb().prepare(
        `SELECT episode.* FROM memory_episodes episode
          WHERE episode.summary IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM memory_episode_quarantines quarantine
               WHERE quarantine.ticket_id = episode.ticket_id
            ) AND (
            (project_id = ? AND project_path_hash = ?) OR
            (project_id IS NULL AND project_path_hash IS NULL)
          )
          ORDER BY created_at DESC LIMIT ?`,
      ).all(projectId, canonicalPathHash, capped) as EpisodeRow[]
    : projectId
    ? getDb().prepare(
        `SELECT episode.* FROM memory_episodes episode
          WHERE episode.summary IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM memory_episode_quarantines quarantine
               WHERE quarantine.ticket_id = episode.ticket_id
            ) AND (
            project_id = ? OR (project_id IS NULL AND project_path_hash IS NULL)
          )
          ORDER BY created_at DESC LIMIT ?`,
      ).all(projectId, capped) as EpisodeRow[]
    : canonicalPathHash
      ? getDb().prepare(
          `SELECT episode.* FROM memory_episodes episode
            WHERE episode.summary IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM memory_episode_quarantines quarantine
                 WHERE quarantine.ticket_id = episode.ticket_id
              ) AND (
              project_path_hash = ? OR (project_id IS NULL AND project_path_hash IS NULL)
            )
            ORDER BY created_at DESC LIMIT ?`,
        ).all(canonicalPathHash, capped) as EpisodeRow[]
    : getDb().prepare(
        `SELECT episode.* FROM memory_episodes episode
          WHERE episode.summary IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM memory_episode_quarantines quarantine
               WHERE quarantine.ticket_id = episode.ticket_id
            )
            AND episode.project_id IS NULL AND episode.project_path_hash IS NULL
          ORDER BY episode.created_at DESC LIMIT ?`,
      ).all(capped) as EpisodeRow[];
  // a turn whose line the owner later CORRECTED ("not Busan, Daegu") no longer speaks as an observation: its summary still carries the wrong claim and the model read both as equally true. A value of the
  // store, not a reading of words: the turn is the origin of a line that a `rewrite` with why=corrected replaced (the replacing line carries the `rewrite-why:corrected` mark). A change that was not a correction keeps its turn.
  const wrong = ticketsOfCorrectedLines(rows.map((row) => row.ticket_id));
  return rows.filter((row) => !wrong.has(row.ticket_id)).map(toEpisode).filter((episode): episode is MemoryEpisode => episode !== null);
}

/** The tickets (turn records) among `ticketIds` that wrote a line which a later correction replaced. One read, read-only; a store without the origin links, or a read that fails, corrects nothing. */
export function ticketsOfCorrectedLines(ticketIds: readonly string[]): Set<string> {
  const out = new Set<string>();
  if (ticketIds.length === 0) return out;
  try {
    const db = getDb();
    for (let start = 0; start < ticketIds.length; start += 400) {
      const part = ticketIds.slice(start, start + 400);
      const marks = part.map(() => "?").join(",");
      const found = db.prepare(
        `SELECT DISTINCT origin.source_id AS ticket_id FROM memory_origin_links origin
           JOIN memory_origin_links replaced ON replaced.source_kind = 'memory' AND replaced.relation = 'supersedes' AND replaced.source_id = origin.memory_id
           JOIN memory_entries line ON line.id = replaced.memory_id
          WHERE origin.source_kind IN ('ticket','memory-ticket') AND origin.source_id IN (${marks})
            AND line.evidence_json LIKE '%"rewrite-why:corrected"%'`,
      ).all(...part) as Array<{ ticket_id: string }>;
      for (const row of found) out.add(row.ticket_id);
    }
  } catch { /* an unreadable link table corrects nothing: every turn stays */ }
  return out;
}

/**
 * The summary of the last finished turn of THIS conversation by THIS agent (K3'-2b): the turn record's summary (compactTurnSummary: at most 360 characters, no secret, no absolute path), or null. It is the "previous summary"
 * part of the recall query (ruleset recall.query; recall-contract.ts recallQueryOf) - what a short follow-up ("do that again") is about. A host read of one row: no model, no write, no new column or index (the agent's
 * created_at index finds the row; the previous turn of a conversation is nearly always the agent's newest).
 * What counts: a turn that finished (ticket state completed or read_only, no failure code - a failed or cancelled turn's summary is the host's fixed sentence about the failure and says nothing about the work), not the
 * run asking, not a record the owner quarantined or a forget cleared (its summary is gone). Another agent's turn in the same room, and every other conversation, is never read: the same rule as the "Recent work" timeline
 * (context.ts readableEpisodes: its own conversation, its own agent).
 */
export function previousTurnSummary(chatId: string | null | undefined, agentId: string | null | undefined, currentRunId?: string | null): string | null {
  const chat = String(chatId ?? "").trim();
  if (!chat) return null;
  const row = getDb().prepare(
    `SELECT episode.summary AS summary FROM memory_episodes episode JOIN memory_tickets ticket ON ticket.ticket_id = episode.ticket_id
      WHERE episode.agent_id IS ? AND episode.chat_id = ? AND episode.summary IS NOT NULL
        AND ticket.state IN ('completed', 'read_only') AND ticket.failure_code IS NULL
        AND (ticket.run_id IS NULL OR ticket.run_id IS NOT ?)
        AND NOT EXISTS (SELECT 1 FROM memory_episode_quarantines quarantine WHERE quarantine.ticket_id = episode.ticket_id)
      ORDER BY episode.created_at DESC, episode.rowid DESC LIMIT 1`,
  ).get(agentId ?? null, chat, currentRunId ?? null) as { summary?: string | null } | undefined;
  const summary = String(row?.summary ?? "").trim();
  return summary || null;
}

/** The run and turn each ticket recorded (episode -> the turn it observed) and its typed failure code (a host receipt such as
 * turn-failed). Missing tickets are absent from the map. */
export function memoryTicketTurns(ticketIds: readonly string[]): Map<string, { runId: string | null; turnId: string | null; failureCode: string | null }> {
  const out = new Map<string, { runId: string | null; turnId: string | null; failureCode: string | null }>();
  const ids = [...new Set(ticketIds.filter(Boolean))];
  for (let start = 0; start < ids.length; start += 400) {
    const slice = ids.slice(start, start + 400);
    const rows = getDb().prepare(`SELECT ticket_id AS ticketId, run_id AS runId, turn_id AS turnId, failure_code AS failureCode FROM memory_tickets
      WHERE ticket_id IN (${slice.map(() => "?").join(",")})`).all(...slice) as Array<{ ticketId: string; runId: string | null; turnId: string | null; failureCode: string | null }>;
    for (const row of rows) out.set(row.ticketId, { runId: row.runId, turnId: row.turnId, failureCode: row.failureCode });
  }
  return out;
}

/**
 * Project-detail timeline read. Unlike recall context, this never includes
 * global observations: a project panel may show only episodes bound to the
 * exact project id and, when available, the same canonical folder identity.
 */
export function listProjectMemoryEpisodes(
  projectId: string,
  projectPath: string | null | undefined,
  limit = 160,
): MemoryEpisode[] {
  const id = String(projectId ?? "").trim();
  if (!id) return [];
  const capped = Math.max(1, Math.min(500, Math.floor(limit)));
  const canonicalPathHash = projectPathHash(projectPath);
  const rows = canonicalPathHash
    ? getDb().prepare(
        `SELECT episode.* FROM memory_episodes episode
          WHERE episode.summary IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM memory_episode_quarantines quarantine
               WHERE quarantine.ticket_id = episode.ticket_id
            ) AND (
            (project_id = ? AND project_path_hash = ?) OR
            (project_id IS NULL AND project_path_hash = ?)
          )
          ORDER BY created_at DESC LIMIT ?`,
      ).all(id, canonicalPathHash, canonicalPathHash, capped) as EpisodeRow[]
    : getDb().prepare(
        `SELECT episode.* FROM memory_episodes episode
          WHERE episode.summary IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM memory_episode_quarantines quarantine
               WHERE quarantine.ticket_id = episode.ticket_id
            )
            AND episode.project_id = ?
          ORDER BY episode.created_at DESC LIMIT ?`,
      ).all(id, capped) as EpisodeRow[];
  return rows.map(toEpisode).filter((episode): episode is MemoryEpisode => episode !== null);
}

export function countMemoryTickets(): number {
  return Number((getDb().prepare("SELECT COUNT(*) AS n FROM memory_tickets").get() as { n: number }).n);
}
