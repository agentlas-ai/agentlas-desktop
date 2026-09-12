import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { MemoryKind, MemoryScope } from "../architecture/manifest";
import {
  activeBorrowedOwnerScopeKey,
  DEVICE_LOCAL_BORROWED_OWNER_SCOPE,
} from "../agents/borrowed-owner-scope";
import { getDb } from "../store/db";

export type MemoryRevocationReason = "exact-content-revoked" | "stale-intake-epoch";

export class MemoryRevokedError extends Error {
  readonly code = "memory_revoked";

  constructor(readonly reason: MemoryRevocationReason) {
    super(reason);
    this.name = "MemoryRevokedError";
  }
}

export interface MemoryAuthorityInput {
  scope: MemoryScope;
  kind: MemoryKind;
  content: string;
  projectId?: string | null;
  projectPath?: string | null;
  agentId?: string | null;
  chatId?: string | null;
  intakeRunId?: string | null;
  intakeEpoch?: number | null;
}

interface ForgettableMemoryRow {
  id: string;
  scope: MemoryScope;
  kind: MemoryKind;
  content: string;
  project_id: string | null;
  project_path: string | null;
  agent_id: string | null;
  chat_id: string | null;
  superseded_at: string | null;
}

interface LegacyDedupDecisionRow {
  ticketId: string;
  candidateIndex: number;
  contentHash: string;
  projectId: string | null;
  projectPathHash: string | null;
  agentId: string | null;
  chatId: string | null;
}

export interface ForgottenMemoryProjection {
  sourceMemoryIds: string[];
  kind: MemoryKind;
  content: string;
  contentHash: string;
  projectPaths: string[];
  forgottenAt: string;
  revokedEpoch: number;
}

export function normalizeMemoryContent(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

export function memoryContentHash(value: string): string {
  return createHash("sha256").update(normalizeMemoryContent(value), "utf8").digest("hex");
}

/** Exact source ids whose downstream projections must never be recalled. */
export function revokedMemorySourceIds(sourceIds: Iterable<string>): Set<string> {
  const ids = [...new Set([...sourceIds].map((id) => id.trim()).filter(Boolean))];
  const revoked = new Set<string>();
  for (let offset = 0; offset < ids.length; offset += 400) {
    const batch = ids.slice(offset, offset + 400);
    const placeholders = batch.map(() => "?").join(",");
    const rows = getDb().prepare(
      `SELECT source_memory_id AS sourceMemoryId
         FROM memory_revocation_sources
        WHERE source_memory_id IN (${placeholders})`,
    ).all(...batch) as Array<{ sourceMemoryId: string }>;
    for (const row of rows) revoked.add(row.sourceMemoryId);
  }
  return revoked;
}

/** Trusted in-process snapshot for background producers without a Main run id. */
export function currentMemoryForgetEpoch(): number {
  return Number((getDb().prepare(
    "SELECT epoch FROM memory_forget_clock WHERE id = 1",
  ).get() as { epoch: number }).epoch);
}

/** Content-free ticket fence for a run that began before any later forget. */
export function memoryRunPredatesAnyForget(runIdValue: string | null | undefined): boolean {
  const runId = String(runIdValue ?? "").trim();
  if (!runId) return false;
  const currentEpoch = currentMemoryForgetEpoch();
  if (currentEpoch === 0) return false;
  const snapshot = getDb().prepare(
    "SELECT intake_epoch AS intakeEpoch FROM memory_run_epochs WHERE run_id = ? LIMIT 1",
  ).get(runId) as { intakeEpoch: number } | undefined;
  if (snapshot) return snapshot.intakeEpoch < currentEpoch;
  const legacy = getDb().prepare(
    "SELECT MIN(ts) AS startedAt FROM run_events WHERE run_id = ?",
  ).get(runId) as { startedAt: string | null } | undefined;
  if (!legacy?.startedAt) return false;
  return Boolean(getDb().prepare(
    "SELECT 1 FROM memory_revocations WHERE revoked_at >= ? LIMIT 1",
  ).get(legacy.startedAt));
}

function stableHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export type MemoryProjectionTargetKind = "project-files" | "agent-nest-scan";

export interface MemoryProjectionWriterLease {
  targetId: string;
  token: string;
  sourceMemoryId: string;
}

export interface MemoryProjectionWriteItem<T> {
  lease: MemoryProjectionWriterLease;
  value: T;
}

export interface MemoryProjectionCommitReceipt {
  committedTargetIds: string[];
  rejectedTargetIds: string[];
}

function projectionTargetIdentity(
  sourceMemoryId: string,
  targetKind: MemoryProjectionTargetKind,
  targetRef: string,
): { targetId: string; targetRefHash: string } {
  const targetRefHash = stableHash(`memory-projection-target-v1\0${targetKind}\0${targetRef}`);
  return {
    targetId: `mct_${stableHash(`${sourceMemoryId}\0${targetKind}\0${targetRefHash}`).slice(0, 32)}`,
    targetRefHash,
  };
}

/**
 * Register an external projection before writing it. A concurrent forget turns
 * this exact row pending and cleanup waits for the short writer lease; a writer
 * arriving after a tombstone is refused before raw content reaches a file.
 */
export function beginMemoryProjectionWrite(input: {
  sourceMemoryId: string;
  targetKind: MemoryProjectionTargetKind;
  targetRef: string;
}): MemoryProjectionWriterLease | null {
  const sourceMemoryId = input.sourceMemoryId.trim();
  const targetRef = input.targetKind === "project-files"
    ? canonicalProjectPath(input.targetRef)
    : input.targetRef.trim();
  if (!sourceMemoryId || !targetRef) return null;
  if (
    input.targetKind === "agent-nest-scan"
    && targetRef !== DEVICE_LOCAL_BORROWED_OWNER_SCOPE
    && !/^borrowed-owner:account:[0-9a-f]{64}$/.test(targetRef)
  ) return null;
  const { targetId, targetRefHash } = projectionTargetIdentity(sourceMemoryId, input.targetKind, targetRef);
  const token = `mpw_${randomUUID()}`;
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + 30_000).toISOString();
  return getDb().transaction(() => {
    const revoked = getDb().prepare(
      "SELECT revocation_id AS revocationId FROM memory_revocation_sources WHERE source_memory_id = ?",
    ).get(sourceMemoryId) as { revocationId: string } | undefined;
    getDb().prepare(
      `INSERT OR IGNORE INTO memory_revocation_cleanup_targets (
         target_id, source_memory_id, revocation_id, target_kind, target_ref,
         target_ref_hash, state, lease_kind, lease_token, lease_expires_at,
         attempt_count, progress_cursor, next_attempt_at, last_error_code, created_at, updated_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, NULL, NULL, NULL, ?, ?, NULL)`,
    ).run(
      targetId,
      sourceMemoryId,
      revoked?.revocationId ?? null,
      input.targetKind,
      targetRef,
      targetRefHash,
      revoked ? "pending" : "registered",
      nowIso,
      nowIso,
    );
    const row = getDb().prepare(
      "SELECT revocation_id AS revocationId FROM memory_revocation_cleanup_targets WHERE target_id = ?",
    ).get(targetId) as { revocationId: string | null } | undefined;
    if (!row || row.revocationId) return null;
    const claimed = getDb().prepare(
      `UPDATE memory_revocation_cleanup_targets
          SET state = 'writing', lease_kind = 'writer', lease_token = ?,
              lease_expires_at = ?, updated_at = ?, completed_at = NULL
        WHERE target_id = ? AND revocation_id IS NULL
          AND (lease_token IS NULL OR lease_expires_at <= ?)`,
    ).run(token, expiresAt, nowIso, targetId, nowIso);
    return claimed.changes === 1 ? { targetId, token, sourceMemoryId } : null;
  }).immediate();
}

/**
 * Perform the final external projection write while the canonical store still
 * owns the exact writer lease. The callback is deliberately synchronous: its
 * file or nested-SQLite write completes before this IMMEDIATE transaction can
 * release the target to forget cleanup.
 */
export function commitMemoryProjectionWrites<T>(
  items: MemoryProjectionWriteItem<T>[],
  write: (values: T[]) => void,
): MemoryProjectionCommitReceipt {
  const releaseInputLeases = (): void => {
    for (const item of items) finishMemoryProjectionWrite(item.lease);
  };
  if (write.constructor.name === "AsyncFunction") {
    releaseInputLeases();
    throw new TypeError("memory projection callback must be synchronous");
  }
  const uniqueItems = new Map<string, MemoryProjectionWriteItem<T>>();
  for (const item of items) {
    const targetId = item.lease.targetId.trim();
    const token = item.lease.token.trim();
    const sourceMemoryId = item.lease.sourceMemoryId.trim();
    if (!targetId || !token || !sourceMemoryId) continue;
    const previous = uniqueItems.get(targetId);
    if (
      previous
      && (
        previous.lease.token !== token
        || previous.lease.sourceMemoryId !== sourceMemoryId
      )
    ) {
      releaseInputLeases();
      throw new TypeError("conflicting memory projection leases");
    }
    uniqueItems.set(targetId, item);
  }
  const normalizedItems = [...uniqueItems.values()];
  if (normalizedItems.length === 0) {
    return { committedTargetIds: [], rejectedTargetIds: [] };
  }

  try {
    return getDb().transaction(() => {
      const selectTarget = getDb().prepare(
        `SELECT source_memory_id AS sourceMemoryId, revocation_id AS revocationId,
                state, lease_kind AS leaseKind, lease_token AS leaseToken,
                EXISTS(
                  SELECT 1 FROM memory_revocation_sources source
                   WHERE source.source_memory_id = memory_revocation_cleanup_targets.source_memory_id
                ) AS sourceRevoked
           FROM memory_revocation_cleanup_targets
          WHERE target_id = ?`,
      );
      const releaseRevokedWriter = getDb().prepare(
        `UPDATE memory_revocation_cleanup_targets
            SET revocation_id = COALESCE(
                  revocation_id,
                  (SELECT source.revocation_id FROM memory_revocation_sources source
                    WHERE source.source_memory_id = memory_revocation_cleanup_targets.source_memory_id)
                ),
                state = 'pending', lease_kind = NULL, lease_token = NULL,
                lease_expires_at = NULL, next_attempt_at = ?, updated_at = ?
          WHERE target_id = ? AND source_memory_id = ?
            AND lease_kind = 'writer' AND lease_token = ?`,
      );
      const completeWriter = getDb().prepare(
        `UPDATE memory_revocation_cleanup_targets
            SET state = 'registered', lease_kind = NULL, lease_token = NULL,
                lease_expires_at = NULL, next_attempt_at = NULL,
                updated_at = ?, completed_at = NULL
          WHERE target_id = ? AND source_memory_id = ?
            AND state = 'writing' AND lease_kind = 'writer' AND lease_token = ?
            AND revocation_id IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM memory_revocation_sources source
               WHERE source.source_memory_id = memory_revocation_cleanup_targets.source_memory_id
            )`,
      );
      const valid: MemoryProjectionWriteItem<T>[] = [];
      const rejectedTargetIds: string[] = [];
      const now = new Date().toISOString();
      for (const item of normalizedItems) {
        const row = selectTarget.get(item.lease.targetId) as {
          sourceMemoryId: string;
          revocationId: string | null;
          state: string;
          leaseKind: string | null;
          leaseToken: string | null;
          sourceRevoked: number;
        } | undefined;
        const exactLease = Boolean(
          row
          && row.sourceMemoryId === item.lease.sourceMemoryId
          && row.leaseKind === "writer"
          && row.leaseToken === item.lease.token
        );
        const exactWriter = exactLease && row?.state === "writing";
        if (exactWriter && row && !row.revocationId && row.sourceRevoked === 0) {
          valid.push(item);
          continue;
        }
        rejectedTargetIds.push(item.lease.targetId);
        if (exactLease && row && (row.revocationId || row.sourceRevoked !== 0)) {
          releaseRevokedWriter.run(
            now,
            now,
            item.lease.targetId,
            item.lease.sourceMemoryId,
            item.lease.token,
          );
        }
      }

      if (valid.length > 0) {
        const result = write(valid.map((item) => item.value));
        if (
          result !== null
          && (typeof result === "object" || typeof result === "function")
          && typeof (result as { then?: unknown }).then === "function"
        ) {
          throw new TypeError("memory projection callback must be synchronous");
        }
      }

      const committedTargetIds: string[] = [];
      for (const item of valid) {
        const completed = completeWriter.run(
          now,
          item.lease.targetId,
          item.lease.sourceMemoryId,
          item.lease.token,
        );
        if (completed.changes !== 1) {
          throw new Error("memory projection authority changed during commit");
        }
        committedTargetIds.push(item.lease.targetId);
      }
      return { committedTargetIds, rejectedTargetIds };
    }).immediate();
  } catch (error) {
    for (const item of normalizedItems) finishMemoryProjectionWrite(item.lease);
    throw error;
  }
}

export function finishMemoryProjectionWrite(lease: MemoryProjectionWriterLease): void {
  const now = new Date().toISOString();
  getDb().prepare(
    `UPDATE memory_revocation_cleanup_targets
        SET state = CASE WHEN revocation_id IS NULL THEN 'registered' ELSE 'pending' END,
            lease_kind = NULL, lease_token = NULL, lease_expires_at = NULL,
            next_attempt_at = CASE WHEN revocation_id IS NULL THEN NULL ELSE ? END,
            updated_at = ?
      WHERE target_id = ? AND lease_kind = 'writer' AND lease_token = ?`,
  ).run(now, now, lease.targetId, lease.token);
}

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

/**
 * A one-way identity for the exact durable-memory authority. Project paths and
 * account-local ids never enter the revocation table in plaintext.
 */
export function memoryOwnerKey(input: Pick<MemoryAuthorityInput,
  "scope" | "projectId" | "projectPath" | "agentId" | "chatId"
>): string {
  const projectId = String(input.projectId ?? "").trim();
  const projectPath = canonicalProjectPath(input.projectPath);
  const agentId = String(input.agentId ?? "").trim();
  const chatId = String(input.chatId ?? "").trim();
  let authority: string;
  if (input.scope === "project") {
    authority = projectPath
      ? `project-path:${stableHash(projectPath)}`
      : projectId
        ? `project-id:${projectId}`
        : "project-unbound";
  } else if (input.scope === "agent_repo") {
    authority = `agent:${agentId || "unbound"}`;
  } else if (input.scope === "session") {
    authority = `chat:${chatId || "unbound"}`;
  } else {
    authority = "shared";
  }
  return stableHash(`agentlas-memory-owner-v1\0${input.scope}\0${authority}`);
}

function latestOwnerRevocation(ownerKey: string): { epoch: number; revokedAt: string } | null {
  return getDb().prepare(
    `SELECT revoked_epoch AS epoch, revoked_at AS revokedAt
       FROM memory_revocations
      WHERE owner_key = ?
      ORDER BY revoked_epoch DESC LIMIT 1`,
  ).get(ownerKey) as { epoch: number; revokedAt: string } | undefined ?? null;
}

/** Must run inside the caller's IMMEDIATE insert transaction. */
export function assertMemoryWriteAllowed(input: MemoryAuthorityInput): void {
  const ownerKey = memoryOwnerKey(input);
  const contentHash = memoryContentHash(input.content);
  const exact = getDb().prepare(
    `SELECT 1 FROM memory_revocations
      WHERE owner_key = ? AND memory_kind = ? AND content_hash = ?
      LIMIT 1`,
  ).get(ownerKey, input.kind, contentHash);
  if (exact) throw new MemoryRevokedError("exact-content-revoked");

  const latest = latestOwnerRevocation(ownerKey);
  if (!latest) return;
  if (Number.isInteger(input.intakeEpoch) && Number(input.intakeEpoch) < latest.epoch) {
    throw new MemoryRevokedError("stale-intake-epoch");
  }
  const runId = String(input.intakeRunId ?? "").trim();
  if (!runId) return;
  const snapshot = getDb().prepare(
    "SELECT intake_epoch AS intakeEpoch FROM memory_run_epochs WHERE run_id = ? LIMIT 1",
  ).get(runId) as { intakeEpoch: number } | undefined;
  if (snapshot) {
    if (snapshot.intakeEpoch < latest.epoch) throw new MemoryRevokedError("stale-intake-epoch");
    return;
  }

  // Pre-v118 runs have no trigger snapshot. Their immutable first run-event
  // timestamp is the compatibility fence for an invocation already active
  // while the user forgot a memory during upgrade.
  const legacy = getDb().prepare(
    "SELECT MIN(ts) AS startedAt FROM run_events WHERE run_id = ?",
  ).get(runId) as { startedAt: string | null } | undefined;
  if (legacy?.startedAt && legacy.startedAt <= latest.revokedAt) {
    throw new MemoryRevokedError("stale-intake-epoch");
  }
}

/** Read-boundary fallback when a project-file rewrite was interrupted. */
export function filterRevokedProjectSoul(
  soul: string,
  projectId: string | null | undefined,
  projectPath: string | null | undefined,
): string {
  const ownerKey = memoryOwnerKey({
    scope: "project",
    projectId,
    projectPath,
    agentId: null,
    chatId: null,
  });
  const revoked = getDb().prepare(
    "SELECT memory_kind AS kind, content_hash AS contentHash FROM memory_revocations WHERE owner_key = ?",
  ).all(ownerKey) as Array<{ kind: string; contentHash: string }>;
  if (revoked.length === 0) return soul;
  const denied = new Set(revoked.map((row) => `${row.kind}\0${row.contentHash}`));
  return soul.split(/\r?\n/).filter((line) => {
    const match = /^- \(([^)]+)\) (.*)$/.exec(line);
    return !match || !denied.has(`${match[1]}\0${memoryContentHash(match[2])}`);
  }).join("\n");
}

function tableExists(name: string): boolean {
  return Boolean(getDb().prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
  ).get(name));
}

function legacyTicketMatchesOwner(row: LegacyDedupDecisionRow, memory: ForgettableMemoryRow): boolean {
  if (memory.scope === "project") {
    const projectPath = canonicalProjectPath(memory.project_path);
    return projectPath
      ? row.projectPathHash === stableHash(projectPath)
      : Boolean(memory.project_id) && row.projectId === memory.project_id;
  }
  if (memory.scope === "agent_repo") return row.agentId === memory.agent_id;
  if (memory.scope === "session") return row.chatId === memory.chat_id;
  return true;
}

/**
 * Pre-v118 dedup decisions did not persist their target id. Recover only exact
 * raw-content hashes under the same ticket owner. Preserve an exact live source
 * for unrelated content; quarantine every remaining unprovable episode from
 * recall without inventing a target id or deleting the original observation.
 */
function reconcileLegacyDedupEpisodes(
  matched: ForgettableMemoryRow[],
  selected: ForgettableMemoryRow,
  revocationId: string,
  revokedAt: string,
): void {
  const targetByRawHash = new Map(matched.map((row) => [stableHash(row.content), row.id]));
  if (targetByRawHash.size === 0) return;
  const ownerKey = memoryOwnerKey({
    scope: selected.scope,
    projectId: selected.project_id,
    projectPath: selected.project_path,
    agentId: selected.agent_id,
    chatId: selected.chat_id,
  });
  const liveTargetByRawHash = new Map(
    (getDb().prepare(
      `SELECT id, scope, kind, content, project_id, project_path, agent_id, chat_id, superseded_at
         FROM memory_entries
        WHERE scope = ? AND kind = ? AND superseded_at IS NULL`,
    ).all(selected.scope, selected.kind) as ForgettableMemoryRow[])
      .filter((row) => memoryOwnerKey({
        scope: row.scope,
        projectId: row.project_id,
        projectPath: row.project_path,
        agentId: row.agent_id,
        chatId: row.chat_id,
      }) === ownerKey && !targetByRawHash.has(stableHash(row.content)))
      .map((row) => [stableHash(row.content), row.id]),
  );
  const redactEpisode = getDb().prepare(
    `UPDATE memory_episodes
        SET summary = NULL, summary_hash = NULL,
            embedding_model = NULL, embedding_adapter = NULL,
            embedding_model_sha256 = NULL, embedding_content_hash = NULL,
            embedding_dimensions = NULL, embedding_json = NULL
      WHERE ticket_id = ?`,
  );
  const linkTarget = getDb().prepare(
    `UPDATE memory_decisions SET target_memory_id = ?
      WHERE ticket_id = ? AND candidate_index = ? AND target_memory_id IS NULL`,
  );
  const quarantineEpisode = getDb().prepare(
    `INSERT INTO memory_episode_quarantines (ticket_id, revocation_id, reason, created_at)
     VALUES (?, ?, 'legacy-unlinked-dedup', ?)
     ON CONFLICT(ticket_id) DO NOTHING`,
  );
  const rows = getDb().prepare(
    `SELECT decision.ticket_id AS ticketId, decision.candidate_index AS candidateIndex,
            decision.content_hash AS contentHash, ticket.project_id AS projectId,
            ticket.project_path_hash AS projectPathHash, ticket.agent_id AS agentId,
            ticket.chat_id AS chatId
       FROM memory_decisions decision
       JOIN memory_tickets ticket ON ticket.ticket_id = decision.ticket_id
      WHERE decision.target_memory_id IS NULL
        AND decision.action = 'deduped'
        AND decision.memory_kind = ? AND decision.resolved_scope = ?`,
  ).all(selected.kind, selected.scope) as LegacyDedupDecisionRow[];
  for (const row of rows) {
    if (!legacyTicketMatchesOwner(row, selected)) continue;
    const targetMemoryId = targetByRawHash.get(row.contentHash);
    if (targetMemoryId) {
      redactEpisode.run(row.ticketId);
      linkTarget.run(targetMemoryId, row.ticketId, row.candidateIndex);
      continue;
    }
    if (liveTargetByRawHash.has(row.contentHash)) continue;
    quarantineEpisode.run(row.ticketId, revocationId, revokedAt);
  }
}

function enqueueRevocationCleanupTarget(input: {
  sourceMemoryId: string;
  revocationId: string;
  targetKind: MemoryProjectionTargetKind;
  targetRef: string;
  now: string;
}): void {
  const { targetId, targetRefHash } = projectionTargetIdentity(
    input.sourceMemoryId,
    input.targetKind,
    input.targetRef,
  );
  getDb().prepare(
    `INSERT INTO memory_revocation_cleanup_targets (
       target_id, source_memory_id, revocation_id, target_kind, target_ref,
       target_ref_hash, state, lease_kind, lease_token, lease_expires_at,
       attempt_count, progress_cursor, next_attempt_at, last_error_code, created_at, updated_at, completed_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, 0, NULL, ?, NULL, ?, ?, NULL)
     ON CONFLICT(source_memory_id, target_kind, target_ref_hash) DO UPDATE SET
       revocation_id = excluded.revocation_id,
       state = 'pending',
       progress_cursor = NULL,
       next_attempt_at = excluded.next_attempt_at,
       last_error_code = NULL,
       updated_at = excluded.updated_at,
       completed_at = NULL`,
  ).run(
    targetId,
    input.sourceMemoryId,
    input.revocationId,
    input.targetKind,
    input.targetRef,
    targetRefHash,
    input.now,
    input.now,
    input.now,
  );
}

/**
 * Commit the durable tombstone and remove every directly retrievable raw DB
 * projection in one IMMEDIATE transaction. Filesystem/nest projections are
 * reconciled by the caller from the bounded return value.
 */
export function revokeOneMemoryEntry(memoryId: string, expectedAgentId: string): ForgottenMemoryProjection | null {
  const activeNestOwnerScopeKey = activeBorrowedOwnerScopeKey();
  const revoke = getDb().transaction((): ForgottenMemoryProjection | null => {
    const selected = getDb().prepare(
      `SELECT id, scope, kind, content, project_id, project_path, agent_id, chat_id, superseded_at
         FROM memory_entries
        WHERE id = ? AND agent_id = ? AND superseded_at IS NULL
        LIMIT 1`,
    ).get(memoryId, expectedAgentId) as ForgettableMemoryRow | undefined;
    if (!selected) return null;

    const ownerKey = memoryOwnerKey({
      scope: selected.scope,
      projectId: selected.project_id,
      projectPath: selected.project_path,
      agentId: selected.agent_id,
      chatId: selected.chat_id,
    });
    const contentHash = memoryContentHash(selected.content);
    const now = new Date().toISOString();
    getDb().prepare("UPDATE memory_forget_clock SET epoch = epoch + 1 WHERE id = 1").run();
    const epoch = Number((getDb().prepare(
      "SELECT epoch FROM memory_forget_clock WHERE id = 1",
    ).get() as { epoch: number }).epoch);
    const revocationId = `mrv_${randomUUID()}`;
    getDb().prepare(
      `INSERT INTO memory_revocations (
         revocation_id, owner_key, memory_kind, content_hash, source_memory_id,
         revoked_epoch, revoked_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner_key, memory_kind, content_hash) DO UPDATE SET
         source_memory_id = excluded.source_memory_id,
         revoked_epoch = excluded.revoked_epoch,
         revoked_at = excluded.revoked_at`,
    ).run(revocationId, ownerKey, selected.kind, contentHash, selected.id, epoch, now);
    const canonicalRevocation = getDb().prepare(
      `SELECT revocation_id AS revocationId FROM memory_revocations
        WHERE owner_key = ? AND memory_kind = ? AND content_hash = ?`,
    ).get(ownerKey, selected.kind, contentHash) as { revocationId: string };

    const candidates = getDb().prepare(
      `SELECT id, scope, kind, content, project_id, project_path, agent_id, chat_id, superseded_at
         FROM memory_entries
        WHERE scope = ? AND kind = ?`,
    ).all(selected.scope, selected.kind) as ForgettableMemoryRow[];
    const matched = candidates.filter((row) =>
      memoryOwnerKey({
        scope: row.scope,
        projectId: row.project_id,
        projectPath: row.project_path,
        agentId: row.agent_id,
        chatId: row.chat_id,
      }) === ownerKey && memoryContentHash(row.content) === contentHash,
    );
    const sourceMemoryIds = matched.map((row) => row.id);
    const projectPaths = [...new Set(matched.map((row) => row.project_path).filter((value): value is string => Boolean(value)))];
    if (sourceMemoryIds.length === 0) return null;

    reconcileLegacyDedupEpisodes(matched, selected, canonicalRevocation.revocationId, now);

    const linkSource = getDb().prepare(
      `INSERT INTO memory_revocation_sources (source_memory_id, revocation_id)
       VALUES (?, ?)
       ON CONFLICT(source_memory_id) DO UPDATE SET revocation_id = excluded.revocation_id`,
    );
    for (const id of sourceMemoryIds) linkSource.run(id, canonicalRevocation.revocationId);

    const placeholders = sourceMemoryIds.map(() => "?").join(",");
    getDb().prepare(
      `UPDATE memory_revocation_cleanup_targets
          SET revocation_id = ?, state = 'pending', next_attempt_at = ?,
              progress_cursor = NULL,
              last_error_code = NULL, updated_at = ?, completed_at = NULL
        WHERE source_memory_id IN (${placeholders})`,
    ).run(canonicalRevocation.revocationId, now, now, ...sourceMemoryIds);
    for (const row of matched) {
      const projectPath = canonicalProjectPath(row.project_path);
      if (projectPath) {
        enqueueRevocationCleanupTarget({
          sourceMemoryId: row.id,
          revocationId: canonicalRevocation.revocationId,
          targetKind: "project-files",
          targetRef: projectPath,
          now,
        });
      }
      if (row.scope === "agent_repo") {
        enqueueRevocationCleanupTarget({
          sourceMemoryId: row.id,
          revocationId: canonicalRevocation.revocationId,
          targetKind: "agent-nest-scan",
          targetRef: activeNestOwnerScopeKey,
          now,
        });
      }
    }

    const redactMemory = getDb().prepare(
      `UPDATE memory_entries
          SET content = '', evidence_json = '[]', context_json = '{}', chat_id = NULL,
              embedding_model = NULL, embedding_adapter = NULL,
              embedding_model_sha256 = NULL, embedding_content_hash = NULL,
              embedding_dimensions = NULL, embedding_json = NULL, superseded_at = ?
        WHERE id = ?`,
    );
    const deleteRelations = getDb().prepare(
      "DELETE FROM memory_relation_edges WHERE from_memory_id = ? OR to_memory_id = ?",
    );
    const redactEpisodes = getDb().prepare(
      `UPDATE memory_episodes
          SET summary = NULL, summary_hash = NULL,
              embedding_model = NULL, embedding_adapter = NULL,
              embedding_model_sha256 = NULL, embedding_content_hash = NULL,
              embedding_dimensions = NULL, embedding_json = NULL
        WHERE ticket_id IN (
          SELECT ticket_id FROM memory_decisions WHERE target_memory_id = ?
        )`,
    );
    for (const id of sourceMemoryIds) {
      redactEpisodes.run(id);
      deleteRelations.run(id, id);
      if (tableExists("experience_candidates")) {
        getDb().prepare(
          `UPDATE experience_candidates
              SET summary = '', task_terms_json = '[]', status = 'rejected',
                  public_safe = 0, embedding_model = NULL, embedding_adapter = NULL,
                  embedding_model_sha256 = NULL, embedding_content_hash = NULL,
                  embedding_dimensions = NULL, embedding_json = NULL, updated_at = ?
            WHERE source_memory_id = ?`,
        ).run(now, id);
      }
      if (tableExists("taste_draft_candidates")) {
        getDb().prepare(
          `UPDATE taste_draft_candidates
              SET axis_candidates_json = '[]', task_signatures_json = '[]',
                  status = 'rejected', updated_at = ?
            WHERE source_memory_id = ?`,
        ).run(now, id);
      }
      redactMemory.run(now, id);
    }

    return {
      sourceMemoryIds,
      kind: selected.kind,
      content: selected.content,
      contentHash,
      projectPaths,
      forgottenAt: now,
      revokedEpoch: epoch,
    };
  });
  return revoke.immediate();
}
