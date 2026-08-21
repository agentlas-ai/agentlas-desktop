import { createHash } from "node:crypto";
import type {
  CanonicalTask,
  InvocationRunReceipt,
  RunEventUi,
} from "../../shared/types";
import type {
  OneEcosystemSuggestion,
  OneAutomationSignal,
  OneObservedAgentBuildSignal,
  OneObservedPluginBuildSignal,
  OneObservedRetainTeamSignal,
  OneSuggestionAcceptedResultEvidence,
  OneSuggestionArbitrationReason,
  OneSuggestionCandidateSignals,
} from "../../shared/one-suggestions";
import {
  isOneRecurrenceSelectionV1,
  nextOneRecurrenceAt,
  oneRecurrenceStopControl,
  oneRecurrenceTriggerPreview,
  type OneRecurrenceSelectionV1,
} from "../../shared/one-recurrence";
import type {
  OneTrustedOutcomeEvidence,
  OneValueClosureRecord,
} from "../../shared/one-value-closure";
import { getDb } from "../store/db";
import { listInstalledAgentsReadOnly } from "../mcp/registry";
import { getInvocationRunReceipt, listRunEvents } from "../store/run-events";
import { getCanonicalTask } from "../store/tasks";
import { getOneBriefingSnapshot } from "./briefing";
import { listOneDomainEvents } from "./domain-events";
import {
  arbitrateOneSuggestion,
  getOneSuggestionState,
} from "./suggestions";
import { getOneValueClosureState } from "./value-closure";

export const ONE_COMPLETION_OBSERVATION_META_KEY = "agentlas.one.completion-suggestion-observations.v1";
export const ONE_AUTOMATION_OBSERVATION_META_KEY = "agentlas.one.automation-suggestion-observations.v1";
const OBSERVATION_CONTRACT_VERSION = "1.0.0" as const;
const AUTOMATION_OBSERVATION_CONTRACT_VERSION = "1.0.0" as const;
const HOST_ID_RE = /^host_[a-f0-9]{32}$/;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const MAX_OBSERVATIONS = 512;
const MAX_RUN_EVENTS = 500;

type ObservedCandidateType = "agent_build" | "retain_team";

interface AcceptedCompletionObservation {
  observationId: string;
  hostId: string;
  taskId: string;
  taskVersion: number;
  runId: string;
  valueClosureId: string;
  valueClosureVersion: number;
  candidateType: ObservedCandidateType;
  patternKey: string;
  participantRefs: string[];
  roleRefs: string[];
  toolRefs: string[];
  taskKindRef: string;
  contributionReceiptRefs: string[];
  evidence: OneSuggestionAcceptedResultEvidence;
  observedAt: string;
}

interface AcceptedCompletionObservationState {
  contractVersion: typeof OBSERVATION_CONTRACT_VERSION;
  version: number;
  observations: AcceptedCompletionObservation[];
  createdAt: string;
  updatedAt: string;
}

interface AcceptedAutomationObservation {
  observationId: string;
  hostId: string;
  taskId: string;
  taskVersion: number;
  runId: string;
  valueClosureId: string;
  valueClosureVersion: number;
  patternKey: string;
  selection: OneRecurrenceSelectionV1;
  evidence: OneSuggestionAcceptedResultEvidence;
  observedAt: string;
}

interface AcceptedAutomationObservationState {
  contractVersion: typeof AUTOMATION_OBSERVATION_CONTRACT_VERSION;
  version: number;
  observations: AcceptedAutomationObservation[];
  createdAt: string;
  updatedAt: string;
}

export interface ProduceAcceptedResultSuggestionInput {
  hostId: string;
  taskId: string;
  expectedTaskVersion: number;
  expectedTaskUpdatedAt: string;
  expectedRunId: string;
  valueClosureId: string;
  expectedValueClosureVersion: number;
  confirmedByUser: true;
}

export type ProduceAcceptedResultSuggestionReason =
  | OneSuggestionArbitrationReason
  | "observation_recorded"
  | "not_one_mode"
  | "no_reusable_execution_pattern"
  | "producer_failed";

export interface ProduceAcceptedResultSuggestionResult {
  reason: ProduceAcceptedResultSuggestionReason;
  suggestion: OneEcosystemSuggestion | null;
  observationId: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID_RE.test(value);
}

function positiveVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function uniqueSafeIds(value: unknown, min: number, max: number): value is string[] {
  return Array.isArray(value)
    && value.length >= min
    && value.length <= max
    && value.every(safeId)
    && new Set(value).size === value.length;
}

function stableRef(prefix: string, ...parts: string[]): string {
  const digest = createHash("sha256")
    .update(parts.map((part) => `${Buffer.byteLength(part, "utf8")}:${part}`).join("|"), "utf8")
    .digest("hex")
    .slice(0, 32);
  return `${prefix}:${digest}`;
}

function installedParticipantRefs(
  hostId: string,
  task: CanonicalTask,
  participantIds: readonly string[],
): string[] | null {
  const installedById = new Map(listInstalledAgentsReadOnly().map((agent) => [agent.id, agent] as const));
  const refs: string[] = [];
  for (const agentId of participantIds) {
    const participant = task.participants.find((item) => item.agentId === agentId);
    const installed = installedById.get(agentId);
    if (
      !installed
      || (participant !== undefined && participant.agentSlug !== installed.slug)
      || installed.kind === "team"
      || installed.visibility === "background"
      || installed.visibility === "private"
      || Boolean(installed.sourceMissingSince)
      || !timestamp(installed.installedAt)
      || (installed.packageHash !== undefined && !/^[a-f0-9]{64}$/.test(installed.packageHash))
    ) return null;
    refs.push(stableRef(
      "participant",
      hostId,
      installed.id,
      installed.slug,
      installed.installedAt,
      installed.packageHash ?? "unversioned",
    ));
  }
  return refs;
}

function isAcceptedEvidence(value: unknown): value is OneSuggestionAcceptedResultEvidence {
  if (!isRecord(value) || !exactKeys(value, [
    "taskId", "taskVersion", "patternKey", "status", "outcome", "acceptanceReceiptVerified",
    "hostId", "runId", "completionReceiptRef", "verificationRef", "evidenceRefs", "completedAt",
  ])) return false;
  return safeId(value.taskId)
    && positiveVersion(value.taskVersion)
    && safeId(value.patternKey)
    && value.status === "completed"
    && value.outcome === "accepted_internal_result"
    && value.acceptanceReceiptVerified === true
    && typeof value.hostId === "string" && HOST_ID_RE.test(value.hostId)
    && safeId(value.runId)
    && value.completionReceiptRef === value.runId
    && safeId(value.verificationRef)
    && uniqueSafeIds(value.evidenceRefs, 1, 32)
    && timestamp(value.completedAt);
}

function isObservation(value: unknown): value is AcceptedCompletionObservation {
  if (!isRecord(value) || !exactKeys(value, [
    "observationId", "hostId", "taskId", "taskVersion", "runId", "valueClosureId",
    "valueClosureVersion", "candidateType", "patternKey", "participantRefs", "roleRefs",
    "toolRefs", "taskKindRef", "contributionReceiptRefs", "evidence", "observedAt",
  ])) return false;
  return safeId(value.observationId)
    && typeof value.hostId === "string" && HOST_ID_RE.test(value.hostId)
    && safeId(value.taskId)
    && positiveVersion(value.taskVersion)
    && safeId(value.runId)
    && safeId(value.valueClosureId)
    && positiveVersion(value.valueClosureVersion)
    && (value.candidateType === "agent_build" || value.candidateType === "retain_team")
    && safeId(value.patternKey)
    && uniqueSafeIds(value.participantRefs, 1, 32)
    && uniqueSafeIds(value.roleRefs, 1, 32)
    && uniqueSafeIds(value.toolRefs, 0, 64)
    && safeId(value.taskKindRef)
    && uniqueSafeIds(value.contributionReceiptRefs, 1, 64)
    && isAcceptedEvidence(value.evidence)
    && value.evidence.taskId === value.taskId
    && value.evidence.taskVersion === value.taskVersion
    && value.evidence.patternKey === value.patternKey
    && value.evidence.hostId === value.hostId
    && value.evidence.runId === value.runId
    && value.observedAt === value.evidence.completedAt
    && timestamp(value.observedAt)
    && (value.candidateType === "agent_build" ? value.participantRefs.length === 1 : value.participantRefs.length >= 2);
}

function isObservationState(value: unknown): value is AcceptedCompletionObservationState {
  if (!isRecord(value) || !exactKeys(value, [
    "contractVersion", "version", "observations", "createdAt", "updatedAt",
  ])) return false;
  if (
    value.contractVersion !== OBSERVATION_CONTRACT_VERSION
    || !positiveVersion(value.version)
    || !timestamp(value.createdAt)
    || !timestamp(value.updatedAt)
    || Date.parse(value.updatedAt) !== value.version
    || !Array.isArray(value.observations)
    || value.observations.length > MAX_OBSERVATIONS
    || !value.observations.every(isObservation)
  ) return false;
  const observations = value.observations;
  return new Set(observations.map((item) => item.observationId)).size === observations.length
    && new Set(observations.map((item) => `${item.hostId}:${item.taskId}:${item.taskVersion}:${item.runId}`)).size === observations.length;
}

function isAutomationObservation(value: unknown): value is AcceptedAutomationObservation {
  if (!isRecord(value) || !exactKeys(value, [
    "observationId", "hostId", "taskId", "taskVersion", "runId", "valueClosureId",
    "valueClosureVersion", "patternKey", "selection", "evidence", "observedAt",
  ])) return false;
  return safeId(value.observationId)
    && typeof value.hostId === "string" && HOST_ID_RE.test(value.hostId)
    && safeId(value.taskId)
    && positiveVersion(value.taskVersion)
    && safeId(value.runId)
    && safeId(value.valueClosureId)
    && positiveVersion(value.valueClosureVersion)
    && safeId(value.patternKey)
    && isOneRecurrenceSelectionV1(value.selection)
    && isAcceptedEvidence(value.evidence)
    && value.evidence.taskId === value.taskId
    && value.evidence.taskVersion === value.taskVersion
    && value.evidence.patternKey === value.patternKey
    && value.evidence.hostId === value.hostId
    && value.evidence.runId === value.runId
    && value.observedAt === value.evidence.completedAt
    && timestamp(value.observedAt);
}

function isAutomationObservationState(value: unknown): value is AcceptedAutomationObservationState {
  if (!isRecord(value) || !exactKeys(value, [
    "contractVersion", "version", "observations", "createdAt", "updatedAt",
  ])) return false;
  if (
    value.contractVersion !== AUTOMATION_OBSERVATION_CONTRACT_VERSION
    || !positiveVersion(value.version)
    || !timestamp(value.createdAt)
    || !timestamp(value.updatedAt)
    || Date.parse(value.updatedAt) !== value.version
    || !Array.isArray(value.observations)
    || value.observations.length > MAX_OBSERVATIONS
    || !value.observations.every(isAutomationObservation)
  ) return false;
  const observations = value.observations;
  return new Set(observations.map((item) => item.observationId)).size === observations.length
    && new Set(observations.map((item) => `${item.hostId}:${item.taskId}:${item.taskVersion}:${item.runId}`)).size === observations.length;
}

function initialState(): AcceptedCompletionObservationState {
  const version = Math.max(1, Date.now());
  const now = new Date(version).toISOString();
  return {
    contractVersion: OBSERVATION_CONTRACT_VERSION,
    version,
    observations: [],
    createdAt: now,
    updatedAt: now,
  };
}

function initialAutomationState(): AcceptedAutomationObservationState {
  const version = Math.max(1, Date.now());
  const now = new Date(version).toISOString();
  return {
    contractVersion: AUTOMATION_OBSERVATION_CONTRACT_VERSION,
    version,
    observations: [],
    createdAt: now,
    updatedAt: now,
  };
}

function parseState(raw: string): AcceptedCompletionObservationState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Stored One completion observations are corrupt; they were not overwritten");
  }
  if (!isObservationState(parsed)) {
    throw new Error("Stored One completion observations violate their closed contract; they were not overwritten");
  }
  return parsed;
}

function parseAutomationState(raw: string): AcceptedAutomationObservationState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Stored One automation observations are corrupt; they were not overwritten");
  }
  if (!isAutomationObservationState(parsed)) {
    throw new Error("Stored One automation observations violate their closed contract; they were not overwritten");
  }
  return parsed;
}

function readState(): { raw: string; state: AcceptedCompletionObservationState } {
  const db = getDb();
  let row = db.prepare("SELECT value FROM meta WHERE key = ? LIMIT 1")
    .get(ONE_COMPLETION_OBSERVATION_META_KEY) as { value: string } | undefined;
  if (!row) {
    db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)")
      .run(ONE_COMPLETION_OBSERVATION_META_KEY, JSON.stringify(initialState()));
    row = db.prepare("SELECT value FROM meta WHERE key = ? LIMIT 1")
      .get(ONE_COMPLETION_OBSERVATION_META_KEY) as { value: string } | undefined;
  }
  if (!row) throw new Error("Could not initialize One completion observations");
  return { raw: row.value, state: parseState(row.value) };
}

function readAutomationState(): { raw: string; state: AcceptedAutomationObservationState } {
  const db = getDb();
  let row = db.prepare("SELECT value FROM meta WHERE key = ? LIMIT 1")
    .get(ONE_AUTOMATION_OBSERVATION_META_KEY) as { value: string } | undefined;
  if (!row) {
    db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)")
      .run(ONE_AUTOMATION_OBSERVATION_META_KEY, JSON.stringify(initialAutomationState()));
    row = db.prepare("SELECT value FROM meta WHERE key = ? LIMIT 1")
      .get(ONE_AUTOMATION_OBSERVATION_META_KEY) as { value: string } | undefined;
  }
  if (!row) throw new Error("Could not initialize One automation observations");
  return { raw: row.value, state: parseAutomationState(row.value) };
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function appendObservation(candidate: AcceptedCompletionObservation): AcceptedCompletionObservationState {
  if (!isObservation(candidate)) throw new Error("Refused an invalid accepted-completion observation");
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const { raw, state } = readState();
    const existing = state.observations.find((item) => item.observationId === candidate.observationId);
    if (existing) {
      if (!sameJson(existing, candidate)) throw new Error("Accepted-completion observation id collided with different evidence");
      return state;
    }
    if (state.observations.some((item) =>
      item.hostId === candidate.hostId
      && item.taskId === candidate.taskId
      && item.taskVersion === candidate.taskVersion
      && item.runId === candidate.runId,
    )) throw new Error("Accepted completion already has a different observation binding");
    const version = Math.max(Date.now(), state.version + 1);
    const updatedAt = new Date(version).toISOString();
    const next: AcceptedCompletionObservationState = {
      ...state,
      version,
      observations: [...state.observations, candidate].slice(-MAX_OBSERVATIONS),
      updatedAt,
    };
    if (!isObservationState(next)) throw new Error("One completion observation mutation violated its closed contract");
    const changed = getDb().prepare("UPDATE meta SET value = ? WHERE key = ? AND value = ?")
      .run(JSON.stringify(next), ONE_COMPLETION_OBSERVATION_META_KEY, raw).changes;
    if (changed === 1) return next;
  }
  throw new Error("One completion observations changed concurrently; retry later");
}

function appendAutomationObservation(candidate: AcceptedAutomationObservation): AcceptedAutomationObservationState {
  if (!isAutomationObservation(candidate)) throw new Error("Refused an invalid accepted automation observation");
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const { raw, state } = readAutomationState();
    const existing = state.observations.find((item) => item.observationId === candidate.observationId);
    if (existing) {
      if (!sameJson(existing, candidate)) throw new Error("Accepted automation observation id collided with different evidence");
      return state;
    }
    if (state.observations.some((item) =>
      item.hostId === candidate.hostId
      && item.taskId === candidate.taskId
      && item.taskVersion === candidate.taskVersion
      && item.runId === candidate.runId,
    )) throw new Error("Accepted completion already has a different automation observation binding");
    const version = Math.max(Date.now(), state.version + 1);
    const updatedAt = new Date(version).toISOString();
    const next: AcceptedAutomationObservationState = {
      ...state,
      version,
      observations: [...state.observations, candidate].slice(-MAX_OBSERVATIONS),
      updatedAt,
    };
    if (!isAutomationObservationState(next)) {
      throw new Error("One automation observation mutation violated its closed contract");
    }
    const changed = getDb().prepare("UPDATE meta SET value = ? WHERE key = ? AND value = ?")
      .run(JSON.stringify(next), ONE_AUTOMATION_OBSERVATION_META_KEY, raw).changes;
    if (changed === 1) return next;
  }
  throw new Error("One automation observations changed concurrently; retry later");
}

function assertExactInput(input: ProduceAcceptedResultSuggestionInput): void {
  if (!isRecord(input) || !exactKeys(input, [
    "hostId", "taskId", "expectedTaskVersion", "expectedTaskUpdatedAt", "expectedRunId",
    "valueClosureId", "expectedValueClosureVersion", "confirmedByUser",
  ])) throw new TypeError("Accepted-result suggestion producer input must be a closed object");
  if (!HOST_ID_RE.test(input.hostId)) throw new TypeError("Accepted-result suggestion requires an exact local host id");
  if (!safeId(input.taskId) || !positiveVersion(input.expectedTaskVersion) || !timestamp(input.expectedTaskUpdatedAt)) {
    throw new TypeError("Accepted-result suggestion requires an exact Task id/version/timestamp binding");
  }
  if (!safeId(input.expectedRunId)) throw new TypeError("expectedRunId must be an opaque safe id");
  if (!safeId(input.valueClosureId) || !positiveVersion(input.expectedValueClosureVersion)) {
    throw new TypeError("Accepted-result suggestion requires an exact Value Closure id/version binding");
  }
  if (input.confirmedByUser !== true) throw new Error("Accepted-result suggestion requires explicit result acceptance");
}

function exactClosureEvidence(
  task: CanonicalTask,
  run: InvocationRunReceipt & { finishedAt: string },
  valueClosureId: string,
  expectedValueClosureVersion: number,
): { record: OneValueClosureRecord; acceptance: OneTrustedOutcomeEvidence; execution: OneTrustedOutcomeEvidence } {
  const state = getOneValueClosureState();
  const record = state.closures.find((item) => item.closure.valueClosureId === valueClosureId);
  if (!record || record.version !== expectedValueClosureVersion) {
    throw new Error("Accepted-result Value Closure is stale or not canonical");
  }
  if (
    record.closure.taskId !== task.id
    || record.taskVersion !== task.version
    || record.closure.outcomeStatus !== "partially_verified"
    || record.closure.outcomeRefs.length !== 1
    || !record.closure.outcomeRefs[0]?.startsWith("result:accepted-internal:")
  ) throw new Error("Value Closure is not the exact truth-bounded accepted internal result");
  const trusted = state.evidence.filter((item) => record.trustedEvidenceRefs.includes(item.evidenceRef));
  if (trusted.length !== record.trustedEvidenceRefs.length) throw new Error("Value Closure trusted evidence is incomplete");
  const acceptance = trusted.find((item) =>
    item.kind === "result_acceptance"
    && item.source === "canonical_task_runtime"
    && item.taskId === task.id
    && item.taskVersion === task.version
    && item.sourceRunRef === run.runId
    && item.observedAt === task.updatedAt,
  );
  const execution = trusted.find((item) =>
    item.kind === "execution_receipt"
    && item.source === "invocation_runtime"
    && item.taskId === task.id
    && item.taskVersion === task.version
    && item.sourceRunRef === run.runId
    && item.observedAt === run.finishedAt,
  );
  if (!acceptance || !execution) throw new Error("Value Closure lacks the exact acceptance and execution receipts");
  const acceptanceEvent = listOneDomainEvents(task.id, 500).find((event) =>
    event.eventId === acceptance.sourceRef
    && event.eventType === "task.state_changed"
    && event.taskId === task.id
    && event.version === task.version
    && event.occurredAt === task.updatedAt
    && event.actor === "user",
  );
  const runStart = listOneDomainEvents(run.runId, 500).find((event) =>
    event.eventType === "run.started"
    && event.taskId === task.id
    && event.entityId === run.runId,
  );
  if (!acceptanceEvent || !runStart) throw new Error("Accepted result is not bound to exact Task and run domain receipts");
  return { record, acceptance, execution };
}

function eventPayload(event: RunEventUi): Record<string, unknown> {
  return isRecord(event.payload) ? event.payload : {};
}

function recurrenceSelectionFromStart(start: RunEventUi): OneRecurrenceSelectionV1 | null {
  const payload = eventPayload(start);
  if (payload.oneRecurrenceSelection === undefined) return null;
  if (
    payload.oneRecurrencePolicy !== "proposal_evidence_only_review_required"
    || !isOneRecurrenceSelectionV1(payload.oneRecurrenceSelection)
  ) throw new Error("Durable recurrence selection is malformed or lacks its review-only policy");
  return { ...payload.oneRecurrenceSelection };
}

function recurrencePatternKey(
  hostId: string,
  basePatternKey: string,
  selection: OneRecurrenceSelectionV1 | null,
): string {
  if (!selection) return basePatternKey;
  return stableRef(
    "recurrence-pattern",
    hostId,
    basePatternKey,
    selection.intentKind,
    selection.cadence,
    String(selection.weekday ?? "none"),
    selection.localTime,
    selection.timeZone,
    selection.startPolicy,
    selection.endPolicy,
    selection.permission,
  );
}

function boundedLedgerText(value: unknown): value is string {
  return typeof value === "string"
    && value.trim().length >= 1
    && value.length <= 240
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function isSuccessfulToolReceiptEvent(event: RunEventUi): boolean {
  const payload = eventPayload(event);
  return event.kind === "mcp_tool-use"
    && safeId(event.id)
    && boundedLedgerText(payload.toolName)
    && boundedLedgerText(payload.toolId)
    && payload.toolIsError === false;
}

function structuredTaskKindRef(hostId: string, start: RunEventUi, toolRefs: string[]): string | null {
  const payload = eventPayload(start);
  if (payload.oneMode !== true) return null;
  const modes = {
    oneMode: true,
    planMode: payload.planMode === true,
    goalMode: payload.goalMode === true,
    appsGenerateMode: payload.appsGenerateMode === true,
    toolMode: typeof payload.toolMode === "string" ? payload.toolMode : "unset",
    hubMode: typeof payload.hubMode === "string" ? payload.hubMode : "unset",
    toolRefs,
  };
  return stableRef("task-kind", hostId, JSON.stringify(modes));
}

function buildObservation(input: ProduceAcceptedResultSuggestionInput): AcceptedCompletionObservation | null {
  assertExactInput(input);
  const task = getCanonicalTask(input.taskId);
  if (
    !task
    || task.version !== input.expectedTaskVersion
    || task.updatedAt !== input.expectedTaskUpdatedAt
    || task.status !== "completed"
    || task.archivedAt !== null
    || !task.originChatId
  ) throw new Error("Accepted Canonical Task is stale or no longer completed");
  const receipt = getInvocationRunReceipt(input.expectedRunId);
  if (
    !receipt
    || receipt.status !== "completed"
    || typeof receipt.finishedAt !== "string"
    || receipt.chatId !== task.originChatId
  ) throw new Error("Exact durable completed run receipt is unavailable");
  const events = listRunEvents(receipt.runId, MAX_RUN_EVENTS);
  if (receipt.eventCount > MAX_RUN_EVENTS || events.length !== receipt.eventCount) {
    throw new Error("Run ledger is too large or incomplete for safe pattern observation");
  }
  const start = events.find((event) => event.kind === "invoke_started");
  if (!start) throw new Error("Run ledger lacks its durable start");

  const participantIds = [...new Set(events
    .map((event) => event.agentId?.trim() ?? "")
    .filter(Boolean))].sort();
  if (participantIds.length === 0) return null;
  const participantRefs = installedParticipantRefs(input.hostId, task, participantIds);
  if (!participantRefs) return null;
  const roleRefs = [...new Set(participantIds.map((agentId) => {
    const observedRole = events.find((event) =>
      event.agentId === agentId && typeof eventPayload(event).role === "string",
    );
    const canonicalRole = task.participants.find((item) => item.agentId === agentId)?.role ?? "unspecified";
    const role = typeof eventPayload(observedRole ?? start).role === "string"
      ? String(eventPayload(observedRole ?? start).role)
      : canonicalRole;
    return stableRef("role", input.hostId, agentId, role);
  }))].sort();
  const toolRefs = [...new Set(events.flatMap((event) => {
    if (!isSuccessfulToolReceiptEvent(event)) return [];
    const toolName = String(eventPayload(event).toolName).trim();
    return [stableRef("tool", input.hostId, toolName)];
  }))].sort();
  const contributionReceiptRefs = participantIds.flatMap((participantId) => {
    const durableToolEvent = events.find((event) =>
      event.agentId === participantId && isSuccessfulToolReceiptEvent(event),
    );
    return durableToolEvent ? [durableToolEvent.id] : [];
  });
  if (participantIds.length === 1) {
    // A plain answer from the default owner/orchestrator is not an Agent Build
    // pattern. Require at least one actually observed successful tool event,
    // and exclude known default orchestration identities even when a tool ran.
    if (toolRefs.length === 0) return null;
    const canonical = task.participants.find((item) => item.agentId === participantIds[0]);
    if (
      canonical?.role === "owner"
      && /(?:^|[-_:])(agentlas|one)[-_:]?(?:orchestrator|owner)(?:$|[-_:])/i.test(canonical.agentSlug)
    ) return null;
  } else if (contributionReceiptRefs.length !== participantIds.length) {
    // A roster is not contribution evidence. Every proposed team member must
    // have an actual durable successful tool event in this exact run.
    return null;
  }
  const taskKindRef = structuredTaskKindRef(input.hostId, start, toolRefs);
  if (!taskKindRef) return null;

  const { record, acceptance, execution } = exactClosureEvidence(
    task,
    receipt as InvocationRunReceipt & { finishedAt: string },
    input.valueClosureId,
    input.expectedValueClosureVersion,
  );
  const candidateType: ObservedCandidateType = participantRefs.length === 1 ? "agent_build" : "retain_team";
  const basePatternKey = stableRef(
    "pattern",
    input.hostId,
    taskKindRef,
    ...participantRefs,
    ...roleRefs,
    ...toolRefs,
  );
  const patternKey = recurrencePatternKey(
    input.hostId,
    basePatternKey,
    recurrenceSelectionFromStart(start),
  );
  const observationId = stableRef("completion-observation", input.hostId, task.id, String(task.version), receipt.runId);
  const evidence: OneSuggestionAcceptedResultEvidence = {
    taskId: task.id,
    taskVersion: task.version,
    patternKey,
    status: "completed",
    outcome: "accepted_internal_result",
    acceptanceReceiptVerified: true,
    hostId: input.hostId,
    runId: receipt.runId,
    completionReceiptRef: receipt.runId,
    verificationRef: acceptance.evidenceRef,
    evidenceRefs: [acceptance.receiptRef, execution.evidenceRef, record.closure.valueClosureId],
    completedAt: task.updatedAt,
  };
  const observation: AcceptedCompletionObservation = {
    observationId,
    hostId: input.hostId,
    taskId: task.id,
    taskVersion: task.version,
    runId: receipt.runId,
    valueClosureId: record.closure.valueClosureId,
    valueClosureVersion: record.version,
    candidateType,
    patternKey,
    participantRefs,
    roleRefs,
    toolRefs,
    taskKindRef,
    contributionReceiptRefs,
    evidence,
    observedAt: task.updatedAt,
  };
  if (!isObservation(observation)) throw new Error("Accepted completion produced an invalid safe observation");
  return observation;
}

function buildAutomationObservation(
  input: ProduceAcceptedResultSuggestionInput,
  reusable: AcceptedCompletionObservation | null,
): AcceptedAutomationObservation | null {
  assertExactInput(input);
  const task = getCanonicalTask(input.taskId);
  if (
    !task
    || task.version !== input.expectedTaskVersion
    || task.updatedAt !== input.expectedTaskUpdatedAt
    || task.status !== "completed"
    || task.archivedAt !== null
    || !task.originChatId
  ) throw new Error("Accepted Canonical Task is stale or no longer completed");
  const receipt = getInvocationRunReceipt(input.expectedRunId);
  if (
    !receipt
    || receipt.status !== "completed"
    || typeof receipt.finishedAt !== "string"
    || receipt.chatId !== task.originChatId
  ) throw new Error("Exact durable completed run receipt is unavailable");
  const events = listRunEvents(receipt.runId, MAX_RUN_EVENTS);
  if (receipt.eventCount > MAX_RUN_EVENTS || events.length !== receipt.eventCount) {
    throw new Error("Run ledger is too large or incomplete for safe recurrence observation");
  }
  const start = events.find((event) => event.kind === "invoke_started");
  if (!start) throw new Error("Run ledger lacks its durable start");
  const selection = recurrenceSelectionFromStart(start);
  if (!selection) return null;

  let patternKey: string;
  let evidence: OneSuggestionAcceptedResultEvidence;
  let valueClosureId: string;
  let valueClosureVersion: number;
  if (reusable) {
    patternKey = reusable.patternKey;
    evidence = reusable.evidence;
    valueClosureId = reusable.valueClosureId;
    valueClosureVersion = reusable.valueClosureVersion;
  } else {
    const toolRefs = [...new Set(events.flatMap((event) => {
      if (!isSuccessfulToolReceiptEvent(event)) return [];
      return [stableRef("tool", input.hostId, String(eventPayload(event).toolName).trim())];
    }))].sort();
    const taskKindRef = structuredTaskKindRef(input.hostId, start, toolRefs);
    if (!taskKindRef) return null;
    const participantPatternRefs = [...new Set(events.flatMap((event) =>
      safeId(event.agentId) ? [stableRef("run-participant", input.hostId, event.agentId)] : [],
    ))].sort();
    const basePatternKey = stableRef(
      "pattern",
      input.hostId,
      taskKindRef,
      ...participantPatternRefs,
      ...toolRefs,
    );
    patternKey = recurrencePatternKey(input.hostId, basePatternKey, selection);
    const { record, acceptance, execution } = exactClosureEvidence(
      task,
      receipt as InvocationRunReceipt & { finishedAt: string },
      input.valueClosureId,
      input.expectedValueClosureVersion,
    );
    valueClosureId = record.closure.valueClosureId;
    valueClosureVersion = record.version;
    evidence = {
      taskId: task.id,
      taskVersion: task.version,
      patternKey,
      status: "completed",
      outcome: "accepted_internal_result",
      acceptanceReceiptVerified: true,
      hostId: input.hostId,
      runId: receipt.runId,
      completionReceiptRef: receipt.runId,
      verificationRef: acceptance.evidenceRef,
      evidenceRefs: [acceptance.receiptRef, execution.evidenceRef, record.closure.valueClosureId],
      completedAt: task.updatedAt,
    };
  }
  const observation: AcceptedAutomationObservation = {
    observationId: stableRef(
      "automation-observation",
      input.hostId,
      task.id,
      String(task.version),
      receipt.runId,
    ),
    hostId: input.hostId,
    taskId: task.id,
    taskVersion: task.version,
    runId: receipt.runId,
    valueClosureId,
    valueClosureVersion,
    patternKey,
    selection,
    evidence,
    observedAt: task.updatedAt,
  };
  if (!isAutomationObservation(observation)) {
    throw new Error("Accepted completion produced an invalid safe automation observation");
  }
  return observation;
}

function stillCanonical(observation: AcceptedCompletionObservation): boolean {
  try {
    const task = getCanonicalTask(observation.taskId);
    const closure = getOneValueClosureState().closures.find((item) =>
      item.closure.valueClosureId === observation.valueClosureId
      && item.version === observation.valueClosureVersion,
    );
    if (!task || !closure) return false;
    const rebuilt = buildObservation({
      hostId: observation.hostId,
      taskId: task.id,
      expectedTaskVersion: task.version,
      expectedTaskUpdatedAt: task.updatedAt,
      expectedRunId: observation.runId,
      valueClosureId: closure.closure.valueClosureId,
      expectedValueClosureVersion: closure.version,
      confirmedByUser: true,
    });
    return Boolean(rebuilt && sameJson(rebuilt, observation));
  } catch {
    return false;
  }
}

function stillCanonicalAutomation(observation: AcceptedAutomationObservation): boolean {
  try {
    const task = getCanonicalTask(observation.taskId);
    const closure = getOneValueClosureState().closures.find((item) =>
      item.closure.valueClosureId === observation.valueClosureId
      && item.version === observation.valueClosureVersion,
    );
    if (!task || !closure) return false;
    const input: ProduceAcceptedResultSuggestionInput = {
      hostId: observation.hostId,
      taskId: task.id,
      expectedTaskVersion: task.version,
      expectedTaskUpdatedAt: task.updatedAt,
      expectedRunId: observation.runId,
      valueClosureId: closure.closure.valueClosureId,
      expectedValueClosureVersion: closure.version,
      confirmedByUser: true,
    };
    const reusable = buildObservation(input);
    const rebuilt = buildAutomationObservation(input, reusable);
    return Boolean(rebuilt && sameJson(rebuilt, observation));
  } catch {
    return false;
  }
}

function signalsFor(observations: AcceptedCompletionObservation[]): OneSuggestionCandidateSignals {
  const latest = observations[observations.length - 1];
  if (!latest || observations.length < 2) {
    return { pluginBuild: null, agentBuild: null, retainTeam: null, automation: null, hubDerivative: null };
  }
  const sameProcedure = observations.length >= 3
    && latest.toolRefs.length >= 2
    && observations.every((item) => item.taskKindRef === latest.taskKindRef)
    && observations.every((item) => sameJson(item.toolRefs, latest.toolRefs));
  const pluginBuild: OneObservedPluginBuildSignal | null = sameProcedure ? {
    signalSource: "accepted_result_pattern",
    patternKey: latest.patternKey,
    taskKindRef: latest.taskKindRef,
    toolRefs: latest.toolRefs,
    observationRefs: observations.map((item) => item.observationId),
    acceptedResultCount: observations.length,
    reviewRequired: true,
  } : null;
  if (latest.candidateType === "agent_build") {
    const signal: OneObservedAgentBuildSignal = {
      signalSource: "accepted_result_pattern",
      participantRef: latest.participantRefs[0],
      roleRef: latest.roleRefs[0],
      taskKindRef: latest.taskKindRef,
      toolRefs: latest.toolRefs,
      observationRefs: observations.map((item) => item.observationId),
      acceptedResultCount: observations.length,
      reviewRequired: true,
    };
    return { pluginBuild, agentBuild: signal, retainTeam: null, automation: null, hubDerivative: null };
  }
  const signal: OneObservedRetainTeamSignal = {
    signalSource: "accepted_result_pattern",
    teamSignatureRef: stableRef("team-signature", latest.patternKey),
    participantRefs: latest.participantRefs,
    roleRefs: latest.roleRefs,
    toolRefs: latest.toolRefs,
    contributionReceiptRefs: [...new Set(observations.flatMap((item) => item.contributionReceiptRefs))],
    acceptedResultRefs: observations.map((item) => item.evidence.verificationRef),
    acceptedResultCount: observations.length,
    reviewRequired: true,
  };
  return { pluginBuild, agentBuild: null, retainTeam: signal, automation: null, hubDerivative: null };
}

function automationSignalFor(observations: AcceptedAutomationObservation[]): OneAutomationSignal | null {
  const latest = observations[observations.length - 1];
  if (!latest || observations.length < 3) return null;
  if (
    new Set(observations.map((item) => item.taskId)).size !== observations.length
    || new Set(observations.map((item) => item.runId)).size !== observations.length
    || observations.some((item) => !sameJson(item.selection, latest.selection))
  ) return null;
  return {
    intentRef: stableRef("automation-intent", latest.hostId, latest.patternKey, latest.selection.intentKind),
    startConditionRef: stableRef(
      "automation-start",
      latest.patternKey,
      latest.selection.startPolicy,
      latest.selection.cadence,
      latest.selection.localTime,
      latest.selection.timeZone,
    ),
    endConditionRef: stableRef("automation-end", latest.patternKey, latest.selection.endPolicy),
    repeatedIntentCount: observations.length,
    reversible: true,
    riskControlsVerified: true,
    preview: {
      trigger: oneRecurrenceTriggerPreview(latest.selection),
      nextRunAt: nextOneRecurrenceAt(latest.selection),
      permission: latest.selection.permission,
      stopControl: oneRecurrenceStopControl(),
      approvalPolicy: "explicit_approval_before_external_change",
    },
  };
}

function arbitrateProductionObservations(
  origin: AcceptedCompletionObservation | null,
  observationState: AcceptedCompletionObservationState | null,
  automationOrigin: AcceptedAutomationObservation | null,
  automationState: AcceptedAutomationObservationState | null,
): ProduceAcceptedResultSuggestionResult {
  const current = origin ?? automationOrigin;
  if (!current) throw new Error("Suggestion arbitration requires an accepted completion observation");
  if (origin && automationOrigin && origin.patternKey !== automationOrigin.patternKey) {
    throw new Error("Reusable and recurrence observations do not share one exact pattern binding");
  }
  const matching = origin && observationState
    ? observationState.observations
      .filter((item) =>
        item.hostId === origin.hostId
        && item.patternKey === origin.patternKey
        && item.candidateType === origin.candidateType,
      )
      .filter(stillCanonical)
      .sort((left, right) => left.observedAt.localeCompare(right.observedAt) || left.taskId.localeCompare(right.taskId))
      .slice(-16)
    : [];
  if (origin && !matching.some((item) => item.observationId === origin.observationId)) {
    throw new Error("Current accepted completion did not survive exact canonical revalidation");
  }
  const matchingAutomation = automationOrigin && automationState
    ? automationState.observations
      .filter((item) =>
        item.hostId === automationOrigin.hostId
        && item.patternKey === automationOrigin.patternKey,
      )
      .filter(stillCanonicalAutomation)
      .sort((left, right) => left.observedAt.localeCompare(right.observedAt) || left.taskId.localeCompare(right.taskId))
      .slice(-16)
    : [];
  if (automationOrigin && !matchingAutomation.some((item) => item.observationId === automationOrigin.observationId)) {
    throw new Error("Current accepted recurrence did not survive exact canonical revalidation");
  }
  const evidenceByTask = new Map<string, OneSuggestionAcceptedResultEvidence>();
  for (const evidence of [
    ...matching.map((item) => item.evidence),
    ...matchingAutomation.map((item) => item.evidence),
  ]) {
    const prior = evidenceByTask.get(evidence.taskId);
    if (prior && !sameJson(prior, evidence)) {
      throw new Error("One Task has conflicting suggestion evidence for one exact pattern");
    }
    evidenceByTask.set(evidence.taskId, evidence);
  }
  const evidence = [...evidenceByTask.values()]
    .sort((left, right) => left.completedAt.localeCompare(right.completedAt) || left.taskId.localeCompare(right.taskId))
    .slice(-16);
  const reusableSignals = signalsFor(matching);
  const signals: OneSuggestionCandidateSignals = {
    pluginBuild: reusableSignals.pluginBuild,
    agentBuild: reusableSignals.agentBuild,
    retainTeam: reusableSignals.retainTeam,
    automation: automationSignalFor(matchingAutomation),
    hubDerivative: null,
  };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const suggestions = getOneSuggestionState();
    try {
      const result = arbitrateOneSuggestion({
        expectedStoreVersion: suggestions.version,
        originTaskId: current.taskId,
        patternKey: current.patternKey,
        importantBriefingActive: Boolean(getOneBriefingSnapshot().candidate),
        evidence,
        signals,
      });
      return { reason: result.reason, suggestion: result.suggestion, observationId: current.observationId };
    } catch (error) {
      if (attempt === 3 || !/changed|concurrently|locked|busy/i.test(error instanceof Error ? error.message : String(error))) {
        throw error;
      }
    }
  }
  throw new Error("Suggestion arbitration retry budget exhausted");
}

/**
 * Main-only production caller for the accepted-result flow. It persists only
 * opaque hashes and receipt references. Raw prompts, transcripts, Memory,
 * local paths, credentials, and result bodies never enter this comparison.
 */
export function produceAcceptedResultSuggestion(
  input: ProduceAcceptedResultSuggestionInput,
): ProduceAcceptedResultSuggestionResult {
  const observation = buildObservation(input);
  const automationObservation = buildAutomationObservation(input, observation);
  if (!observation && !automationObservation) {
    const receipt = getInvocationRunReceipt(input.expectedRunId);
    const start = receipt ? listRunEvents(receipt.runId, MAX_RUN_EVENTS).find((event) => event.kind === "invoke_started") : null;
    return {
      reason: start && eventPayload(start).oneMode === true ? "no_reusable_execution_pattern" : "not_one_mode",
      suggestion: null,
      observationId: null,
    };
  }
  const observations = observation ? appendObservation(observation) : null;
  const automationObservations = automationObservation
    ? appendAutomationObservation(automationObservation)
    : null;
  return arbitrateProductionObservations(
    observation,
    observations,
    automationObservation,
    automationObservations,
  );
}

/** Optional growth suggestions must never roll back a valid result acceptance. */
export function tryProduceAcceptedResultSuggestion(
  input: ProduceAcceptedResultSuggestionInput,
): ProduceAcceptedResultSuggestionResult {
  try {
    return produceAcceptedResultSuggestion(input);
  } catch {
    return { reason: "producer_failed", suggestion: null, observationId: null };
  }
}
