// Experience reuse from canonical learned memory.
//
// 0b9185be (2026-10-14) retired the per-memory approval writers (propose/save/edit/use-once). The
// legacy approved-asset overlay can therefore never gain a new asset, and Experience Reuse /
// Improvement Proof — which only read those assets — had no source for any memory learned since.
// The current path is: the curator writes canonical memory from a run (origin links: run/ticket),
// ordinary recall puts selected entries into a later run's prompt and records their ids
// (memory/recall-receipt.ts), and the owner explicitly accepts results. A reused experience is an
// applied canonical entry whose origin run is the exact accepted run of a different completed Task.
// The owner's acceptance of that source result is the explicit act (no per-memory approval exists).
import type { OneExperienceReuseAssetBinding, OneExperienceReuseScope } from "../../shared/one-experience-reuse";
import type { OneValueClosureRecord, OneValueClosureState } from "../../shared/one-value-closure";
import type { CanonicalTask, InvocationRunReceipt, RunEventUi } from "../../shared/types";
import { getMemoryDb, getMemoryStoreInfo } from "../memory/database";
import {
  MEMORY_RECALL_APPLIED_EVENT_KIND,
  isCanonicalMemoryEntryId,
  parseMemoryRecallAppliedPayload,
} from "../memory/recall-receipt";
import { getInvocationRunReceipt } from "../store/run-events";
import { findCanonicalTaskForChat } from "../store/tasks";

const CANONICAL_ASSET_RE = /^memory_([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})$/;
const MAX_BINDINGS = 32;

export interface CanonicalReuseMemory {
  entryId: string;
  revision: number;
  scope: string;
  reuseScope: OneExperienceReuseScope;
  projectId: string | null;
  actorId: string | null;
  createdAt: string;
}

export interface CanonicalAcceptedSource {
  task: CanonicalTask;
  run: InvocationRunReceipt & { finishedAt: string };
  closure: OneValueClosureRecord;
}

/** Reversible, collision-free mapping onto the closed `memory_<32 hex>` asset id. */
export function canonicalMemoryAssetId(entryId: string): string {
  if (!isCanonicalMemoryEntryId(entryId)) throw new TypeError("Canonical memory id is invalid");
  return `memory_${entryId.replace(/-/g, "")}`;
}

export function canonicalMemoryEntryIdFromAsset(assetId: string): string | null {
  const match = CANONICAL_ASSET_RE.exec(assetId);
  return match ? match.slice(1).join("-") : null;
}

export function canonicalReuseScope(scope: string): OneExperienceReuseScope | null {
  if (scope === "user_identity") return "personal";
  if (scope === "project") return "project";
  if (scope === "agent_repo") return "agent";
  if (scope === "team_memory" || scope === "agent_team") return "team";
  return null; // session memory never crosses Tasks.
}

function applicability(raw: string | null): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/**
 * The live canonical entry, or null when it is not an active, owner-bound, default-channel memory:
 * forgotten (content ''), superseded (owner edit / explicit replacement), disabled, foreign owner,
 * legacy One overlay copy (that reuse is attested by the legacy receipt), or session scope.
 */
export function readActiveCanonicalReuseMemory(entryId: string): CanonicalReuseMemory | null {
  if (!isCanonicalMemoryEntryId(entryId)) return null;
  const store = getMemoryStoreInfo();
  const row = getMemoryDb().prepare(
    `SELECT m.id, m.scope, m.content, m.project_id, m.agent_id, m.superseded_at, m.created_at,
            b.owner_namespace, b.actor_id, b.applicability_json, b.revision
       FROM memory_entries m JOIN memory_identity_bindings b ON b.memory_id = m.id
      WHERE m.id = ? LIMIT 1`,
  ).get(entryId) as {
    id: string; scope: string; content: string; project_id: string | null; agent_id: string | null;
    superseded_at: string | null; created_at: string; owner_namespace: string | null; actor_id: string | null;
    applicability_json: string | null; revision: number;
  } | undefined;
  if (!row || !row.content || row.superseded_at) return null;
  if (row.owner_namespace ? row.owner_namespace !== store.ownerNamespace : !store.ownerNamespace.startsWith("device-local:")) return null;
  const app = applicability(row.applicability_json);
  if (app.enabled === false || app.recallChannel === "legacy_one_overlay") return null;
  const reuseScope = canonicalReuseScope(row.scope);
  if (!reuseScope || !Number.isSafeInteger(row.revision) || row.revision < 1) return null;
  return {
    entryId: row.id,
    revision: row.revision,
    scope: row.scope,
    reuseScope,
    projectId: row.project_id,
    actorId: row.actor_id?.trim() || row.agent_id || null,
    createdAt: row.created_at,
  };
}

/** Runs that produced this entry: direct run origins plus the runs of its origin Tickets. */
export function canonicalMemoryOriginRunIds(entryId: string): string[] {
  const db = getMemoryDb();
  const direct = db.prepare(
    "SELECT source_id FROM memory_origin_links WHERE memory_id = ? AND source_kind = 'run'",
  ).all(entryId) as Array<{ source_id: string }>;
  const viaTicket = db.prepare(
    `SELECT t.run_id AS source_id FROM memory_origin_links l JOIN memory_tickets t ON t.ticket_id = l.source_id
      WHERE l.memory_id = ? AND l.source_kind = 'ticket' AND t.run_id IS NOT NULL`,
  ).all(entryId) as Array<{ source_id: string }>;
  return [...new Set([...direct, ...viaTicket].map((row) => row.source_id).filter(Boolean))].sort();
}

/** The exact accepted closure of a completed Task for exactly this run, or null. */
export function acceptedClosureForRun(state: OneValueClosureState, task: CanonicalTask, runId: string): OneValueClosureRecord | null {
  for (const record of state.closures) {
    if (
      record.closure.taskId !== task.id
      || record.taskVersion !== task.version
      || record.closure.outcomeStatus !== "partially_verified"
      || record.closure.outcomeRefs.length !== 1
      || !record.closure.outcomeRefs[0]?.startsWith("result:accepted-internal:")
    ) continue;
    const evidence = state.evidence.filter((item) => record.trustedEvidenceRefs.includes(item.evidenceRef));
    const acceptance = evidence.some((item) =>
      item.kind === "result_acceptance" && item.source === "canonical_task_runtime"
      && item.taskId === task.id && item.taskVersion === task.version && item.sourceRunRef === runId);
    const execution = evidence.some((item) =>
      item.kind === "execution_receipt" && item.source === "invocation_runtime"
      && item.taskId === task.id && item.taskVersion === task.version && item.sourceRunRef === runId);
    if (acceptance && execution) return record;
  }
  return null;
}

/** Earliest accepted origin of an entry: its learning run is the exact run the owner accepted. */
export function canonicalAcceptedSource(entryId: string, state: OneValueClosureState): CanonicalAcceptedSource | null {
  const candidates: CanonicalAcceptedSource[] = [];
  for (const runId of canonicalMemoryOriginRunIds(entryId)) {
    const run = getInvocationRunReceipt(runId);
    if (!run || run.status !== "completed" || typeof run.finishedAt !== "string" || !run.chatId) continue;
    const task = findCanonicalTaskForChat(run.chatId);
    if (!task || task.status !== "completed" || task.originChatId !== run.chatId) continue;
    const closure = acceptedClosureForRun(state, task, runId);
    if (closure) candidates.push({ task, run: run as InvocationRunReceipt & { finishedAt: string }, closure });
  }
  candidates.sort((left, right) =>
    left.run.finishedAt.localeCompare(right.run.finishedAt) || left.run.runId.localeCompare(right.run.runId));
  return candidates[0] ?? null;
}

/**
 * Canonical bindings applied to one run, from its recall receipts. Malformed receipts and entries
 * that changed after they were applied (forgotten, edited/superseded, disabled, revision moved)
 * throw; entries without an accepted different-Task origin are simply not reused experience.
 */
export function canonicalAppliedMemoryBindings(
  events: RunEventUi[],
  current: { taskId: string; runStartedAt: string },
  state: OneValueClosureState,
): { authorityRevision: number; bindings: OneExperienceReuseAssetBinding[] } | null {
  const receipts = events.filter((event) => event.kind === MEMORY_RECALL_APPLIED_EVENT_KIND);
  if (receipts.length === 0) return null;
  const applied = new Map<string, number>();
  let authorityRevision = 0;
  for (const event of receipts) {
    const parsed = parseMemoryRecallAppliedPayload(event.payload);
    authorityRevision = Math.max(authorityRevision, parsed.authorityRevision);
    parsed.memoryIds.forEach((entryId, index) => {
      const prior = applied.get(entryId);
      if (prior !== undefined && prior !== parsed.revisions[index]) throw new Error("Run has ambiguous Memory application receipts");
      applied.set(entryId, parsed.revisions[index]);
    });
  }
  const bindings: OneExperienceReuseAssetBinding[] = [];
  for (const [entryId, revision] of applied) {
    const memory = readActiveCanonicalReuseMemory(entryId);
    if (!memory) {
      // A legacy One overlay copy or session entry is not canonical reuse; anything else changed.
      const raw = getMemoryDb().prepare(
        "SELECT m.scope, b.applicability_json FROM memory_entries m LEFT JOIN memory_identity_bindings b ON b.memory_id = m.id WHERE m.id = ?",
      ).get(entryId) as { scope: string; applicability_json: string | null } | undefined;
      if (raw && (canonicalReuseScope(raw.scope) === null || applicability(raw.applicability_json).recallChannel === "legacy_one_overlay")) continue;
      throw new Error("Applied Memory asset changed before exact reuse could be attested");
    }
    if (memory.revision !== revision) throw new Error("Applied Memory asset changed before exact reuse could be attested");
    if (Date.parse(memory.createdAt) > Date.parse(current.runStartedAt)) continue;
    const source = canonicalAcceptedSource(entryId, state);
    if (!source || source.task.id === current.taskId) continue;
    bindings.push({
      assetId: canonicalMemoryAssetId(entryId),
      assetVersion: revision,
      provenanceStatus: "verified",
      sourceTaskId: source.task.id,
      sourceTaskVersion: source.task.version,
      sourceRunId: source.run.runId,
      sourceValueClosureId: source.closure.closure.valueClosureId,
      sourceValueClosureVersion: source.closure.version,
      scope: memory.reuseScope,
    });
    if (bindings.length >= MAX_BINDINGS) break;
  }
  return { authorityRevision: Math.max(1, authorityRevision), bindings };
}
