// Every completed model turn enters this append-only observation boundary.
// A ticket is not durable semantic memory: it records that the turn was seen,
// then the Curator records a separate disposition for each proposed candidate.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getDb } from "../store/db";
import { looksSecret } from "../../shared/secret-patterns";
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

function projectPathHash(value: string | null | undefined): string | null {
  const canonical = canonicalProjectPath(value);
  return canonical ? sha256(canonical) : null;
}

function compactTurnSummary(value: string | null | undefined): string | null {
  const summary = String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 360);
  if (!summary || looksSecret(summary)) return null;
  return summary.replace(ABSOLUTE_PATH_RE, "[local-path]");
}

function turnKey(ctx: MemoryTicketContext): string {
  const turnId = String(ctx.turnId ?? "").trim();
  if (turnId) return `turn:${turnId}`;
  const runId = String(ctx.runId ?? "").trim();
  if (runId) return `run:${runId}:node:${String(ctx.nodeId ?? "root")}`;
  return `ephemeral:${randomUUID()}`;
}

function insertEpisode(
  ticketId: string,
  ctx: MemoryTicketContext,
  turnSummary: string | null | undefined,
  createdAt: string,
): void {
  const summary = compactTurnSummary(turnSummary);
  const embedding = summary ? autoLocalEmbedding(summary) : null;
  getDb().prepare(
    `INSERT OR IGNORE INTO memory_episodes (
       episode_id, ticket_id, project_id, project_path_hash, agent_id, chat_id, summary, summary_hash,
       embedding_model, embedding_adapter, embedding_model_sha256,
       embedding_content_hash, embedding_dimensions, embedding_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `mep_${randomUUID()}`,
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
  );
}

/** Idempotent for a runtime turn: retries reuse the same run+node ticket. */
export function beginMemoryTicket(input: {
  context: MemoryTicketContext;
  emitterStatus: MemoryEmitterStatus;
  candidateCount: number;
  turnSummary?: string | null;
}): MemoryTicket {
  const key = turnKey(input.context);
  const existing = getDb().prepare(
    `SELECT ticket_id AS ticketId, emitter_status AS emitterStatus,
            candidate_count AS candidateCount, state
       FROM memory_tickets WHERE turn_key = ? LIMIT 1`,
  ).get(key) as {
    ticketId: string;
    emitterStatus: MemoryEmitterStatus;
    candidateCount: number;
    state: string;
  } | undefined;
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
    insertEpisode(ticketId, input.context, input.turnSummary, now);
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
  getDb().prepare(
    `INSERT INTO memory_decisions (
       decision_id, ticket_id, candidate_index, content_hash, memory_kind,
       proposed_scope, resolved_scope, action, reason_code, target_memory_id,
       confidence, sensitivity, curator_mode, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(ticket_id, candidate_index) DO UPDATE SET
       resolved_scope = excluded.resolved_scope,
       action = excluded.action,
       reason_code = excluded.reason_code,
       target_memory_id = excluded.target_memory_id,
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
    input.targetMemoryId ?? null,
    input.confidence,
    input.sensitivity,
    input.curatorMode,
    new Date().toISOString(),
  );
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
  const rows = getDb().prepare(
    `SELECT * FROM memory_episodes
      WHERE summary IS NOT NULL
      ORDER BY created_at DESC LIMIT ?`,
  ).all(Math.max(1, Math.min(500, Math.floor(limit)))) as EpisodeRow[];
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
        `SELECT * FROM memory_episodes
          WHERE summary IS NOT NULL AND (
            (project_id = ? AND project_path_hash = ?) OR
            (project_id IS NULL AND project_path_hash IS NULL)
          )
          ORDER BY created_at DESC LIMIT ?`,
      ).all(projectId, canonicalPathHash, capped) as EpisodeRow[]
    : projectId
    ? getDb().prepare(
        `SELECT * FROM memory_episodes
          WHERE summary IS NOT NULL AND (
            project_id = ? OR (project_id IS NULL AND project_path_hash IS NULL)
          )
          ORDER BY created_at DESC LIMIT ?`,
      ).all(projectId, capped) as EpisodeRow[]
    : canonicalPathHash
      ? getDb().prepare(
          `SELECT * FROM memory_episodes
            WHERE summary IS NOT NULL AND (
              project_path_hash = ? OR (project_id IS NULL AND project_path_hash IS NULL)
            )
            ORDER BY created_at DESC LIMIT ?`,
        ).all(canonicalPathHash, capped) as EpisodeRow[]
    : getDb().prepare(
        `SELECT * FROM memory_episodes
          WHERE summary IS NOT NULL AND project_id IS NULL AND project_path_hash IS NULL
          ORDER BY created_at DESC LIMIT ?`,
      ).all(capped) as EpisodeRow[];
  return rows.map(toEpisode).filter((episode): episode is MemoryEpisode => episode !== null);
}

export function countMemoryTickets(): number {
  return Number((getDb().prepare("SELECT COUNT(*) AS n FROM memory_tickets").get() as { n: number }).n);
}
