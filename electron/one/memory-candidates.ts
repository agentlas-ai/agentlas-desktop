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
import { getDb } from "../store/db";
import { getChat } from "../store/chats";
import { getInvocationRunReceipt } from "../store/run-events";
import { findCanonicalTaskForChat, getCanonicalTask } from "../store/tasks";
import {
  tryRecordOneDomainEvent,
  type RecordOneDomainEventInput,
} from "./domain-events";
import { getOneValueClosureState } from "./value-closure";

export const ONE_MEMORY_META_KEY = "agentlas.one.memory.v1";

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
  agentGroupId: string | null;
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
    agentGroupId: chat.agentGroupId,
    teamId: chat.firmId,
  };
}

function sameUseOnceBinding(left: OneMemoryUseOnceBinding, right: OneMemoryUseOnceBinding): boolean {
  return left.chatId === right.chatId
    && left.taskId === right.taskId
    && left.taskVersion === right.taskVersion
    && left.projectId === right.projectId
    && left.agentId === right.agentId
    && left.agentGroupId === right.agentGroupId
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
    "[One-time Memory — explicitly confirmed for this invocation only]",
    `- [${grant.scope}${grant.scopeRef ? `:${grant.scopeRef}` : ""}] ${grant.content}`,
    "This instruction expires after this accepted invocation start, is not durable Memory, and is not evidence of improvement.",
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
  const db = getDb();
  let row = db.prepare("SELECT value FROM meta WHERE key = ? LIMIT 1").get(ONE_MEMORY_META_KEY) as
    | { value: string }
    | undefined;
  if (!row) {
    const candidate = JSON.stringify(initialState());
    db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)").run(ONE_MEMORY_META_KEY, candidate);
    row = db.prepare("SELECT value FROM meta WHERE key = ? LIMIT 1").get(ONE_MEMORY_META_KEY) as
      | { value: string }
      | undefined;
  }
  if (!row) throw new Error("Could not initialize One Memory state");
  return { raw: row.value, state: parseState(row.value) };
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
    const result = getDb()
      .prepare("UPDATE meta SET value = ? WHERE key = ? AND value = ?")
      .run(JSON.stringify(outcome.state), ONE_MEMORY_META_KEY, current.raw);
    if (result.changes !== 1) throw new Error("One Memory state changed concurrently; reload and try again");
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
  if (!isRecord(input)) throw new TypeError("Invalid Memory candidate proposal");
  assertOnlyKeys(input, [
    "expectedStoreVersion", "normalizedPreview", "scope", "scopeRef", "source", "suppressionKey", "reviewAfter",
  ], "Memory candidate proposal");
  assertVersion(input.expectedStoreVersion, "expectedStoreVersion");
  const normalizedPreview = cleanMemoryText(input.normalizedPreview, "normalizedPreview");
  const scope = normalizeScope(input.scope, input.scopeRef);
  const source = normalizeSource(input.source, allowLegacy);
  assertSafeId(input.suppressionKey, "suppressionKey");

  return mutateState(input.expectedStoreVersion, (current, timestamp) => {
    const nowMs = Date.parse(timestamp.iso);
    const activeSuppressions = current.suppressions.filter((item) => Date.parse(item.until) > nowMs);
    const suppressed = activeSuppressions.find((item) =>
      item.suppressionKey === input.suppressionKey && item.scope === scope.scope && item.scopeRef === scope.scopeRef);
    if (suppressed) throw new Error(`Memory candidate suppressed until ${suppressed.until}`);
    if (current.candidates.some((item) =>
      item.status === "pending" && item.suppressionKey === input.suppressionKey &&
      item.scope === scope.scope && item.scopeRef === scope.scopeRef)) {
      throw new Error("An equivalent Memory candidate is already pending");
    }
    if (current.candidates.length >= 512) throw new Error("One Memory candidate limit reached");

    const reviewAfterMs = input.reviewAfter ? Date.parse(input.reviewAfter) : nowMs + DEFAULT_REVIEW_MS;
    if (!Number.isFinite(reviewAfterMs) || reviewAfterMs < nowMs + MIN_REVIEW_MS || reviewAfterMs > nowMs + MAX_REVIEW_MS) {
      throw new TypeError("reviewAfter must be 1-730 days in the future");
    }
    const candidate: OneMemoryCandidate = {
      id: opaqueId("memory_candidate"),
      version: timestamp.version,
      normalizedPreview,
      scope: scope.scope,
      scopeRef: scope.scopeRef,
      source,
      suppressionKey: input.suppressionKey,
      status: "pending",
      resolution: null,
      memoryId: null,
      reviewAfter: new Date(reviewAfterMs).toISOString(),
      cooldownUntil: null,
      createdAt: timestamp.iso,
      updatedAt: timestamp.iso,
      resolvedAt: null,
    };
    const state = stateWithTimestamp(current, timestamp, {
      candidates: [...current.candidates, candidate],
      suppressions: activeSuppressions,
    });
    return {
      state,
      value: candidate,
      events: [{
        eventType: "memory.candidate_created",
        occurredAt: candidate.createdAt,
        actor: source.basis === "inferred" ? "one" : "user",
        entityId: candidate.id,
        taskId: source.sourceTaskId,
        version: candidate.version,
        visibility: domainVisibility(candidate.scope),
        entries: [
          { name: "candidateId", value: candidate.id },
          // The review store owns candidate text until resolution. The append-
          // only domain ledger keeps only a content-free lifecycle statement so
          // a later Use once tombstone can truthfully remove the original.
          { name: "normalizedPreview", value: "Candidate content awaiting explicit review" },
          { name: "scope", value: candidate.scope },
          { name: "sourceRef", value: source.sourceRef },
        ],
      }],
    };
  });
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
 * Main-only bridge between a completed run and explicit result acceptance.
 * The review candidate is durable, but its source is deliberately ineligible
 * for save/reuse/proof until acceptance seals the exact Task/run/Closure tuple.
 */
export function proposeUnverifiedOneMemoryCandidateFromRun(
  input: ProposeUnverifiedOneMemoryCandidateFromRunInput,
): OneMemoryMutationResult<OneMemoryCandidate> {
  if (!isRecord(input)) throw new TypeError("Invalid unverified Memory candidate proposal");
  assertOnlyKeys(input, [
    "expectedStoreVersion", "normalizedPreview", "scope", "scopeRef", "sourceTaskId",
    "sourceRunId", "basis", "suppressionKey",
  ], "Unverified Memory candidate proposal");
  assertSafeId(input.sourceTaskId, "sourceTaskId");
  assertSafeId(input.sourceRunId, "sourceRunId");
  const task = getCanonicalTask(input.sourceTaskId);
  const run = getInvocationRunReceipt(input.sourceRunId);
  if (!task || !task.originChatId || !run || run.status !== "completed" || run.chatId !== task.originChatId) {
    throw new Error("Unverified Memory candidate is not bound to the exact completed run");
  }
  return proposeOneMemoryCandidateInternal({
    expectedStoreVersion: input.expectedStoreVersion,
    normalizedPreview: input.normalizedPreview,
    scope: input.scope,
    ...(input.scopeRef === undefined ? {} : { scopeRef: input.scopeRef }),
    source: {
      provenanceStatus: "legacy_unversioned",
      sourceTaskId: task.id,
      sourceTaskVersion: null,
      sourceRunId: null,
      sourceValueClosureId: null,
      sourceValueClosureVersion: null,
      sourceRef: `user_instruction:${run.runId}`,
      evidenceRefs: [`run:${run.runId}`],
      basis: input.basis,
    },
    suppressionKey: input.suppressionKey,
  }, true);
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
  if (!isRecord(input)) throw new TypeError("Invalid Memory provenance seal");
  assertOnlyKeys(input, [
    "sourceTaskId", "sourceTaskVersion", "sourceRunId", "sourceValueClosureId", "sourceValueClosureVersion",
  ], "Memory provenance seal");
  const verified = normalizeSource({
    provenanceStatus: "verified",
    sourceTaskId: input.sourceTaskId,
    sourceTaskVersion: input.sourceTaskVersion,
    sourceRunId: input.sourceRunId,
    sourceValueClosureId: input.sourceValueClosureId,
    sourceValueClosureVersion: input.sourceValueClosureVersion,
    sourceRef: `user_instruction:${input.sourceRunId}`,
    evidenceRefs: [`run:${input.sourceRunId}`],
    basis: "explicit_user_statement",
  });
  const state = getOneMemoryState();
  const matches = state.candidates.filter((candidate) =>
    candidate.status === "pending"
    && candidate.source.provenanceStatus === "legacy_unversioned"
    && candidate.source.sourceTaskId === verified.sourceTaskId
    && candidate.source.sourceRef === verified.sourceRef
    && candidate.source.evidenceRefs.includes(`run:${input.sourceRunId}`),
  );
  if (matches.length === 0) return null;
  return mutateState(state.version, (current, timestamp) => {
    const matchIds = new Set(matches.map((item) => item.id));
    const sealed: OneMemoryCandidate[] = [];
    const candidates = current.candidates.map((candidate) => {
      if (
        !matchIds.has(candidate.id)
        || candidate.status !== "pending"
        || candidate.source.provenanceStatus !== "legacy_unversioned"
        || candidate.source.sourceTaskId !== verified.sourceTaskId
        || candidate.source.sourceRef !== verified.sourceRef
      ) return candidate;
      const updated: OneMemoryCandidate = {
        ...candidate,
        version: timestamp.version,
        source: {
          ...verified,
          basis: candidate.source.basis,
          sourceRef: candidate.source.sourceRef,
          evidenceRefs: [...candidate.source.evidenceRefs],
        },
        updatedAt: timestamp.iso,
      };
      sealed.push(updated);
      return updated;
    });
    if (sealed.length !== matches.length) {
      throw new Error("Memory candidate changed before provenance could be sealed");
    }
    return {
      state: stateWithTimestamp(current, timestamp, { candidates }),
      value: sealed,
    };
  });
}

function saveCandidate(
  input: SaveOneMemoryCandidateInput | EditAndSaveOneMemoryCandidateInput,
  edited: boolean,
): OneMemoryMutationResult<OneMemorySavedResult> {
  return mutateState(input.expectedStoreVersion, (current, timestamp) => {
    const candidate = pendingCandidate(current, input.candidateId, input.expectedCandidateVersion);
    if (candidate.source.provenanceStatus !== "verified") {
      throw new Error("Accept this Task result before saving its Memory candidate");
    }
    assertVerifiedSourceProvenance(candidate.source);
    if (current.memories.length >= 512) throw new Error("One Memory asset limit reached");
    const editedInput = edited ? input as EditAndSaveOneMemoryCandidateInput : null;
    const content = editedInput ? cleanMemoryText(editedInput.content, "Memory content") : candidate.normalizedPreview;
    const scope = editedInput
      ? normalizeScope(editedInput.scope ?? candidate.scope, "scopeRef" in editedInput ? editedInput.scopeRef : candidate.scopeRef)
      : { scope: candidate.scope, scopeRef: candidate.scopeRef };
    const memory: OneMemoryAsset = {
      id: opaqueId("memory"),
      version: timestamp.version,
      content,
      scope: scope.scope,
      scopeRef: scope.scopeRef,
      sourceCandidateId: candidate.id,
      provenanceStatus: candidate.source.provenanceStatus,
      sourceTaskId: candidate.source.sourceTaskId,
      sourceTaskVersion: candidate.source.sourceTaskVersion,
      sourceRunId: candidate.source.sourceRunId,
      sourceValueClosureId: candidate.source.sourceValueClosureId,
      sourceValueClosureVersion: candidate.source.sourceValueClosureVersion,
      sourceRef: candidate.source.sourceRef,
      evidenceRefs: [...candidate.source.evidenceRefs],
      approvalSource: "explicit_user",
      approvedAt: timestamp.iso,
      enabled: true,
      createdAt: timestamp.iso,
      updatedAt: timestamp.iso,
      disabledAt: null,
    };
    const resolved: OneMemoryCandidate = {
      ...candidate,
      version: timestamp.version,
      normalizedPreview: content,
      scope: scope.scope,
      scopeRef: scope.scopeRef,
      status: "saved",
      resolution: "saved",
      memoryId: memory.id,
      updatedAt: timestamp.iso,
      resolvedAt: timestamp.iso,
    };
    return {
      state: stateWithTimestamp(current, timestamp, {
        candidates: current.candidates.map((item) => item.id === candidate.id ? resolved : item),
        memories: [...current.memories, memory],
      }),
      value: { candidate: resolved, memory },
      events: [resolvedEvent(resolved, edited ? "edited_and_saved" : "saved", memory.id)],
    };
  });
}

export function saveOneMemoryCandidate(
  input: SaveOneMemoryCandidateInput,
): OneMemoryMutationResult<OneMemorySavedResult> {
  if (!isRecord(input)) throw new TypeError("Invalid Memory candidate save request");
  assertOnlyKeys(input, ["expectedStoreVersion", "candidateId", "expectedCandidateVersion", "approvedByUser"], "Memory candidate save request");
  assertVersion(input.expectedStoreVersion, "expectedStoreVersion");
  if (input.approvedByUser !== true) throw new Error("Saving Memory requires explicit user approval");
  return saveCandidate(input, false);
}

export function editAndSaveOneMemoryCandidate(
  input: EditAndSaveOneMemoryCandidateInput,
): OneMemoryMutationResult<OneMemorySavedResult> {
  if (!isRecord(input)) throw new TypeError("Invalid Memory candidate edit-and-save request");
  assertOnlyKeys(input, [
    "expectedStoreVersion", "candidateId", "expectedCandidateVersion", "approvedByUser", "content", "scope", "scopeRef",
  ], "Memory candidate edit-and-save request");
  assertVersion(input.expectedStoreVersion, "expectedStoreVersion");
  if (input.approvedByUser !== true) throw new Error("Editing and saving Memory requires explicit user approval");
  cleanMemoryText(input.content, "Memory content");
  return saveCandidate(input, true);
}

export function useOneMemoryCandidateOnce(
  input: UseOneMemoryCandidateOnceInput,
): OneMemoryMutationResult<OneMemoryUseOnceReceipt> {
  if (!isRecord(input)) throw new TypeError("Invalid Memory use-once request");
  assertOnlyKeys(input, [
    "expectedStoreVersion", "candidateId", "expectedCandidateVersion", "target", "confirmedByUser",
  ], "Memory use-once request");
  assertVersion(input.expectedStoreVersion, "expectedStoreVersion");
  if (input.confirmedByUser !== true) throw new Error("Use once requires explicit user confirmation");
  const binding = normalizeUseOnceTarget(input.target);
  let grant: EphemeralOneMemoryUseOnceGrant | null = null;
  const result = mutateState(input.expectedStoreVersion, (current, timestamp) => {
    const candidate = pendingCandidate(current, input.candidateId, input.expectedCandidateVersion);
    assertMemoryScopeMatchesBinding(candidate.scope, candidate.scopeRef, binding);
    const resolved: OneMemoryCandidate = {
      ...candidate,
      version: timestamp.version,
      // The original is held only by Main's process-local grant below. The
      // renderer receipt and durable candidate both remain content-free.
      normalizedPreview: "Used once; not saved as long-term Memory.",
      status: "used_once",
      resolution: "used_once",
      updatedAt: timestamp.iso,
      resolvedAt: timestamp.iso,
    };
    const receipt: OneMemoryUseOnceReceipt = {
      contractVersion: ONE_MEMORY_CONTRACT_VERSION,
      receiptId: opaqueId("memory_once_receipt"),
      issuedAt: timestamp.iso,
      expiresAt: new Date(timestamp.version + USE_ONCE_RECEIPT_MS).toISOString(),
      persisted: false,
    };
    grant = {
      receiptId: receipt.receiptId,
      claimToken: randomUUID(),
      candidateId: candidate.id,
      candidateVersion: resolved.version,
      sourceTaskId: candidate.source.sourceTaskId,
      content: candidate.normalizedPreview,
      scope: candidate.scope,
      scopeRef: candidate.scopeRef,
      binding,
      issuedAt: receipt.issuedAt,
      expiresAt: receipt.expiresAt,
      evictionTimer: null,
    };
    return {
      state: stateWithTimestamp(current, timestamp, {
        candidates: current.candidates.map((item) => item.id === candidate.id ? resolved : item),
      }),
      value: receipt,
      events: [resolvedEvent(resolved, "used_once")],
    };
  });
  const issuedGrant = grant as EphemeralOneMemoryUseOnceGrant | null;
  if (!issuedGrant) throw new Error("Memory use-once grant was not created");
  cleanupExpiredUseOnceGrants();
  oneMemoryUseOnceGrants.set(issuedGrant.receiptId, issuedGrant);
  scheduleUseOnceGrantEviction(issuedGrant);
  return result;
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
  if (!isRecord(input)) throw new TypeError("Invalid Memory update request");
  assertOnlyKeys(input, [
    "expectedStoreVersion", "memoryId", "expectedMemoryVersion", "content", "scope", "scopeRef", "approvedByUser",
  ], "Memory update request");
  assertVersion(input.expectedStoreVersion, "expectedStoreVersion");
  if (input.approvedByUser !== true) throw new Error("Editing Memory requires explicit user approval");
  if (!("content" in input) && !("scope" in input) && !("scopeRef" in input)) throw new TypeError("Memory update is empty");
  return mutateState(input.expectedStoreVersion, (current, timestamp) => {
    const memory = exactMemory(current, input.memoryId, input.expectedMemoryVersion);
    const content = "content" in input ? cleanMemoryText(input.content, "Memory content") : memory.content;
    const scope = normalizeScope(input.scope ?? memory.scope, "scopeRef" in input ? input.scopeRef : memory.scopeRef);
    const changedFields = [
      ...(content !== memory.content ? ["content"] : []),
      ...(scope.scope !== memory.scope ? ["scope"] : []),
      ...(scope.scopeRef !== memory.scopeRef ? ["scopeRef"] : []),
    ];
    if (changedFields.length === 0) return { state: current, value: memory };
    const updated: OneMemoryAsset = {
      ...memory,
      version: timestamp.version,
      content,
      scope: scope.scope,
      scopeRef: scope.scopeRef,
      approvalSource: "explicit_user",
      approvedAt: timestamp.iso,
      updatedAt: timestamp.iso,
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
          { name: "changedFields", value: changedFields },
        ],
      }],
    };
  });
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
  return state.memories.filter((memory) => memory.enabled).filter((memory) => {
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
  if (memories.length === 0) return "[Approved One Memory]\n- None enabled.";
  return [
    "[Approved One Memory — explicit user approvals only]",
    ...memories.map((memory) =>
      `- [${memory.scope}${memory.scopeRef ? `:${memory.scopeRef}` : ""}] ${memory.content} (source ${memory.sourceRef})`),
    "These entries are context, not evidence that a later result improved.",
  ].join("\n");
}
