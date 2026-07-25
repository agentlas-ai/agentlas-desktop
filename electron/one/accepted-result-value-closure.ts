import { createHash } from "node:crypto";
import {
  type CreateOneValueClosureInput,
  type OneTrustedOutcomeEvidence,
  type OneValueClosureMutationResult,
  type OneValueClosureRecord,
  type OneValueClosureState,
} from "../../shared/one-value-closure";
import type { CanonicalTask, InvocationRunReceipt } from "../../shared/types";
import { getInvocationRunReceipt } from "../store/run-events";
import { getCanonicalTask } from "../store/tasks";
import {
  type OneVerifiedBoundArtifactSet,
  verifyOneAcceptedSurfaceArtifactSet,
} from "./artifact-preview";
import { listOneDomainEvents } from "./domain-events";
import {
  createOneValueClosure,
  getOneValueClosureState,
} from "./value-closure";

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const ACCEPTANCE_REASON = "explicit user acceptance of a matching completed run receipt";

export interface EnsureAcceptedResultValueClosureInput {
  priorTaskVersion: number;
  acceptedTask: CanonicalTask;
  expectedRunId: string;
  receipt: InvocationRunReceipt | null;
  /** Main-only assertion supplied by an explicit Desktop or Mobile accept action. */
  confirmedByUser: true;
}

interface AcceptedResultEvidenceBinding {
  digest: string;
  runEvidenceRef: string;
  runReceiptRef: string;
  acceptanceEvidenceRef: string;
  acceptanceReceiptRef: string;
  internalResultRef: string;
  valueItemRef: string;
  remainingWorkRef: string;
}

interface VerifiedAcceptedArtifactBinding {
  digest: string;
  executionEvidenceRef: string;
  executionReceiptRef: string;
  acceptanceEvidenceRef: string;
  acceptanceReceiptRef: string;
  outcomeEvidenceRef: string;
  outcomeReceiptRef: string;
  outcomeRef: string;
  valueItemRef: string;
  remainingWorkRef: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const keys = new Set(allowed);
  if (Object.keys(value).some((key) => !keys.has(key))) {
    throw new TypeError("Accepted-result Value Closure input contains unsupported fields");
  }
}

function assertVersion(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function assertSafeId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SAFE_ID_RE.test(value)) {
    throw new TypeError(`${label} must be an opaque safe id`);
  }
}

function bindingFor(
  taskId: string,
  priorTaskVersion: number,
  taskVersion: number,
  runId: string,
): AcceptedResultEvidenceBinding {
  const digest = createHash("sha256")
    .update(`agentlas-one:accepted-result:v1:${taskId}:${priorTaskVersion}:${taskVersion}:${runId}`, "utf8")
    .digest("hex")
    .slice(0, 32);
  return {
    digest,
    runEvidenceRef: `evidence:accepted-run:${digest}`,
    runReceiptRef: `receipt:accepted-run:${digest}`,
    acceptanceEvidenceRef: `evidence:result-acceptance:${digest}`,
    acceptanceReceiptRef: `receipt:result-acceptance:${digest}`,
    internalResultRef: `result:accepted-internal:${digest}`,
    valueItemRef: `value:accepted-internal:${digest}`,
    remainingWorkRef: `remaining:external-verification:${digest}`,
  };
}

function verifiedArtifactBindingFor(
  taskId: string,
  taskVersion: number,
  runId: string,
  artifactSetRef: string,
): VerifiedAcceptedArtifactBinding {
  const digest = createHash("sha256")
    .update(`agentlas-one:accepted-artifact-set:v1:${taskId}:${taskVersion}:${runId}:${artifactSetRef}`, "utf8")
    .digest("hex")
    .slice(0, 32);
  return {
    digest,
    executionEvidenceRef: `evidence:accepted-artifact-run:${digest}`,
    executionReceiptRef: `receipt:accepted-artifact-run:${digest}`,
    acceptanceEvidenceRef: `evidence:accepted-artifact-user:${digest}`,
    acceptanceReceiptRef: `receipt:accepted-artifact-user:${digest}`,
    outcomeEvidenceRef: `evidence:accepted-artifact-set:${digest}`,
    outcomeReceiptRef: `receipt:accepted-artifact-set:${digest}`,
    outcomeRef: `outcome:accepted-artifact-set:${digest}`,
    valueItemRef: `value:accepted-artifact-set:${digest}`,
    remainingWorkRef: `remaining:external-effect:${digest}`,
  };
}

function eventEntries(event: ReturnType<typeof listOneDomainEvents>[number]): Map<string, unknown> {
  return new Map(event.payload.entries.map((entry) => [entry.name, entry.value]));
}

function exactAcceptanceEvent(task: CanonicalTask) {
  return listOneDomainEvents(task.id, 500).find((event) => {
    if (
      event.eventType !== "task.state_changed"
      || event.actor !== "user"
      || event.taskId !== task.id
      || event.entityId !== task.id
      || event.version !== task.version
      || event.occurredAt !== task.updatedAt
    ) return false;
    const entries = eventEntries(event);
    return entries.get("from") === "partial"
      && entries.get("to") === "completed"
      && entries.get("reason") === ACCEPTANCE_REASON;
  }) ?? null;
}

function exactResultReadyEvent(task: CanonicalTask, priorTaskVersion: number) {
  return listOneDomainEvents(task.id, 500).find((event) => {
    if (
      event.eventType !== "task.state_changed"
      || event.actor !== "system"
      || event.taskId !== task.id
      || event.entityId !== task.id
      || event.version !== priorTaskVersion
    ) return false;
    const entries = eventEntries(event);
    return entries.get("to") === "partial"
      && entries.get("reason") === "authoritative invocation lifecycle";
  }) ?? null;
}

function assertExactReceipt(
  receipt: InvocationRunReceipt | null,
  durable: InvocationRunReceipt | null,
  task: CanonicalTask,
  expectedRunId: string,
): asserts durable is InvocationRunReceipt & { finishedAt: string } {
  if (
    !receipt
    || !durable
    || receipt.runId !== expectedRunId
    || durable.runId !== expectedRunId
    || receipt.chatId !== task.originChatId
    || durable.chatId !== task.originChatId
    || receipt.status !== "completed"
    || durable.status !== "completed"
    || typeof receipt.finishedAt !== "string"
    || typeof durable.finishedAt !== "string"
  ) {
    throw new Error("An exact durable completed InvocationRunReceipt is required");
  }
  for (const field of ["startedAt", "updatedAt", "finishedAt", "eventCount"] as const) {
    if (receipt[field] !== durable[field]) {
      throw new Error("The supplied InvocationRunReceipt does not match the durable run ledger");
    }
  }
}

function exactAcceptedTask(input: EnsureAcceptedResultValueClosureInput): CanonicalTask {
  if (!isRecord(input.acceptedTask)) throw new TypeError("acceptedTask must be a Canonical Task");
  assertVersion(input.priorTaskVersion, "priorTaskVersion");
  assertSafeId(input.acceptedTask.id, "acceptedTask.id");
  assertVersion(input.acceptedTask.version, "acceptedTask.version");
  assertSafeId(input.expectedRunId, "expectedRunId");
  if (input.confirmedByUser !== true) {
    throw new Error("Accepted-result Value Closure requires explicit user confirmation");
  }
  const task = getCanonicalTask(input.acceptedTask.id);
  if (
    !task
    || task.id !== input.acceptedTask.id
    || task.version !== input.acceptedTask.version
    || task.updatedAt !== input.acceptedTask.updatedAt
    || task.originChatId !== input.acceptedTask.originChatId
    || task.status !== "completed"
    || !task.originChatId
  ) {
    throw new Error("The accepted Canonical Task no longer matches its authoritative completed version");
  }
  if (input.priorTaskVersion >= task.version) {
    throw new Error("Accepted-result Value Closure requires the exact prior Task version");
  }
  return task;
}

/**
 * The exact fact statements these Main-authored closures write. The async accept
 * paths pre-judge them (see judged-completion-claim) so the synchronous trust
 * validator can peek a model verdict instead of relying on the wordlist alone.
 */
export const ACCEPTED_RESULT_CLOSURE_FACT_STATEMENTS = [
  "The completed internal run result was explicitly accepted for this Task.",
  "Every declared media artifact in the accepted internal result matched its sealed filesystem binding.",
] as const;

function buildCreateInput(
  state: OneValueClosureState,
  task: CanonicalTask,
  run: InvocationRunReceipt & { finishedAt: string },
  acceptanceEvent: NonNullable<ReturnType<typeof exactAcceptanceEvent>>,
  binding: AcceptedResultEvidenceBinding,
): CreateOneValueClosureInput {
  const evidence: OneTrustedOutcomeEvidence[] = [
    {
      evidenceRef: binding.runEvidenceRef,
      receiptRef: binding.runReceiptRef,
      taskId: task.id,
      taskVersion: task.version,
      kind: "execution_receipt",
      source: "invocation_runtime",
      verificationStatus: "verified",
      observedAt: run.finishedAt,
      sourceRef: run.runId,
      sourceRunRef: run.runId,
    },
    {
      evidenceRef: binding.acceptanceEvidenceRef,
      receiptRef: binding.acceptanceReceiptRef,
      taskId: task.id,
      taskVersion: task.version,
      kind: "result_acceptance",
      source: "canonical_task_runtime",
      verificationStatus: "verified",
      observedAt: acceptanceEvent.occurredAt,
      sourceRef: acceptanceEvent.eventId,
      outcomeRef: binding.internalResultRef,
      sourceRunRef: run.runId,
    },
  ];
  return {
    expectedStoreVersion: state.version,
    trustedHostAttested: true,
    taskId: task.id,
    expectedTaskVersion: task.version,
    outcomeStatus: "partially_verified",
    outcomeRefs: [binding.internalResultRef],
    lifecycleClaims: [
      {
        phase: "discovery",
        status: "not_started",
        summary: "Discovery was not evaluated by this result acceptance.",
        evidenceRefs: [],
      },
      {
        phase: "preparation",
        status: "not_started",
        summary: "Preparation was not evaluated by this result acceptance.",
        evidenceRefs: [],
      },
      {
        phase: "execution",
        status: "completed",
        summary: "The bound internal invocation reached its durable completed receipt.",
        evidenceRefs: [binding.runEvidenceRef],
      },
      {
        phase: "verification",
        status: "not_started",
        summary: "External effects were not verified by accepting the internal result.",
        evidenceRefs: [],
      },
    ],
    valueItems: [
      {
        valueItemId: binding.valueItemRef,
        kind: "fact",
        statement: ACCEPTED_RESULT_CLOSURE_FACT_STATEMENTS[0],
        evidenceRefs: [binding.runEvidenceRef, binding.acceptanceEvidenceRef],
      },
    ],
    originalPreservation: {
      status: "not_applicable",
      artifactRefs: [],
      receiptRefs: [],
    },
    remainingWork: [
      {
        itemRef: binding.remainingWorkRef,
        action: "Check the target system separately if this work was intended to change anything outside Agentlas.",
        owner: "external",
        status: "pending",
        reason: "This record covers only the bound internal run and the user's acceptance of its result.",
      },
    ],
    receiptRefs: [binding.runReceiptRef, binding.acceptanceReceiptRef],
    reflectionEligible: false,
    trustedHostEvidence: evidence,
  };
}

function buildVerifiedArtifactCreateInput(
  state: OneValueClosureState,
  task: CanonicalTask,
  run: InvocationRunReceipt & { finishedAt: string },
  acceptanceEvent: NonNullable<ReturnType<typeof exactAcceptanceEvent>>,
  artifactSet: OneVerifiedBoundArtifactSet,
  binding: VerifiedAcceptedArtifactBinding,
): CreateOneValueClosureInput {
  const execution: OneTrustedOutcomeEvidence = {
    evidenceRef: binding.executionEvidenceRef,
    receiptRef: binding.executionReceiptRef,
    taskId: task.id,
    taskVersion: task.version,
    kind: "execution_receipt",
    source: "invocation_runtime",
    verificationStatus: "verified",
    observedAt: run.finishedAt,
    sourceRef: run.runId,
    sourceRunRef: run.runId,
  };
  const acceptance: OneTrustedOutcomeEvidence = {
    evidenceRef: binding.acceptanceEvidenceRef,
    receiptRef: binding.acceptanceReceiptRef,
    taskId: task.id,
    taskVersion: task.version,
    kind: "result_acceptance",
    source: "canonical_task_runtime",
    verificationStatus: "verified",
    observedAt: acceptanceEvent.occurredAt,
    sourceRef: acceptanceEvent.eventId,
    outcomeRef: binding.outcomeRef,
    sourceRunRef: run.runId,
  };
  const artifactEvidence: OneTrustedOutcomeEvidence[] = artifactSet.artifacts.map((artifact, index) => ({
    evidenceRef: `evidence:accepted-artifact:${binding.digest}:${index + 1}`,
    receiptRef: `receipt:accepted-artifact:${binding.digest}:${index + 1}`,
    taskId: task.id,
    taskVersion: task.version,
    kind: "artifact_verification",
    source: "filesystem_guard",
    verificationStatus: "verified",
    observedAt: artifactSet.observedAt,
    sourceRef: artifact.bindingRef,
    artifactRef: artifact.artifactRef,
    sourceRunRef: run.runId,
  }));
  const outcome: OneTrustedOutcomeEvidence = {
    evidenceRef: binding.outcomeEvidenceRef,
    receiptRef: binding.outcomeReceiptRef,
    taskId: task.id,
    taskVersion: task.version,
    kind: "outcome_verification",
    source: "filesystem_guard",
    verificationStatus: "verified",
    observedAt: artifactSet.observedAt,
    sourceRef: artifactSet.setRef,
    outcomeRef: binding.outcomeRef,
    sourceRunRef: run.runId,
  };
  const verificationRefs = [...artifactEvidence.map((item) => item.evidenceRef), outcome.evidenceRef];
  return {
    expectedStoreVersion: state.version,
    trustedHostAttested: true,
    taskId: task.id,
    expectedTaskVersion: task.version,
    outcomeStatus: "verified",
    outcomeRefs: [binding.outcomeRef],
    lifecycleClaims: [
      {
        phase: "discovery",
        status: "not_started",
        summary: "Discovery was not evaluated by this artifact verification.",
        evidenceRefs: [],
      },
      {
        phase: "preparation",
        status: "not_started",
        summary: "Preparation was not evaluated by this artifact verification.",
        evidenceRefs: [],
      },
      {
        phase: "execution",
        status: "completed",
        summary: "The exact accepted run reached its durable terminal receipt.",
        evidenceRefs: [execution.evidenceRef],
      },
      {
        phase: "verification",
        status: "completed",
        summary: "Every declared media artifact matched its sealed filesystem binding.",
        evidenceRefs: verificationRefs,
      },
    ],
    valueItems: [
      {
        valueItemId: binding.valueItemRef,
        kind: "fact",
        statement: ACCEPTED_RESULT_CLOSURE_FACT_STATEMENTS[1],
        evidenceRefs: [acceptance.evidenceRef, ...verificationRefs],
      },
    ],
    originalPreservation: {
      status: "not_applicable",
      artifactRefs: [],
      receiptRefs: [],
    },
    remainingWork: [
      {
        itemRef: binding.remainingWorkRef,
        action: "Verify any intended change outside Agentlas in the target system.",
        owner: "external",
        status: "pending",
        reason: "Filesystem verification proves only the exact internal media deliverable, not an external effect.",
      },
    ],
    receiptRefs: [
      execution.receiptRef,
      acceptance.receiptRef,
      ...artifactEvidence.map((item) => item.receiptRef),
      outcome.receiptRef,
    ],
    reflectionEligible: false,
    trustedHostEvidence: [execution, acceptance, ...artifactEvidence, outcome],
  };
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function findExactExisting(
  state: OneValueClosureState,
  expected: CreateOneValueClosureInput,
  binding: AcceptedResultEvidenceBinding,
): OneValueClosureRecord | null {
  const candidates = state.closures.filter((record) =>
    record.closure.taskId === expected.taskId
    && record.taskVersion === expected.expectedTaskVersion
    && record.closure.outcomeRefs.includes(binding.internalResultRef),
  );
  const consumedEvidence = state.evidence.filter((item) =>
    item.evidenceRef === binding.runEvidenceRef
    || item.evidenceRef === binding.acceptanceEvidenceRef
    || item.receiptRef === binding.runReceiptRef
    || item.receiptRef === binding.acceptanceReceiptRef,
  );
  if (candidates.length === 0) {
    if (consumedEvidence.length > 0) throw new Error("Accepted-result evidence binding was consumed without its exact Value Closure");
    return null;
  }
  if (candidates.length !== 1) throw new Error("Accepted-result Value Closure binding is ambiguous");
  const record = candidates[0];
  const actualEvidence = record.trustedEvidenceRefs.map((ref) =>
    state.evidence.find((item) => item.evidenceRef === ref),
  );
  const actualProjection = {
    outcomeStatus: record.closure.outcomeStatus,
    outcomeRefs: record.closure.outcomeRefs,
    lifecycleClaims: record.closure.lifecycleClaims,
    valueItems: record.closure.valueItems,
    originalPreservation: record.closure.originalPreservation,
    remainingWork: record.closure.remainingWork,
    receiptRefs: record.closure.receiptRefs,
    reflection: record.closure.reflection,
    trustedEvidence: actualEvidence,
    artifactRefs: record.artifactRefs,
    estimateRefs: record.estimateRefs,
  };
  const expectedProjection = {
    outcomeStatus: expected.outcomeStatus,
    outcomeRefs: expected.outcomeRefs,
    lifecycleClaims: expected.lifecycleClaims,
    valueItems: expected.valueItems,
    originalPreservation: expected.originalPreservation,
    remainingWork: expected.remainingWork,
    receiptRefs: expected.receiptRefs,
    reflection: { eligible: false, userOptedIn: false, included: false },
    trustedEvidence: expected.trustedHostEvidence,
    artifactRefs: [],
    estimateRefs: [],
  };
  if (!sameJson(actualProjection, expectedProjection)) {
    throw new Error("Accepted-result Value Closure collided with a different Task-version/run binding");
  }
  return record;
}

function findExactVerifiedArtifactExisting(
  state: OneValueClosureState,
  expected: CreateOneValueClosureInput,
  binding: VerifiedAcceptedArtifactBinding,
): OneValueClosureRecord | null {
  const candidates = state.closures.filter((record) =>
    record.closure.taskId === expected.taskId
    && record.taskVersion === expected.expectedTaskVersion
    && record.closure.outcomeRefs.length === 1
    && record.closure.outcomeRefs[0] === binding.outcomeRef,
  );
  const expectedEvidenceRefs = new Set(expected.trustedHostEvidence.flatMap((item) => [
    item.evidenceRef,
    item.receiptRef,
  ]));
  const consumedEvidence = state.evidence.filter((item) =>
    expectedEvidenceRefs.has(item.evidenceRef) || expectedEvidenceRefs.has(item.receiptRef),
  );
  if (candidates.length === 0) {
    if (consumedEvidence.length > 0) throw new Error("Verified accepted-artifact evidence was consumed without its exact Value Closure");
    return null;
  }
  if (candidates.length !== 1) throw new Error("Verified accepted-artifact Value Closure binding is ambiguous");
  const record = candidates[0];
  const actualEvidence = record.trustedEvidenceRefs.map((ref) =>
    state.evidence.find((item) => item.evidenceRef === ref),
  );
  const actualProjection = {
    outcomeStatus: record.closure.outcomeStatus,
    outcomeRefs: record.closure.outcomeRefs,
    lifecycleClaims: record.closure.lifecycleClaims,
    valueItems: record.closure.valueItems,
    originalPreservation: record.closure.originalPreservation,
    remainingWork: record.closure.remainingWork,
    receiptRefs: record.closure.receiptRefs,
    reflection: record.closure.reflection,
    trustedEvidence: actualEvidence,
    artifactRefs: record.artifactRefs,
    estimateRefs: record.estimateRefs,
  };
  const expectedProjection = {
    outcomeStatus: expected.outcomeStatus,
    outcomeRefs: expected.outcomeRefs,
    lifecycleClaims: expected.lifecycleClaims,
    valueItems: expected.valueItems,
    originalPreservation: expected.originalPreservation,
    remainingWork: expected.remainingWork,
    receiptRefs: expected.receiptRefs,
    reflection: { eligible: false, userOptedIn: false, included: false },
    trustedEvidence: expected.trustedHostEvidence,
    artifactRefs: expected.trustedHostEvidence
      .map((item) => item.artifactRef)
      .filter((item): item is string => Boolean(item)),
    estimateRefs: [],
  };
  if (!sameJson(actualProjection, expectedProjection)) {
    throw new Error("Verified accepted-artifact Value Closure collided with a different binding");
  }
  return record;
}

function hasExactDurablePartialAcceptedClosure(
  state: OneValueClosureState,
  task: CanonicalTask,
  runId: string,
): boolean {
  const candidates = state.closures.filter((record) =>
    record.closure.taskId === task.id
    && record.taskVersion === task.version
    && record.closure.outcomeStatus === "partially_verified"
    && record.closure.outcomeRefs.length === 1
    && record.closure.outcomeRefs[0]?.startsWith("result:accepted-internal:"),
  );
  return candidates.some((record) => {
    const evidence = record.trustedEvidenceRefs.map((ref) =>
      state.evidence.find((item) => item.evidenceRef === ref),
    );
    if (evidence.some((item) => !item)) return false;
    const outcomeRef = record.closure.outcomeRefs[0];
    const execution = evidence.find((item) =>
      item?.kind === "execution_receipt"
      && item.source === "invocation_runtime"
      && item.verificationStatus === "verified"
      && item.taskId === task.id
      && item.taskVersion === task.version
      && item.sourceRunRef === runId);
    const acceptance = evidence.find((item) =>
      item?.kind === "result_acceptance"
      && item.source === "canonical_task_runtime"
      && item.verificationStatus === "verified"
      && item.taskId === task.id
      && item.taskVersion === task.version
      && item.sourceRunRef === runId
      && item.outcomeRef === outcomeRef);
    return Boolean(execution && acceptance);
  });
}

/**
 * Main-only, idempotent producer for one explicit result acceptance. Its claim
 * stops at durable internal execution plus the user's exact Task-version/run
 * acceptance. External effects remain pending and unverified by construction.
 */
export function ensureAcceptedResultValueClosure(
  input: EnsureAcceptedResultValueClosureInput,
): OneValueClosureMutationResult<OneValueClosureRecord> {
  if (!isRecord(input)) throw new TypeError("Accepted-result Value Closure input must be an object");
  assertOnlyKeys(input, [
    "priorTaskVersion", "acceptedTask", "expectedRunId", "receipt", "confirmedByUser",
  ]);
  const task = exactAcceptedTask(input);
  const durable = getInvocationRunReceipt(input.expectedRunId);
  assertExactReceipt(input.receipt, durable, task, input.expectedRunId);
  const acceptanceEvent = exactAcceptanceEvent(task);
  if (!acceptanceEvent) {
    throw new Error("The exact explicit result-acceptance event is unavailable");
  }
  const resultReadyEvent = exactResultReadyEvent(task, input.priorTaskVersion);
  if (!resultReadyEvent || Date.parse(resultReadyEvent.occurredAt) > Date.parse(acceptanceEvent.occurredAt)) {
    throw new Error("The exact result-ready Task-version event is unavailable");
  }
  const hasBoundRunStart = listOneDomainEvents(input.expectedRunId, 500).some((event) =>
    event.eventType === "run.started"
    && event.entityId === input.expectedRunId
    && event.taskId === task.id,
  );
  if (!hasBoundRunStart) {
    throw new Error("The completed InvocationRunReceipt is not bound to this exact Canonical Task");
  }

  const binding = bindingFor(task.id, input.priorTaskVersion, task.version, input.expectedRunId);
  const state = getOneValueClosureState();
  const expected = buildCreateInput(state, task, durable, acceptanceEvent, binding);
  const existing = findExactExisting(state, expected, binding);
  if (existing) {
    return { storeVersion: state.version, updatedAt: state.updatedAt, value: existing };
  }
  try {
    return createOneValueClosure(expected);
  } catch (error) {
    // A concurrent Desktop/Mobile retry may have committed the exact binding.
    // Converge only to that byte-for-byte semantic record; all collisions fail.
    const latest = getOneValueClosureState();
    const convergedExpected = buildCreateInput(latest, task, durable, acceptanceEvent, binding);
    const converged = findExactExisting(latest, convergedExpected, binding);
    if (converged) {
      return { storeVersion: latest.version, updatedAt: latest.updatedAt, value: converged };
    }
    throw error;
  }
}

/**
 * Optional Main-only follow-up to explicit result acceptance. It creates a
 * verified sibling closure only when every declared result artifact is a
 * supported media file whose private binding still passes a fresh filesystem
 * identity and SHA-256 check. It never upgrades documents or external effects.
 */
export function ensureVerifiedAcceptedResultValueClosure(
  input: EnsureAcceptedResultValueClosureInput,
): OneValueClosureMutationResult<OneValueClosureRecord> | null {
  if (!isRecord(input)) throw new TypeError("Verified accepted-result Value Closure input must be an object");
  assertOnlyKeys(input, [
    "priorTaskVersion", "acceptedTask", "expectedRunId", "receipt", "confirmedByUser",
  ]);
  const task = exactAcceptedTask(input);
  const durable = getInvocationRunReceipt(input.expectedRunId);
  assertExactReceipt(input.receipt, durable, task, input.expectedRunId);
  const acceptanceEvent = exactAcceptanceEvent(task);
  if (!acceptanceEvent) throw new Error("The exact explicit result-acceptance event is unavailable");
  const resultReadyEvent = exactResultReadyEvent(task, input.priorTaskVersion);
  if (!resultReadyEvent || Date.parse(resultReadyEvent.occurredAt) > Date.parse(acceptanceEvent.occurredAt)) {
    throw new Error("The exact result-ready Task-version event is unavailable");
  }
  if (!task.originChatId) throw new Error("The accepted Canonical Task has no origin chat");
  const acceptedState = getOneValueClosureState();
  if (!hasExactDurablePartialAcceptedClosure(acceptedState, task, input.expectedRunId)) return null;
  const artifactSet = verifyOneAcceptedSurfaceArtifactSet({
    taskId: task.id,
    taskVersion: task.version,
    chatId: task.originChatId,
    runId: input.expectedRunId,
  });
  if (!artifactSet) return null;

  const binding = verifiedArtifactBindingFor(task.id, task.version, input.expectedRunId, artifactSet.setRef);
  const state = getOneValueClosureState();
  const expected = buildVerifiedArtifactCreateInput(state, task, durable, acceptanceEvent, artifactSet, binding);
  const existing = findExactVerifiedArtifactExisting(state, expected, binding);
  if (existing) return { storeVersion: state.version, updatedAt: state.updatedAt, value: existing };
  try {
    return createOneValueClosure(expected);
  } catch (error) {
    const latest = getOneValueClosureState();
    const convergedExpected = buildVerifiedArtifactCreateInput(
      latest,
      task,
      durable,
      acceptanceEvent,
      artifactSet,
      binding,
    );
    const converged = findExactVerifiedArtifactExisting(latest, convergedExpected, binding);
    if (converged) return { storeVersion: latest.version, updatedAt: latest.updatedAt, value: converged };
    throw error;
  }
}
