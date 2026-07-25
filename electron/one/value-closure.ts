import { randomUUID } from "node:crypto";
import { judgedCompletionClaim } from "./judged-completion-claim";
import {
  ONE_VALUE_CLOSURE_CONTRACT_VERSION,
  isOneTrustedOutcomeEvidence,
  isOneValueClosureState,
  isOneValueClosureV1,
  isSafeOneValueClosureId,
  oneValueClosureContainsCompletionClaim,
  unsafeOneValueClosureTextReason,
  type CreateOneValueClosureInput,
  type OneOriginalPreservationStatus,
  type OneTrustedOutcomeEvidence,
  type OneTrustedOutcomeEvidenceKind,
  type OneValueClosureLifecycleClaim,
  type OneValueClosureMutationResult,
  type OneValueClosureOriginalPreservation,
  type OneValueClosureRecord,
  type OneValueClosureRemainingWork,
  type OneValueClosureState,
  type OneValueClosureValueItem,
  type OneValueClosureV1,
  type SetOneValueClosureReflectionInput,
} from "../../shared/one-value-closure";
import { getDb } from "../store/db";
import { getCanonicalTask } from "../store/tasks";
import { listOneDomainEvents, recordOneDomainEvent } from "./domain-events";
import type { CanonicalTask } from "../../shared/types";

export const ONE_VALUE_CLOSURE_META_KEY = "agentlas.one.value-closures.v1";

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const CLOSURE_ID_RE = /^value_closure_[a-f0-9]{32}$/;
const PHASES = ["discovery", "preparation", "execution", "verification"] as const;
const PHASE_STATUSES = new Set(["not_started", "prepared", "in_progress", "completed", "failed", "not_applicable"]);
const OUTCOME_STATUSES = new Set(["verified", "partially_verified"]);
const EVIDENCE_KINDS = new Set<OneTrustedOutcomeEvidenceKind>([
  "discovery_receipt", "preparation_receipt", "execution_receipt", "outcome_verification",
  "artifact_verification", "original_preservation", "estimate_baseline", "approval_receipt",
  "result_acceptance",
]);
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const keys = new Set(allowed);
  if (Object.keys(value).some((key) => !keys.has(key))) throw new TypeError(`${label} contains unsupported fields`);
}

function assertVersion(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new TypeError(`${label} must be a positive safe integer`);
}

function assertSafeId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SAFE_ID_RE.test(value) || !isSafeOneValueClosureId(value)) {
    throw new TypeError(`${label} must be an opaque safe id`);
  }
}

function safeIds(value: unknown, label: string, min: number, max: number): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new TypeError(`${label} must contain ${min}-${max} opaque ids`);
  }
  const result = value.map((item, index) => {
    assertSafeId(item, `${label}[${index}]`);
    return item;
  });
  if (new Set(result).size !== result.length) throw new TypeError(`${label} must contain unique ids`);
  return result;
}

function cleanText(value: unknown, label: string, maxLength = 4_000): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be text`);
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) {
    throw new TypeError(`${label} contains unsupported control characters`);
  }
  const unsafe = unsafeOneValueClosureTextReason(value);
  if (unsafe) throw new TypeError(`${label} rejected unsafe ${unsafe}`);
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length < 1 || normalized.length > maxLength) {
    throw new RangeError(`${label} must contain 1-${maxLength} normalized characters`);
  }
  return normalized;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 64 || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${label} must be an ISO date-time`);
  }
  if (Date.parse(value) > Date.now() + MAX_CLOCK_SKEW_MS) throw new TypeError(`${label} cannot be in the future`);
  return new Date(Date.parse(value)).toISOString();
}

function initialState(): OneValueClosureState {
  const version = Math.max(1, Date.now());
  const now = new Date(version).toISOString();
  return {
    contractVersion: ONE_VALUE_CLOSURE_CONTRACT_VERSION,
    version,
    evidence: [],
    closures: [],
    createdAt: now,
    updatedAt: now,
  };
}

function parseState(raw: string): OneValueClosureState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Stored One Value Closure state is corrupt; it was not overwritten");
  }
  if (!isOneValueClosureState(parsed)) {
    throw new Error("Stored One Value Closure state violates its closed contract; it was not overwritten");
  }
  return parsed;
}

function readOrCreateState(): { raw: string; state: OneValueClosureState } {
  const db = getDb();
  let row = db.prepare("SELECT value FROM meta WHERE key = ? LIMIT 1").get(ONE_VALUE_CLOSURE_META_KEY) as
    | { value: string }
    | undefined;
  if (!row) {
    const candidate = JSON.stringify(initialState());
    db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)").run(ONE_VALUE_CLOSURE_META_KEY, candidate);
    row = db.prepare("SELECT value FROM meta WHERE key = ? LIMIT 1").get(ONE_VALUE_CLOSURE_META_KEY) as
      | { value: string }
      | undefined;
  }
  if (!row) throw new Error("Could not initialize One Value Closure state");
  return { raw: row.value, state: parseState(row.value) };
}

function nextTimestamp(previousVersion: number): { version: number; iso: string } {
  const version = Math.max(Date.now(), previousVersion + 1);
  return { version, iso: new Date(version).toISOString() };
}

function taskAtVersion(taskId: string, expectedTaskVersion: number): CanonicalTask {
  assertSafeId(taskId, "taskId");
  assertVersion(expectedTaskVersion, "expectedTaskVersion");
  const task = getCanonicalTask(taskId);
  if (!task) throw new Error("Canonical Task is unavailable; no Value Closure was created");
  if (task.version !== expectedTaskVersion) {
    throw new Error(`Canonical Task changed (expected ${expectedTaskVersion}, current ${task.version})`);
  }
  return task;
}

function normalizeLifecycleClaims(value: unknown): OneValueClosureLifecycleClaim[] {
  if (!Array.isArray(value) || value.length !== 4) throw new TypeError("lifecycleClaims must contain exactly four phases");
  return value.map((item, index) => {
    if (!isRecord(item)) throw new TypeError(`lifecycleClaims[${index}] must be an object`);
    assertOnlyKeys(item, ["phase", "status", "summary", "evidenceRefs"], `lifecycleClaims[${index}]`);
    if (item.phase !== PHASES[index]) throw new TypeError("lifecycleClaims must use discovery, preparation, execution, verification order");
    if (typeof item.status !== "string" || !PHASE_STATUSES.has(item.status)) throw new TypeError(`Invalid ${item.phase} status`);
    const refs = safeIds(item.evidenceRefs, `${item.phase}.evidenceRefs`, 0, 32);
    if (item.status === "completed" && refs.length < 1) throw new TypeError(`${item.phase} completed requires trusted evidence`);
    if (["not_started", "not_applicable"].includes(item.status) && refs.length > 0) {
      throw new TypeError(`${item.phase} ${item.status} cannot cite completed evidence`);
    }
    return {
      phase: PHASES[index],
      status: item.status as OneValueClosureLifecycleClaim["status"],
      summary: cleanText(item.summary, `${item.phase}.summary`),
      evidenceRefs: refs,
    };
  });
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return value;
}

function normalizeValueItems(value: unknown): OneValueClosureValueItem[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 24) throw new TypeError("valueItems must contain 1-24 items");
  const items = value.map((item, index): OneValueClosureValueItem => {
    if (!isRecord(item)) throw new TypeError(`valueItems[${index}] must be an object`);
    assertSafeId(item.valueItemId, `valueItems[${index}].valueItemId`);
    const statement = cleanText(item.statement, `valueItems[${index}].statement`);
    if (item.kind === "fact") {
      assertOnlyKeys(item, ["valueItemId", "kind", "statement", "evidenceRefs"], `valueItems[${index}]`);
      return {
        valueItemId: item.valueItemId,
        kind: "fact",
        statement,
        evidenceRefs: safeIds(item.evidenceRefs, `valueItems[${index}].evidenceRefs`, 1, 32),
      };
    }
    if (item.kind !== "estimate") throw new TypeError(`valueItems[${index}].kind must be fact or estimate`);
    assertOnlyKeys(item, ["valueItemId", "kind", "statement", "estimate"], `valueItems[${index}]`);
    if (!isRecord(item.estimate)) throw new TypeError(`valueItems[${index}].estimate must be an object`);
    assertOnlyKeys(item.estimate, ["value", "lowerBound", "upperBound", "unit", "basis", "method", "evidenceRefs"], `valueItems[${index}].estimate`);
    const hasValue = item.estimate.value !== undefined;
    const hasRange = item.estimate.lowerBound !== undefined || item.estimate.upperBound !== undefined;
    if (hasValue === hasRange) throw new TypeError("An estimate requires either one value or a complete range, not both");
    const estimate = {
      ...(hasValue ? { value: finiteNumber(item.estimate.value, "estimate.value") } : {}),
      ...(hasRange ? {
        lowerBound: finiteNumber(item.estimate.lowerBound, "estimate.lowerBound"),
        upperBound: finiteNumber(item.estimate.upperBound, "estimate.upperBound"),
      } : {}),
      unit: cleanText(item.estimate.unit, "estimate.unit", 160),
      basis: cleanText(item.estimate.basis, "estimate.basis"),
      method: cleanText(item.estimate.method, "estimate.method"),
      evidenceRefs: safeIds(item.estimate.evidenceRefs, "estimate.evidenceRefs", 1, 32),
    };
    if (hasRange && Number(estimate.lowerBound) > Number(estimate.upperBound)) throw new TypeError("estimate lowerBound cannot exceed upperBound");
    return { valueItemId: item.valueItemId, kind: "estimate", statement, estimate };
  });
  if (new Set(items.map((item) => item.valueItemId)).size !== items.length) throw new TypeError("valueItems IDs must be unique");
  return items;
}

function normalizeOriginalPreservation(value: unknown): OneValueClosureOriginalPreservation {
  if (!isRecord(value)) throw new TypeError("originalPreservation must be an object");
  assertOnlyKeys(value, ["status", "artifactRefs", "receiptRefs", "explanation"], "originalPreservation");
  if (!["preserved", "not_applicable", "modified_with_approval"].includes(String(value.status))) {
    throw new TypeError("Invalid originalPreservation status");
  }
  const status = value.status as OneOriginalPreservationStatus;
  const artifactRefs = safeIds(value.artifactRefs, "originalPreservation.artifactRefs", 0, 64);
  const receiptRefs = safeIds(value.receiptRefs, "originalPreservation.receiptRefs", 0, 64);
  if (status === "not_applicable" && (artifactRefs.length > 0 || receiptRefs.length > 0 || value.explanation !== undefined)) {
    throw new TypeError("not_applicable original preservation cannot claim artifacts or receipts");
  }
  if (status === "preserved" && receiptRefs.length < 1) throw new TypeError("preserved originals require a trusted receipt");
  if (status === "modified_with_approval" && receiptRefs.length < 1) throw new TypeError("approved modification requires an approval receipt");
  const explanation = value.explanation === undefined ? undefined : cleanText(value.explanation, "originalPreservation.explanation");
  if (status === "modified_with_approval" && !explanation) throw new TypeError("approved modification requires an explanation");
  return { status, artifactRefs, receiptRefs, ...(explanation ? { explanation } : {}) };
}

function normalizeRemainingWork(value: unknown): OneValueClosureRemainingWork[] {
  if (!Array.isArray(value) || value.length > 32) throw new TypeError("remainingWork must contain at most 32 items");
  const items = value.map((item, index): OneValueClosureRemainingWork => {
    if (!isRecord(item)) throw new TypeError(`remainingWork[${index}] must be an object`);
    assertOnlyKeys(item, ["itemRef", "action", "owner", "status", "reason"], `remainingWork[${index}]`);
    assertSafeId(item.itemRef, `remainingWork[${index}].itemRef`);
    if (!["user", "one", "external"].includes(String(item.owner))) throw new TypeError(`Invalid remainingWork[${index}].owner`);
    if (!["pending", "blocked", "not_required"].includes(String(item.status))) throw new TypeError(`Invalid remainingWork[${index}].status`);
    return {
      itemRef: item.itemRef,
      action: cleanText(item.action, `remainingWork[${index}].action`),
      owner: item.owner as OneValueClosureRemainingWork["owner"],
      status: item.status as OneValueClosureRemainingWork["status"],
      ...(item.reason === undefined ? {} : { reason: cleanText(item.reason, `remainingWork[${index}].reason`) }),
    };
  });
  if (new Set(items.map((item) => item.itemRef)).size !== items.length) throw new TypeError("remainingWork IDs must be unique");
  return items;
}

function normalizeTrustedEvidence(
  value: unknown,
  task: CanonicalTask,
  expectedTaskVersion: number,
): OneTrustedOutcomeEvidence[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 128) throw new TypeError("trustedHostEvidence must contain 1-128 attestations");
  const evidence = value.map((item, index) => {
    if (!isRecord(item)) throw new TypeError(`trustedHostEvidence[${index}] must be an object`);
    assertOnlyKeys(item, [
      "evidenceRef", "receiptRef", "taskId", "taskVersion", "kind", "source", "verificationStatus",
      "observedAt", "sourceRef", "outcomeRef", "artifactRef", "sourceRunRef",
    ], `trustedHostEvidence[${index}]`);
    if (!isOneTrustedOutcomeEvidence(item)) {
      throw new TypeError(`trustedHostEvidence[${index}] violates the closed evidence contract`);
    }
    const normalized: OneTrustedOutcomeEvidence = {
      evidenceRef: item.evidenceRef,
      receiptRef: item.receiptRef,
      taskId: item.taskId,
      taskVersion: item.taskVersion,
      kind: item.kind,
      source: item.source,
      verificationStatus: item.verificationStatus,
      observedAt: timestamp(item.observedAt, `trustedHostEvidence[${index}].observedAt`),
      sourceRef: item.sourceRef,
      ...(item.outcomeRef === undefined ? {} : { outcomeRef: item.outcomeRef }),
      ...(item.artifactRef === undefined ? {} : { artifactRef: item.artifactRef }),
      ...(item.sourceRunRef === undefined ? {} : { sourceRunRef: item.sourceRunRef }),
    };
    if (normalized.taskId !== task.id || normalized.taskVersion !== expectedTaskVersion) {
      throw new Error(`trustedHostEvidence[${index}] is not bound to the exact Task version`);
    }
    if (normalized.sourceRunRef) {
      const matchingRun = listOneDomainEvents(normalized.sourceRunRef, 100).some((event) =>
        event.eventType === "run.started" && event.taskId === task.id,
      );
      if (!matchingRun) throw new Error(`trustedHostEvidence[${index}] sourceRunRef is not bound to this Task`);
    }
    return normalized;
  });
  if (new Set(evidence.map((item) => item.evidenceRef)).size !== evidence.length) throw new TypeError("trusted evidence references must be unique");
  if (new Set(evidence.map((item) => item.receiptRef)).size !== evidence.length) throw new TypeError("trusted receipt references must be unique");
  return evidence;
}

function evidenceForRef(evidence: OneTrustedOutcomeEvidence[], ref: string): OneTrustedOutcomeEvidence[] {
  return evidence.filter((item) => item.evidenceRef === ref || item.receiptRef === ref || item.artifactRef === ref || item.outcomeRef === ref);
}

function assertEvidenceSemantics(input: {
  outcomeStatus: OneValueClosureV1["outcomeStatus"];
  outcomeRefs: string[];
  lifecycleClaims: OneValueClosureLifecycleClaim[];
  valueItems: OneValueClosureValueItem[];
  originalPreservation: OneValueClosureOriginalPreservation;
  receiptRefs: string[];
  evidence: OneTrustedOutcomeEvidence[];
}): void {
  const resolve = (ref: string, label: string): OneTrustedOutcomeEvidence[] => {
    const matches = evidenceForRef(input.evidence, ref);
    if (matches.length < 1) throw new Error(`${label} is not bound to trusted host evidence: ${ref}`);
    return matches;
  };
  const used = new Set<string>();
  const use = (ref: string, label: string): OneTrustedOutcomeEvidence[] => {
    const matches = resolve(ref, label);
    matches.forEach((item) => used.add(item.evidenceRef));
    return matches;
  };

  const receiptSet = new Set(input.receiptRefs);
  if (receiptSet.size !== input.evidence.length || input.evidence.some((item) => !receiptSet.has(item.receiptRef))) {
    throw new Error("receiptRefs must exactly match the trusted host evidence receipts");
  }
  input.receiptRefs.forEach((ref) => use(ref, "receiptRef"));

  for (const outcomeRef of input.outcomeRefs) {
    const matches = use(outcomeRef, "outcomeRef").filter((item) =>
      item.outcomeRef === outcomeRef
      && ["outcome_verification", "result_acceptance"].includes(item.kind),
    );
    if (matches.length < 1) throw new Error(`Outcome ${outcomeRef} lacks a verification or internal result-acceptance attestation`);
    if (input.outcomeStatus === "verified" && !matches.some((item) =>
      item.kind === "outcome_verification"
      && item.verificationStatus === "verified"
      && item.source !== "explicit_user_observation",
    )) {
      throw new Error(`Outcome ${outcomeRef} is not host-verified`);
    }
  }

  const allowedPhaseKinds: Record<string, ReadonlySet<OneTrustedOutcomeEvidenceKind>> = {
    discovery: new Set(["discovery_receipt", "outcome_verification", "artifact_verification"]),
    preparation: new Set(["preparation_receipt", "artifact_verification", "approval_receipt"]),
    execution: new Set(["execution_receipt"]),
    verification: new Set(["outcome_verification", "artifact_verification"]),
  };
  for (const claim of input.lifecycleClaims) {
    const matches = claim.evidenceRefs.flatMap((ref) => use(ref, `${claim.phase}.evidenceRefs`));
    if (claim.status === "completed" && !matches.some((item) => allowedPhaseKinds[claim.phase].has(item.kind))) {
      throw new Error(`${claim.phase} completed lacks phase-appropriate trusted evidence`);
    }
    if (claim.phase === "verification" && input.outcomeStatus === "verified" && matches.some((item) => item.verificationStatus !== "verified")) {
      throw new Error("A verified closure cannot rely on partially verified verification evidence");
    }
  }

  for (const item of input.valueItems) {
    if (item.kind === "fact") {
      const matches = item.evidenceRefs.flatMap((ref) => use(ref, `${item.valueItemId}.evidenceRefs`));
      if (matches.some((evidence) => evidence.verificationStatus !== "verified" || evidence.source === "explicit_user_observation")) {
        throw new Error(`Fact ${item.valueItemId} requires verified non-observational evidence`);
      }
      if (oneValueClosureContainsCompletionClaim(item.statement, judgedCompletionClaim) && !matches.some((evidence) =>
        evidence.verificationStatus === "verified" && ["execution_receipt", "outcome_verification"].includes(evidence.kind),
      )) {
        throw new Error(`Fact ${item.valueItemId} makes an execution/outcome claim without matching evidence`);
      }
    } else {
      const matches = item.estimate.evidenceRefs.flatMap((ref) => use(ref, `${item.valueItemId}.estimate.evidenceRefs`));
      if (!matches.some((evidence) => evidence.kind === "estimate_baseline")) {
        throw new Error(`Estimate ${item.valueItemId} requires a trusted baseline`);
      }
    }
  }

  if (input.originalPreservation.status === "preserved") {
    for (const artifactRef of input.originalPreservation.artifactRefs) {
      const matches = use(artifactRef, "originalPreservation.artifactRefs");
      if (!matches.some((item) => item.kind === "original_preservation" && item.artifactRef === artifactRef && item.verificationStatus === "verified")) {
        throw new Error(`Original ${artifactRef} lacks preservation evidence`);
      }
    }
    for (const receiptRef of input.originalPreservation.receiptRefs) {
      const matches = use(receiptRef, "originalPreservation.receiptRefs");
      if (!matches.some((item) => item.kind === "original_preservation" && item.verificationStatus === "verified")) {
        throw new Error(`Preservation receipt ${receiptRef} is not verified`);
      }
    }
  }
  if (input.originalPreservation.status === "modified_with_approval") {
    for (const receiptRef of input.originalPreservation.receiptRefs) {
      const matches = use(receiptRef, "originalPreservation.receiptRefs");
      if (!matches.some((item) => item.kind === "approval_receipt" && item.verificationStatus === "verified")) {
        throw new Error(`Modification receipt ${receiptRef} is not an approval receipt`);
      }
    }
  }

  const referenced = new Set<string>([
    ...input.outcomeRefs,
    ...input.receiptRefs,
    ...input.lifecycleClaims.flatMap((claim) => claim.evidenceRefs),
    ...input.valueItems.flatMap((item) => item.kind === "fact" ? item.evidenceRefs : item.estimate.evidenceRefs),
    ...input.originalPreservation.artifactRefs,
    ...input.originalPreservation.receiptRefs,
  ]);
  for (const item of input.evidence) {
    if (!used.has(item.evidenceRef) || ![
      item.evidenceRef, item.receiptRef, item.outcomeRef, item.artifactRef,
    ].some((ref) => ref !== undefined && referenced.has(ref))) {
      throw new Error(`Trusted evidence ${item.evidenceRef} is not used by the closure`);
    }
  }
}

function artifactRefsFor(evidence: OneTrustedOutcomeEvidence[], preservation: OneValueClosureOriginalPreservation): string[] {
  return [...new Set([
    ...preservation.artifactRefs,
    ...evidence.map((item) => item.artifactRef).filter((item): item is string => Boolean(item)),
  ])];
}

function estimateRefsFor(items: OneValueClosureValueItem[]): string[] {
  return [...new Set(items.flatMap((item) => item.kind === "estimate" ? item.estimate.evidenceRefs : []))];
}

function visibilityFor(task: CanonicalTask): "personal" | "project" {
  return task.projectId ? "project" : "personal";
}

function recordClosureEvents(
  task: CanonicalTask,
  record: OneValueClosureRecord,
  evidence: OneTrustedOutcomeEvidence[],
  prior: OneValueClosureState,
): void {
  const visibility = visibilityFor(task);
  for (const item of evidence) {
    recordOneDomainEvent({
      eventType: "receipt.recorded",
      occurredAt: item.observedAt,
      actor: ["explicit_user_observation", "canonical_task_runtime"].includes(item.source) ? "user" : "system",
      entityId: item.evidenceRef,
      ...(task.projectId ? { projectId: task.projectId } : {}),
      taskId: task.id,
      version: 1,
      visibility,
      entries: [
        { name: "receiptId", value: item.receiptRef },
        { name: "kind", value: `trusted_${item.kind}` },
        {
          name: "sourceOrRunRefs",
          value: [...new Set([
            item.sourceRef,
            ...(item.sourceRunRef ? [item.sourceRunRef] : []),
            ...(item.outcomeRef ? [item.outcomeRef] : []),
            ...(item.artifactRef ? [item.artifactRef] : []),
          ])],
        },
      ],
    });
  }
  for (const outcomeRef of record.closure.outcomeRefs) {
    const outcomeEvidence = evidence.filter((item) =>
      item.outcomeRef === outcomeRef && item.kind === "outcome_verification",
    );
    // Explicit acceptance verifies only the internal result binding. It must
    // never manufacture an outcome.verified event for an external effect.
    if (outcomeEvidence.length < 1) continue;
    const priorOutcomeCount = prior.closures.filter((item) => item.closure.outcomeRefs.includes(outcomeRef)).length;
    const evidenceRefs = outcomeEvidence.map((item) => item.evidenceRef);
    recordOneDomainEvent({
      eventType: "outcome.verified",
      occurredAt: record.closure.generatedAt,
      actor: "system",
      entityId: outcomeRef,
      ...(task.projectId ? { projectId: task.projectId } : {}),
      taskId: task.id,
      version: priorOutcomeCount + 1,
      visibility,
      entries: [
        { name: "outcomeId", value: outcomeRef },
        { name: "status", value: record.closure.outcomeStatus },
        { name: "evidenceRefs", value: evidenceRefs },
        { name: "remainingWork", value: record.closure.remainingWork.map((item) => item.itemRef) },
      ],
    });
  }
  recordOneDomainEvent({
    eventType: "value_closure.ready",
    occurredAt: record.closure.generatedAt,
    actor: "system",
    entityId: record.closure.valueClosureId,
    ...(task.projectId ? { projectId: task.projectId } : {}),
    taskId: task.id,
    version: record.version,
    visibility,
    entries: [
      { name: "valueClosureRef", value: record.closure.valueClosureId },
      { name: "outcomeRefs", value: record.closure.outcomeRefs },
      { name: "artifactRefs", value: record.artifactRefs },
      ...(record.estimateRefs.length > 0 ? [{ name: "estimateRefs", value: record.estimateRefs }] : []),
    ],
  });
}

export function getOneValueClosureState(): OneValueClosureState {
  return readOrCreateState().state;
}

export function listOneValueClosures(taskId?: string): OneValueClosureRecord[] {
  if (taskId !== undefined) assertSafeId(taskId, "taskId");
  return getOneValueClosureState().closures.filter((item) => taskId === undefined || item.closure.taskId === taskId);
}

export function getLatestOneValueClosure(taskId: string): OneValueClosureRecord | null {
  const records = listOneValueClosures(taskId);
  return records.length > 0 ? records[records.length - 1] : null;
}

/**
 * Main-only creation boundary. A completed run or accepted Task is deliberately
 * insufficient: every claim must resolve to the supplied host attestations.
 */
export function createOneValueClosure(input: CreateOneValueClosureInput): OneValueClosureMutationResult<OneValueClosureRecord> {
  if (!isRecord(input)) throw new TypeError("Value Closure input must be an object");
  assertOnlyKeys(input, [
    "expectedStoreVersion", "trustedHostAttested", "taskId", "expectedTaskVersion", "outcomeStatus",
    "outcomeRefs", "lifecycleClaims", "valueItems", "originalPreservation", "remainingWork",
    "receiptRefs", "reflectionEligible", "trustedHostEvidence",
  ], "Value Closure input");
  assertVersion(input.expectedStoreVersion, "expectedStoreVersion");
  if (input.trustedHostAttested !== true) throw new Error("Value Closure requires a trusted host attestation boundary");
  if (typeof input.outcomeStatus !== "string" || !OUTCOME_STATUSES.has(input.outcomeStatus)) throw new TypeError("Invalid outcomeStatus");
  if (typeof input.reflectionEligible !== "boolean") throw new TypeError("reflectionEligible must be boolean");

  const db = getDb();
  const create = db.transaction(() => {
    const current = readOrCreateState();
    if (current.state.version !== input.expectedStoreVersion) {
      throw new Error(`One Value Closure state changed (expected ${input.expectedStoreVersion}, current ${current.state.version})`);
    }
    const task = taskAtVersion(input.taskId, input.expectedTaskVersion);
    const outcomeRefs = safeIds(input.outcomeRefs, "outcomeRefs", 1, 32);
    const lifecycleClaims = normalizeLifecycleClaims(input.lifecycleClaims);
    const valueItems = normalizeValueItems(input.valueItems);
    const originalPreservation = normalizeOriginalPreservation(input.originalPreservation);
    const remainingWork = normalizeRemainingWork(input.remainingWork);
    const receiptRefs = safeIds(input.receiptRefs, "receiptRefs", 1, 128);
    const evidence = normalizeTrustedEvidence(input.trustedHostEvidence, task, input.expectedTaskVersion);

    if (current.state.evidence.some((existing) =>
      evidence.some((candidate) => candidate.evidenceRef === existing.evidenceRef || candidate.receiptRef === existing.receiptRef),
    )) throw new Error("Trusted evidence or receipt was already consumed by a Value Closure");
    if (current.state.closures.some((existing) =>
      existing.closure.taskId === task.id
      && existing.taskVersion === task.version
      && JSON.stringify([...existing.closure.outcomeRefs].sort()) === JSON.stringify([...outcomeRefs].sort()),
    )) throw new Error("A Value Closure already exists for this exact Task version and outcome set");

    assertEvidenceSemantics({
      outcomeStatus: input.outcomeStatus,
      outcomeRefs,
      lifecycleClaims,
      valueItems,
      originalPreservation,
      receiptRefs,
      evidence,
    });
    const tick = nextTimestamp(current.state.version);
    const closure: OneValueClosureV1 = {
      contractVersion: ONE_VALUE_CLOSURE_CONTRACT_VERSION,
      valueClosureId: `value_closure_${randomUUID().replaceAll("-", "")}`,
      taskId: task.id,
      status: "ready",
      outcomeStatus: input.outcomeStatus,
      generatedAt: tick.iso,
      outcomeRefs,
      lifecycleClaims,
      valueItems,
      originalPreservation,
      remainingWork,
      receiptRefs,
      reflection: { eligible: input.reflectionEligible, userOptedIn: false, included: false },
    };
    if (!isOneValueClosureV1(closure)) throw new Error("Value Closure violated its closed renderer contract");
    const record: OneValueClosureRecord = {
      closure,
      version: 1,
      taskVersion: task.version,
      trustedEvidenceRefs: evidence.map((item) => item.evidenceRef),
      artifactRefs: artifactRefsFor(evidence, originalPreservation),
      estimateRefs: estimateRefsFor(valueItems),
      createdAt: tick.iso,
      updatedAt: tick.iso,
    };
    const next: OneValueClosureState = {
      ...current.state,
      version: tick.version,
      evidence: [...current.state.evidence, ...evidence],
      closures: [...current.state.closures, record],
      updatedAt: tick.iso,
    };
    if (!isOneValueClosureState(next)) throw new Error("Value Closure mutation violated the closed storage contract");
    const result = db.prepare("UPDATE meta SET value = ? WHERE key = ? AND value = ?")
      .run(JSON.stringify(next), ONE_VALUE_CLOSURE_META_KEY, current.raw);
    if (result.changes !== 1) throw new Error("One Value Closure state changed concurrently; reload and try again");
    recordClosureEvents(task, record, evidence, current.state);
    return { storeVersion: next.version, updatedAt: next.updatedAt, value: record };
  });
  return create.immediate();
}

export function setOneValueClosureReflection(
  input: SetOneValueClosureReflectionInput,
): OneValueClosureMutationResult<OneValueClosureRecord> {
  if (!isRecord(input)) throw new TypeError("Reflection input must be an object");
  assertOnlyKeys(input, [
    "expectedStoreVersion", "valueClosureId", "expectedClosureVersion", "userOptedIn", "included", "confirmedByUser",
  ], "Reflection input");
  assertVersion(input.expectedStoreVersion, "expectedStoreVersion");
  assertVersion(input.expectedClosureVersion, "expectedClosureVersion");
  if (typeof input.valueClosureId !== "string" || !CLOSURE_ID_RE.test(input.valueClosureId)) throw new TypeError("Invalid valueClosureId");
  if (typeof input.userOptedIn !== "boolean" || typeof input.included !== "boolean") throw new TypeError("Reflection choices must be boolean");
  if (input.confirmedByUser !== true) throw new Error("Reflection changes require explicit user confirmation");

  const db = getDb();
  const mutate = db.transaction(() => {
    const current = readOrCreateState();
    if (current.state.version !== input.expectedStoreVersion) {
      throw new Error(`One Value Closure state changed (expected ${input.expectedStoreVersion}, current ${current.state.version})`);
    }
    const index = current.state.closures.findIndex((item) => item.closure.valueClosureId === input.valueClosureId);
    if (index < 0) throw new Error("Value Closure not found");
    const prior = current.state.closures[index];
    if (prior.version !== input.expectedClosureVersion) throw new Error("Value Closure changed before reflection update");
    if (input.included && (!prior.closure.reflection.eligible || !input.userOptedIn)) {
      throw new Error("Weekly reflection inclusion requires eligibility and explicit opt-in");
    }
    const tick = nextTimestamp(current.state.version);
    const updated: OneValueClosureRecord = {
      ...prior,
      version: prior.version + 1,
      closure: {
        ...prior.closure,
        reflection: {
          eligible: prior.closure.reflection.eligible,
          userOptedIn: input.userOptedIn,
          included: input.included,
        },
      },
      updatedAt: tick.iso,
    };
    const closures = [...current.state.closures];
    closures[index] = updated;
    const next: OneValueClosureState = { ...current.state, version: tick.version, closures, updatedAt: tick.iso };
    if (!isOneValueClosureState(next)) throw new Error("Reflection mutation violated the closed storage contract");
    const result = db.prepare("UPDATE meta SET value = ? WHERE key = ? AND value = ?")
      .run(JSON.stringify(next), ONE_VALUE_CLOSURE_META_KEY, current.raw);
    if (result.changes !== 1) throw new Error("One Value Closure state changed concurrently; reload and try again");
    return { storeVersion: next.version, updatedAt: next.updatedAt, value: updated };
  });
  return mutate.immediate();
}
