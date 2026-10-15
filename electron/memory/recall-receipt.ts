// Content-free receipt of which canonical memory entries actually entered a run's prompt.
//
// Since 0b9185be (2026-10-14) per-memory approval writers are retired: learned memory reaches the
// canonical store only through the Ticket/curator path, and ordinary recall (context.ts) selects it.
// Recall already recorded WHICH SOURCES entered a turn (context_source markers), but not WHICH
// MEMORIES — so nothing could later attest that an experience learned from an earlier accepted
// result was reused (one/experience-reuse.ts read only the retired legacy approved assets).
// This receipt carries ids and binding revisions only: never memory text, scope fields or paths.
import { getMemoryDb, getMemoryStoreInfo } from "./database";
import { tryRecordRunEvent } from "../store/run-events";

export const MEMORY_RECALL_APPLIED_EVENT_KIND = "memory_recall_applied";
/** The run ledger keeps at most 20 array items per payload field. */
export const MEMORY_RECALL_APPLIED_MAX_ENTRIES = 20;
const CANONICAL_MEMORY_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface MemoryRecallAppliedReceipt {
  memoryIds: string[];
  revisions: number[];
  authorityRevision: number;
}

export function isCanonicalMemoryEntryId(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_MEMORY_ID_RE.test(value);
}

/**
 * Records the selected canonical entries that entered this run's prompt. Best effort by design:
 * observability can never refuse, delay or alter the recalled text itself.
 */
export function recordMemoryRecallApplied(input: {
  runId: string | null | undefined;
  chatId?: string | null;
  memoryIds: Iterable<string>;
}): void {
  if (!input.runId) return;
  try {
    const ids = [...new Set([...input.memoryIds].filter(isCanonicalMemoryEntryId))].slice(0, MEMORY_RECALL_APPLIED_MAX_ENTRIES);
    if (ids.length === 0) return;
    const store = getMemoryStoreInfo();
    const rows = getMemoryDb().prepare(
      `SELECT memory_id, revision FROM memory_identity_bindings WHERE memory_id IN (${ids.map(() => "?").join(",")})`,
    ).all(...ids) as Array<{ memory_id: string; revision: number }>;
    const revisionOf = new Map(rows.map((row) => [row.memory_id, Number(row.revision)]));
    const bound = ids.filter((id) => Number.isSafeInteger(revisionOf.get(id)) && Number(revisionOf.get(id)) > 0);
    if (bound.length === 0) return;
    const authorityRevision = Math.max(1, Math.trunc(Number(store.revision) || 0));
    tryRecordRunEvent({
      runId: input.runId,
      kind: MEMORY_RECALL_APPLIED_EVENT_KIND,
      chatId: input.chatId ?? null,
      // No agentId: this receipt must never count as a run participant.
      payload: {
        memoryIds: bound,
        revisions: bound.map((id) => revisionOf.get(id)!),
        authorityRevision,
      },
    });
  } catch {
    /* Recall observability never blocks the turn. */
  }
}

/** Closed reader for one stored receipt payload; the run ledger's runtimeEvidence envelope is ignored. */
export function parseMemoryRecallAppliedPayload(raw: unknown): MemoryRecallAppliedReceipt {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Memory recall receipt is malformed");
  const { runtimeEvidence: _runtimeEvidence, ...payload } = raw as Record<string, unknown>;
  const keys = Object.keys(payload).sort();
  if (keys.join(",") !== "authorityRevision,memoryIds,revisions") throw new Error("Memory recall receipt contains unsupported fields");
  const { memoryIds, revisions, authorityRevision } = payload as Record<string, unknown>;
  if (
    !Array.isArray(memoryIds) || !Array.isArray(revisions)
    || memoryIds.length === 0 || memoryIds.length > MEMORY_RECALL_APPLIED_MAX_ENTRIES
    || revisions.length !== memoryIds.length
    || !memoryIds.every(isCanonicalMemoryEntryId)
    || new Set(memoryIds).size !== memoryIds.length
    || !revisions.every((value) => Number.isSafeInteger(value) && Number(value) > 0)
    || !Number.isSafeInteger(authorityRevision) || Number(authorityRevision) < 1
  ) throw new Error("Memory recall receipt is malformed");
  return { memoryIds: memoryIds as string[], revisions: revisions as number[], authorityRevision: Number(authorityRevision) };
}
