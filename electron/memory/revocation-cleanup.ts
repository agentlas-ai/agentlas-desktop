import { randomUUID } from "node:crypto";

import { onDesktopStoreChange } from "../store/change-bus";
import { openedStoreMigrationRole } from "../store/db";
import { getMemoryDb as getDb } from "./database";
import {
  forgetAgentNestExperienceMemoryForOwnerScope,
  reconcileProjectMemoryProjectionCleanup,
} from "./project-files";
import { onMemoryRevocationCleanupQueued } from "./revocations";

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
    now.getTime() + (
      reason === "agent-nest-scan-continued" || reason === "project-projection-continued"
        ? 0
        : retryDelayMs(row.attemptCount)
    ),
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

function reconcileTarget(
  row: CleanupTargetRow,
  token: string,
): { complete: boolean; reason: string; progressCursor?: string | null } {
  try {
    if (row.targetKind === "project-files") {
      return reconcileProjectMemoryProjectionCleanup({
        targetId: row.targetId,
        cleanupToken: token,
        sourceMemoryId: row.sourceMemoryId,
        projectPath: row.targetRef,
        kind: row.memoryKind,
        contentHash: row.contentHash,
        forgottenAt: row.forgottenAt,
        progressCursor: row.progressCursor,
      });
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
    const result = reconcileTarget(lease.row, lease.token);
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
let failedDrains = 0;
let stopListening: (() => void) | null = null;
let lastExternalWakeAt = 0;

// Node timers overflow near 24.8 days; a longer wait is re-aimed when it fires.
const MAX_TIMER_MS = 24 * 60 * 60_000;
// A drain that claimed nothing although a target looked due (another worker took it, a clock step) is not retried in a tight loop.
const EMPTY_PASS_FLOOR_MS = 1_000;
const WAKE_DEBOUNCE_MS = 250;
// Another process's commits arrive as chat changes, many per turn: one look at the queue per window is enough.
const EXTERNAL_WAKE_WINDOW_MS = 5_000;
/** A store that keeps failing is tried a few more times, further apart, then left alone until something wakes the worker. */
export const MEMORY_REVOCATION_CLEANUP_FAILURE_WAITS_MS: readonly number[] = [5_000, 20_000, 60_000, 300_000];

/**
 * When the earliest waiting target can be claimed: its retry time, or the end of the lease another worker holds on it.
 * 0 means now; null means nothing waits, so no timer is needed.
 */
export function nextMemoryRevocationCleanupDueMs(): number | null {
  const row = getDb().prepare(
    `SELECT MIN(MAX(COALESCE(next_attempt_at, ''),
                    CASE WHEN lease_token IS NULL THEN '' ELSE COALESCE(lease_expires_at, '') END)) AS due
       FROM memory_revocation_cleanup_targets
      WHERE revocation_id IS NOT NULL AND state <> 'complete'`,
  ).get() as { due: string | null } | undefined;
  if (!row || row.due === null) return null;
  if (row.due === "") return 0;
  const due = Date.parse(row.due);
  return Number.isFinite(due) ? due : 0;
}

function schedule(delayMs: number): void {
  if (!controller || controller.signal.aborted || timer) return;
  timer = setTimeout(() => {
    timer = null;
    if (!controller || controller.signal.aborted) return;
    const signal = controller.signal;
    activeDrain = drainMemoryRevocationCleanup({ signal })
      .then((receipt) => {
        failedDrains = 0;
        if (!signal.aborted) aim(receipt.claimed === 0 ? EMPTY_PASS_FLOOR_MS : 0);
      })
      .catch(() => {
        const wait = MEMORY_REVOCATION_CLEANUP_FAILURE_WAITS_MS[failedDrains];
        failedDrains += 1;
        if (!signal.aborted && wait !== undefined) schedule(wait);
      })
      .finally(() => { activeDrain = null; });
  }, Math.min(MAX_TIMER_MS, Math.max(0, delayMs)));
  timer.unref?.();
}

/** One timer aimed at the earliest waiting target, and none when the queue is empty. */
function aim(floorMs: number): void {
  if (!controller || controller.signal.aborted || timer) return;
  let due: number | null;
  try { due = nextMemoryRevocationCleanupDueMs(); }
  catch {
    const wait = MEMORY_REVOCATION_CLEANUP_FAILURE_WAITS_MS[failedDrains];
    failedDrains += 1;
    if (wait !== undefined) schedule(wait);
    return;
  }
  if (due === null) return;
  schedule(Math.max(floorMs, due - Date.now()));
}

/**
 * A forgotten memory just queued (or re-queued) a cleanup target: look at the queue now instead of at the timer's old aim.
 * Safe to call from inside the writing transaction; the look happens after it commits.
 */
export function wakeMemoryRevocationCleanup(): void {
  if (!controller || controller.signal.aborted) return;
  failedDrains = 0;
  // A running drain re-reads the queue when it ends, so it already covers this wake.
  if (activeDrain) return;
  if (timer) { clearTimeout(timer); timer = null; }
  schedule(WAKE_DEBOUNCE_MS);
}

export function startMemoryRevocationCleanup(): void {
  if (openedStoreMigrationRole() !== "owner") return;
  if (controller && !controller.signal.aborted) return;
  controller = new AbortController();
  failedDrains = 0;
  onMemoryRevocationCleanupQueued(wakeMemoryRevocationCleanup);
  // The background service forgets memories too (One turns run there) and cannot call into this process. Its turn commits
  // chat rows, which reach this process's change bus, so that is when the queue is looked at for its targets.
  const unsubscribe = onDesktopStoreChange((change) => {
    if (change.entity !== "chat" || timer || activeDrain) return;
    const now = Date.now();
    if (now - lastExternalWakeAt < EXTERNAL_WAKE_WINDOW_MS) return;
    lastExternalWakeAt = now;
    wakeMemoryRevocationCleanup();
  });
  stopListening = () => { unsubscribe(); onMemoryRevocationCleanupQueued(null); };
  // One pass at start picks up whatever a crash, a quit or the background service left queued.
  schedule(0);
}

export async function stopMemoryRevocationCleanup(): Promise<void> {
  const current = controller;
  controller = null;
  current?.abort(new Error("memory_revocation_cleanup_stopped"));
  stopListening?.();
  stopListening = null;
  if (timer) clearTimeout(timer);
  timer = null;
  await activeDrain?.catch(() => {});
}
