import { createHash } from "node:crypto";
import {
  ONE_EXPERIENCE_REUSE_CONTRACT_VERSION,
  isOneExperienceReuseState,
  type EnsureOneExperienceReuseReceiptInput,
  type OneExperienceReuseAssetBinding,
  type OneExperienceReuseRecord,
  type OneExperienceReuseState,
} from "../../shared/one-experience-reuse";
import { getDb } from "../store/db";
import { getInvocationRunReceipt, listRunEvents } from "../store/run-events";
import { getCanonicalTask } from "../store/tasks";
import { getOneMemoryState } from "./memory-candidates";
import { tryRecordOneDomainEvent } from "./domain-events";
import { getOneValueClosureState } from "./value-closure";

export const ONE_EXPERIENCE_REUSE_META_KEY = "agentlas.one.experience-reuse.v1";
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const MEMORY_ID_RE = /^memory_[a-f0-9]{32}$/;
const VALUE_CLOSURE_ID_RE = /^value_closure_[a-f0-9]{32}$/;
const MEMORY_SCOPES = ["personal", "project", "agent", "team"] as const;
const MAX_RUN_EVENTS = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  const actual = Object.keys(value);
  return actual.length === allowed.length && actual.every((key) => keys.has(key));
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID_RE.test(value);
}

function positiveVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function timestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && new Date(parsed).toISOString() === value;
}

function initialState(): OneExperienceReuseState {
  const version = Math.max(1, Date.now());
  const now = new Date(version).toISOString();
  return {
    contractVersion: ONE_EXPERIENCE_REUSE_CONTRACT_VERSION,
    version,
    receipts: [],
    createdAt: now,
    updatedAt: now,
  };
}

function parseState(raw: string): OneExperienceReuseState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Stored One experience-reuse receipts are corrupt; they were not overwritten");
  }
  if (!isOneExperienceReuseState(parsed)) {
    throw new Error("Stored One experience-reuse receipts violate their closed contract; they were not overwritten");
  }
  return parsed;
}

function readState(): { raw: string; state: OneExperienceReuseState } {
  const db = getDb();
  let row = db.prepare("SELECT value FROM meta WHERE key = ? LIMIT 1")
    .get(ONE_EXPERIENCE_REUSE_META_KEY) as { value: string } | undefined;
  if (!row) {
    db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)")
      .run(ONE_EXPERIENCE_REUSE_META_KEY, JSON.stringify(initialState()));
    row = db.prepare("SELECT value FROM meta WHERE key = ? LIMIT 1")
      .get(ONE_EXPERIENCE_REUSE_META_KEY) as { value: string } | undefined;
  }
  if (!row) throw new Error("Could not initialize One experience-reuse receipts");
  return { raw: row.value, state: parseState(row.value) };
}

function assertInput(input: EnsureOneExperienceReuseReceiptInput): void {
  if (!isRecord(input) || !exactKeys(input, [
    "taskId", "expectedTaskVersion", "expectedTaskUpdatedAt", "expectedRunId", "valueClosureId",
    "expectedValueClosureVersion", "confirmedByUser",
  ])) throw new TypeError("One experience-reuse input must be a closed object");
  if (!safeId(input.taskId) || !positiveVersion(input.expectedTaskVersion) || !timestamp(input.expectedTaskUpdatedAt)) {
    throw new TypeError("One experience-reuse requires an exact Task id/version/timestamp binding");
  }
  if (
    !safeId(input.expectedRunId)
    || !VALUE_CLOSURE_ID_RE.test(input.valueClosureId)
    || !positiveVersion(input.expectedValueClosureVersion)
  ) {
    throw new TypeError("One experience-reuse requires exact run and Value Closure bindings");
  }
  if (input.confirmedByUser !== true) throw new Error("One experience-reuse requires explicit result acceptance");
}

function receiptId(input: EnsureOneExperienceReuseReceiptInput): string {
  const digest = createHash("sha256")
    .update([
      "agentlas-one:experience-reuse:v1", input.taskId, String(input.expectedTaskVersion),
      input.expectedRunId, input.valueClosureId, String(input.expectedValueClosureVersion),
    ].join(":"), "utf8")
    .digest("hex")
    .slice(0, 32);
  return `one_reuse_receipt_${digest}`;
}

function exactAppliedAssets(input: EnsureOneExperienceReuseReceiptInput): {
  memoryStoreVersion: number;
  bindings: OneExperienceReuseAssetBinding[];
} | null {
  const task = getCanonicalTask(input.taskId);
  if (
    !task
    || task.version !== input.expectedTaskVersion
    || task.updatedAt !== input.expectedTaskUpdatedAt
    || task.status !== "completed"
    || !task.originChatId
  ) throw new Error("Canonical Task changed before the experience-reuse receipt was recorded");
  const run = getInvocationRunReceipt(input.expectedRunId);
  if (
    !run
    || run.status !== "completed"
    || run.chatId !== task.originChatId
    || run.eventCount > MAX_RUN_EVENTS
  ) throw new Error("Exact durable completed run is unavailable for experience reuse");
  const events = listRunEvents(run.runId, MAX_RUN_EVENTS);
  if (events.length !== run.eventCount) throw new Error("Run ledger is incomplete for experience reuse");
  const appliedEvents = events.filter((event) => event.kind === "one_memory_context_applied");
  if (appliedEvents.length === 0) return null;
  if (appliedEvents.length !== 1) throw new Error("Run has ambiguous Memory application receipts");
  const payload = appliedEvents[0].payload;
  if (!isRecord(payload)) throw new Error("Memory application receipt is malformed");
  if (exactKeys(payload, ["storeVersion", "memoryIds", "scopeKinds"])) {
    // Pre-v1 run events have no exact asset/version/source binding and cannot
    // be upgraded into a stronger historical reuse claim after the fact.
    return null;
  }
  if (!exactKeys(payload, ["storeVersion", "memoryIds", "scopeKinds", "assets"])) {
    throw new Error("Memory application receipt contains unsupported fields");
  }
  if (
    !positiveVersion(payload.storeVersion)
    || !Array.isArray(payload.memoryIds)
    || payload.memoryIds.length > 32
    || !payload.memoryIds.every((item) => typeof item === "string" && MEMORY_ID_RE.test(item))
    || new Set(payload.memoryIds).size !== payload.memoryIds.length
    || !Array.isArray(payload.scopeKinds)
    || payload.scopeKinds.length > MEMORY_SCOPES.length
    || !payload.scopeKinds.every((item) => MEMORY_SCOPES.includes(item as typeof MEMORY_SCOPES[number]))
    || new Set(payload.scopeKinds).size !== payload.scopeKinds.length
    || !Array.isArray(payload.assets)
    || payload.assets.length !== payload.memoryIds.length
  ) throw new Error("Memory application receipt is malformed");
  const memoryIds = payload.memoryIds as string[];
  const rawAssets = payload.assets;
  if (rawAssets.every((item) => isRecord(item) && exactKeys(item, [
    "assetId", "assetVersion", "sourceTaskId", "scope",
  ]))) {
    // Historical application receipts did not capture an immutable source
    // Task/run/Value Closure tuple and can never be upgraded after the fact.
    return null;
  }
  for (const item of rawAssets) {
    if (!isRecord(item) || item.provenanceStatus !== "legacy_unversioned") continue;
    if (
      !exactKeys(item, [
        "assetId", "assetVersion", "provenanceStatus", "sourceTaskId", "sourceTaskVersion", "sourceRunId",
        "sourceValueClosureId", "sourceValueClosureVersion", "scope",
      ])
      || typeof item.assetId !== "string"
      || !MEMORY_ID_RE.test(item.assetId)
      || !positiveVersion(item.assetVersion)
      || !safeId(item.sourceTaskId)
      || item.sourceTaskVersion !== null
      || item.sourceRunId !== null
      || item.sourceValueClosureId !== null
      || item.sourceValueClosureVersion !== null
      || !MEMORY_SCOPES.includes(item.scope as typeof MEMORY_SCOPES[number])
    ) throw new Error("Legacy Memory application provenance is malformed");
    return null;
  }
  const parsed = rawAssets.map((item): OneExperienceReuseAssetBinding => {
    if (!isRecord(item) || !exactKeys(item, [
      "assetId", "assetVersion", "provenanceStatus", "sourceTaskId", "sourceTaskVersion", "sourceRunId",
      "sourceValueClosureId", "sourceValueClosureVersion", "scope",
    ])) {
      throw new Error("Memory asset application binding is malformed");
    }
    if (
      typeof item.assetId !== "string"
      || !MEMORY_ID_RE.test(item.assetId)
      || !positiveVersion(item.assetVersion)
      || item.provenanceStatus !== "verified"
      || !safeId(item.sourceTaskId)
      || !positiveVersion(item.sourceTaskVersion)
      || !safeId(item.sourceRunId)
      || typeof item.sourceValueClosureId !== "string"
      || !VALUE_CLOSURE_ID_RE.test(item.sourceValueClosureId)
      || !positiveVersion(item.sourceValueClosureVersion)
      || !MEMORY_SCOPES.includes(item.scope as typeof MEMORY_SCOPES[number])
    ) throw new Error("Memory asset application binding is invalid");
    return {
      assetId: item.assetId,
      assetVersion: item.assetVersion,
      provenanceStatus: "verified",
      sourceTaskId: item.sourceTaskId,
      sourceTaskVersion: item.sourceTaskVersion,
      sourceRunId: item.sourceRunId,
      sourceValueClosureId: item.sourceValueClosureId,
      sourceValueClosureVersion: item.sourceValueClosureVersion,
      scope: item.scope as OneExperienceReuseAssetBinding["scope"],
    };
  });
  if (!parsed.every((item, index) => item.assetId === memoryIds[index])) {
    throw new Error("Memory asset application order no longer matches its receipt");
  }
  const appliedScopes = [...new Set(parsed.map((item) => item.scope))].sort();
  const receiptScopes = [...(payload.scopeKinds as string[])].sort();
  if (JSON.stringify(appliedScopes) !== JSON.stringify(receiptScopes)) {
    throw new Error("Memory scope summary no longer matches its asset bindings");
  }
  const memoryState = getOneMemoryState();
  if (memoryState.version < payload.storeVersion) {
    throw new Error("Memory store predates the applied Memory receipt");
  }
  for (const binding of parsed) {
    const asset = memoryState.memories.find((item) => item.id === binding.assetId);
    if (
      !asset
      || !asset.enabled
      || asset.version !== binding.assetVersion
      || asset.provenanceStatus !== "verified"
      || asset.sourceTaskId !== binding.sourceTaskId
      || asset.sourceTaskVersion !== binding.sourceTaskVersion
      || asset.sourceRunId !== binding.sourceRunId
      || asset.sourceValueClosureId !== binding.sourceValueClosureId
      || asset.sourceValueClosureVersion !== binding.sourceValueClosureVersion
      || asset.scope !== binding.scope
    ) throw new Error("Applied Memory asset changed before exact reuse could be attested");
  }
  const crossTask = parsed.filter((item) => item.sourceTaskId !== task.id);
  if (crossTask.length === 0) return null;

  const closureState = getOneValueClosureState();
  for (const binding of crossTask) {
    const sourceTask = getCanonicalTask(binding.sourceTaskId);
    if (
      !sourceTask
      || sourceTask.status !== "completed"
      || sourceTask.version !== binding.sourceTaskVersion
      || !sourceTask.originChatId
    ) throw new Error("A reused Memory source Task no longer matches its exact version");
    const sourceRun = getInvocationRunReceipt(binding.sourceRunId);
    if (!sourceRun || sourceRun.status !== "completed" || sourceRun.chatId !== sourceTask.originChatId) {
      throw new Error("A reused Memory source run no longer matches its exact Task");
    }
    const sourceClosure = closureState.closures.find((item) =>
      item.closure.valueClosureId === binding.sourceValueClosureId
      && item.version === binding.sourceValueClosureVersion,
    );
    if (
      !sourceClosure
      || sourceClosure.taskVersion !== sourceTask.version
      || sourceClosure.closure.taskId !== sourceTask.id
      || sourceClosure.closure.outcomeStatus !== "partially_verified"
      || sourceClosure.closure.outcomeRefs.length !== 1
      || !sourceClosure.closure.outcomeRefs[0]?.startsWith("result:accepted-internal:")
    ) throw new Error("A reused Memory source Value Closure no longer matches its exact Task");
    const sourceAcceptance = closureState.evidence.find((item) =>
      sourceClosure.trustedEvidenceRefs.includes(item.evidenceRef)
      && item.kind === "result_acceptance"
      && item.source === "canonical_task_runtime"
      && item.taskId === sourceTask.id
      && item.taskVersion === sourceTask.version
      && item.sourceRunRef === sourceRun.runId,
    );
    const sourceExecution = closureState.evidence.find((item) =>
      sourceClosure.trustedEvidenceRefs.includes(item.evidenceRef)
      && item.kind === "execution_receipt"
      && item.source === "invocation_runtime"
      && item.taskId === sourceTask.id
      && item.taskVersion === sourceTask.version
      && item.sourceRunRef === sourceRun.runId,
    );
    if (!sourceAcceptance || !sourceExecution) {
      throw new Error("A reused Memory source Value Closure lacks exact acceptance and execution evidence");
    }
  }
  const closure = closureState.closures.find((item) => item.closure.valueClosureId === input.valueClosureId);
  if (
    !closure
    || closure.version !== input.expectedValueClosureVersion
    || closure.taskVersion !== task.version
    || closure.closure.taskId !== task.id
    || closure.closure.outcomeStatus !== "partially_verified"
    || closure.closure.outcomeRefs.length !== 1
    || !closure.closure.outcomeRefs[0]?.startsWith("result:accepted-internal:")
  ) throw new Error("Exact accepted-result Value Closure is unavailable for experience reuse");
  const acceptance = closureState.evidence.find((item) =>
    closure.trustedEvidenceRefs.includes(item.evidenceRef)
    && item.kind === "result_acceptance"
    && item.source === "canonical_task_runtime"
    && item.taskId === task.id
    && item.taskVersion === task.version
    && item.sourceRunRef === run.runId,
  );
  const execution = closureState.evidence.find((item) =>
    closure.trustedEvidenceRefs.includes(item.evidenceRef)
    && item.kind === "execution_receipt"
    && item.source === "invocation_runtime"
    && item.taskId === task.id
    && item.taskVersion === task.version
    && item.sourceRunRef === run.runId,
  );
  if (!acceptance || !execution) throw new Error("Value Closure lacks exact acceptance and execution evidence");
  return { memoryStoreVersion: payload.storeVersion, bindings: crossTask };
}

export function getOneExperienceReuseState(): OneExperienceReuseState {
  return readState().state;
}

export function listOneExperienceReuseReceipts(taskId?: string): OneExperienceReuseRecord[] {
  if (taskId !== undefined && !safeId(taskId)) throw new TypeError("Experience-reuse taskId is invalid");
  return getOneExperienceReuseState().receipts.filter((item) => !taskId || item.receipt.taskId === taskId);
}

export function getLatestOneExperienceReuseReceipt(taskId: string): OneExperienceReuseRecord | null {
  if (!safeId(taskId)) throw new TypeError("Experience-reuse taskId is invalid");
  return listOneExperienceReuseReceipts(taskId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
}

/**
 * Main-only producer. It proves that an exact, user-approved Memory asset was
 * applied to an accepted run. It deliberately makes no quality or improvement
 * claim; that remains the stricter Improvement Proof contract.
 */
export function ensureOneExperienceReuseReceipt(
  input: EnsureOneExperienceReuseReceiptInput,
): OneExperienceReuseRecord | null {
  assertInput(input);
  const id = receiptId(input);
  const prior = readState().state.receipts.find((item) => item.receipt.reuseReceiptId === id);
  if (prior) {
    if (
      prior.receipt.taskId !== input.taskId
      || prior.receipt.taskVersion !== input.expectedTaskVersion
      || prior.receipt.runId !== input.expectedRunId
      || prior.receipt.valueClosureId !== input.valueClosureId
      || prior.receipt.valueClosureVersion !== input.expectedValueClosureVersion
    ) throw new Error("Experience-reuse receipt id collided with different evidence");
    return prior;
  }
  const exact = exactAppliedAssets(input);
  if (!exact) return null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const { raw, state } = readState();
    const existing = state.receipts.find((item) => item.receipt.reuseReceiptId === id);
    if (existing) {
      const current = JSON.stringify(existing.receipt.assetBindings);
      const expected = JSON.stringify(exact.bindings);
      if (
        existing.receipt.taskId !== input.taskId
        || existing.receipt.taskVersion !== input.expectedTaskVersion
        || existing.receipt.runId !== input.expectedRunId
        || existing.receipt.valueClosureId !== input.valueClosureId
        || existing.receipt.valueClosureVersion !== input.expectedValueClosureVersion
        || existing.receipt.memoryStoreVersion !== exact.memoryStoreVersion
        || current !== expected
      ) throw new Error("Experience-reuse receipt id collided with different evidence");
      return existing;
    }
    const version = Math.max(Date.now(), state.version + 1);
    const updatedAt = new Date(version).toISOString();
    const record: OneExperienceReuseRecord = {
      receipt: {
        contractVersion: ONE_EXPERIENCE_REUSE_CONTRACT_VERSION,
        reuseReceiptId: id,
        taskId: input.taskId,
        taskVersion: input.expectedTaskVersion,
        runId: input.expectedRunId,
        valueClosureId: input.valueClosureId,
        valueClosureVersion: input.expectedValueClosureVersion,
        memoryStoreVersion: exact.memoryStoreVersion,
        assetBindings: exact.bindings,
        reuseStatus: "approved_experience_reused",
        comparisonStatus: "not_yet_measured",
        improvementClaimed: false,
        createdAt: input.expectedTaskUpdatedAt,
      },
      version,
      createdAt: input.expectedTaskUpdatedAt,
      updatedAt,
    };
    const next: OneExperienceReuseState = {
      ...state,
      version,
      receipts: [...state.receipts, record].slice(-4_096),
      updatedAt,
    };
    if (!isOneExperienceReuseState(next)) throw new Error("Experience-reuse mutation violated its closed contract");
    const changed = getDb().prepare("UPDATE meta SET value = ? WHERE key = ? AND value = ?")
      .run(JSON.stringify(next), ONE_EXPERIENCE_REUSE_META_KEY, raw).changes;
    if (changed !== 1) continue;
    tryRecordOneDomainEvent({
      eventType: "receipt.recorded",
      occurredAt: updatedAt,
      actor: "system",
      entityId: id,
      taskId: input.taskId,
      version,
      visibility: "personal",
      entries: [
        { name: "receiptId", value: id },
        { name: "kind", value: "approved_experience_reused_no_improvement_claim" },
        { name: "sourceOrRunRefs", value: [input.expectedRunId, ...exact.bindings.map((item) => item.assetId)] },
      ],
    });
    return record;
  }
  throw new Error("Experience-reuse receipts changed concurrently; retry later");
}
