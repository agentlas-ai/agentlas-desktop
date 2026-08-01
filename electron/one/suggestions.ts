import { randomUUID } from "node:crypto";
import {
  ONE_HUB_PRIVATE_EXCLUSIONS,
  ONE_SUGGESTION_CONTRACT_VERSION,
  ONE_SUGGESTION_PRIORITY,
  ONE_SUGGESTION_REVIEW_HANDOFF_CONTRACT_VERSION,
  isOneSuggestionState,
  unsafeOneSuggestionTextReason,
  type AcceptOneSuggestionForReviewInput,
  type ArbitrateOneSuggestionInput,
  type DismissOneSuggestionInput,
  type MarkOneSuggestionIgnoredInput,
  type NeverAskOneSuggestionInput,
  type OneAgentBuildSignal,
  type OneAutomationPreview,
  type OneAutomationSignal,
  type OneEcosystemSuggestion,
  type OneHubDerivativeSignal,
  type OneHubPrivateExclusion,
  type OneRetainTeamSignal,
  type OneSuggestionArbitrationReason,
  type OneSuggestionArbitrationResult,
  type OneSuggestionCandidateSignals,
  type OneSuggestionMutationResult,
  type OneSuggestionPatternFeedback,
  type OneSuggestionProposal,
  type OneSuggestionReviewKind,
  type OneSuggestionReviewHandoff,
  type OneSuggestionReviewHandoffInput,
  type OneSuggestionReviewRequest,
  type OneSuggestionReviewSurface,
  type OneSuggestionState,
  type OneSuggestionSuppression,
  type OneSuggestionTaskEvidence,
  type OneSuggestionType,
  type SnoozeOneSuggestionInput,
} from "../../shared/one-suggestions";
import { getDb } from "../store/db";
import { getInvocationRunReceipt } from "../store/run-events";
import { getCanonicalTask } from "../store/tasks";
import {
  tryRecordOneDomainEvent,
  type RecordOneDomainEventInput,
} from "./domain-events";
import { prepareOneHubDerivativeDraft } from "./hub-derivative";

export const ONE_SUGGESTION_META_KEY = "agentlas.one.suggestions.v1";

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const SUGGESTION_ID_RE = /^one_suggestion_[a-f0-9]{32}$/;
const REVIEW_ID_RE = /^one_suggestion_review_[a-f0-9]{32}$/;
const DRAFT_ID_RE = /^one_(?:agent|team|automation|hub)_draft_[a-f0-9]{32}$/;
const DEFAULT_SNOOZE_MS = 7 * 24 * 60 * 60 * 1_000;
const MIN_SNOOZE_MS = DEFAULT_SNOOZE_MS;
const DEFAULT_DISMISS_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1_000;
const MIN_DISMISS_COOLDOWN_MS = DEFAULT_DISMISS_COOLDOWN_MS;
const MAX_COOLDOWN_MS = 365 * 24 * 60 * 60 * 1_000;
const MAX_EVIDENCE_AGE_MS = 730 * 24 * 60 * 60 * 1_000;
const MAX_AUTOMATION_PREVIEW_HORIZON_MS = 366 * 24 * 60 * 60 * 1_000;
const CLOCK_SKEW_MS = 5 * 60 * 1_000;
const PERMISSIONS = new Set(["read_only", "draft_only", "approval_before_external_change"]);

interface Mutation<T> {
  state: OneSuggestionState;
  value: T;
  events?: RecordOneDomainEventInput[];
  /** Optional second durable store mutation, committed in the same SQLite transaction. */
  commit?: () => void;
  /** Removes a prepared local artifact when validation or either CAS fails. */
  rollback?: () => void;
}

interface NormalizedEvidenceResult {
  verified: boolean;
  evidence: OneSuggestionTaskEvidence[];
}

interface SelectedProposal {
  type: OneSuggestionType;
  proposal: OneSuggestionProposal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const safe = new Set(allowed);
  if (Object.keys(value).some((key) => !safe.has(key))) throw new TypeError(`${label} contains unsupported fields`);
}

function assertPositiveVersion(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new TypeError(`${label} must be a positive safe integer`);
}

function assertSafeId(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string"
    || !SAFE_ID_RE.test(value)
    || unsafeOneSuggestionTextReason(value) === "secret"
  ) throw new TypeError(`${label} must be an opaque safe id without secrets`);
}

function assertTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new TypeError(`${label} must be an ISO timestamp`);
}

function normalizeSafeText(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be text`);
  const unsafe = unsafeOneSuggestionTextReason(value);
  if (unsafe) throw new TypeError(`${label} rejected unsafe ${unsafe}`);
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length < 1 || normalized.length > 240) throw new RangeError(`${label} must contain 1-240 normalized characters`);
  return normalized;
}

function normalizeUniqueSafeIds(value: unknown, label: string, minimum = 1, maximum = 64): string[] {
  if (
    !Array.isArray(value) || value.length < minimum || value.length > maximum
    || value.some((item) => typeof item !== "string" || !SAFE_ID_RE.test(item))
    || new Set(value).size !== value.length
  ) throw new TypeError(`${label} must contain ${minimum}-${maximum} unique opaque ids`);
  return [...value] as string[];
}

function opaqueId(prefix: "one_suggestion" | "one_suggestion_review" | "one_suggestion_suppression"): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function draftId(type: OneSuggestionType): string {
  const prefix = type === "agent_build"
    ? "one_agent_draft"
    : type === "retain_team"
      ? "one_team_draft"
      : type === "automation"
        ? "one_automation_draft"
        : "one_hub_draft";
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function nextTimestamp(previousVersion: number): { version: number; iso: string } {
  const version = Math.max(Date.now(), previousVersion + 1);
  return { version, iso: new Date(version).toISOString() };
}

function initialState(): OneSuggestionState {
  const version = Math.max(1, Date.now());
  const now = new Date(version).toISOString();
  return {
    contractVersion: ONE_SUGGESTION_CONTRACT_VERSION,
    version,
    suggestions: [],
    reviewRequests: [],
    suppressions: [],
    patternFeedback: [],
    taskArbitrations: [],
    createdAt: now,
    updatedAt: now,
  };
}

function parseState(raw: string): OneSuggestionState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Stored One suggestion state is corrupt; it was not overwritten");
  }
  if (!isOneSuggestionState(parsed)) {
    throw new Error("Stored One suggestion state violates its closed contract; it was not overwritten");
  }
  return parsed;
}

function readOrCreateState(): { raw: string; state: OneSuggestionState } {
  const db = getDb();
  let row = db.prepare("SELECT value FROM meta WHERE key = ? LIMIT 1").get(ONE_SUGGESTION_META_KEY) as
    | { value: string }
    | undefined;
  if (!row) {
    const candidate = JSON.stringify(initialState());
    db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)").run(ONE_SUGGESTION_META_KEY, candidate);
    row = db.prepare("SELECT value FROM meta WHERE key = ? LIMIT 1").get(ONE_SUGGESTION_META_KEY) as
      | { value: string }
      | undefined;
  }
  if (!row) throw new Error("Could not initialize One suggestion state");
  return { raw: row.value, state: parseState(row.value) };
}

function assertExpectedState(expectedStoreVersion: number): { raw: string; state: OneSuggestionState } {
  assertPositiveVersion(expectedStoreVersion, "expectedStoreVersion");
  const current = readOrCreateState();
  if (current.state.version !== expectedStoreVersion) throw new Error("One suggestion state changed; refresh and retry");
  return current;
}

function mutateState<T>(
  expectedStoreVersion: number,
  update: (current: OneSuggestionState, timestamp: { version: number; iso: string }) => Mutation<T>,
): OneSuggestionMutationResult<T> {
  const { raw, state } = assertExpectedState(expectedStoreVersion);
  const timestamp = nextTimestamp(state.version);
  let mutation: Mutation<T> | null = null;
  try {
    mutation = update(state, timestamp);
    if (!isOneSuggestionState(mutation.state)) throw new Error("Refused to persist invalid One suggestion state");
    if (mutation.state.version !== timestamp.version || mutation.state.updatedAt !== timestamp.iso) {
      throw new Error("One suggestion mutation did not advance its exact version");
    }
    const serialized = JSON.stringify(mutation.state);
    const db = getDb();
    const commit = db.transaction(() => {
      const result = db.prepare("UPDATE meta SET value = ? WHERE key = ? AND value = ?")
        .run(serialized, ONE_SUGGESTION_META_KEY, raw);
      if (result.changes !== 1) throw new Error("One suggestion state changed concurrently; refresh and retry");
      mutation?.commit?.();
    });
    commit.immediate();
  } catch (error) {
    mutation?.rollback?.();
    throw error;
  }
  if (!mutation) throw new Error("One suggestion mutation did not produce state");
  for (const event of mutation.events ?? []) tryRecordOneDomainEvent(event);
  return { storeVersion: mutation.state.version, updatedAt: mutation.state.updatedAt, value: mutation.value };
}

function stateWithTimestamp(
  current: OneSuggestionState,
  timestamp: { version: number; iso: string },
  changes: Partial<Omit<OneSuggestionState, "contractVersion" | "version" | "createdAt" | "updatedAt">>,
): OneSuggestionState {
  return { ...current, ...changes, version: timestamp.version, updatedAt: timestamp.iso };
}

function normalizeEvidence(
  value: unknown,
  patternKey: string,
  originTaskId: string,
): NormalizedEvidenceResult {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) {
    throw new TypeError("evidence must contain 1-16 canonical Task receipts");
  }
  const now = Date.now();
  let verified = true;
  const normalized = value.map((item, index): OneSuggestionTaskEvidence => {
    if (!isRecord(item)) throw new TypeError(`evidence[${index}] must be an object`);
    assertOnlyKeys(item, [
      "taskId", "taskVersion", "patternKey", "status", "outcome", "hostVerified", "hostId", "runId",
      "acceptanceReceiptVerified", "completionReceiptRef", "verificationRef", "evidenceRefs", "completedAt",
    ], `evidence[${index}]`);
    assertSafeId(item.taskId, `evidence[${index}].taskId`);
    assertPositiveVersion(item.taskVersion, `evidence[${index}].taskVersion`);
    assertSafeId(item.patternKey, `evidence[${index}].patternKey`);
    if (item.patternKey !== patternKey) throw new TypeError("all Task evidence must use the requested patternKey");
    if (typeof item.status !== "string" || typeof item.outcome !== "string") {
      throw new TypeError(`evidence[${index}] verification fields are invalid`);
    }
    const acceptedInternal = item.outcome === "accepted_internal_result";
    const verifiedClaim = acceptedInternal
      ? item.acceptanceReceiptVerified === true && item.hostVerified === undefined
      : item.outcome === "success" && item.hostVerified === true && item.acceptanceReceiptVerified === undefined;
    if (item.status !== "completed" || !verifiedClaim) verified = false;
    assertSafeId(item.hostId, `evidence[${index}].hostId`);
    assertSafeId(item.runId, `evidence[${index}].runId`);
    assertSafeId(item.completionReceiptRef, `evidence[${index}].completionReceiptRef`);
    if (item.completionReceiptRef !== item.runId) {
      throw new TypeError(`evidence[${index}].completionReceiptRef must be the exact runId`);
    }
    assertSafeId(item.verificationRef, `evidence[${index}].verificationRef`);
    const evidenceRefs = normalizeUniqueSafeIds(item.evidenceRefs, `evidence[${index}].evidenceRefs`, 1, 32);
    assertTimestamp(item.completedAt, `evidence[${index}].completedAt`);
    const completedAtMs = Date.parse(item.completedAt);
    if (completedAtMs > now + CLOCK_SKEW_MS || completedAtMs < now - MAX_EVIDENCE_AGE_MS) {
      throw new RangeError(`evidence[${index}].completedAt is outside the allowed verification window`);
    }
    const base = {
      taskId: item.taskId,
      taskVersion: item.taskVersion,
      patternKey: item.patternKey,
      status: item.status as "completed",
      hostId: item.hostId,
      runId: item.runId,
      completionReceiptRef: item.completionReceiptRef,
      verificationRef: item.verificationRef,
      evidenceRefs,
      completedAt: item.completedAt,
    };
    return acceptedInternal
      ? { ...base, outcome: "accepted_internal_result" as const, acceptanceReceiptVerified: true as const }
      : { ...base, outcome: "success" as const, hostVerified: true as const };
  });
  if (new Set(normalized.map((item) => item.taskId)).size !== normalized.length) {
    throw new TypeError("Task evidence must contain distinct completed Task instances");
  }
  if (new Set(normalized.map((item) => item.hostId)).size !== 1) {
    throw new TypeError("Task evidence must come from one exact host authority");
  }
  if (new Set(normalized.map((item) => item.outcome)).size !== 1) {
    throw new TypeError("Task evidence must not mix accepted internal results with stronger outcome verification");
  }
  const origin = normalized.find((item) => item.taskId === originTaskId);
  if (!origin) throw new TypeError("originTaskId must reference one of the supplied Task receipts");
  const latestCompletedAt = Math.max(...normalized.map((item) => Date.parse(item.completedAt)));
  if (Date.parse(origin.completedAt) !== latestCompletedAt) {
    throw new TypeError("originTaskId must be the most recently completed Task receipt");
  }
  if (verified) {
    verified = normalized.every((item) => {
      const task = getCanonicalTask(item.taskId);
      const receipt = getInvocationRunReceipt(item.runId);
      return Boolean(
        task
        && task.status === "completed"
        && task.version === item.taskVersion
        && task.updatedAt === item.completedAt
        && task.originChatId
        && receipt
        && receipt.status === "completed"
        && typeof receipt.finishedAt === "string"
        && receipt.chatId === task.originChatId,
      );
    });
  }
  return { verified, evidence: normalized };
}

function normalizeAgentBuild(value: unknown): OneAgentBuildSignal | null {
  if (value === null) return null;
  if (!isRecord(value)) throw new TypeError("signals.agentBuild must be an object or null");
  if (value.signalSource === "accepted_result_pattern") {
    assertOnlyKeys(value, [
      "signalSource", "participantRef", "roleRef", "taskKindRef", "toolRefs", "observationRefs",
      "acceptedResultCount", "reviewRequired",
    ], "signals.agentBuild");
    assertSafeId(value.participantRef, "signals.agentBuild.participantRef");
    assertSafeId(value.roleRef, "signals.agentBuild.roleRef");
    assertSafeId(value.taskKindRef, "signals.agentBuild.taskKindRef");
    const toolRefs = normalizeUniqueSafeIds(value.toolRefs, "signals.agentBuild.toolRefs", 0, 64);
    const observationRefs = normalizeUniqueSafeIds(value.observationRefs, "signals.agentBuild.observationRefs", 2, 16);
    if (
      !Number.isSafeInteger(value.acceptedResultCount)
      || Number(value.acceptedResultCount) !== observationRefs.length
      || value.reviewRequired !== true
    ) throw new TypeError("observed Agent Build signal must bind every distinct accepted result and remain review-only");
    return {
      signalSource: "accepted_result_pattern",
      participantRef: value.participantRef,
      roleRef: value.roleRef,
      taskKindRef: value.taskKindRef,
      toolRefs,
      observationRefs,
      acceptedResultCount: Number(value.acceptedResultCount),
      reviewRequired: true,
    };
  }
  assertOnlyKeys(value, [
    "roleRef", "inputSchemaRef", "outputContractRef", "reuseIntentRef", "userReuseIntentConfirmed",
  ], "signals.agentBuild");
  assertSafeId(value.roleRef, "signals.agentBuild.roleRef");
  assertSafeId(value.inputSchemaRef, "signals.agentBuild.inputSchemaRef");
  assertSafeId(value.outputContractRef, "signals.agentBuild.outputContractRef");
  assertSafeId(value.reuseIntentRef, "signals.agentBuild.reuseIntentRef");
  if (typeof value.userReuseIntentConfirmed !== "boolean") throw new TypeError("signals.agentBuild.userReuseIntentConfirmed must be boolean");
  if (!value.userReuseIntentConfirmed) return null;
  return {
    roleRef: value.roleRef,
    inputSchemaRef: value.inputSchemaRef,
    outputContractRef: value.outputContractRef,
    reuseIntentRef: value.reuseIntentRef,
    userReuseIntentConfirmed: true,
  };
}

function normalizeRetainTeam(value: unknown): OneRetainTeamSignal | null {
  if (value === null) return null;
  if (!isRecord(value)) throw new TypeError("signals.retainTeam must be an object or null");
  if (value.signalSource === "accepted_result_pattern") {
    assertOnlyKeys(value, [
      "signalSource", "teamSignatureRef", "participantRefs", "roleRefs", "toolRefs",
      "contributionReceiptRefs", "acceptedResultRefs", "acceptedResultCount", "reviewRequired",
    ], "signals.retainTeam");
    assertSafeId(value.teamSignatureRef, "signals.retainTeam.teamSignatureRef");
    const participantRefs = normalizeUniqueSafeIds(value.participantRefs, "signals.retainTeam.participantRefs", 2, 32);
    const roleRefs = normalizeUniqueSafeIds(value.roleRefs, "signals.retainTeam.roleRefs", 1, 32);
    const toolRefs = normalizeUniqueSafeIds(value.toolRefs, "signals.retainTeam.toolRefs", 0, 64);
    const contributionReceiptRefs = normalizeUniqueSafeIds(
      value.contributionReceiptRefs,
      "signals.retainTeam.contributionReceiptRefs",
      2,
      64,
    );
    const acceptedResultRefs = normalizeUniqueSafeIds(value.acceptedResultRefs, "signals.retainTeam.acceptedResultRefs", 2, 16);
    if (
      !Number.isSafeInteger(value.acceptedResultCount)
      || Number(value.acceptedResultCount) !== acceptedResultRefs.length
      || value.reviewRequired !== true
    ) throw new TypeError("observed Team signal must bind every distinct accepted result and remain review-only");
    return {
      signalSource: "accepted_result_pattern",
      teamSignatureRef: value.teamSignatureRef,
      participantRefs,
      roleRefs,
      toolRefs,
      contributionReceiptRefs,
      acceptedResultRefs,
      acceptedResultCount: Number(value.acceptedResultCount),
      reviewRequired: true,
    };
  }
  assertOnlyKeys(value, [
    "teamSignatureRef", "assignmentRefs", "roleRefs", "contributionEvidenceRefs", "teamBenefitEvidenceRef",
  ], "signals.retainTeam");
  assertSafeId(value.teamSignatureRef, "signals.retainTeam.teamSignatureRef");
  const assignmentRefs = normalizeUniqueSafeIds(value.assignmentRefs, "signals.retainTeam.assignmentRefs", 2, 32);
  const roleRefs = normalizeUniqueSafeIds(value.roleRefs, "signals.retainTeam.roleRefs", 2, 32);
  const contributionEvidenceRefs = normalizeUniqueSafeIds(
    value.contributionEvidenceRefs,
    "signals.retainTeam.contributionEvidenceRefs",
    2,
    64,
  );
  assertSafeId(value.teamBenefitEvidenceRef, "signals.retainTeam.teamBenefitEvidenceRef");
  return {
    teamSignatureRef: value.teamSignatureRef,
    assignmentRefs,
    roleRefs,
    contributionEvidenceRefs,
    teamBenefitEvidenceRef: value.teamBenefitEvidenceRef,
  };
}

function normalizeAutomationPreview(value: unknown): OneAutomationPreview {
  if (!isRecord(value)) throw new TypeError("signals.automation.preview must be an object");
  assertOnlyKeys(value, ["trigger", "nextRunAt", "permission", "stopControl", "approvalPolicy"], "signals.automation.preview");
  const trigger = normalizeSafeText(value.trigger, "signals.automation.preview.trigger");
  assertTimestamp(value.nextRunAt, "signals.automation.preview.nextRunAt");
  const nextRunAtMs = Date.parse(value.nextRunAt);
  const nowMs = Date.now();
  if (nextRunAtMs <= nowMs || nextRunAtMs > nowMs + MAX_AUTOMATION_PREVIEW_HORIZON_MS) {
    throw new RangeError("signals.automation.preview.nextRunAt must be a bounded future preview");
  }
  if (typeof value.permission !== "string" || !PERMISSIONS.has(value.permission)) {
    throw new TypeError("signals.automation.preview.permission is invalid");
  }
  const stopControl = normalizeSafeText(value.stopControl, "signals.automation.preview.stopControl");
  if (value.approvalPolicy !== "explicit_approval_before_external_change") {
    throw new TypeError("signals.automation.preview.approvalPolicy must preserve the approval gate");
  }
  return {
    trigger,
    nextRunAt: value.nextRunAt,
    permission: value.permission as OneAutomationPreview["permission"],
    stopControl,
    approvalPolicy: "explicit_approval_before_external_change",
  };
}

function normalizeAutomation(value: unknown): OneAutomationSignal | null {
  if (value === null) return null;
  if (!isRecord(value)) throw new TypeError("signals.automation must be an object or null");
  assertOnlyKeys(value, [
    "intentRef", "startConditionRef", "endConditionRef", "repeatedIntentCount",
    "reversible", "riskControlsVerified", "preview",
  ], "signals.automation");
  assertSafeId(value.intentRef, "signals.automation.intentRef");
  assertSafeId(value.startConditionRef, "signals.automation.startConditionRef");
  assertSafeId(value.endConditionRef, "signals.automation.endConditionRef");
  if (!Number.isSafeInteger(value.repeatedIntentCount) || Number(value.repeatedIntentCount) < 0) {
    throw new TypeError("signals.automation.repeatedIntentCount must be a non-negative safe integer");
  }
  if (typeof value.reversible !== "boolean" || typeof value.riskControlsVerified !== "boolean") {
    throw new TypeError("signals.automation safety gates must be boolean");
  }
  const preview = normalizeAutomationPreview(value.preview);
  if (Number(value.repeatedIntentCount) < 3 || !value.reversible || !value.riskControlsVerified) return null;
  return {
    intentRef: value.intentRef,
    startConditionRef: value.startConditionRef,
    endConditionRef: value.endConditionRef,
    repeatedIntentCount: Number(value.repeatedIntentCount),
    reversible: true,
    riskControlsVerified: true,
    preview,
  };
}

function normalizeHub(value: unknown): OneHubDerivativeSignal | null {
  if (value === null) return null;
  if (!isRecord(value)) throw new TypeError("signals.hubDerivative must be an object or null");
  assertOnlyKeys(value, [
    "privateSourceId", "ownerVerified", "publicReleaseIntentConfirmed", "privateInputExcluded", "publicSuitability",
    "publicSuitabilityRef", "sanitizedManifestRef", "rightsReviewRef", "economy",
    "excludedPrivateCategories",
  ], "signals.hubDerivative");
  assertSafeId(value.privateSourceId, "signals.hubDerivative.privateSourceId");
  if (
    typeof value.ownerVerified !== "boolean"
    || typeof value.publicReleaseIntentConfirmed !== "boolean"
    || typeof value.privateInputExcluded !== "boolean"
  ) {
    throw new TypeError("signals.hubDerivative ownership and intent gates must be boolean");
  }
  if (typeof value.publicSuitability !== "string") throw new TypeError("signals.hubDerivative.publicSuitability must be a status");
  assertSafeId(value.publicSuitabilityRef, "signals.hubDerivative.publicSuitabilityRef");
  assertSafeId(value.sanitizedManifestRef, "signals.hubDerivative.sanitizedManifestRef");
  assertSafeId(value.rightsReviewRef, "signals.hubDerivative.rightsReviewRef");
  if (!isRecord(value.economy)) throw new TypeError("signals.hubDerivative.economy must be an object");
  assertOnlyKeys(value.economy, ["available", "policyRef", "feeScheduleRef", "settlementRuleRef"], "signals.hubDerivative.economy");
  if (typeof value.economy.available !== "boolean") throw new TypeError("signals.hubDerivative.economy.available must be boolean");
  assertSafeId(value.economy.policyRef, "signals.hubDerivative.economy.policyRef");
  assertSafeId(value.economy.feeScheduleRef, "signals.hubDerivative.economy.feeScheduleRef");
  assertSafeId(value.economy.settlementRuleRef, "signals.hubDerivative.economy.settlementRuleRef");
  if (!Array.isArray(value.excludedPrivateCategories)) {
    throw new TypeError("signals.hubDerivative.excludedPrivateCategories must be an array");
  }
  const exclusions = value.excludedPrivateCategories as unknown[];
  const exactExclusions = exclusions.length === ONE_HUB_PRIVATE_EXCLUSIONS.length
    && exclusions.every((item) => typeof item === "string" && ONE_HUB_PRIVATE_EXCLUSIONS.includes(item as OneHubPrivateExclusion))
    && new Set(exclusions).size === ONE_HUB_PRIVATE_EXCLUSIONS.length;
  if (!exactExclusions) {
    throw new TypeError("Hub derivative must explicitly exclude every private and raw category");
  }
  if (
    !value.ownerVerified || !value.publicReleaseIntentConfirmed || !value.privateInputExcluded
    || value.publicSuitability !== "passed"
    || !value.economy.available
  ) return null;
  return {
    privateSourceId: value.privateSourceId,
    ownerVerified: true,
    publicReleaseIntentConfirmed: true,
    privateInputExcluded: true,
    publicSuitability: "passed",
    publicSuitabilityRef: value.publicSuitabilityRef,
    sanitizedManifestRef: value.sanitizedManifestRef,
    rightsReviewRef: value.rightsReviewRef,
    economy: {
      available: true,
      policyRef: value.economy.policyRef,
      feeScheduleRef: value.economy.feeScheduleRef,
      settlementRuleRef: value.economy.settlementRuleRef,
    },
    excludedPrivateCategories: [...ONE_HUB_PRIVATE_EXCLUSIONS],
  };
}

function normalizeSignals(value: unknown): OneSuggestionCandidateSignals {
  if (!isRecord(value)) throw new TypeError("signals must be a closed candidate object");
  assertOnlyKeys(value, ["agentBuild", "retainTeam", "automation", "hubDerivative"], "signals");
  if (!["agentBuild", "retainTeam", "automation", "hubDerivative"].every((key) => key in value)) {
    throw new TypeError("signals must explicitly contain every candidate key, using null when absent");
  }
  return {
    agentBuild: normalizeAgentBuild(value.agentBuild),
    retainTeam: normalizeRetainTeam(value.retainTeam),
    automation: normalizeAutomation(value.automation),
    hubDerivative: normalizeHub(value.hubDerivative),
  };
}

function proposalFor(type: OneSuggestionType, signals: OneSuggestionCandidateSignals): OneSuggestionProposal | null {
  if (type === "agent_build") return signals.agentBuild ? { type, ...signals.agentBuild } : null;
  if (type === "retain_team") return signals.retainTeam ? { type, ...signals.retainTeam } : null;
  if (type === "automation") return signals.automation ? { type, ...signals.automation } : null;
  return signals.hubDerivative ? { type, ...signals.hubDerivative } : null;
}

function minimumEvidence(type: OneSuggestionType): number {
  return type === "automation" ? 3 : 2;
}

function activeSuppression(
  state: OneSuggestionState,
  type: OneSuggestionType,
  patternKey: string,
  nowMs: number,
): boolean {
  return state.suppressions.some((item) => {
    if (item.scope === "type" && item.type !== type) return false;
    if (item.scope === "pattern" && item.patternKey !== patternKey) return false;
    return item.mode === "never_ask_again" || (item.until !== null && Date.parse(item.until) > nowMs);
  });
}

function hasActiveSuggestion(
  state: OneSuggestionState,
  type: OneSuggestionType,
  patternKey: string,
): boolean {
  return state.suggestions.some((item) =>
    item.type === type
    && item.patternKey === patternKey
    && ["open", "accepted_for_review", "snoozed"].includes(item.status),
  );
}

function selectProposal(
  state: OneSuggestionState,
  signals: OneSuggestionCandidateSignals,
  evidenceCount: number,
  patternKey: string,
  nowMs: number,
): {
  selected: SelectedProposal | null;
  hadEligibleSuppressed: boolean;
  hadEligibleDuplicate: boolean;
} {
  let hadEligibleSuppressed = false;
  let hadEligibleDuplicate = false;
  for (const type of ONE_SUGGESTION_PRIORITY) {
    const proposal = proposalFor(type, signals);
    if (!proposal || evidenceCount < minimumEvidence(type)) continue;
    if (hasActiveSuggestion(state, type, patternKey)) {
      hadEligibleDuplicate = true;
      continue;
    }
    if (activeSuppression(state, type, patternKey, nowMs)) {
      hadEligibleSuppressed = true;
      continue;
    }
    return { selected: { type, proposal }, hadEligibleSuppressed, hadEligibleDuplicate };
  }
  return { selected: null, hadEligibleSuppressed, hadEligibleDuplicate };
}

function collectEvidenceRefs(evidence: OneSuggestionTaskEvidence[]): string[] {
  const refs = [...new Set(evidence.flatMap((item) => [
    item.completionReceiptRef,
    item.verificationRef,
    ...item.evidenceRefs,
  ]))];
  if (refs.length > 64) throw new RangeError("Task evidence expands beyond the domain-event evidence reference limit");
  return refs;
}

function createdEvent(suggestion: OneEcosystemSuggestion): RecordOneDomainEventInput {
  return {
    eventType: "ecosystem.suggestion_created",
    occurredAt: suggestion.createdAt,
    actor: "one",
    entityId: suggestion.id,
    taskId: suggestion.originTaskId,
    version: suggestion.version,
    visibility: "personal",
    entries: [
      { name: "suggestionId", value: suggestion.id },
      { name: "type", value: suggestion.type },
      { name: "evidenceRefs", value: suggestion.evidenceRefs },
      { name: "cooldown", value: "none" },
    ],
  };
}

function noSuggestion(
  state: OneSuggestionState,
  reason: Exclude<OneSuggestionArbitrationReason, "created">,
): OneSuggestionArbitrationResult {
  return { storeVersion: state.version, reason, suggestion: null };
}

export function getOneSuggestionState(): OneSuggestionState {
  return readOrCreateState().state;
}

export function listOneSuggestions(includeResolved = false, nowMs = Date.now()): OneEcosystemSuggestion[] {
  if (!Number.isFinite(nowMs)) throw new TypeError("nowMs must be finite");
  return getOneSuggestionState().suggestions.filter((item) => {
    if (includeResolved) return true;
    if (item.status === "open") return true;
    return item.status === "snoozed" && item.resumeAfter !== null && Date.parse(item.resumeAfter) <= nowMs;
  });
}

export function listOneSuggestionReviewRequests(): OneSuggestionReviewRequest[] {
  return getOneSuggestionState().reviewRequests;
}

function reviewSurface(type: OneSuggestionType): {
  surface: OneSuggestionReviewSurface;
  baseRoute: string;
  fallbackReason: OneSuggestionReviewHandoff["fallbackReason"];
} {
  if (type === "agent_build") return { surface: "build", baseRoute: "/build", fallbackReason: null };
  if (type === "retain_team") return { surface: "work", baseRoute: "/workspace/task", fallbackReason: null };
  if (type === "automation") return { surface: "automation", baseRoute: "/automation/new", fallbackReason: null };
  // The local sanitized derivative is reviewed beside the exact originating
  // Task in Work. This is not Marketplace navigation and exposes no publish
  // operation; live Hub gates remain unknown and locked.
  return { surface: "work", baseRoute: "/workspace/task", fallbackReason: null };
}

function reviewHandoffRoute(
  target: ReturnType<typeof reviewSurface>,
  input: OneSuggestionReviewHandoffInput,
): string {
  const params = new URLSearchParams();
  if (target.surface === "work") params.set("task", input.originTaskId);
  params.set("oneReview", "1");
  params.set("suggestionId", input.suggestionId);
  params.set("suggestionVersion", String(input.expectedSuggestionVersion));
  params.set("reviewRequestId", input.reviewRequestId);
  params.set("draftId", input.draftId);
  params.set("originTaskId", input.originTaskId);
  return `${target.baseRoute}?${params.toString()}`;
}

/**
 * Re-resolve an accepted suggestion against Main's current closed state before
 * either One or a destination surface trusts its navigation reference.
 * This method is deliberately read-only: it cannot build, save, enable, run,
 * publish, or copy private source material into the renderer.
 */
export function getOneSuggestionReviewHandoff(
  input: OneSuggestionReviewHandoffInput,
): OneSuggestionReviewHandoff {
  if (!isRecord(input)) throw new TypeError("Invalid One suggestion review handoff");
  assertOnlyKeys(input, [
    "suggestionId", "expectedSuggestionVersion", "reviewRequestId", "draftId", "originTaskId",
  ], "One suggestion review handoff");
  if (typeof input.suggestionId !== "string" || !SUGGESTION_ID_RE.test(input.suggestionId)) {
    throw new TypeError("suggestionId is invalid");
  }
  assertPositiveVersion(input.expectedSuggestionVersion, "expectedSuggestionVersion");
  if (typeof input.reviewRequestId !== "string" || !REVIEW_ID_RE.test(input.reviewRequestId)) {
    throw new TypeError("reviewRequestId is invalid");
  }
  if (typeof input.draftId !== "string" || !DRAFT_ID_RE.test(input.draftId)) {
    throw new TypeError("draftId is invalid");
  }
  assertSafeId(input.originTaskId, "originTaskId");

  const state = getOneSuggestionState();
  const suggestion = state.suggestions.find((item) => item.id === input.suggestionId);
  if (!suggestion) throw new Error("One suggestion was not found");
  if (suggestion.version !== input.expectedSuggestionVersion) {
    throw new Error("One suggestion changed; refresh before continuing review");
  }
  if (suggestion.status !== "accepted_for_review" || suggestion.reviewRequestId !== input.reviewRequestId) {
    throw new Error("One suggestion is no longer bound to this review request");
  }
  const review = state.reviewRequests.find((item) => item.id === input.reviewRequestId);
  if (
    !review
    || review.suggestionId !== suggestion.id
    || review.originTaskId !== input.originTaskId
    || review.draftId !== input.draftId
    || review.type !== suggestion.type
    || review.createdAt !== suggestion.resolvedAt
  ) {
    throw new Error("One review handoff no longer matches its canonical draft");
  }
  if (suggestion.originTaskId !== input.originTaskId) {
    throw new Error("One review handoff no longer matches its originating Task");
  }
  const sourceTaskIds = suggestion.evidence.map((item) => item.taskId);
  if (
    sourceTaskIds.length !== review.sourceTaskRefs.length
    || sourceTaskIds.some((taskId) => !review.sourceTaskRefs.includes(taskId))
    || !review.sourceTaskRefs.includes(input.originTaskId)
  ) {
    throw new Error("One review handoff source Task references changed");
  }
  const originEvidence = suggestion.evidence.find((item) => item.taskId === input.originTaskId);
  const originTask = getCanonicalTask(input.originTaskId);
  if (
    !originEvidence
    || !originTask
    || originTask.status !== "completed"
    || originTask.version !== originEvidence.taskVersion
    || !originTask.originChatId
  ) {
    throw new Error("The originating Task changed; reopen the current Task before continuing review");
  }

  const target = reviewSurface(suggestion.type);
  const acceptedInternal = suggestion.evidence.every((item) => item.outcome === "accepted_internal_result");
  return {
    contractVersion: ONE_SUGGESTION_REVIEW_HANDOFF_CONTRACT_VERSION,
    suggestionId: suggestion.id,
    suggestionVersion: suggestion.version,
    reviewRequestId: review.id,
    draftId: review.draftId,
    originTaskId: review.originTaskId,
    type: suggestion.type,
    reviewKind: review.reviewKind,
    reviewOnly: true,
    actionState: "not_started",
    createdAt: review.createdAt,
    sourceTaskCount: review.sourceTaskRefs.length,
    evidenceBasis: acceptedInternal ? "accepted_internal_results" : "verified_outcomes",
    externalOutcomeVerified: !acceptedInternal,
    targetSurface: target.surface,
    targetRoute: reviewHandoffRoute(target, input),
    fallbackToOriginTaskWork: target.surface === "work" && suggestion.type !== "hub_derivative",
    fallbackReason: target.fallbackReason,
  };
}

export function arbitrateOneSuggestion(input: ArbitrateOneSuggestionInput): OneSuggestionArbitrationResult {
  if (!isRecord(input)) throw new TypeError("Invalid One suggestion arbitration request");
  assertOnlyKeys(input, [
    "expectedStoreVersion", "originTaskId", "patternKey", "importantBriefingActive", "evidence", "signals",
  ], "One suggestion arbitration request");
  assertPositiveVersion(input.expectedStoreVersion, "expectedStoreVersion");
  assertSafeId(input.originTaskId, "originTaskId");
  assertSafeId(input.patternKey, "patternKey");
  if (typeof input.importantBriefingActive !== "boolean") throw new TypeError("importantBriefingActive must be boolean");
  const current = assertExpectedState(input.expectedStoreVersion).state;
  const normalizedEvidence = normalizeEvidence(input.evidence, input.patternKey, input.originTaskId);
  const signals = normalizeSignals(input.signals);
  const acceptedInternalEvidence = normalizedEvidence.evidence.every((item) => item.outcome === "accepted_internal_result");
  if (input.importantBriefingActive) return noSuggestion(current, "important_briefing_active");
  if (!normalizedEvidence.verified) {
    return noSuggestion(current, acceptedInternalEvidence
      ? "verified_completion_receipt_required"
      : "host_verified_success_required");
  }
  if (normalizedEvidence.evidence.length < 2) {
    return noSuggestion(current, acceptedInternalEvidence
      ? "insufficient_verified_completions"
      : "insufficient_verified_successes");
  }
  if (current.taskArbitrations.some((item) => item.taskId === input.originTaskId)) {
    return noSuggestion(current, "completed_task_already_arbitrated");
  }
  const feedback = current.patternFeedback.find((item) => item.patternKey === input.patternKey);
  if (feedback?.nextEligibleAt && Date.parse(feedback.nextEligibleAt) > Date.now()) {
    return noSuggestion(current, "ignored_pattern_cooldown");
  }
  const selection = selectProposal(current, signals, normalizedEvidence.evidence.length, input.patternKey, Date.now());
  if (!selection.selected) {
    return noSuggestion(
      current,
      selection.hadEligibleDuplicate
        ? "duplicate_active"
        : selection.hadEligibleSuppressed
          ? "suppressed"
          : "no_eligible_candidate",
    );
  }

  const result = mutateState(input.expectedStoreVersion, (state, timestamp): Mutation<OneEcosystemSuggestion> => {
    if (state.taskArbitrations.some((item) => item.taskId === input.originTaskId)) {
      throw new Error("A completed Task may create at most one ecosystem suggestion");
    }
    const suggestion: OneEcosystemSuggestion = {
      id: opaqueId("one_suggestion"),
      version: timestamp.version,
      type: selection.selected!.type,
      originTaskId: input.originTaskId,
      patternKey: input.patternKey,
      evidence: normalizedEvidence.evidence.map((item) => ({ ...item, evidenceRefs: [...item.evidenceRefs] })),
      evidenceRefs: collectEvidenceRefs(normalizedEvidence.evidence),
      proposal: selection.selected!.proposal,
      status: "open",
      reviewRequestId: null,
      resumeAfter: null,
      cooldownUntil: null,
      createdAt: timestamp.iso,
      updatedAt: timestamp.iso,
      resolvedAt: null,
    };
    const previousFeedback = state.patternFeedback.find((item) => item.patternKey === input.patternKey);
    const nextFeedback: OneSuggestionPatternFeedback = previousFeedback
      ? { ...previousFeedback, lastShownAt: timestamp.iso, nextEligibleAt: null }
      : {
          patternKey: input.patternKey,
          ignoredCount: 0,
          consecutiveIgnoredCount: 0,
          frequencyDivisor: 1,
          lastShownAt: timestamp.iso,
          lastIgnoredAt: null,
          nextEligibleAt: null,
        };
    return {
      state: stateWithTimestamp(state, timestamp, {
        suggestions: [...state.suggestions, suggestion],
        patternFeedback: previousFeedback
          ? state.patternFeedback.map((item) => item.patternKey === input.patternKey ? nextFeedback : item)
          : [...state.patternFeedback, nextFeedback],
        taskArbitrations: [...state.taskArbitrations, {
          taskId: input.originTaskId,
          patternKey: input.patternKey,
          suggestionId: suggestion.id,
          selectedType: suggestion.type,
          arbitratedAt: timestamp.iso,
        }],
      }),
      value: suggestion,
      events: [createdEvent(suggestion)],
    };
  });
  return { storeVersion: result.storeVersion, reason: "created", suggestion: result.value };
}

function exactSuggestion(
  state: OneSuggestionState,
  suggestionId: unknown,
  expectedSuggestionVersion: unknown,
  nowMs = Date.now(),
): OneEcosystemSuggestion {
  if (typeof suggestionId !== "string" || !SUGGESTION_ID_RE.test(suggestionId)) {
    throw new TypeError("suggestionId is invalid");
  }
  assertPositiveVersion(expectedSuggestionVersion, "expectedSuggestionVersion");
  const suggestion = state.suggestions.find((item) => item.id === suggestionId);
  if (!suggestion) throw new Error("One suggestion was not found");
  if (suggestion.version !== expectedSuggestionVersion) throw new Error("One suggestion changed; refresh and retry");
  if (suggestion.status === "open") return suggestion;
  if (suggestion.status === "snoozed" && suggestion.resumeAfter && Date.parse(suggestion.resumeAfter) <= nowMs) return suggestion;
  throw new Error(`One suggestion is not actionable from status ${suggestion.status}`);
}

function reviewKind(type: OneSuggestionType): OneSuggestionReviewKind {
  if (type === "agent_build") return "agent_definition_draft";
  if (type === "retain_team") return "team_definition_draft";
  if (type === "automation") return "automation_proposal_draft";
  return "hub_derivative_draft";
}

function reviewEvent(
  suggestion: OneEcosystemSuggestion,
  review: OneSuggestionReviewRequest,
  version: number,
): RecordOneDomainEventInput {
  const base = {
    occurredAt: review.createdAt,
    actor: "user" as const,
    entityId: suggestion.id,
    taskId: suggestion.originTaskId,
    version,
    visibility: "personal" as const,
  };
  if (suggestion.type === "agent_build") {
    return {
      ...base,
      eventType: "agent.build_requested",
      entries: [
        { name: "sourceTaskRefs", value: review.sourceTaskRefs },
        { name: "agentDraftId", value: review.draftId },
      ],
    };
  }
  if (suggestion.type === "retain_team") {
    const proposal = suggestion.proposal.type === "retain_team" ? suggestion.proposal : null;
    if (!proposal) throw new Error("Team suggestion proposal is inconsistent");
    const assignmentRefs = "signalSource" in proposal
      ? proposal.participantRefs
      : proposal.assignmentRefs;
    return {
      ...base,
      eventType: "team.retention_requested",
      entries: [
        { name: "assignmentRefs", value: assignmentRefs },
        { name: "teamDraftId", value: review.draftId },
      ],
    };
  }
  if (suggestion.type === "automation") {
    const proposal = suggestion.proposal.type === "automation" ? suggestion.proposal : null;
    if (!proposal) throw new Error("Automation suggestion proposal is inconsistent");
    return {
      ...base,
      eventType: "automation.proposed",
      entries: [
        { name: "triggerPreview", value: proposal.preview.trigger },
        { name: "approvalPolicy", value: proposal.preview.approvalPolicy },
      ],
    };
  }
  const proposal = suggestion.proposal.type === "hub_derivative" ? suggestion.proposal : null;
  if (!proposal) throw new Error("Hub derivative suggestion proposal is inconsistent");
  return {
    ...base,
    eventType: "hub.derivative_requested",
    entries: [
      { name: "privateSourceId", value: proposal.privateSourceId },
      { name: "publicDraftId", value: review.draftId },
    ],
  };
}

export function acceptOneSuggestionForReview(
  input: AcceptOneSuggestionForReviewInput,
): OneSuggestionMutationResult<OneSuggestionReviewRequest> {
  if (!isRecord(input)) throw new TypeError("Invalid One suggestion review request");
  assertOnlyKeys(input, [
    "expectedStoreVersion", "suggestionId", "expectedSuggestionVersion", "confirmedByUser", "reviewOnly",
    "publicDerivativeReview",
  ], "One suggestion review request");
  assertPositiveVersion(input.expectedStoreVersion, "expectedStoreVersion");
  if (input.confirmedByUser !== true || input.reviewOnly !== true) {
    throw new Error("Suggestion acceptance may create only a user-confirmed review draft");
  }
  return mutateState(input.expectedStoreVersion, (state, timestamp) => {
    const suggestion = exactSuggestion(state, input.suggestionId, input.expectedSuggestionVersion);
    if (suggestion.type !== "hub_derivative" && input.publicDerivativeReview !== undefined) {
      throw new Error("publicDerivativeReview is valid only for a Hub derivative suggestion");
    }
    if (suggestion.type === "hub_derivative" && input.publicDerivativeReview !== true) {
      throw new Error("Hub public derivative review requires the user's explicit publicDerivativeReview selection");
    }
    const review: OneSuggestionReviewRequest = {
      id: opaqueId("one_suggestion_review"),
      suggestionId: suggestion.id,
      originTaskId: suggestion.originTaskId,
      type: suggestion.type,
      reviewKind: reviewKind(suggestion.type),
      draftId: draftId(suggestion.type),
      status: "review_required",
      sourceTaskRefs: suggestion.evidence.map((item) => item.taskId),
      createdAt: timestamp.iso,
    };
    const updated: OneEcosystemSuggestion = {
      ...suggestion,
      version: timestamp.version,
      status: "accepted_for_review",
      reviewRequestId: review.id,
      resumeAfter: null,
      cooldownUntil: null,
      updatedAt: timestamp.iso,
      resolvedAt: timestamp.iso,
    };
    const proposal = suggestion.proposal.type === "hub_derivative" ? suggestion.proposal : null;
    const prepared = proposal && input.publicDerivativeReview === true
      ? prepareOneHubDerivativeDraft({
          draftId: review.draftId,
          suggestionId: suggestion.id,
          reviewRequestId: review.id,
          originTaskId: suggestion.originTaskId,
          privateSourceId: proposal.privateSourceId,
          createdAt: timestamp.iso,
        })
      : null;
    return {
      state: stateWithTimestamp(state, timestamp, {
        suggestions: state.suggestions.map((item) => item.id === suggestion.id ? updated : item),
        reviewRequests: [...state.reviewRequests, review],
      }),
      value: review,
      events: [reviewEvent(suggestion, review, timestamp.version)],
      ...(prepared ? { commit: prepared.commit, rollback: prepared.rollback } : {}),
    };
  });
}

/** Renderer/Mobile production boundary: Hub review can never take the legacy
 * state-only test path; it must create the separate sanitized local draft. */
export function acceptOneSuggestionForReviewFromUser(
  input: AcceptOneSuggestionForReviewInput,
): OneSuggestionMutationResult<OneSuggestionReviewRequest> {
  if (!isRecord(input)) throw new TypeError("Invalid One suggestion review request");
  const current = assertExpectedState(input.expectedStoreVersion).state;
  const suggestion = current.suggestions.find((item) => item.id === input.suggestionId);
  if (!suggestion) throw new Error("One suggestion was not found");
  if (suggestion.type === "hub_derivative" && input.publicDerivativeReview !== true) {
    throw new Error("Hub public derivative review requires the user's explicit publicDerivativeReview selection");
  }
  return acceptOneSuggestionForReview(input);
}

function boundedDuration(value: unknown, fallback: number, minimum: number, label: string): number {
  const duration = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(duration) || duration < minimum || duration > MAX_COOLDOWN_MS) {
    throw new RangeError(`${label} must be between ${minimum} and ${MAX_COOLDOWN_MS} milliseconds`);
  }
  return duration;
}

function suppression(
  suggestion: OneEcosystemSuggestion,
  timestamp: { version: number; iso: string },
  scope: "pattern" | "type",
  mode: OneSuggestionSuppression["mode"],
  until: string | null,
): OneSuggestionSuppression {
  return {
    id: opaqueId("one_suggestion_suppression"),
    suggestionId: suggestion.id,
    patternKey: suggestion.patternKey,
    type: suggestion.type,
    scope,
    mode,
    createdAt: timestamp.iso,
    until,
  };
}

export function snoozeOneSuggestion(
  input: SnoozeOneSuggestionInput,
): OneSuggestionMutationResult<OneEcosystemSuggestion> {
  if (!isRecord(input)) throw new TypeError("Invalid One suggestion snooze request");
  assertOnlyKeys(input, [
    "expectedStoreVersion", "suggestionId", "expectedSuggestionVersion", "confirmedByUser", "snoozeMs",
  ], "One suggestion snooze request");
  assertPositiveVersion(input.expectedStoreVersion, "expectedStoreVersion");
  if (input.confirmedByUser !== true) throw new Error("Snoozing a suggestion requires explicit user confirmation");
  const duration = boundedDuration(input.snoozeMs, DEFAULT_SNOOZE_MS, MIN_SNOOZE_MS, "snoozeMs");
  return mutateState(input.expectedStoreVersion, (state, timestamp) => {
    const suggestion = exactSuggestion(state, input.suggestionId, input.expectedSuggestionVersion);
    const resumeAfter = new Date(timestamp.version + duration).toISOString();
    const updated: OneEcosystemSuggestion = {
      ...suggestion,
      version: timestamp.version,
      status: "snoozed",
      reviewRequestId: null,
      resumeAfter,
      cooldownUntil: resumeAfter,
      updatedAt: timestamp.iso,
      resolvedAt: null,
    };
    return {
      state: stateWithTimestamp(state, timestamp, {
        suggestions: state.suggestions.map((item) => item.id === suggestion.id ? updated : item),
        suppressions: [...state.suppressions, suppression(suggestion, timestamp, "pattern", "snooze", resumeAfter)],
      }),
      value: updated,
      events: [{
        eventType: "suggestion.snoozed",
        occurredAt: timestamp.iso,
        actor: "user",
        entityId: suggestion.id,
        taskId: suggestion.originTaskId,
        version: timestamp.version,
        visibility: "personal",
        entries: [
          { name: "suggestionId", value: suggestion.id },
          { name: "resumeAfter", value: resumeAfter },
        ],
      }],
    };
  });
}

export function dismissOneSuggestion(
  input: DismissOneSuggestionInput,
): OneSuggestionMutationResult<OneEcosystemSuggestion> {
  if (!isRecord(input)) throw new TypeError("Invalid One suggestion dismissal request");
  assertOnlyKeys(input, [
    "expectedStoreVersion", "suggestionId", "expectedSuggestionVersion", "confirmedByUser", "cooldownMs",
  ], "One suggestion dismissal request");
  assertPositiveVersion(input.expectedStoreVersion, "expectedStoreVersion");
  if (input.confirmedByUser !== true) throw new Error("Dismissing a suggestion requires explicit user confirmation");
  const duration = boundedDuration(input.cooldownMs, DEFAULT_DISMISS_COOLDOWN_MS, MIN_DISMISS_COOLDOWN_MS, "cooldownMs");
  return mutateState(input.expectedStoreVersion, (state, timestamp) => {
    const suggestion = exactSuggestion(state, input.suggestionId, input.expectedSuggestionVersion);
    const cooldownUntil = new Date(timestamp.version + duration).toISOString();
    const updated: OneEcosystemSuggestion = {
      ...suggestion,
      version: timestamp.version,
      status: "dismissed",
      reviewRequestId: null,
      resumeAfter: null,
      cooldownUntil,
      updatedAt: timestamp.iso,
      resolvedAt: timestamp.iso,
    };
    return {
      state: stateWithTimestamp(state, timestamp, {
        suggestions: state.suggestions.map((item) => item.id === suggestion.id ? updated : item),
        suppressions: [...state.suppressions, suppression(suggestion, timestamp, "type", "cooldown", cooldownUntil)],
      }),
      value: updated,
      events: [{
        eventType: "suggestion.dismissed",
        occurredAt: timestamp.iso,
        actor: "user",
        entityId: suggestion.id,
        taskId: suggestion.originTaskId,
        version: timestamp.version,
        visibility: "personal",
        entries: [
          { name: "suggestionId", value: suggestion.id },
          { name: "suppressionScope", value: "type:cooldown" },
        ],
      }],
    };
  });
}

export function neverAskOneSuggestion(
  input: NeverAskOneSuggestionInput,
): OneSuggestionMutationResult<OneEcosystemSuggestion> {
  if (!isRecord(input)) throw new TypeError("Invalid One suggestion never-ask request");
  assertOnlyKeys(input, [
    "expectedStoreVersion", "suggestionId", "expectedSuggestionVersion", "confirmedByUser",
  ], "One suggestion never-ask request");
  assertPositiveVersion(input.expectedStoreVersion, "expectedStoreVersion");
  if (input.confirmedByUser !== true) throw new Error("Never ask again requires explicit user confirmation");
  return mutateState(input.expectedStoreVersion, (state, timestamp) => {
    const suggestion = exactSuggestion(state, input.suggestionId, input.expectedSuggestionVersion);
    const updated: OneEcosystemSuggestion = {
      ...suggestion,
      version: timestamp.version,
      status: "never_ask_again",
      reviewRequestId: null,
      resumeAfter: null,
      cooldownUntil: null,
      updatedAt: timestamp.iso,
      resolvedAt: timestamp.iso,
    };
    return {
      state: stateWithTimestamp(state, timestamp, {
        suggestions: state.suggestions.map((item) => item.id === suggestion.id ? updated : item),
        suppressions: [...state.suppressions, suppression(suggestion, timestamp, "type", "never_ask_again", null)],
      }),
      value: updated,
      events: [{
        eventType: "suggestion.dismissed",
        occurredAt: timestamp.iso,
        actor: "user",
        entityId: suggestion.id,
        taskId: suggestion.originTaskId,
        version: timestamp.version,
        visibility: "personal",
        entries: [
          { name: "suggestionId", value: suggestion.id },
          { name: "suppressionScope", value: "type:never_ask_again" },
        ],
      }],
    };
  });
}

export function markOneSuggestionIgnored(
  input: MarkOneSuggestionIgnoredInput,
): OneSuggestionMutationResult<OneSuggestionPatternFeedback> {
  if (!isRecord(input)) throw new TypeError("Invalid One suggestion ignored observation");
  assertOnlyKeys(input, [
    "expectedStoreVersion", "suggestionId", "expectedSuggestionVersion", "observationConfirmed",
  ], "One suggestion ignored observation");
  assertPositiveVersion(input.expectedStoreVersion, "expectedStoreVersion");
  if (input.observationConfirmed !== true) throw new Error("Ignored frequency requires a confirmed presentation observation");
  return mutateState(input.expectedStoreVersion, (state, timestamp) => {
    const suggestion = exactSuggestion(state, input.suggestionId, input.expectedSuggestionVersion);
    const previous = state.patternFeedback.find((item) => item.patternKey === suggestion.patternKey);
    if (!previous) throw new Error("Suggestion pattern feedback was not initialized");
    const ignoredCount = previous.ignoredCount + 1;
    const consecutiveIgnoredCount = previous.consecutiveIgnoredCount + 1;
    const frequencyDivisor = Math.min(8, 2 ** Math.floor(consecutiveIgnoredCount / 2));
    const cooldownMs = Math.min(MAX_COOLDOWN_MS, DEFAULT_SNOOZE_MS * frequencyDivisor);
    const nextEligibleAt = new Date(timestamp.version + cooldownMs).toISOString();
    const feedback: OneSuggestionPatternFeedback = {
      ...previous,
      ignoredCount,
      consecutiveIgnoredCount,
      frequencyDivisor,
      lastIgnoredAt: timestamp.iso,
      nextEligibleAt,
    };
    const updated: OneEcosystemSuggestion = {
      ...suggestion,
      version: timestamp.version,
      status: "ignored",
      reviewRequestId: null,
      resumeAfter: null,
      cooldownUntil: nextEligibleAt,
      updatedAt: timestamp.iso,
      resolvedAt: timestamp.iso,
    };
    return {
      state: stateWithTimestamp(state, timestamp, {
        suggestions: state.suggestions.map((item) => item.id === suggestion.id ? updated : item),
        patternFeedback: state.patternFeedback.map((item) => item.patternKey === suggestion.patternKey ? feedback : item),
        suppressions: [
          ...state.suppressions,
          suppression(suggestion, timestamp, "pattern", "ignored_frequency", nextEligibleAt),
        ],
      }),
      value: feedback,
    };
  });
}
