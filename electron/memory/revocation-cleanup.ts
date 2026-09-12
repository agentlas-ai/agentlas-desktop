import { randomUUID } from "node:crypto";

import { getDb, openedStoreMigrationRole } from "../store/db";
import {
  forgetAgentNestExperienceMemoryForOwnerScope,
  forgetProjectMemoryProjection,
  isProjectMemoryProjectionForgotten,
} from "./project-files";

const DEFAULT_BATCH_SIZE = 8;
const CLEANUP_LEASE_MS = 30_000;

interface CleanupTargetRow {
  targetId: string;
  sourceMemoryId: string;
  targetKind: "project-files" | "agent-nest-scan";
  targetRef: string;
  memoryKind: string;
  contentHash: string;
  forgottenAt: string;
  attemptCount: number;
  progressCursor: string | null;
}

export interface MemoryRevocationCleanupReceipt {
  claimed: number;
  completed: number;
  pending: number;
  stopped: boolean;
}

function retryDelayMs(attemptCount: number): number {
  return Math.min(5 * 60_000, 1_000 * (2 ** Math.min(8, Math.max(0, attemptCount - 1))));
}

function claimNextTarget(now: Date): { row: CleanupTargetRow; token: string } | null {
  const nowIso = now.toISOString();
  const token = `mcl_${randomUUID()}`;
  const expiresAt = new Date(now.getTime() + CLEANUP_LEASE_MS).toISOString();
  return getDb().transaction(() => {
    const row = getDb().prepare(
      `SELECT target.target_id AS targetId,
              target.source_memory_id AS sourceMemoryId,
              target.target_kind AS targetKind,
              target.target_ref AS targetRef,
              revocation.memory_kind AS memoryKind,
              revocation.content_hash AS contentHash,
              revocation.revoked_at AS forgottenAt,
              target.attempt_count AS attemptCount
              , target.progress_cursor AS progressCursor
         FROM memory_revocation_cleanup_targets target
         JOIN memory_revocations revocation ON revocation.revocation_id = target.revocation_id
        WHERE target.state <> 'complete'
          AND (target.next_attempt_at IS NULL OR target.next_attempt_at <= ?)
          AND (target.lease_token IS NULL OR target.lease_expires_at <= ?)
        ORDER BY target.created_at ASC, target.target_id ASC
        LIMIT 1`,
    ).get(nowIso, nowIso) as CleanupTargetRow | undefined;
    if (!row) return null;
    const claimed = getDb().prepare(
      `UPDATE memory_revocation_cleanup_targets
          SET state = 'leased', lease_kind = 'cleanup', lease_token = ?,
              lease_expires_at = ?, attempt_count = attempt_count + 1,
              updated_at = ?
        WHERE target_id = ? AND state <> 'complete'
          AND (lease_token IS NULL OR lease_expires_at <= ?)`,
    ).run(token, expiresAt, nowIso, row.targetId, nowIso);
    if (claimed.changes !== 1) return null;
    return { row: { ...row, attemptCount: row.attemptCount + 1 }, token };
  }).immediate();
}

function completeTarget(targetId: string, token: string, now: Date): boolean {
  const nowIso = now.toISOString();
  return getDb().prepare(
    `UPDATE memory_revocation_cleanup_targets
        SET state = 'complete', lease_kind = NULL, lease_token = NULL,
            lease_expires_at = NULL, next_attempt_at = NULL,
            progress_cursor = NULL, last_error_code = NULL, updated_at = ?, completed_at = ?
      WHERE target_id = ? AND state = 'leased'
        AND lease_kind = 'cleanup' AND lease_token = ?`,
  ).run(nowIso, nowIso, targetId, token).changes === 1;
}

function deferTarget(
  row: CleanupTargetRow,
  token: string,
  now: Date,
  reason: string,
  progressCursor: string | null = row.progressCursor,
): void {
  const nowIso = now.toISOString();
  const retryAt = new Date(
    now.getTime() + (reason === "agent-nest-scan-continued" ? 0 : retryDelayMs(row.attemptCount)),
  ).toISOString();
  getDb().prepare(
    `UPDATE memory_revocation_cleanup_targets
        SET state = 'pending', lease_kind = NULL, lease_token = NULL,
            lease_expires_at = NULL, next_attempt_at = ?,
            progress_cursor = ?, last_error_code = ?, updated_at = ?, completed_at = NULL
      WHERE target_id = ? AND state = 'leased'
        AND lease_kind = 'cleanup' AND lease_token = ?`,
  ).run(retryAt, progressCursor, reason, nowIso, row.targetId, token);
}

function reconcileTarget(row: CleanupTargetRow): { complete: boolean; reason: string; progressCursor?: string | null } {
  try {
    if (row.targetKind === "project-files") {
      forgetProjectMemoryProjection(
        row.targetRef,
        row.memoryKind,
        row.contentHash,
        row.forgottenAt,
        [row.sourceMemoryId],
      );
      return {
        complete: isProjectMemoryProjectionForgotten(
          row.targetRef,
          row.memoryKind,
          row.contentHash,
          [row.sourceMemoryId],
        ),
        reason: "project-projection-remains",
      };
    }
    const result = forgetAgentNestExperienceMemoryForOwnerScope(
      row.targetRef,
      row.sourceMemoryId,
      row.forgottenAt,
      row.progressCursor,
    );
    return {
      complete: result.complete,
      reason: result.nextCursor && result.nextCursor !== row.progressCursor
        ? "agent-nest-scan-continued"
        : "agent-nest-scan-incomplete",
      progressCursor: result.nextCursor,
    };
  } catch {
    return {
      complete: false,
      reason: row.targetKind === "project-files"
        ? "project-projection-unavailable"
        : "agent-nest-scan-unavailable",
    };
  }
}

export async function drainMemoryRevocationCleanup(input: {
  limit?: number;
  signal?: AbortSignal;
  now?: () => Date;
} = {}): Promise<MemoryRevocationCleanupReceipt> {
  const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? DEFAULT_BATCH_SIZE)));
  const now = input.now ?? (() => new Date());
  let claimed = 0;
  let completed = 0;
  for (; claimed < limit && !input.signal?.aborted; claimed += 1) {
    const lease = claimNextTarget(now());
    if (!lease) break;
    const result = reconcileTarget(lease.row);
    if (result.complete) {
      if (completeTarget(lease.row.targetId, lease.token, now())) completed += 1;
    } else {
      deferTarget(lease.row, lease.token, now(), result.reason, result.progressCursor);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const pending = Number((getDb().prepare(
    "SELECT COUNT(*) AS n FROM memory_revocation_cleanup_targets WHERE revocation_id IS NOT NULL AND state <> 'complete'",
  ).get() as { n: number }).n);
  return { claimed, completed, pending, stopped: Boolean(input.signal?.aborted) };
}

let timer: NodeJS.Timeout | null = null;
let controller: AbortController | null = null;
let activeDrain: Promise<void> | null = null;

function schedule(delayMs: number): void {
  if (!controller || controller.signal.aborted || timer) return;
  timer = setTimeout(() => {
    timer = null;
    if (!controller || controller.signal.aborted) return;
    const signal = controller.signal;
    activeDrain = drainMemoryRevocationCleanup({ signal })
      .then((receipt) => {
        if (!signal.aborted) schedule(receipt.pending > 0 ? 1_000 : 30_000);
      })
      .catch(() => {
        if (!signal.aborted) schedule(5_000);
      })
      .finally(() => { activeDrain = null; });
  }, delayMs);
  timer.unref?.();
}

export function startMemoryRevocationCleanup(): void {
  if (openedStoreMigrationRole() !== "owner") return;
  if (controller && !controller.signal.aborted) return;
  controller = new AbortController();
  schedule(0);
}

export async function stopMemoryRevocationCleanup(): Promise<void> {
  const current = controller;
  controller = null;
  current?.abort(new Error("memory_revocation_cleanup_stopped"));
  if (timer) clearTimeout(timer);
  timer = null;
  await activeDrain?.catch(() => {});
}
