import { createHash } from "node:crypto";
import type {
  OneImprovementAssetBinding,
  OneImprovementAssetControl,
  OneImprovementComparisonRecord,
  OneImprovementProofRecord,
  OneImprovementReusedAssetV1,
  OneImprovementResult,
  OneTrustedOutcomeEvidence,
  OneValueClosureRecord,
  OneValueClosureState,
} from "../../shared/types";
import type {
  OneTrustedImprovementEvidence,
  OneTrustedImprovementTaskEvidence,
} from "../../shared/one-improvement-proof";
import type { CanonicalTask, InvocationRunReceipt, RunEventUi, RuntimeBackend, RuntimeKind } from "../../shared/types";
import { getDb } from "../store/db";
import { getChat } from "../store/chats";
import { getInvocationRunReceipt, listRunEvents } from "../store/run-events";
import { getCanonicalTask, listCanonicalTasks } from "../store/tasks";
import { getOneMemoryState } from "./memory-candidates";
import { listOneDomainEvents } from "./domain-events";
import { getOneExperienceReuseState } from "./experience-reuse";
import {
  createOneImprovementProof,
  getLatestOneImprovementProof,
  getOneImprovementProofState,
} from "./improvement-proof";
import { getOneTeamPreflightForChat } from "./team-preflight";
import { getOneValueClosureState } from "./value-closure";

const MAX_RUN_EVENTS = 500;
const MAX_RECONCILE_TASKS = 100;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const TASK_KIND_REF_RE = /^task-kind:[a-f0-9]{64}$/;
const TASK_FORCE_MODEL_CALL_RECEIPT_SCHEMA = "agentlas.one-model-call-receipt.v1";
const TASK_FORCE_MODEL_CALL_REF_RE = /^one-model-call:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ACCEPTANCE_REASON = "explicit user acceptance of a matching completed run receipt";

export type OneImprovementProofProductionReason =
  | "created"
  | "existing"
  | "task_unavailable"
  | "result_not_explicitly_accepted"
  | "verified_result_unavailable"
  | "approved_reuse_unavailable"
  | "comparable_baseline_unavailable"
  | "producer_failed";

export interface OneImprovementProofProductionResult {
  reason: OneImprovementProofProductionReason;
  proof: OneImprovementProofRecord | null;
}

interface VerifiedTaskResult {
  task: CanonicalTask;
  run: InvocationRunReceipt & { finishedAt: string };
  events: RunEventUi[];
  closure: OneValueClosureRecord;
  output: OneTrustedOutcomeEvidence;
  outcome: OneTrustedOutcomeEvidence;
  signature: string;
  participantBindings: OneParticipantVersionBinding[];
  instructionTurns: number;
}

interface OneParticipantVersionBinding {
  agentId: string;
  agentSlug: string;
  versionRef: string;
  effectivePromptRef: string;
}

interface OneExecutionSignature {
  signature: string;
  participantBindings: OneParticipantVersionBinding[];
}

interface ReusedAssetDraft {
  baseline: VerifiedTaskResult;
  publicAsset: OneImprovementReusedAssetV1;
  binding: OneImprovementAssetBinding;
  evidence: Extract<OneTrustedImprovementEvidence, { kind: "asset_reuse" }>;
}

function stableRef(prefix: string, ...parts: string[]): string {
  const digest = createHash("sha256")
    .update(parts.map((part) => `${Buffer.byteLength(part, "utf8")}:${part}`).join("|"), "utf8")
    .digest("hex")
    .slice(0, 32);
  return `${prefix}:${digest}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeString(value: unknown, max = 240): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length >= 1 && normalized.length <= max && !/[\u0000-\u001f\u007f]/.test(normalized)
    ? normalized
    : null;
}

function participantBindingsFromStart(value: unknown): OneParticipantVersionBinding[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) return null;
  const bindings: OneParticipantVersionBinding[] = [];
  for (const item of value) {
    if (!isRecord(item) || Object.keys(item).sort().join(",") !== "agentId,agentSlug,effectivePromptRef,versionRef") return null;
    const agentId = safeString(item.agentId, 128);
    const agentSlug = safeString(item.agentSlug, 160);
    const versionRef = safeString(item.versionRef, 96);
    const effectivePromptRef = safeString(item.effectivePromptRef, 96);
    if (
      !agentId
      || !SAFE_ID_RE.test(agentId)
      || !agentSlug
      || !SAFE_ID_RE.test(agentSlug)
      || !versionRef
      || !/^participant-version:[a-f0-9]{64}$/.test(versionRef)
      || !effectivePromptRef
      || !/^effective-prompt:[a-f0-9]{64}$/.test(effectivePromptRef)
    ) return null;
    bindings.push({ agentId, agentSlug, versionRef, effectivePromptRef });
  }
  bindings.sort((left, right) => left.agentId.localeCompare(right.agentId));
  if (
    new Set(bindings.map((item) => item.agentId)).size !== bindings.length
    || new Set(bindings.map((item) => item.agentSlug)).size !== bindings.length
    || new Set(bindings.map((item) => item.versionRef)).size !== bindings.length
  ) return null;
  return bindings;
}

function sameTaskScope(left: CanonicalTask, right: CanonicalTask): boolean {
  return left.projectId === right.projectId && left.firmId === right.firmId;
}

function completedBeforeCurrentRun(baseline: VerifiedTaskResult, current: VerifiedTaskResult): boolean {
  return Date.parse(baseline.run.finishedAt) <= Date.parse(current.run.startedAt)
    && Date.parse(baseline.task.updatedAt) <= Date.parse(current.run.startedAt);
}

function memoryScopeMatchesCurrent(
  memory: ReturnType<typeof getOneMemoryState>["memories"][number],
  current: VerifiedTaskResult,
): boolean {
  if (memory.scope === "personal") return memory.scopeRef === null;
  if (!current.task.originChatId) return false;
  const chat = getChat(current.task.originChatId);
  if (!chat) return false;
  if (memory.scope === "project") return Boolean(current.task.projectId) && memory.scopeRef === current.task.projectId;
  if (memory.scope === "agent") return memory.scopeRef === chat.agentId;
  return Boolean(current.task.firmId) && memory.scopeRef === current.task.firmId;
}

function payload(event: RunEventUi | undefined): Record<string, unknown> {
  return event && isRecord(event.payload) ? event.payload : {};
}

type TaskForceModelCallPhase = "planner" | "worker" | "synthesis";
type TaskForceModelCallStatus = "started" | "completed" | "failed";

interface TaskForceModelCallReceiptEvent {
  event: RunEventUi;
  callRef: string;
  phase: TaskForceModelCallPhase;
  attempt: number | null;
  status: TaskForceModelCallStatus;
  agentId: string;
  nodeId: string;
  runtimeIdentity: string | null;
}

const TASK_FORCE_RUNTIME_KINDS = ["claude-code", "codex", "antigravity", "kimi", "grok", "cursor", "byok", "ollama", "lmstudio", "mlx", "acp", "agentlas"] as const satisfies readonly RuntimeKind[];
const TASK_FORCE_RUNTIME_BACKENDS = ["anthropic", "openai", "google", "ollama", "lmstudio", "mlx", "upstage", "custom", "glm", "kimi", "deepseek", "minimax", "xai", "openrouter", "cursor", "agentlas"] as const satisfies readonly RuntimeBackend[];

/** Optional diagnostics are not proof authority. Validate only the known wire
 * fields, and bind paired calls to the same runtime when that evidence exists. */
function taskForceRuntimeMetadata(item: Record<string, unknown>, status: TaskForceModelCallStatus): { identity: string | null } | null {
  const has = (key: string) => Object.prototype.hasOwnProperty.call(item, key);
  const runtimeKeys = ["runtimeKind", "runtimeBackend", "runtimeSource", "runtimeModel"];
  let identity: string | null = null;
  if (runtimeKeys.some(has)) {
    if (!(TASK_FORCE_RUNTIME_KINDS as readonly unknown[]).includes(item.runtimeKind)) return null;
    if (has("runtimeBackend") && !(TASK_FORCE_RUNTIME_BACKENDS as readonly unknown[]).includes(item.runtimeBackend)) return null;
    for (const key of ["runtimeSource", "runtimeModel"]) {
      if (has(key) && (safeString(item[key], 256) === null || safeString(item[key], 256) !== item[key])) return null;
    }
    identity = JSON.stringify(runtimeKeys.map((key) => item[key] ?? null));
  }
  if (has("durationMs") && (status === "started" || !Number.isSafeInteger(item.durationMs) || Number(item.durationMs) < 0)) return null;
  if (has("failureKind") || has("failureSource")) {
    if (status !== "failed"
      || typeof item.failureKind !== "string"
      || !["quota", "auth", "refused", "empty", "exit", "timeout", "unsupported"].includes(item.failureKind)
      || typeof item.failureSource !== "string"
      || !["marker", "exit", "heuristic"].includes(item.failureSource)) return null;
  }
  return { identity };
}

function taskForceModelCallReceiptEvent(event: RunEventUi): TaskForceModelCallReceiptEvent | null {
  const statusByKind: Partial<Record<RunEventUi["kind"], TaskForceModelCallStatus>> = {
    task_force_model_call_started: "started",
    task_force_model_call_completed: "completed",
    task_force_model_call_failed: "failed",
  };
  const status = statusByKind[event.kind];
  if (!status) return null;
  const item = payload(event);
  const hasAttempt = Object.prototype.hasOwnProperty.call(item, "attempt");
  const optionalKeys = ["runtimeKind", "runtimeBackend", "runtimeSource", "runtimeModel", "durationMs", "failureKind", "failureSource"];
  const expectedKeys = ["callRef", "phase", "schemaVersion", "status", ...(hasAttempt ? ["attempt"] : []),
    ...optionalKeys.filter((key) => Object.prototype.hasOwnProperty.call(item, key))].sort();
  if (Object.keys(item).sort().join("\u0000") !== expectedKeys.join("\u0000")) return null;
  const runtimeMetadata = taskForceRuntimeMetadata(item, status);
  if (!runtimeMetadata) return null;
  const schemaVersion = safeString(item.schemaVersion, 80);
  const callRef = safeString(item.callRef, 96);
  const phase = safeString(item.phase, 32);
  const payloadStatus = safeString(item.status, 32);
  const agentId = safeString(event.agentId, 128);
  const nodeId = safeString(event.nodeId, 240);
  const attempt = hasAttempt ? Number(item.attempt) : null;
  if (
    schemaVersion !== TASK_FORCE_MODEL_CALL_RECEIPT_SCHEMA
    || !callRef
    || !TASK_FORCE_MODEL_CALL_REF_RE.test(callRef)
    || (phase !== "planner" && phase !== "worker" && phase !== "synthesis")
    || payloadStatus !== status
    || !agentId
    || !SAFE_ID_RE.test(agentId)
    || !nodeId
    || (attempt !== null && (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > 16))
  ) return null;
  return { event, callRef, phase, attempt, status, agentId, nodeId, runtimeIdentity: runtimeMetadata.identity };
}

function sameTaskForceModelCall(left: TaskForceModelCallReceiptEvent, right: TaskForceModelCallReceiptEvent): boolean {
  return left.callRef === right.callRef
    && left.phase === right.phase
    && left.attempt === right.attempt
    && left.agentId === right.agentId
    && left.nodeId === right.nodeId
    && left.runtimeIdentity === right.runtimeIdentity;
}

/**
 * Confirmed local teams use only paired receipts emitted around the real model
 * promise. Renderer/status aliases are still useful to the UI, but can never
 * establish execution identity. Every durable MCP event is checked separately
 * so an extra installed id or `borrow:<slug>` spoof also fails closed.
 */
function confirmedTaskForceParticipants(
  events: RunEventUi[],
  ownerAgentId: string,
  boundParticipantIds: string[],
): string[] | null {
  if (
    boundParticipantIds.length < 2
    || !boundParticipantIds.includes(ownerAgentId)
    || new Set(boundParticipantIds).size !== boundParticipantIds.length
  ) return null;
  const receiptEvents = events.filter((event) => event.kind.startsWith("task_force_model_call_"));
  if (receiptEvents.length < 6) return null;
  const parsed = receiptEvents.map(taskForceModelCallReceiptEvent);
  if (parsed.some((item) => !item)) return null;
  const byCallRef = new Map<string, Partial<Record<TaskForceModelCallStatus, TaskForceModelCallReceiptEvent>>>();
  for (const item of parsed as TaskForceModelCallReceiptEvent[]) {
    const row = byCallRef.get(item.callRef) ?? {};
    if (row[item.status]) return null;
    row[item.status] = item;
    byCallRef.set(item.callRef, row);
  }
  const completed: TaskForceModelCallReceiptEvent[] = [];
  for (const row of byCallRef.values()) {
    if (row.failed || !row.started || !row.completed) return null;
    if (
      !sameTaskForceModelCall(row.started, row.completed)
      || row.started.event.seq >= row.completed.event.seq
    ) return null;
    completed.push(row.completed);
  }
  const bound = new Set(boundParticipantIds);
  if (completed.some((item) => !bound.has(item.agentId))) return null;
  const ownerPhases = new Set(completed
    .filter((item) => item.agentId === ownerAgentId)
    .map((item) => item.phase));
  if (!ownerPhases.has("planner") || !ownerPhases.has("synthesis")) return null;
  if (completed.some((item) =>
    item.agentId === ownerAgentId
      ? item.phase === "worker"
      : item.phase !== "worker")) return null;
  for (const participantId of boundParticipantIds) {
    if (participantId === ownerAgentId) continue;
    if (!completed.some((item) => item.agentId === participantId && item.phase === "worker")) return null;
  }
  const completedParticipants = [...new Set(completed.map((item) => item.agentId))].sort();
  const exactBoundParticipants = [...boundParticipantIds].sort();
  if (completedParticipants.join("\u0000") !== exactBoundParticipants.join("\u0000")) return null;

  const mcpEvents = events.filter((event) => event.kind.startsWith("mcp_"));
  if (mcpEvents.length === 0 || mcpEvents.some((event) => {
    const item = payload(event);
    return event.kind === "mcp_error"
      || item.toolIsError === true
      || item.nodeState === "failed"
      || !safeString(event.agentId, 128)
      || !bound.has(event.agentId!);
  })) return null;
  const mcpParticipants = [...new Set(mcpEvents.map((event) => event.agentId!))].sort();
  return mcpParticipants.join("\u0000") === exactBoundParticipants.join("\u0000")
    ? exactBoundParticipants
    : null;
}

function exactRun(task: CanonicalTask, runId: string): {
  run: InvocationRunReceipt & { finishedAt: string };
  events: RunEventUi[];
} | null {
  if (!task.originChatId || !SAFE_ID_RE.test(runId)) return null;
  const run = getInvocationRunReceipt(runId);
  if (
    !run
    || run.status !== "completed"
    || typeof run.finishedAt !== "string"
    || run.chatId !== task.originChatId
    || run.eventCount > MAX_RUN_EVENTS
  ) return null;
  const events = listRunEvents(run.runId, MAX_RUN_EVENTS);
  if (events.length !== run.eventCount || !events.some((event) => event.kind === "invoke_started")) return null;
  return { run: run as InvocationRunReceipt & { finishedAt: string }, events };
}

function eventEntries(event: ReturnType<typeof listOneDomainEvents>[number]): Map<string, unknown> {
  return new Map(event.payload.entries.map((entry) => [entry.name, entry.value]));
}

function hasExplicitResultAcceptance(task: CanonicalTask): boolean {
  return listOneDomainEvents(task.id, 500).some((event) => {
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
  });
}

function trustedForClosure(state: OneValueClosureState, closure: OneValueClosureRecord): OneTrustedOutcomeEvidence[] | null {
  const trusted = closure.trustedEvidenceRefs.map((ref) => state.evidence.find((item) => item.evidenceRef === ref));
  if (trusted.some((item) => !item)) return null;
  return trusted as OneTrustedOutcomeEvidence[];
}

function verifiedClosureEvidence(
  state: OneValueClosureState,
  task: CanonicalTask,
  runId: string,
): { closure: OneValueClosureRecord; output: OneTrustedOutcomeEvidence; outcome: OneTrustedOutcomeEvidence } | null {
  const candidates = state.closures
    .filter((record) =>
      record.closure.taskId === task.id
      && record.taskVersion === task.version
      && record.closure.outcomeStatus === "verified")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  for (const closure of candidates) {
    const verification = closure.closure.lifecycleClaims.find((claim) => claim.phase === "verification");
    if (verification?.status !== "completed") continue;
    const trusted = trustedForClosure(state, closure);
    if (!trusted) continue;
    const output = trusted.find((item) =>
      item.kind === "artifact_verification"
      && item.verificationStatus === "verified"
      && item.sourceRunRef === runId
      && verification.evidenceRefs.includes(item.evidenceRef)
      && ["host_connector", "artifact_verifier", "filesystem_guard"].includes(item.source));
    const outcome = trusted.find((item) =>
      item.kind === "outcome_verification"
      && item.verificationStatus === "verified"
      && item.sourceRunRef === runId
      && verification.evidenceRefs.includes(item.evidenceRef)
      && !["explicit_user_observation", "canonical_task_runtime", "invocation_runtime"].includes(item.source));
    if (output && outcome) return { closure, output, outcome };
  }
  return null;
}

function hasExactAcceptedSourceProvenance(
  state: OneValueClosureState,
  source: {
    sourceTaskId: string;
    sourceTaskVersion: number;
    sourceRunId: string;
    sourceValueClosureId: string;
    sourceValueClosureVersion: number;
  },
): boolean {
  const closure = state.closures.find((record) =>
    record.closure.valueClosureId === source.sourceValueClosureId
    && record.version === source.sourceValueClosureVersion
    && record.taskVersion === source.sourceTaskVersion
    && record.closure.taskId === source.sourceTaskId
    && record.closure.outcomeStatus === "partially_verified"
    && record.closure.outcomeRefs.length === 1
    && record.closure.outcomeRefs[0]?.startsWith("result:accepted-internal:"));
  if (!closure) return false;
  const trusted = trustedForClosure(state, closure);
  if (!trusted) return false;
  const acceptance = trusted.find((item) =>
    item.kind === "result_acceptance"
    && item.source === "canonical_task_runtime"
    && item.verificationStatus === "verified"
    && item.taskId === source.sourceTaskId
    && item.taskVersion === source.sourceTaskVersion
    && item.sourceRunRef === source.sourceRunId
    && item.outcomeRef === closure.closure.outcomeRefs[0]);
  const execution = trusted.find((item) =>
    item.kind === "execution_receipt"
    && item.source === "invocation_runtime"
    && item.verificationStatus === "verified"
    && item.taskId === source.sourceTaskId
    && item.taskVersion === source.sourceTaskVersion
    && item.sourceRunRef === source.sourceRunId);
  return Boolean(acceptance && execution);
}

function acceptedRunIdForTask(state: OneValueClosureState, task: CanonicalTask): string | null {
  const candidates = state.closures
    .filter((record) =>
      record.closure.taskId === task.id
      && record.taskVersion === task.version
      && record.closure.outcomeStatus === "partially_verified"
      && record.closure.outcomeRefs.length === 1
      && record.closure.outcomeRefs[0]?.startsWith("result:accepted-internal:"))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  for (const closure of candidates) {
    const trusted = trustedForClosure(state, closure);
    if (!trusted) continue;
    const acceptance = trusted.find((item) =>
      item.kind === "result_acceptance"
      && item.source === "canonical_task_runtime"
      && item.verificationStatus === "verified"
      && item.taskId === task.id
      && item.taskVersion === task.version
      && item.outcomeRef === closure.closure.outcomeRefs[0]);
    const execution = trusted.find((item) =>
      item.kind === "execution_receipt"
      && item.source === "invocation_runtime"
      && item.verificationStatus === "verified"
      && item.taskId === task.id
      && item.taskVersion === task.version);
    if (
      acceptance?.sourceRunRef
      && acceptance.sourceRunRef === execution?.sourceRunRef
      && SAFE_ID_RE.test(acceptance.sourceRunRef)
    ) return acceptance.sourceRunRef;
  }
  return null;
}

function teamSignature(task: CanonicalTask, runId: string): {
  assetId: string;
  sourceRef: string;
  signature: string;
  candidateSlugs: string[];
} | null {
  if (!task.originChatId) return null;
  const proposal = getOneTeamPreflightForChat(task.originChatId);
  if (
    !proposal
    || proposal.status !== "team_started"
    || proposal.startedRun?.mode !== "team"
    || proposal.startedRun.runId !== runId
    || proposal.binding.taskId !== task.id
    || proposal.roles.length < 2
  ) return null;
  const candidateSlugs = proposal.roles.map((role) => role.candidate.slug).sort();
  if (new Set(candidateSlugs).size !== candidateSlugs.length) return null;
  const signature = JSON.stringify({
    runtimeDigest: proposal.binding.runtimeDigest,
    roles: proposal.roles.map((role) => ({
      roleId: role.roleId,
      responsibility: role.responsibility,
      candidateRef: role.candidate.candidateRef,
      releaseState: role.candidate.releaseState,
      releaseRef: role.candidate.releaseRef,
      inputScopes: [...role.inputScopes].sort(),
      permissionScopes: [...role.permissionScopes].sort(),
    })).sort((left, right) => left.roleId.localeCompare(right.roleId)),
  });
  return {
    assetId: stableRef("team", signature),
    sourceRef: proposal.proposalId,
    signature,
    candidateSlugs,
  };
}

function executionSignature(task: CanonicalTask, run: InvocationRunReceipt, events: RunEventUi[]): OneExecutionSignature | null {
  const start = events.find((event) => event.kind === "invoke_started");
  const startPayload = payload(start);
  if (!start || startPayload.oneMode !== true) return null;
  const tools = events.flatMap((event) => {
    const item = payload(event);
    const toolName = safeString(item.toolName);
    return event.kind === "mcp_tool-use" && item.toolIsError === false && toolName ? [toolName] : [];
  });
  const models = [...new Set(events.flatMap((event) => {
    const model = safeString(payload(event).model);
    return model ? [model] : [];
  }))].sort();
  if (!task.originChatId) return null;
  const chat = getChat(task.originChatId);
  const taskKindRef = safeString(startPayload.oneTaskKindRef);
  const participantBindings = participantBindingsFromStart(startPayload.oneParticipantVersionBindings);
  const boundParticipantIds = participantBindings?.map((item) => item.agentId) ?? [];
  const participants = startPayload.oneTeamExecutionPolicy === "confirmed_existing_roster" && chat
    ? confirmedTaskForceParticipants(events, chat.agentId, boundParticipantIds)
    : [...new Set(events.flatMap((event) => {
        const agentId = safeString(event.agentId);
        return agentId ? [agentId] : [];
      }))].sort();
  if (
    !chat
    || !taskKindRef
    || !TASK_KIND_REF_RE.test(taskKindRef)
    || !participantBindings
    || !participants
    || participants.length === 0
    || participants.join("\u0000") !== boundParticipantIds.join("\u0000")
    || chat.projectId !== task.projectId
    || chat.firmId !== task.firmId
  ) return null;
  const team = teamSignature(task, run.runId);
  const signature = JSON.stringify({
    taskKindRef,
    projectId: task.projectId,
    firmId: task.firmId,
    ownerAgentId: chat.agentId,
    oneMode: true,
    planMode: startPayload.planMode === true,
    goalMode: startPayload.goalMode === true,
    appsGenerateMode: startPayload.appsGenerateMode === true,
    toolMode: safeString(startPayload.toolMode) ?? "unset",
    hubMode: safeString(startPayload.hubMode) ?? "unset",
    teamExecutionPolicy: safeString(startPayload.oneTeamExecutionPolicy) ?? "unset",
    hasImages: startPayload.hasImages === true,
    hasOneAttachments: startPayload.hasOneAttachments === true,
    attachmentCount: Number.isSafeInteger(startPayload.oneAttachmentCount)
      ? Number(startPayload.oneAttachmentCount)
      : 0,
    tools,
    models,
    participantRefs: participantBindings.map((item) => item.versionRef),
    participantEffectivePromptRefs: participantBindings.map((item) => item.effectivePromptRef),
    team: team?.assetId ?? null,
  });
  return {
    signature: stableRef("task-kind", taskKindRef, signature),
    participantBindings,
  };
}

function instructionTurns(chatId: string, runFinishedAt: string): number | null {
  const row = getDb().prepare(
    `SELECT COUNT(*) AS count
       FROM chat_messages
      WHERE chat_id = ? AND role = 'user' AND created_at <= ?`,
  ).get(chatId, runFinishedAt) as { count?: number } | undefined;
  const count = Number(row?.count ?? 0);
  return Number.isSafeInteger(count) && count >= 1 && count <= 10_000 ? count : null;
}

function verifiedTaskResult(
  task: CanonicalTask,
  valueState: OneValueClosureState,
  expectedRunId?: string,
): VerifiedTaskResult | null {
  if (task.status !== "completed" || !task.originChatId || !hasExplicitResultAcceptance(task)) return null;
  const boundRunId = expectedRunId ?? acceptedRunIdForTask(valueState, task);
  const run = boundRunId ? exactRun(task, boundRunId) : null;
  if (!run) return null;
  const verified = verifiedClosureEvidence(valueState, task, run.run.runId);
  const execution = executionSignature(task, run.run, run.events);
  const turns = instructionTurns(task.originChatId, run.run.finishedAt);
  if (!verified || !execution || turns === null) return null;
  return {
    task,
    run: run.run,
    events: run.events,
    closure: verified.closure,
    output: verified.output,
    outcome: verified.outcome,
    signature: execution.signature,
    participantBindings: execution.participantBindings,
    instructionTurns: turns,
  };
}

function outputEvidenceSource(source: OneTrustedOutcomeEvidence["source"]): OneTrustedImprovementTaskEvidence["source"] {
  return source === "host_connector" ? "host_connector" : "artifact_verifier";
}

function outcomeEvidenceSource(source: OneTrustedOutcomeEvidence["source"]): OneTrustedImprovementTaskEvidence["source"] {
  return source === "host_connector" ? "host_connector" : "outcome_verifier";
}

function proofTaskEvidence(result: VerifiedTaskResult, taskKind: string): {
  output: OneTrustedImprovementTaskEvidence;
  outcome: OneTrustedImprovementTaskEvidence;
} {
  const outputVerificationRef = stableRef("verification", result.task.id, String(result.task.version), result.output.evidenceRef, "output");
  const outcomeVerificationRef = stableRef("verification", result.task.id, String(result.task.version), result.outcome.evidenceRef, "outcome");
  return {
    output: {
      evidenceRef: stableRef("evidence", outputVerificationRef),
      receiptRef: stableRef("receipt", outputVerificationRef),
      kind: "output_verification",
      source: outputEvidenceSource(result.output.source),
      taskKind,
      observedAt: result.output.observedAt,
      sourceRef: result.output.evidenceRef,
      taskId: result.task.id,
      taskVersion: result.task.version,
      verificationRef: outputVerificationRef,
    },
    outcome: {
      evidenceRef: stableRef("evidence", outcomeVerificationRef),
      receiptRef: stableRef("receipt", outcomeVerificationRef),
      kind: "outcome_verification",
      source: outcomeEvidenceSource(result.outcome.source),
      taskKind,
      observedAt: result.outcome.observedAt,
      sourceRef: result.outcome.evidenceRef,
      taskId: result.task.id,
      taskVersion: result.task.version,
      verificationRef: outcomeVerificationRef,
    },
  };
}

function memoryAssetDrafts(
  current: VerifiedTaskResult,
  valueState: OneValueClosureState,
  taskKind: string,
): ReusedAssetDraft[] {
  const receipt = getOneExperienceReuseState().receipts
    .filter((record) =>
      record.receipt.taskId === current.task.id
      && record.receipt.taskVersion === current.task.version
      && record.receipt.runId === current.run.runId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  if (!receipt) return [];
  const memoryState = getOneMemoryState();
  const baselineCache = new Map<string, VerifiedTaskResult | null>();
  return receipt.receipt.assetBindings.flatMap((asset): ReusedAssetDraft[] => {
    const memory = memoryState.memories.find((item) =>
      item.id === asset.assetId
      && item.version === asset.assetVersion
      && item.provenanceStatus === "verified"
      && item.sourceTaskId === asset.sourceTaskId
      && item.sourceTaskVersion === asset.sourceTaskVersion
      && item.sourceRunId === asset.sourceRunId
      && item.sourceValueClosureId === asset.sourceValueClosureId
      && item.sourceValueClosureVersion === asset.sourceValueClosureVersion
      && item.enabled);
    if (!memory) return [];
    const baselineKey = [
      asset.sourceTaskId,
      String(asset.sourceTaskVersion),
      asset.sourceRunId,
      asset.sourceValueClosureId,
      String(asset.sourceValueClosureVersion),
    ].join("\u0000");
    let baseline = baselineCache.get(baselineKey);
    if (baseline === undefined) {
      const task = getCanonicalTask(asset.sourceTaskId);
      baseline = task?.version === asset.sourceTaskVersion
        ? verifiedTaskResult(task, valueState, asset.sourceRunId)
        : null;
      baselineCache.set(baselineKey, baseline);
    }
    if (
      !baseline
      || !hasExactAcceptedSourceProvenance(valueState, asset)
      || !sameTaskScope(baseline.task, current.task)
      || !completedBeforeCurrentRun(baseline, current)
      || !memoryScopeMatchesCurrent(memory, current)
      || Date.parse(memory.approvedAt) > Date.parse(current.run.startedAt)
      || baseline.signature !== current.signature
    ) return [];
    const controls: OneImprovementAssetControl[] = ["edit", "use_once", "disable", "delete"];
    const controlRefs = controls.map((control) => ({
      control,
      controlRef: stableRef("control", memory.id, String(memory.version), control),
    }));
    const evidenceRef = stableRef("evidence", receipt.receipt.reuseReceiptId, memory.id, String(memory.version));
    const evidence: ReusedAssetDraft["evidence"] = {
      evidenceRef,
      receiptRef: stableRef("receipt", receipt.receipt.reuseReceiptId, memory.id, String(memory.version)),
      kind: "asset_reuse",
      source: "memory_runtime",
      taskKind,
      observedAt: receipt.updatedAt,
      sourceRef: receipt.receipt.reuseReceiptId,
      taskId: current.task.id,
      taskVersion: current.task.version,
      sourceTaskId: baseline.task.id,
      sourceTaskVersion: baseline.task.version,
      assetId: memory.id,
      assetVersion: memory.version,
      assetKind: "memory",
      sourceControlRef: memory.sourceCandidateId,
      controlRefs,
      rollbackRef: memory.sourceCandidateId,
      removeRef: controlRefs.find((item) => item.control === "delete")!.controlRef,
    };
    return [{
      baseline,
      publicAsset: {
        assetRef: memory.id,
        assetType: "memory",
        label: "Approved Memory",
        sourceTaskRef: baseline.task.id,
        receiptRefs: [evidence.receiptRef],
        controls,
      },
      binding: {
        assetId: memory.id,
        assetVersion: memory.version,
        assetKind: "memory",
        sourceTaskId: baseline.task.id,
        sourceTaskVersion: baseline.task.version,
        currentTaskId: current.task.id,
        currentTaskVersion: current.task.version,
        taskKind,
        reuseEvidenceRef: evidence.evidenceRef,
        reuseReceiptRef: evidence.receiptRef,
        sourceControlRef: evidence.sourceControlRef,
        controlRefs,
        rollbackRef: evidence.rollbackRef,
        removeRef: evidence.removeRef,
      },
      evidence,
    }];
  });
}

function comparisonResult(baseline: number, current: number): OneImprovementResult {
  if (current === baseline) return "no_change";
  return current < baseline ? "improved" : "regression";
}

function buildProofInput(
  current: VerifiedTaskResult,
  assets: ReusedAssetDraft[],
  expectedStoreVersion: number,
) {
  const taskKind = current.signature;
  const byBaseline = new Map<string, { baseline: VerifiedTaskResult; assets: ReusedAssetDraft[] }>();
  for (const asset of assets) {
    const key = `${asset.baseline.task.id}:${asset.baseline.task.version}`;
    const group = byBaseline.get(key) ?? { baseline: asset.baseline, assets: [] };
    group.assets.push(asset);
    byBaseline.set(key, group);
  }
  const taskEvidence = new Map<string, ReturnType<typeof proofTaskEvidence>>();
  taskEvidence.set(`${current.task.id}:${current.task.version}`, proofTaskEvidence(current, taskKind));
  for (const group of byBaseline.values()) {
    taskEvidence.set(
      `${group.baseline.task.id}:${group.baseline.task.version}`,
      proofTaskEvidence(group.baseline, taskKind),
    );
  }
  const trusted: OneTrustedImprovementEvidence[] = [
    ...[...taskEvidence.values()].flatMap((item) => [item.output, item.outcome]),
    ...assets.map((asset) => asset.evidence),
  ];
  const changes = [] as Array<{
    changeRef: string;
    kind: "instruction_reduction";
    evidenceType: "measured";
    statement: string;
    baseline: number;
    current: number;
    unit: string;
    comparisonDirection: "lower_is_better";
    evidenceRefs: string[];
  }>;
  const comparisons: OneImprovementComparisonRecord[] = [];
  for (const group of byBaseline.values()) {
    const baseline = group.baseline;
    const comparisonRef = stableRef("comparison", baseline.task.id, String(baseline.task.version), current.task.id, String(current.task.version));
    const changeRef = stableRef("change", comparisonRef, "instruction-turns");
    const basis = "Both verified Tasks share the same product-owned salted Task-kind receipt, project/team scope, installed-agent execution signature, One runtime policy, and acceptance boundary.";
    const method = "Count durable user turns in the Task conversation through the exact accepted run; later turns and unaccepted runs are excluded.";
    const baselineMeasurement = {
      evidenceRef: stableRef("evidence", comparisonRef, "measurement", "baseline"),
      receiptRef: stableRef("receipt", comparisonRef, "measurement", "baseline"),
      kind: "measurement" as const,
      source: "measurement_engine" as const,
      taskKind,
      observedAt: baseline.run.finishedAt,
      sourceRef: baseline.run.runId,
      baselineTaskId: baseline.task.id,
      baselineTaskVersion: baseline.task.version,
      currentTaskId: current.task.id,
      currentTaskVersion: current.task.version,
      comparisonRef,
      role: "baseline" as const,
      valueType: "fact" as const,
      value: baseline.instructionTurns,
      unit: "user instruction turns",
      method,
      sampleSize: 1,
      comparable: true,
      comparabilityBasis: basis,
      comparisonDirection: "lower_is_better" as const,
    };
    const currentMeasurement = {
      ...baselineMeasurement,
      evidenceRef: stableRef("evidence", comparisonRef, "measurement", "current"),
      receiptRef: stableRef("receipt", comparisonRef, "measurement", "current"),
      observedAt: current.run.finishedAt,
      sourceRef: current.run.runId,
      role: "current" as const,
      value: current.instructionTurns,
    };
    const result = comparisonResult(baseline.instructionTurns, current.instructionTurns);
    const statement = result === "improved"
      ? "Recorded user turns through the verified accepted run decreased on the same conservative Task fingerprint. This is an observed association, not a causal attribution."
      : result === "no_change"
        ? "Recorded user turns through the verified accepted run were unchanged on the same conservative Task fingerprint."
        : "Recorded user turns through the verified accepted run increased on the same conservative Task fingerprint; the regression remains visible.";
    const baselineEvidence = taskEvidence.get(`${baseline.task.id}:${baseline.task.version}`)!;
    const currentEvidence = taskEvidence.get(`${current.task.id}:${current.task.version}`)!;
    const reusedAssetVersions = group.assets.map((asset) => ({
      assetId: asset.binding.assetId,
      assetVersion: asset.binding.assetVersion,
    }));
    const comparisonEvidence = {
      evidenceRef: stableRef("evidence", comparisonRef, "verification"),
      receiptRef: stableRef("receipt", comparisonRef, "verification"),
      kind: "comparison_verification" as const,
      source: "comparison_verifier" as const,
      taskKind,
      observedAt: current.closure.closure.generatedAt,
      sourceRef: stableRef("source", baseline.closure.closure.valueClosureId, current.closure.closure.valueClosureId),
      baselineTaskId: baseline.task.id,
      baselineTaskVersion: baseline.task.version,
      currentTaskId: current.task.id,
      currentTaskVersion: current.task.version,
      comparisonRef,
      evidenceType: "measured" as const,
      result,
      baselineOutputVerificationRef: baselineEvidence.output.verificationRef,
      baselineOutcomeVerificationRef: baselineEvidence.outcome.verificationRef,
      currentOutputVerificationRef: currentEvidence.output.verificationRef,
      currentOutcomeVerificationRef: currentEvidence.outcome.verificationRef,
      reusedAssetVersions,
    };
    const evidenceRefs = [baselineMeasurement.evidenceRef, currentMeasurement.evidenceRef, comparisonEvidence.evidenceRef];
    trusted.push(baselineMeasurement, currentMeasurement, comparisonEvidence);
    changes.push({
      changeRef,
      kind: "instruction_reduction",
      evidenceType: "measured",
      statement,
      baseline: baseline.instructionTurns,
      current: current.instructionTurns,
      unit: "user instruction turns",
      comparisonDirection: "lower_is_better",
      evidenceRefs,
    });
    comparisons.push({
      comparisonRef,
      changeRef,
      taskKind,
      baselineTaskId: baseline.task.id,
      baselineTaskVersion: baseline.task.version,
      currentTaskId: current.task.id,
      currentTaskVersion: current.task.version,
      evidenceType: "measured",
      result,
      baselineOutputVerificationRef: baselineEvidence.output.verificationRef,
      baselineOutcomeVerificationRef: baselineEvidence.outcome.verificationRef,
      currentOutputVerificationRef: currentEvidence.output.verificationRef,
      currentOutcomeVerificationRef: currentEvidence.outcome.verificationRef,
      reusedAssetVersions,
      comparisonEvidenceRef: comparisonEvidence.evidenceRef,
      measurementEvidenceRefs: [baselineMeasurement.evidenceRef, currentMeasurement.evidenceRef],
      evidenceRefs,
      receiptRefs: [baselineMeasurement.receiptRef, currentMeasurement.receiptRef, comparisonEvidence.receiptRef],
    });
  }
  return {
    expectedStoreVersion,
    trustedHostAttested: true as const,
    attributionStatus: "not_established" as const,
    currentTaskId: current.task.id,
    currentTaskVersion: current.task.version,
    taskKind,
    reusedAssets: assets.map((asset) => asset.publicAsset),
    changes,
    assetBindings: assets.map((asset) => asset.binding),
    comparisons,
    receiptRefs: trusted.map((item) => item.receiptRef),
    trustedHostEvidence: trusted,
  };
}

/**
 * Main-only production composer. It never reads prompt bodies or output text,
 * and it refuses to turn result acceptance alone into an improvement claim.
 */
export function produceOneImprovementProofForTask(taskId: string): OneImprovementProofProductionResult {
  if (!SAFE_ID_RE.test(taskId)) return { reason: "task_unavailable", proof: null };
  const task = getCanonicalTask(taskId);
  if (!task || task.status !== "completed" || !task.originChatId) return { reason: "task_unavailable", proof: null };
  const existing = getLatestOneImprovementProof(taskId);
  if (existing?.currentTaskVersion === task.version) return { reason: "existing", proof: existing };
  if (!hasExplicitResultAcceptance(task)) return { reason: "result_not_explicitly_accepted", proof: null };
  const valueState = getOneValueClosureState();
  const current = verifiedTaskResult(task, valueState);
  if (!current) return { reason: "verified_result_unavailable", proof: null };
  const taskKind = current.signature;
  const memoryAssets = memoryAssetDrafts(current, valueState, taskKind);
  const assets = memoryAssets
    .filter((asset, index, all) => all.findIndex((candidate) => candidate.binding.assetId === asset.binding.assetId) === index)
    .slice(0, 16);
  if (assets.length === 0) {
    const hasApprovedReuse = getOneExperienceReuseState().receipts.some((record) =>
      record.receipt.taskId === task.id && record.receipt.taskVersion === task.version && record.receipt.runId === current.run.runId)
      || Boolean(teamSignature(task, current.run.runId));
    return { reason: hasApprovedReuse ? "comparable_baseline_unavailable" : "approved_reuse_unavailable", proof: null };
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const refreshedTask = getCanonicalTask(task.id);
    if (
      !refreshedTask
      || refreshedTask.version !== task.version
      || refreshedTask.updatedAt !== task.updatedAt
      || refreshedTask.status !== "completed"
    ) return { reason: "task_unavailable", proof: null };
    const refreshedValueState = getOneValueClosureState();
    const refreshedCurrent = verifiedTaskResult(refreshedTask, refreshedValueState);
    if (!refreshedCurrent || refreshedCurrent.signature !== current.signature) {
      return { reason: "verified_result_unavailable", proof: null };
    }
    const refreshedMemoryAssets = memoryAssetDrafts(refreshedCurrent, refreshedValueState, refreshedCurrent.signature);
    const refreshedAssets = refreshedMemoryAssets
      .filter((asset, index, all) => all.findIndex((candidate) =>
        candidate.binding.assetId === asset.binding.assetId
        && candidate.binding.assetVersion === asset.binding.assetVersion) === index)
      .slice(0, 16);
    if (refreshedAssets.length === 0) {
      return { reason: "comparable_baseline_unavailable", proof: null };
    }
    const proofState = getOneImprovementProofState();
    const converged = proofState.proofs.find((record) =>
      record.proof.taskId === task.id && record.currentTaskVersion === task.version);
    if (converged) return { reason: "existing", proof: converged };
    try {
      const created = createOneImprovementProof(buildProofInput(refreshedCurrent, refreshedAssets, proofState.version));
      return { reason: "created", proof: created.value };
    } catch (error) {
      if (attempt === 3 || !/changed|concurrently|locked|busy/i.test(error instanceof Error ? error.message : String(error))) {
        throw error;
      }
    }
  }
  return { reason: "producer_failed", proof: null };
}

export function tryProduceOneImprovementProofForTask(taskId: string): OneImprovementProofProductionResult {
  try {
    return produceOneImprovementProofForTask(taskId);
  } catch {
    return { reason: "producer_failed", proof: null };
  }
}

/** Eventual Main reconciliation used by Desktop reads and Mobile projection. */
let lastReconcileSweepAt = 0;
export function reconcileOneImprovementProofs(limit = MAX_RECONCILE_TASKS): number {
  // 읽기 폴링(5초 틱)이 이 보정을 그대로 끌고 오면 태스크 수만큼의 조회가 틱마다
  // 반복된다. eventual 보정이므로 10초에 한 번이면 같은 결과에 수렴한다.
  const now = Date.now();
  if (now - lastReconcileSweepAt < 10_000) return 0;
  lastReconcileSweepAt = now;
  const bounded = Math.max(1, Math.min(MAX_RECONCILE_TASKS, Math.floor(limit)));
  let created = 0;
  for (const task of listCanonicalTasks({ limit: bounded, includeArchived: false })) {
    const latest = getLatestOneImprovementProof(task.id);
    if (task.status !== "completed" || latest?.currentTaskVersion === task.version) continue;
    if (tryProduceOneImprovementProofForTask(task.id).reason === "created") created += 1;
  }
  return created;
}
