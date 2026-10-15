import { randomUUID } from "node:crypto";
import {
  ONE_MEMORY_CONTRACT_VERSION,
  isOneMemoryUseOnceRef,
  isOneMemoryState,
  unsafeOneMemoryTextReason,
  type DeleteOneMemoryAssetInput,
  type DeleteOneMemoryCandidateInput,
  type EditAndSaveOneMemoryCandidateInput,
  type OneMemoryAsset,
  type OneMemoryCandidate,
  type OneMemoryCandidateSource,
  type OneMemoryMutationResult,
  type OneMemoryInvocationScope,
  type OneMemorySavedResult,
  type OneMemoryScope,
  type OneMemoryState,
  type OneMemorySuppression,
  type OneMemoryUseOnceRef,
  type OneMemoryUseOnceReceipt,
  type OneMemoryUseOnceTarget,
  type ProposeOneMemoryCandidateInput,
  type RejectOneMemoryCandidateInput,
  type SaveOneMemoryCandidateInput,
  type SetOneMemoryAssetEnabledInput,
  type UpdateOneMemoryAssetInput,
  type UseOneMemoryCandidateOnceInput,
} from "../../shared/one-memory";
import { readLegacyOneState, replaceLegacyOneState, isLegacyOneAssetActive, buildLegacyOneAutomaticContext, legacyOneMemoryText } from "../memory/one-legacy";
import { getChat } from "../store/chats";
import { getInvocationRunReceipt } from "../store/run-events";
import { findCanonicalTaskForChat, getCanonicalTask } from "../store/tasks";
import {
  tryRecordOneDomainEvent,
  type RecordOneDomainEventInput,
} from "./domain-events";
import { getOneValueClosureState } from "./value-closure";
import { recordAutomaticMemoryTurn } from "../memory/automatic-curator";
import { assertMemoryTicketSource } from "../memory/source-custody";
import { getMemoryDb } from "../memory/database";

export const ONE_MEMORY_META_KEY = "agentlas.one.memory.v1";

function retiredApproval(): never { throw Object.assign(new Error("one_memory_approval_retired"), { code: "one_memory_approval_retired" }); }

const SCOPES = new Set<OneMemoryScope>(["personal", "project", "agent", "team"]);
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const CANDIDATE_ID_RE = /^memory_candidate_[a-f0-9]{32}$/;
const MEMORY_ID_RE = /^memory_[a-f0-9]{32}$/;
const VALUE_CLOSURE_ID_RE = /^value_closure_[a-f0-9]{32}$/;
const UNSAFE_CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const DEFAULT_REVIEW_MS = 90 * 24 * 60 * 60 * 1_000;
const MIN_REVIEW_MS = 24 * 60 * 60 * 1_000;
const MAX_REVIEW_MS = 730 * 24 * 60 * 60 * 1_000;
const DEFAULT_REJECT_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1_000;
const MIN_REJECT_COOLDOWN_MS = 60 * 60 * 1_000;
const MAX_REJECT_COOLDOWN_MS = 365 * 24 * 60 * 60 * 1_000;
const USE_ONCE_RECEIPT_MS = 60 * 60 * 1_000;
const USE_ONCE_MIN_CLAIM_WINDOW_MS = 5_000;

interface OneMemoryUseOnceBinding {
  chatId: string;
  taskId: string | null;
  taskVersion: number | null;
  projectId: string | null;
  agentId: string;
  teamId: string | null;
}

interface EphemeralOneMemoryUseOnceGrant {
  receiptId: string;
  claimToken: string;
  candidateId: string;
  candidateVersion: number;
  sourceTaskId: string;
  content: string;
  scope: OneMemoryScope;
  scopeRef: string | null;
  binding: OneMemoryUseOnceBinding;
  issuedAt: string;
  expiresAt: string;
  evictionTimer: ReturnType<typeof setTimeout> | null;
}

/** Main-only prepared claim. No renderer or durable store receives this object. */
export interface PreparedOneMemoryUseOnceClaim {
  receiptId: string;
  claimToken: string;
  candidateId: string;
  candidateVersion: number;
  sourceTaskId: string;
  scope: OneMemoryScope;
  scopeRef: string | null;
  binding: OneMemoryUseOnceBinding;
  context: string;
  issuedAt: string;
  expiresAt: string;
}

export interface ClaimedOneMemoryUseOnceReceipt {
  receiptId: string;
  candidateId: string;
  candidateVersion: number;
  sourceTaskId: string;
  scope: OneMemoryScope;
  scopeRef: string | null;
  binding: OneMemoryUseOnceBinding;
  issuedAt: string;
  expiresAt: string;
  claimedAt: string;
}

// Deliberately process-local: restart destroys every unclaimed one-time grant.
const oneMemoryUseOnceGrants = new Map<string, EphemeralOneMemoryUseOnceGrant>();

interface StateMutation<T> {
  state: OneMemoryState;
  value: T;
  events?: RecordOneDomainEventInput[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const safe = new Set(allowed);
  if (Object.keys(value).some((key) => !safe.has(key))) throw new TypeError(`${label} contains unsupported fields`);
}

function hasExactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const safe = new Set(allowed);
  const actual = Object.keys(value);
  return actual.length === allowed.length && actual.every((key) => safe.has(key));
}

function assertVersion(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new TypeError(`${label} must be a positive safe integer`);
}

function assertSafeId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SAFE_ID_RE.test(value)) throw new TypeError(`${label} must be an opaque safe id`);
}

function cleanMemoryText(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be text`);
  if (UNSAFE_CONTROL_RE.test(value)) throw new TypeError(`${label} contains unsupported control characters`);
  const unsafeReason = unsafeOneMemoryTextReason(value);
  if (unsafeReason) throw new TypeError(`${label} rejected unsafe ${unsafeReason}`);
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length < 1 || normalized.length > 500) throw new RangeError(`${label} must contain 1-500 normalized characters`);
  return normalized;
}

function normalizeScope(
  scopeValue: unknown,
  scopeRefValue: unknown,
): { scope: OneMemoryScope; scopeRef: string | null } {
  if (typeof scopeValue !== "string" || !SCOPES.has(scopeValue as OneMemoryScope)) {
    throw new TypeError("Invalid One Memory scope");
  }
  const scope = scopeValue as OneMemoryScope;
  if (scope === "personal") {
    if (scopeRefValue != null && scopeRefValue !== "") throw new TypeError("A personal Memory cannot have scopeRef");
    return { scope, scopeRef: null };
  }
  assertSafeId(scopeRefValue, `${scope} scopeRef`);
  return { scope, scopeRef: scopeRefValue };
}

function normalizeSource(value: unknown, allowLegacy = false): OneMemoryCandidateSource {
  if (!isRecord(value)) throw new TypeError("Memory candidate source must be an object");
  assertOnlyKeys(value, [
    "provenanceStatus", "sourceTaskId", "sourceTaskVersion", "sourceRunId",
    "sourceValueClosureId", "sourceValueClosureVersion", "sourceRef", "evidenceRefs", "basis",
  ], "Memory candidate source");
  assertSafeId(value.sourceTaskId, "source.sourceTaskId");
  assertSafeId(value.sourceRef, "source.sourceRef");
  if (
    !Array.isArray(value.evidenceRefs) || value.evidenceRefs.length < 1 || value.evidenceRefs.length > 32 ||
    value.evidenceRefs.some((item) => typeof item !== "string" || !SAFE_ID_RE.test(item)) ||
    new Set(value.evidenceRefs).size !== value.evidenceRefs.length
  ) throw new TypeError("source.evidenceRefs must contain 1-32 unique opaque ids");
  if (typeof value.basis !== "string" || !new Set(["inferred", "explicit_user_statement", "user_correction"]).has(value.basis)) {
    throw new TypeError("Invalid Memory candidate proposal basis");
  }
  if (value.provenanceStatus === "verified") {
    assertVersion(value.sourceTaskVersion, "source.sourceTaskVersion");
    assertSafeId(value.sourceRunId, "source.sourceRunId");
    if (typeof value.sourceValueClosureId !== "string" || !VALUE_CLOSURE_ID_RE.test(value.sourceValueClosureId)) {
      throw new TypeError("source.sourceValueClosureId must be an exact Value Closure id");
    }
    assertVersion(value.sourceValueClosureVersion, "source.sourceValueClosureVersion");
  } else if (
    value.provenanceStatus !== "legacy_unversioned"
    || value.sourceTaskVersion !== null
    || value.sourceRunId !== null
    || value.sourceValueClosureId !== null
    || value.sourceValueClosureVersion !== null
  ) {
    throw new TypeError("Memory candidate source provenance is malformed");
  } else if (!allowLegacy) {
    throw new Error("Unversioned Memory provenance cannot create a new candidate");
  }
  const source: OneMemoryCandidateSource = {
    provenanceStatus: value.provenanceStatus,
    sourceTaskId: value.sourceTaskId,
    sourceTaskVersion: value.sourceTaskVersion,
    sourceRunId: value.sourceRunId,
    sourceValueClosureId: value.sourceValueClosureId,
    sourceValueClosureVersion: value.sourceValueClosureVersion,
    sourceRef: value.sourceRef,
    evidenceRefs: [...value.evidenceRefs] as string[],
    basis: value.basis as OneMemoryCandidateSource["basis"],
  };
  if (source.provenanceStatus === "verified") assertVerifiedSourceProvenance(source);
  return source;
}

function assertVerifiedSourceProvenance(source: OneMemoryCandidateSource): void {
  if (
    source.provenanceStatus !== "verified"
    || source.sourceTaskVersion === null
    || source.sourceRunId === null
    || source.sourceValueClosureId === null
    || source.sourceValueClosureVersion === null
  ) throw new Error("Memory source provenance is not verified");
  const task = getCanonicalTask(source.sourceTaskId);
  if (
    !task
    || task.status !== "completed"
    || task.version !== source.sourceTaskVersion
    || !task.originChatId
  ) throw new Error("Memory source canonical Task no longer matches its exact version");
  const run = getInvocationRunReceipt(source.sourceRunId);
  if (!run || run.status !== "completed" || run.chatId !== task.originChatId) {
    throw new Error("Memory source run is not the exact completed Task run");
  }
  const closureState = getOneValueClosureState();
  const closure = closureState.closures.find((item) =>
    item.closure.valueClosureId === source.sourceValueClosureId
    && item.version === source.sourceValueClosureVersion,
  );
  if (
    !closure
    || closure.taskVersion !== task.version
    || closure.closure.taskId !== task.id
    || closure.closure.outcomeStatus !== "partially_verified"
    || closure.closure.outcomeRefs.length !== 1
    || !closure.closure.outcomeRefs[0]?.startsWith("result:accepted-internal:")
  ) throw new Error("Memory source Value Closure no longer matches its exact Task version");
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
  if (!acceptance || !execution) {
    throw new Error("Memory source Value Closure lacks exact acceptance and execution evidence");
  }
}

function normalizeUseOnceTarget(value: unknown): OneMemoryUseOnceBinding {
  if (!isRecord(value)) throw new TypeError("Memory use-once target must be an object");
  assertOnlyKeys(value, ["chatId", "expectedTaskId", "expectedTaskVersion"], "Memory use-once target");
  assertSafeId(value.chatId, "target.chatId");
  const expectedTaskId = value.expectedTaskId;
  const expectedTaskVersion = value.expectedTaskVersion;
  if (expectedTaskId === null) {
    if (expectedTaskVersion !== null) {
      throw new TypeError("A Task-free use-once target cannot include expectedTaskVersion");
    }
  } else {
    assertSafeId(expectedTaskId, "target.expectedTaskId");
    assertVersion(expectedTaskVersion, "target.expectedTaskVersion");
  }

  const chat = getChat(value.chatId);
  if (!chat || chat.kind !== "user" || chat.archivedAt) {
    throw new Error("Memory use-once target chat is unavailable");
  }
  const task = findCanonicalTaskForChat(chat.id);
  if (expectedTaskId === null) {
    if (task) throw new Error("Memory use-once target changed from conversation to Task");
  } else if (!task || task.id !== expectedTaskId || task.version !== expectedTaskVersion) {
    throw new Error("Memory use-once target Task changed; reload and try again");
  }
  return {
    chatId: chat.id,
    taskId: task?.id ?? null,
    taskVersion: task?.version ?? null,
    projectId: chat.projectId,
    agentId: chat.agentId,
    teamId: chat.firmId,
  };
}

function sameUseOnceBinding(left: OneMemoryUseOnceBinding, right: OneMemoryUseOnceBinding): boolean {
  return left.chatId === right.chatId
    && left.taskId === right.taskId
    && left.taskVersion === right.taskVersion
    && left.projectId === right.projectId
    && left.agentId === right.agentId
    && left.teamId === right.teamId;
}

function memoryScopeMatchesBinding(
  scope: OneMemoryScope,
  scopeRef: string | null,
  binding: OneMemoryUseOnceBinding,
): boolean {
  if (scope === "personal") return scopeRef === null;
  if (scope === "project") return Boolean(binding.projectId) && scopeRef === binding.projectId;
  if (scope === "agent") return scopeRef === binding.agentId;
  return Boolean(binding.teamId) && scopeRef === binding.teamId;
}

function assertMemoryScopeMatchesBinding(
  scope: OneMemoryScope,
  scopeRef: string | null,
  binding: OneMemoryUseOnceBinding,
): void {
  if (!memoryScopeMatchesBinding(scope, scopeRef, binding)) {
    throw new Error("Memory use-once scope does not match the target conversation");
  }
}

function cleanupExpiredUseOnceGrants(nowMs = Date.now()): void {
  for (const [receiptId, grant] of oneMemoryUseOnceGrants) {
    if (Date.parse(grant.expiresAt) <= nowMs) deleteUseOnceGrant(receiptId, grant.claimToken);
  }
}

function deleteUseOnceGrant(receiptId: string, expectedClaimToken?: string): boolean {
  const current = oneMemoryUseOnceGrants.get(receiptId);
  if (!current || (expectedClaimToken && current.claimToken !== expectedClaimToken)) return false;
  if (current.evictionTimer) clearTimeout(current.evictionTimer);
  return oneMemoryUseOnceGrants.delete(receiptId);
}

function scheduleUseOnceGrantEviction(grant: EphemeralOneMemoryUseOnceGrant): void {
  if (grant.evictionTimer) clearTimeout(grant.evictionTimer);
  const remaining = Math.min(
    USE_ONCE_RECEIPT_MS,
    2_147_483_647,
    Math.max(0, Date.parse(grant.expiresAt) - Date.now()),
  );
  const timer = setTimeout(() => {
    const current = oneMemoryUseOnceGrants.get(grant.receiptId);
    if (
      !current
      || current.claimToken !== grant.claimToken
      || current.expiresAt !== grant.expiresAt
    ) return;
    if (Date.parse(current.expiresAt) > Date.now()) {
      // Defend against an early timer or wall-clock adjustment without ever
      // leaving an expired original resident until another user action.
      scheduleUseOnceGrantEviction(current);
      return;
    }
    deleteUseOnceGrant(current.receiptId, current.claimToken);
  }, remaining);
  timer.unref?.();
  grant.evictionTimer = timer;
}

function exactUseOnceGrant(
  ref: OneMemoryUseOnceRef,
  chatId: string,
  nowMs: number,
): EphemeralOneMemoryUseOnceGrant {
  if (!isOneMemoryUseOnceRef(ref)) throw new TypeError("Invalid Memory use-once receipt reference");
  assertSafeId(chatId, "invocation chatId");
  cleanupExpiredUseOnceGrants(nowMs);
  const grant = oneMemoryUseOnceGrants.get(ref.receiptId);
  if (!grant) throw new Error("Memory use-once receipt is unavailable, expired, restarted, or already used");
  if (grant.binding.chatId !== chatId) throw new Error("Memory use-once receipt belongs to a different conversation");
  if (Date.parse(grant.expiresAt) - nowMs < USE_ONCE_MIN_CLAIM_WINDOW_MS) {
    deleteUseOnceGrant(grant.receiptId, grant.claimToken);
    throw new Error("Memory use-once receipt expired before invocation start");
  }

  const currentBinding = normalizeUseOnceTarget({
    chatId: grant.binding.chatId,
    expectedTaskId: grant.binding.taskId,
    expectedTaskVersion: grant.binding.taskVersion,
  } satisfies OneMemoryUseOnceTarget);
  if (!sameUseOnceBinding(currentBinding, grant.binding)) {
    throw new Error("Memory use-once conversation binding changed; reload and try again");
  }
  const state = getOneMemoryState();
  const candidate = state.candidates.find((item) => item.id === grant.candidateId);
  if (
    !candidate
    || candidate.version !== grant.candidateVersion
    || candidate.status !== "used_once"
    || candidate.scope !== grant.scope
    || candidate.scopeRef !== grant.scopeRef
  ) {
    throw new Error("Memory use-once candidate changed or was removed");
  }
  assertMemoryScopeMatchesBinding(grant.scope, grant.scopeRef, currentBinding);
  return grant;
}

function oneMemoryUseOnceContext(grant: EphemeralOneMemoryUseOnceGrant): string {
  return [
    "[One-time Memory — confirmed, this invocation only; not durable]",
    `- [${grant.scope}${grant.scopeRef ? `:${grant.scopeRef}` : ""}] ${grant.content}`,
  ].join("\n");
}

function opaqueId(prefix: "memory_candidate" | "memory" | "memory_suppression" | "memory_once_receipt"): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function nextTimestamp(previousVersion: number): { version: number; iso: string } {
  const version = Math.max(Date.now(), previousVersion + 1);
  return { version, iso: new Date(version).toISOString() };
}

function initialState(): OneMemoryState {
  const version = Math.max(1, Date.now());
  const now = new Date(version).toISOString();
  return {
    contractVersion: ONE_MEMORY_CONTRACT_VERSION,
    version,
    candidates: [],
    memories: [],
    suppressions: [],
    createdAt: now,
    updatedAt: now,
  };
}

function normalizeLegacyStoredState(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.candidates) || !Array.isArray(value.memories)) return value;
  let changed = false;
  const candidates = value.candidates.map((candidate) => {
    if (!isRecord(candidate) || !isRecord(candidate.source)) return candidate;
    const source = candidate.source;
    if (!hasExactKeys(source, ["taskId", "sourceRef", "evidenceRefs", "basis"])) return candidate;
    changed = true;
    return {
      ...candidate,
      source: {
        provenanceStatus: "legacy_unversioned",
        sourceTaskId: source.taskId,
        sourceTaskVersion: null,
        sourceRunId: null,
        sourceValueClosureId: null,
        sourceValueClosureVersion: null,
        sourceRef: source.sourceRef,
        evidenceRefs: source.evidenceRefs,
        basis: source.basis,
      },
    };
  });
  const legacyMemoryKeys = [
    "id", "version", "content", "scope", "scopeRef", "sourceCandidateId", "sourceTaskId", "sourceRef",
    "evidenceRefs", "approvalSource", "approvedAt", "enabled", "createdAt", "updatedAt", "disabledAt",
  ];
  const memories = value.memories.map((memory) => {
    if (!isRecord(memory) || !hasExactKeys(memory, legacyMemoryKeys)) return memory;
    changed = true;
    return {
      ...memory,
      provenanceStatus: "legacy_unversioned",
      sourceTaskVersion: null,
      sourceRunId: null,
      sourceValueClosureId: null,
      sourceValueClosureVersion: null,
    };
  });
  return changed ? { ...value, candidates, memories } : value;
}

function parseState(raw: string): OneMemoryState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Stored One Memory state is corrupt; it was not overwritten");
  }
  const normalized = normalizeLegacyStoredState(parsed);
  if (!isOneMemoryState(normalized)) {
    throw new Error("Stored One Memory state violates its closed contract; it was not overwritten");
  }
  return normalized;
}

function readOrCreateState(): { raw: string; state: OneMemoryState } {
  return readLegacyOneState(parseState, initialState);
}

function mutateState<T>(
  expectedStoreVersion: number,
  update: (current: OneMemoryState, timestamp: { version: number; iso: string }) => StateMutation<T>,
): OneMemoryMutationResult<T> {
  assertVersion(expectedStoreVersion, "expectedStoreVersion");
  const current = readOrCreateState();
  if (current.state.version !== expectedStoreVersion) {
    throw new Error(`One Memory state changed (expected ${expectedStoreVersion}, current ${current.state.version})`);
  }
  const outcome = update(current.state, nextTimestamp(current.state.version));
  if (!isOneMemoryState(outcome.state)) throw new Error("One Memory mutation violated the closed storage contract");
  if (outcome.state !== current.state) {
    replaceLegacyOneState(current.raw, current.state, outcome.state);
    for (const event of outcome.events ?? []) tryRecordOneDomainEvent(event);
  }
  return {
    storeVersion: outcome.state.version,
    updatedAt: outcome.state.updatedAt,
    value: outcome.value,
  };
}

function assertCandidateId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !CANDIDATE_ID_RE.test(value)) throw new TypeError("Invalid Memory candidate id");
}

function assertMemoryId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !MEMORY_ID_RE.test(value)) throw new TypeError("Invalid Memory id");
}

function pendingCandidate(
  state: OneMemoryState,
  candidateId: unknown,
  expectedCandidateVersion: unknown,
): OneMemoryCandidate {
  assertCandidateId(candidateId);
  assertVersion(expectedCandidateVersion, "expectedCandidateVersion");
  const candidate = state.candidates.find((item) => item.id === candidateId);
  if (!candidate) throw new Error("Memory candidate not found");
  if (candidate.version !== expectedCandidateVersion) {
    throw new Error(`Memory candidate changed (expected ${expectedCandidateVersion}, current ${candidate.version})`);
  }
  if (candidate.status !== "pending") throw new Error(`Memory candidate is already resolved as ${candidate.status}`);
  return candidate;
}

function exactMemory(
  state: OneMemoryState,
  memoryId: unknown,
  expectedMemoryVersion: unknown,
): OneMemoryAsset {
  assertMemoryId(memoryId);
  assertVersion(expectedMemoryVersion, "expectedMemoryVersion");
  const memory = state.memories.find((item) => item.id === memoryId);
  if (!memory) throw new Error("Memory not found");
  if (memory.version !== expectedMemoryVersion) {
    throw new Error(`Memory changed (expected ${expectedMemoryVersion}, current ${memory.version})`);
  }
  return memory;
}

function stateWithTimestamp(
  current: OneMemoryState,
  timestamp: { version: number; iso: string },
  patch: Partial<Pick<OneMemoryState, "candidates" | "memories" | "suppressions">>,
): OneMemoryState {
  return { ...current, ...patch, version: timestamp.version, updatedAt: timestamp.iso };
}

function resolvedEvent(
  candidate: OneMemoryCandidate,
  resolution: string,
  memoryId?: string,
): RecordOneDomainEventInput {
  return {
    eventType: "memory.resolved",
    occurredAt: candidate.resolvedAt ?? candidate.updatedAt,
    actor: "user",
    entityId: candidate.id,
    taskId: candidate.source.sourceTaskId,
    version: candidate.version,
    visibility: domainVisibility(candidate.scope),
    entries: [
      { name: "candidateId", value: candidate.id },
      { name: "resolution", value: resolution },
      ...(memoryId ? [{ name: "memoryId", value: memoryId }] : []),
    ],
  };
}

function domainVisibility(scope: OneMemoryScope): RecordOneDomainEventInput["visibility"] {
  // Agent-scoped Memory remains private to the user's One; it is not team-public.
  if (scope === "agent" || scope === "personal") return "personal";
  return scope;
}

export function getOneMemoryState(): OneMemoryState {
  return readOrCreateState().state;
}

export function listOneMemoryCandidates(status?: OneMemoryCandidate["status"]): OneMemoryCandidate[] {
  const candidates = getOneMemoryState().candidates;
  return status ? candidates.filter((item) => item.status === status) : candidates;
}

export function listOneMemoryAssets(includeDisabled = false): OneMemoryAsset[] {
  return getOneMemoryState().memories.filter((item) => includeDisabled || item.enabled);
}

function proposeOneMemoryCandidateInternal(
  input: ProposeOneMemoryCandidateInput,
  allowLegacy: boolean,
): OneMemoryMutationResult<OneMemoryCandidate> {
  return retiredApproval();
}

export function proposeOneMemoryCandidate(
  input: ProposeOneMemoryCandidateInput,
): OneMemoryMutationResult<OneMemoryCandidate> {
  return proposeOneMemoryCandidateInternal(input, false);
}

export interface ProposeUnverifiedOneMemoryCandidateFromRunInput {
  expectedStoreVersion: number;
  normalizedPreview: string;
  scope: OneMemoryScope;
  scopeRef?: string | null;
  sourceTaskId: string;
  sourceRunId: string;
  basis: OneMemoryCandidateSource["basis"];
  suppressionKey: string;
}

/**
 * Main-only completed-source bridge to automatic curation. The original host
 * source capability is required; no approval candidate or legacy asset is created.
 */
export function proposeUnverifiedOneMemoryCandidateFromRun(
  input: ProposeUnverifiedOneMemoryCandidateFromRunInput,
): null {
  const task = getCanonicalTask(input.sourceTaskId), run = getInvocationRunReceipt(input.sourceRunId);
  if (!task?.originChatId || !run || run.runId !== input.sourceRunId || run.status !== "completed" || run.chatId !== task.originChatId)
    throw new Error("one_memory_source_unavailable");
  const chat = getChat(task.originChatId);
  if (!chat?.agentId) throw new Error("one_memory_source_unavailable");
  const context = { runId: run.runId, chatId: task.originChatId, agentId: chat.agentId,
    projectId: task.projectId ?? null, projectPath: null, hostOutcome: "unknown" as const };
  // Guard the original foreground source before looking up or creating a Ticket.
  // A completed run-id or renderer payload is not a source capability.
  assertMemoryTicketSource(context);
  const db = getMemoryDb();
  // Any original Ticket owns its processing policy, including read-only,
  // failed, or pending/retry work. The old producer must never reopen it.
  const existing = db.prepare(`SELECT 1 FROM memory_tickets
    WHERE run_id=? AND chat_id=? AND agent_id=? LIMIT 1`)
    .get(context.runId, context.chatId, context.agentId);
  if (existing) return null;
  const observation = cleanMemoryText(input.normalizedPreview, "Memory observation");
  recordAutomaticMemoryTurn({ context, turnSummary: observation, replyText: observation });
  return null;
}

export interface SealOneMemoryCandidateProvenanceInput {
  sourceTaskId: string;
  sourceTaskVersion: number;
  sourceRunId: string;
  sourceValueClosureId: string;
  sourceValueClosureVersion: number;
}

/** Seal every pending candidate from this accepted run to one immutable tuple. */
export function sealOneMemoryCandidateProvenance(
  input: SealOneMemoryCandidateProvenanceInput,
): OneMemoryMutationResult<OneMemoryCandidate[]> | null {
  // Historical approval provenance stays as recorded; acceptance no longer opens a writer.
  return null;
}

function saveCandidate(
  input: SaveOneMemoryCandidateInput | EditAndSaveOneMemoryCandidateInput,
  edited: boolean,
): OneMemoryMutationResult<OneMemorySavedResult> {
  return retiredApproval();
}

export function saveOneMemoryCandidate(
  input: SaveOneMemoryCandidateInput,
): OneMemoryMutationResult<OneMemorySavedResult> {
  return retiredApproval();
}

export function editAndSaveOneMemoryCandidate(
  input: EditAndSaveOneMemoryCandidateInput,
): OneMemoryMutationResult<OneMemorySavedResult> {
  return retiredApproval();
}

export function useOneMemoryCandidateOnce(
  input: UseOneMemoryCandidateOnceInput,
): OneMemoryMutationResult<OneMemoryUseOnceReceipt> {
  return retiredApproval();
}

/**
 * Validate and prepare without consuming. InvocationService calls this before
 * durable start registration so a rejected start leaves the capability intact.
 */
export function prepareOneMemoryUseOnceClaim(
  ref: OneMemoryUseOnceRef,
  chatId: string,
  nowMs = Date.now(),
): PreparedOneMemoryUseOnceClaim {
  const grant = exactUseOnceGrant(ref, chatId, nowMs);
  return Object.freeze({
    receiptId: grant.receiptId,
    claimToken: grant.claimToken,
    candidateId: grant.candidateId,
    candidateVersion: grant.candidateVersion,
    sourceTaskId: grant.sourceTaskId,
    scope: grant.scope,
    scopeRef: grant.scopeRef,
    binding: Object.freeze({ ...grant.binding }),
    context: oneMemoryUseOnceContext(grant),
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
  });
}

/**
 * Atomic single-process claim. Call only after the invocation start receipt is
 * durable. A later runtime failure never restores the grant or auto-retries it.
 */
export function claimPreparedOneMemoryUseOnce(
  prepared: PreparedOneMemoryUseOnceClaim,
  nowMs = Date.now(),
): ClaimedOneMemoryUseOnceReceipt {
  const ref: OneMemoryUseOnceRef = {
    contractVersion: ONE_MEMORY_CONTRACT_VERSION,
    receiptId: prepared.receiptId,
  };
  const grant = exactUseOnceGrant(ref, prepared.binding.chatId, nowMs);
  if (
    grant.claimToken !== prepared.claimToken
    || grant.candidateId !== prepared.candidateId
    || grant.candidateVersion !== prepared.candidateVersion
  ) throw new Error("Memory use-once prepared claim is stale");
  if (!deleteUseOnceGrant(grant.receiptId, grant.claimToken)) {
    throw new Error("Memory use-once receipt was already claimed");
  }
  return {
    receiptId: grant.receiptId,
    candidateId: grant.candidateId,
    candidateVersion: grant.candidateVersion,
    sourceTaskId: grant.sourceTaskId,
    scope: grant.scope,
    scopeRef: grant.scopeRef,
    binding: { ...grant.binding },
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
    claimedAt: new Date(nowMs).toISOString(),
  };
}

export function rejectOneMemoryCandidate(
  input: RejectOneMemoryCandidateInput,
): OneMemoryMutationResult<OneMemoryCandidate> {
  if (!isRecord(input)) throw new TypeError("Invalid Memory candidate rejection");
  assertOnlyKeys(input, [
    "expectedStoreVersion", "candidateId", "expectedCandidateVersion", "rejectedByUser", "cooldownMs",
  ], "Memory candidate rejection");
  assertVersion(input.expectedStoreVersion, "expectedStoreVersion");
  if (input.rejectedByUser !== true) throw new Error("Rejecting Memory requires explicit user action");
  const cooldownMs = input.cooldownMs ?? DEFAULT_REJECT_COOLDOWN_MS;
  if (!Number.isSafeInteger(cooldownMs) || cooldownMs < MIN_REJECT_COOLDOWN_MS || cooldownMs > MAX_REJECT_COOLDOWN_MS) {
    throw new RangeError("Memory rejection cooldown must be 1 hour-365 days");
  }
  return mutateState(input.expectedStoreVersion, (current, timestamp) => {
    const candidate = pendingCandidate(current, input.candidateId, input.expectedCandidateVersion);
    const cooldownUntil = new Date(timestamp.version + cooldownMs).toISOString();
    const rejected: OneMemoryCandidate = {
      ...candidate,
      version: timestamp.version,
      status: "rejected",
      resolution: "rejected",
      cooldownUntil,
      updatedAt: timestamp.iso,
      resolvedAt: timestamp.iso,
    };
    const suppression: OneMemorySuppression = {
      id: opaqueId("memory_suppression"),
      suppressionKey: candidate.suppressionKey,
      scope: candidate.scope,
      scopeRef: candidate.scopeRef,
      candidateId: candidate.id,
      createdAt: timestamp.iso,
      until: cooldownUntil,
    };
    const activeOtherSuppressions = current.suppressions.filter((item) =>
      Date.parse(item.until) > timestamp.version &&
      !(item.suppressionKey === suppression.suppressionKey && item.scope === suppression.scope && item.scopeRef === suppression.scopeRef));
    if (activeOtherSuppressions.length >= 511) throw new Error("One Memory suppression limit reached");
    return {
      state: stateWithTimestamp(current, timestamp, {
        candidates: current.candidates.map((item) => item.id === candidate.id ? rejected : item),
        suppressions: [...activeOtherSuppressions, suppression],
      }),
      value: rejected,
      events: [resolvedEvent(rejected, "rejected")],
    };
  });
}

export function deleteOneMemoryCandidate(
  input: DeleteOneMemoryCandidateInput,
): OneMemoryMutationResult<{ candidateId: string; deletedAt: string }> {
  if (!isRecord(input)) throw new TypeError("Invalid Memory candidate delete request");
  assertOnlyKeys(input, ["expectedStoreVersion", "candidateId", "expectedCandidateVersion", "confirmedByUser"], "Memory candidate delete request");
  assertVersion(input.expectedStoreVersion, "expectedStoreVersion");
  if (input.confirmedByUser !== true) throw new Error("Deleting a Memory candidate requires explicit user confirmation");
  return mutateState(input.expectedStoreVersion, (current, timestamp) => {
    assertCandidateId(input.candidateId);
    assertVersion(input.expectedCandidateVersion, "expectedCandidateVersion");
    const candidate = current.candidates.find((item) => item.id === input.candidateId);
    if (!candidate) throw new Error("Memory candidate not found");
    if (candidate.version !== input.expectedCandidateVersion) throw new Error("Memory candidate changed; reload and try again");
    return {
      state: stateWithTimestamp(current, timestamp, {
        candidates: current.candidates.filter((item) => item.id !== candidate.id),
      }),
      value: { candidateId: candidate.id, deletedAt: timestamp.iso },
      events: [resolvedEvent({ ...candidate, version: timestamp.version, updatedAt: timestamp.iso, resolvedAt: timestamp.iso }, "deleted")],
    };
  });
}

export function updateOneMemoryAsset(
  input: UpdateOneMemoryAssetInput,
): OneMemoryMutationResult<OneMemoryAsset> {
  return retiredApproval();
}

export function setOneMemoryAssetEnabled(
  input: SetOneMemoryAssetEnabledInput,
): OneMemoryMutationResult<OneMemoryAsset> {
  if (!isRecord(input)) throw new TypeError("Invalid Memory enabled-state request");
  assertOnlyKeys(input, [
    "expectedStoreVersion", "memoryId", "expectedMemoryVersion", "enabled", "confirmedByUser",
  ], "Memory enabled-state request");
  assertVersion(input.expectedStoreVersion, "expectedStoreVersion");
  if (typeof input.enabled !== "boolean" || input.confirmedByUser !== true) {
    throw new Error("Changing Memory state requires explicit user confirmation");
  }
  return mutateState(input.expectedStoreVersion, (current, timestamp) => {
    const memory = exactMemory(current, input.memoryId, input.expectedMemoryVersion);
    if (memory.enabled === input.enabled) return { state: current, value: memory };
    const updated: OneMemoryAsset = {
      ...memory,
      version: timestamp.version,
      enabled: input.enabled,
      updatedAt: timestamp.iso,
      disabledAt: input.enabled ? null : timestamp.iso,
    };
    return {
      state: stateWithTimestamp(current, timestamp, {
        memories: current.memories.map((item) => item.id === memory.id ? updated : item),
      }),
      value: updated,
      events: [{
        eventType: "memory.updated",
        occurredAt: updated.updatedAt,
        actor: "user",
        entityId: updated.id,
        version: updated.version,
        visibility: domainVisibility(updated.scope),
        entries: [
          { name: "memoryId", value: updated.id },
          { name: "changedFields", value: ["enabled"] },
        ],
      }],
    };
  });
}

export function deleteOneMemoryAsset(
  input: DeleteOneMemoryAssetInput,
): OneMemoryMutationResult<{ memoryId: string; deletedAt: string }> {
  if (!isRecord(input)) throw new TypeError("Invalid Memory delete request");
  assertOnlyKeys(input, ["expectedStoreVersion", "memoryId", "expectedMemoryVersion", "confirmedByUser"], "Memory delete request");
  assertVersion(input.expectedStoreVersion, "expectedStoreVersion");
  if (input.confirmedByUser !== true) throw new Error("Deleting Memory requires explicit user confirmation");
  return mutateState(input.expectedStoreVersion, (current, timestamp) => {
    const memory = exactMemory(current, input.memoryId, input.expectedMemoryVersion);
    return {
      state: stateWithTimestamp(current, timestamp, {
        memories: current.memories.filter((item) => item.id !== memory.id),
      }),
      value: { memoryId: memory.id, deletedAt: timestamp.iso },
      events: [{
        eventType: "memory.deleted",
        occurredAt: timestamp.iso,
        actor: "user",
        entityId: memory.id,
        version: timestamp.version,
        visibility: domainVisibility(memory.scope),
        entries: [
          { name: "memoryId", value: memory.id },
          { name: "effectiveTime", value: timestamp.iso },
        ],
      }],
    };
  });
}

/**
 * Local-only context for future runtime assembly. It includes only enabled,
 * explicitly user-approved assets and makes no claim that they improved a result.
 */
export function selectApprovedOneMemoryAssets(
  scope: OneMemoryInvocationScope = {},
  state: OneMemoryState = getOneMemoryState(),
): OneMemoryAsset[] {
  if (!isOneMemoryState(state)) throw new TypeError("Invalid One Memory state");
  return state.memories.filter((memory) => memory.enabled && isLegacyOneAssetActive(memory)).filter((memory) => {
    if (memory.scope === "personal") return true;
    if (memory.scope === "project") return Boolean(scope.projectId) && memory.scopeRef === scope.projectId;
    if (memory.scope === "agent") return Boolean(scope.agentId) && memory.scopeRef === scope.agentId;
    return Boolean(scope.teamId) && memory.scopeRef === scope.teamId;
  });
}

export function buildApprovedOneMemoryContext(
  scope: OneMemoryInvocationScope = {},
  state: OneMemoryState = getOneMemoryState(),
): string {
  const memories = selectApprovedOneMemoryAssets(scope, state);
  const automatic = buildLegacyOneAutomaticContext(scope);
  if (memories.length === 0) return automatic;
  return [
    "[Approved One Memory]",
    ...memories.map((memory) =>
      `- [${memory.scope}${memory.scopeRef ? `:${memory.scopeRef}` : ""}] ${legacyOneMemoryText(memory)} (source ${memory.sourceRef})`),
  ].concat(automatic ? [automatic] : []).join("\n");
}
