import {
  isSafeOneSuggestionId,
  isSafeOneSuggestionText,
  type OneAutomationPermissionPreview,
  type OneSuggestionStatus,
  type OneSuggestionType,
} from "./one-suggestions";
import {
  ONE_HUB_DERIVATIVE_ALWAYS_EXCLUDED,
  type OneHubDerivativeExclusionCategory,
} from "./one-hub-derivative";

/** Closed, renderer-safe continuity contract for Desktop Main suggestions. */
export const ONE_MOBILE_SUGGESTION_CONTRACT_VERSION = "1.0.0" as const;

export type OneMobileSuggestionVisibleStatus = Extract<OneSuggestionStatus, "open" | "snoozed">;
export type OneMobileSuggestionEvidenceBasis = "accepted_internal_results" | "verified_outcomes";

export interface OneMobileSuggestionCopy {
  titleKo: string;
  titleEn: string;
  bodyKo: string;
  bodyEn: string;
  reviewOnly: true;
  executionStarted: false;
}

export interface OneMobileSuggestionEvidenceSummary {
  count: number;
  basis: OneMobileSuggestionEvidenceBasis;
  acceptedInternalResultCount: number;
  verifiedOutcomeCount: number;
}

export interface OneMobileSuggestionMemberRef {
  /** Stable value-free reference. It is not an installed-agent id or slug. */
  memberRef: string;
  roleRef: string;
  displayNameKo: string;
  displayNameEn: string;
  sourceStatus: "installed" | "external" | "unavailable";
}

export interface OneMobileAgentBuildScope {
  type: "agent_build";
  reviewMode: "definition_draft";
  participantCount: number;
  observedToolCount: number;
  sourceTaskCount: number;
  saved: false;
}

export interface OneMobilePluginBuildScope {
  type: "plugin_build";
  reviewMode: "plugin_builder";
  observedToolCount: number;
  sourceTaskCount: number;
  saved: false;
}

export interface OneMobileRetainTeamScope {
  type: "retain_team";
  reviewMode: "team_draft";
  members: OneMobileSuggestionMemberRef[];
  sourceTaskCount: number;
  temporaryUseAvailable: true;
  saved: false;
}

export interface OneMobileAutomationScope {
  type: "automation";
  reviewMode: "automation_proposal";
  trigger: string;
  nextRunAt: string;
  permission: OneAutomationPermissionPreview;
  stopControl: string;
  approvalPolicy: "explicit_approval_before_external_change";
  scheduled: false;
  enabled: false;
}

export interface OneMobileHubDerivativeScope {
  type: "hub_derivative";
  reviewMode: "public_derivative_scope";
  includedCategories: ["generated_review_scaffold"];
  alwaysExcludedCategories: OneHubDerivativeExclusionCategory[];
  gates: {
    entitlement: "unknown";
    rights: "unknown";
    economy: "unknown";
    fee: "unknown";
  };
  privateSourceIncluded: false;
  publishingStarted: false;
  publishAllowed: false;
  revenueGuaranteed: false;
}

export type OneMobileSuggestionScope =
  | OneMobilePluginBuildScope
  | OneMobileAgentBuildScope
  | OneMobileRetainTeamScope
  | OneMobileAutomationScope
  | OneMobileHubDerivativeScope;

/**
 * A single Main-selected suggestion for the exact completed Task and Value
 * Closure. Pattern keys, prompts, transcripts, Memory, paths, credentials,
 * system prompts, tool arguments, and draft bodies are intentionally absent.
 */
export interface OneMobileEcosystemSuggestionV1 {
  contractVersion: typeof ONE_MOBILE_SUGGESTION_CONTRACT_VERSION;
  authoritativeHostRef: string;
  storeVersion: number;
  suggestionId: string;
  suggestionVersion: number;
  type: OneSuggestionType;
  status: OneMobileSuggestionVisibleStatus;
  originTask: {
    taskId: string;
    taskVersion: number;
    status: "completed";
    valueClosureId: string;
    valueClosureVersion: number;
  };
  copy: OneMobileSuggestionCopy;
  evidence: OneMobileSuggestionEvidenceSummary;
  scope: OneMobileSuggestionScope;
  createdAt: string;
  updatedAt: string;
}

export type OneMobileSuggestionAction = "review" | "snooze" | "dismiss" | "never_ask_again";

export interface OneMobileSuggestionActionInput {
  schemaVersion: 1;
  action: OneMobileSuggestionAction;
  expectedStoreVersion: number;
  suggestionId: string;
  expectedSuggestionVersion: number;
  originTaskId: string;
  expectedTaskVersion: number;
  valueClosureId: string;
  expectedValueClosureVersion: number;
  confirmedByUser: true;
  reviewOnly: true;
}

export interface OneMobileSuggestionActionAcknowledgement {
  contractVersion: typeof ONE_MOBILE_SUGGESTION_CONTRACT_VERSION;
  action: OneMobileSuggestionAction;
  suggestionId: string;
  previousSuggestionVersion: number;
  currentSuggestionVersion: number;
  storeVersion: number;
  originTaskId: string;
  taskVersion: number;
  status: Exclude<OneSuggestionStatus, "open" | "ignored">;
  reviewOnly: true;
  executionStarted: false;
  reviewRequestId: string | null;
  targetSurface: "build" | "plugin" | "automation" | "work" | null;
}

const HOST_REF_RE = /^host_[a-f0-9]{32}$/;
const SUGGESTION_REF_RE = /^one_suggestion_[a-f0-9]{32}$/;
const REVIEW_REF_RE = /^one_suggestion_review_[a-f0-9]{32}$/;
const CLOSURE_REF_RE = /^value_closure_[a-f0-9]{32}$/;
const MEMBER_REF_RE = /^member_[a-f0-9]{32}$/;
const ROLE_REF_RE = /^role_[a-f0-9]{32}$/;
const TYPES = new Set<OneSuggestionType>(["plugin_build", "agent_build", "retain_team", "automation", "hub_derivative"]);
const PERMISSIONS = new Set<OneAutomationPermissionPreview>([
  "read_only", "draft_only", "approval_before_external_change",
]);

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  const allowed = new Set(expected);
  return keys.length === expected.length && keys.every((key) => allowed.has(key));
}

function positiveVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function boundedCount(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function copy(value: unknown): value is OneMobileSuggestionCopy {
  return record(value)
    && exactKeys(value, ["titleKo", "titleEn", "bodyKo", "bodyEn", "reviewOnly", "executionStarted"])
    && isSafeOneSuggestionText(value.titleKo)
    && isSafeOneSuggestionText(value.titleEn)
    && isSafeOneSuggestionText(value.bodyKo)
    && isSafeOneSuggestionText(value.bodyEn)
    && value.reviewOnly === true
    && value.executionStarted === false;
}

function evidence(value: unknown): value is OneMobileSuggestionEvidenceSummary {
  if (!record(value) || !exactKeys(value, [
    "count", "basis", "acceptedInternalResultCount", "verifiedOutcomeCount",
  ])) return false;
  if (!boundedCount(value.count, 2, 16)
    || !boundedCount(value.acceptedInternalResultCount, 0, 16)
    || !boundedCount(value.verifiedOutcomeCount, 0, 16)
    || Number(value.acceptedInternalResultCount) + Number(value.verifiedOutcomeCount) !== Number(value.count)) return false;
  if (value.basis === "accepted_internal_results") {
    return value.acceptedInternalResultCount === value.count && value.verifiedOutcomeCount === 0;
  }
  return value.basis === "verified_outcomes"
    && value.verifiedOutcomeCount === value.count
    && value.acceptedInternalResultCount === 0;
}

function member(value: unknown): value is OneMobileSuggestionMemberRef {
  return record(value)
    && exactKeys(value, ["memberRef", "roleRef", "displayNameKo", "displayNameEn", "sourceStatus"])
    && typeof value.memberRef === "string" && MEMBER_REF_RE.test(value.memberRef)
    && typeof value.roleRef === "string" && ROLE_REF_RE.test(value.roleRef)
    && isSafeOneSuggestionText(value.displayNameKo)
    && isSafeOneSuggestionText(value.displayNameEn)
    && ["installed", "external", "unavailable"].includes(String(value.sourceStatus));
}

function scope(
  value: unknown,
  expectedType: OneSuggestionType,
  evidenceCount: number,
): value is OneMobileSuggestionScope {
  if (!record(value) || value.type !== expectedType) return false;
  if (expectedType === "agent_build") {
    return exactKeys(value, [
      "type", "reviewMode", "participantCount", "observedToolCount", "sourceTaskCount", "saved",
    ])
      && value.reviewMode === "definition_draft"
      && boundedCount(value.participantCount, 1, 16)
      && boundedCount(value.observedToolCount, 0, 64)
      && boundedCount(value.sourceTaskCount, 2, 16)
      && value.sourceTaskCount === evidenceCount
      && value.saved === false;
  }
  if (expectedType === "plugin_build") {
    return exactKeys(value, ["type", "reviewMode", "observedToolCount", "sourceTaskCount", "saved"])
      && value.reviewMode === "plugin_builder"
      && boundedCount(value.observedToolCount, 2, 64)
      && boundedCount(value.sourceTaskCount, 3, 16)
      && value.sourceTaskCount === evidenceCount
      && value.saved === false;
  }
  if (expectedType === "retain_team") {
    return exactKeys(value, [
      "type", "reviewMode", "members", "sourceTaskCount", "temporaryUseAvailable", "saved",
    ])
      && value.reviewMode === "team_draft"
      && Array.isArray(value.members)
      && value.members.length >= 2 && value.members.length <= 16
      && value.members.every(member)
      && new Set(value.members.map((item) => item.memberRef)).size === value.members.length
      && boundedCount(value.sourceTaskCount, 2, 16)
      && value.sourceTaskCount === evidenceCount
      && value.temporaryUseAvailable === true
      && value.saved === false;
  }
  if (expectedType === "automation") {
    return exactKeys(value, [
      "type", "reviewMode", "trigger", "nextRunAt", "permission", "stopControl", "approvalPolicy",
      "scheduled", "enabled",
    ])
      && value.reviewMode === "automation_proposal"
      && isSafeOneSuggestionText(value.trigger)
      && timestamp(value.nextRunAt)
      && typeof value.permission === "string" && PERMISSIONS.has(value.permission as OneAutomationPermissionPreview)
      && isSafeOneSuggestionText(value.stopControl)
      && value.approvalPolicy === "explicit_approval_before_external_change"
      && value.scheduled === false
      && value.enabled === false;
  }
  const alwaysExcludedCategories = value.alwaysExcludedCategories;
  if (!Array.isArray(alwaysExcludedCategories)) return false;
  return exactKeys(value, [
    "type", "reviewMode", "includedCategories", "alwaysExcludedCategories", "gates",
    "privateSourceIncluded", "publishingStarted", "publishAllowed", "revenueGuaranteed",
  ])
    && value.reviewMode === "public_derivative_scope"
    && Array.isArray(value.includedCategories)
    && value.includedCategories.length === 1
    && value.includedCategories[0] === "generated_review_scaffold"
    && alwaysExcludedCategories.length === ONE_HUB_DERIVATIVE_ALWAYS_EXCLUDED.length
    && new Set(alwaysExcludedCategories).size === alwaysExcludedCategories.length
    && ONE_HUB_DERIVATIVE_ALWAYS_EXCLUDED.every((item) => alwaysExcludedCategories.includes(item))
    && record(value.gates)
    && exactKeys(value.gates, ["entitlement", "rights", "economy", "fee"])
    && value.gates.entitlement === "unknown"
    && value.gates.rights === "unknown"
    && value.gates.economy === "unknown"
    && value.gates.fee === "unknown"
    && value.privateSourceIncluded === false
    && value.publishingStarted === false
    && value.publishAllowed === false
    && value.revenueGuaranteed === false;
}

export function isOneMobileEcosystemSuggestionV1(value: unknown): value is OneMobileEcosystemSuggestionV1 {
  if (!record(value) || !exactKeys(value, [
    "contractVersion", "authoritativeHostRef", "storeVersion", "suggestionId", "suggestionVersion",
    "type", "status", "originTask", "copy", "evidence", "scope", "createdAt", "updatedAt",
  ])) return false;
  if (value.contractVersion !== ONE_MOBILE_SUGGESTION_CONTRACT_VERSION
    || typeof value.authoritativeHostRef !== "string" || !HOST_REF_RE.test(value.authoritativeHostRef)
    || !positiveVersion(value.storeVersion)
    || typeof value.suggestionId !== "string" || !SUGGESTION_REF_RE.test(value.suggestionId)
    || !positiveVersion(value.suggestionVersion)
    || typeof value.type !== "string" || !TYPES.has(value.type as OneSuggestionType)
    || !["open", "snoozed"].includes(String(value.status))
    || !record(value.originTask) || !exactKeys(value.originTask, [
      "taskId", "taskVersion", "status", "valueClosureId", "valueClosureVersion",
    ])
    || !isSafeOneSuggestionId(value.originTask.taskId)
    || !positiveVersion(value.originTask.taskVersion)
    || value.originTask.status !== "completed"
    || typeof value.originTask.valueClosureId !== "string" || !CLOSURE_REF_RE.test(value.originTask.valueClosureId)
    || !positiveVersion(value.originTask.valueClosureVersion)
    || !copy(value.copy)
    || !evidence(value.evidence)
    || !scope(value.scope, value.type as OneSuggestionType, Number(value.evidence.count))
    || !timestamp(value.createdAt) || !timestamp(value.updatedAt)
    || Date.parse(value.updatedAt) !== value.suggestionVersion
    || Date.parse(value.updatedAt) < Date.parse(value.createdAt)) return false;
  return value.storeVersion >= value.suggestionVersion;
}

export function isOneMobileSuggestionActionAcknowledgement(
  value: unknown,
): value is OneMobileSuggestionActionAcknowledgement {
  if (!record(value) || !exactKeys(value, [
    "contractVersion", "action", "suggestionId", "previousSuggestionVersion", "currentSuggestionVersion",
    "storeVersion", "originTaskId", "taskVersion", "status", "reviewOnly", "executionStarted",
    "reviewRequestId", "targetSurface",
  ])) return false;
  const actionStatusMatches = value.action === "review"
    ? value.status === "accepted_for_review"
    : value.action === "snooze"
      ? value.status === "snoozed"
      : value.action === "dismiss"
        ? value.status === "dismissed"
        : value.action === "never_ask_again" && value.status === "never_ask_again";
  return value.contractVersion === ONE_MOBILE_SUGGESTION_CONTRACT_VERSION
    && ["review", "snooze", "dismiss", "never_ask_again"].includes(String(value.action))
    && typeof value.suggestionId === "string" && SUGGESTION_REF_RE.test(value.suggestionId)
    && positiveVersion(value.previousSuggestionVersion)
    && positiveVersion(value.currentSuggestionVersion)
    && positiveVersion(value.storeVersion)
    && value.currentSuggestionVersion === value.storeVersion
    && Number(value.currentSuggestionVersion) > Number(value.previousSuggestionVersion)
    && isSafeOneSuggestionId(value.originTaskId)
    && positiveVersion(value.taskVersion)
    && ["accepted_for_review", "snoozed", "dismissed", "never_ask_again"].includes(String(value.status))
    && value.reviewOnly === true
    && value.executionStarted === false
    && (value.reviewRequestId === null
      || (typeof value.reviewRequestId === "string" && REVIEW_REF_RE.test(value.reviewRequestId)))
    && (value.targetSurface === null
      || ["build", "plugin", "automation", "work"].includes(String(value.targetSurface)))
    && actionStatusMatches
    && (value.action === "review"
      ? value.status === "accepted_for_review" && value.reviewRequestId !== null && value.targetSurface !== null
      : value.reviewRequestId === null && value.targetSurface === null);
}
