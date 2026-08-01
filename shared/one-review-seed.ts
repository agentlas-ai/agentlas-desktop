import { isSafeOneSuggestionId, isSafeOneSuggestionText } from "./one-suggestions";

export const ONE_REVIEW_SEED_CONTRACT_VERSION = "1.0.0" as const;

export type OneReviewSeedSurface = "build" | "automation" | "work";
export type OneReviewSeedBlockedReason =
  | "source_evidence_changed"
  | "installed_agent_unavailable"
  | "proposal_not_materializable"
  | "unsupported_review_surface";

export interface OneReviewSeedBinding {
  suggestionId: string;
  suggestionVersion: number;
  reviewRequestId: string;
  draftId: string;
  originTaskId: string;
}

export interface OneReviewInstalledAgentRef {
  agentId: string;
  slug: string;
  /** Exact, value-free installation identity. Never a local source path. */
  installedAt: string;
  packageHash: string | null;
  name: string;
  nameEn: string;
  tagline: string;
  taglineEn: string;
  trustGrade: "A" | "B" | "C" | "unknown";
}

interface OneReviewSeedBase extends OneReviewSeedBinding {
  contractVersion: typeof ONE_REVIEW_SEED_CONTRACT_VERSION;
  reviewOnly: true;
  actionState: "not_started";
  sourceTaskCount: number;
  acceptedResultCount: number;
  targetSurface: OneReviewSeedSurface;
}

export interface OneAgentBuildReviewSeed extends OneReviewSeedBase {
  kind: "agent_build";
  materialization: "editor_prefill";
  targetSurface: "build";
  buildMode: "single";
  candidate: OneReviewInstalledAgentRef;
  observedToolCount: number;
}

export interface OneRetainTeamReviewSeed extends OneReviewSeedBase {
  kind: "retain_team";
  materialization: "editor_prefill";
  targetSurface: "work";
  candidates: OneReviewInstalledAgentRef[];
}

export interface OneAutomationReviewSeed extends OneReviewSeedBase {
  kind: "automation";
  materialization: "editor_prefill";
  targetSurface: "automation";
  name: "One suggested automation";
  triggerPreview: string;
  permission: "read_only" | "draft_only" | "approval_before_external_change";
  approvalPolicy: "explicit_approval_before_external_change";
  stopControl: string;
  executableScheduleIncluded: false;
}

export interface OneHubDerivativeReviewSeed extends OneReviewSeedBase {
  kind: "hub_derivative";
  materialization: "scope_review";
  targetSurface: "work";
  excludedPrivateCategories: Array<
    "memory" | "credentials" | "local_paths" | "customer_data" | "private_examples" | "raw_task_context"
  >;
  publishingStarted: false;
}

export interface OneBlockedReviewSeed extends OneReviewSeedBase {
  kind: "blocked";
  materialization: "blocked";
  reason: OneReviewSeedBlockedReason;
}

export type OneSuggestionReviewSeed =
  | OneAgentBuildReviewSeed
  | OneRetainTeamReviewSeed
  | OneAutomationReviewSeed
  | OneHubDerivativeReviewSeed
  | OneBlockedReviewSeed;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  const actual = Object.keys(value);
  return actual.length === allowed.length && actual.every((key) => keys.has(key));
}

function isPositiveVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isAgentRef(value: unknown): value is OneReviewInstalledAgentRef {
  if (!isRecord(value) || !exactKeys(value, [
    "agentId", "slug", "installedAt", "packageHash", "name", "nameEn", "tagline", "taglineEn", "trustGrade",
  ])) return false;
  return isSafeOneSuggestionId(value.agentId)
    && isSafeOneSuggestionId(value.slug)
    && isTimestamp(value.installedAt)
    && (value.packageHash === null || (typeof value.packageHash === "string" && /^[a-f0-9]{64}$/.test(value.packageHash)))
    && isSafeOneSuggestionText(value.name)
    && isSafeOneSuggestionText(value.nameEn)
    && isSafeOneSuggestionText(value.tagline)
    && isSafeOneSuggestionText(value.taglineEn)
    && ["A", "B", "C", "unknown"].includes(String(value.trustGrade));
}

function isAgentRefList(value: unknown): value is OneReviewInstalledAgentRef[] {
  return Array.isArray(value)
    && value.length >= 2
    && value.length <= 16
    && value.every(isAgentRef)
    && new Set(value.map((item) => item.agentId)).size === value.length;
}

function hasAllPrivateExclusions(value: unknown): value is OneHubDerivativeReviewSeed["excludedPrivateCategories"] {
  const required: OneHubDerivativeReviewSeed["excludedPrivateCategories"] = [
    "memory", "credentials", "local_paths", "customer_data", "private_examples", "raw_task_context",
  ];
  return Array.isArray(value)
    && value.length === required.length
    && value.every((item) => typeof item === "string")
    && required.every((item) => value.includes(item));
}

const BASE_KEYS = [
  "contractVersion", "suggestionId", "suggestionVersion", "reviewRequestId", "draftId",
  "originTaskId", "reviewOnly", "actionState", "sourceTaskCount", "acceptedResultCount",
  "targetSurface", "kind", "materialization",
] as const;

function validBase(value: Record<string, unknown>): boolean {
  return value.contractVersion === ONE_REVIEW_SEED_CONTRACT_VERSION
    && isSafeOneSuggestionId(value.suggestionId)
    && isPositiveVersion(value.suggestionVersion)
    && isSafeOneSuggestionId(value.reviewRequestId)
    && isSafeOneSuggestionId(value.draftId)
    && isSafeOneSuggestionId(value.originTaskId)
    && value.reviewOnly === true
    && value.actionState === "not_started"
    && Number.isSafeInteger(value.sourceTaskCount)
    && Number(value.sourceTaskCount) >= 2
    && Number(value.sourceTaskCount) <= 32
    && Number.isSafeInteger(value.acceptedResultCount)
    && Number(value.acceptedResultCount) >= 0
    && Number(value.acceptedResultCount) <= Number(value.sourceTaskCount);
}

export function isOneSuggestionReviewSeed(value: unknown): value is OneSuggestionReviewSeed {
  if (!isRecord(value) || !validBase(value)) return false;
  if (value.kind === "agent_build") {
    return exactKeys(value, [...BASE_KEYS, "buildMode", "candidate", "observedToolCount"])
      && value.materialization === "editor_prefill"
      && value.targetSurface === "build"
      && value.buildMode === "single"
      && isAgentRef(value.candidate)
      && Number.isSafeInteger(value.observedToolCount)
      && Number(value.observedToolCount) >= 1
      && Number(value.observedToolCount) <= 64
      && Number(value.acceptedResultCount) >= 2;
  }
  if (value.kind === "retain_team") {
    return exactKeys(value, [...BASE_KEYS, "candidates"])
      && value.materialization === "editor_prefill"
      && value.targetSurface === "work"
      && isAgentRefList(value.candidates)
      && Number(value.acceptedResultCount) >= 2;
  }
  if (value.kind === "automation") {
    return exactKeys(value, [
      ...BASE_KEYS, "name", "triggerPreview", "permission", "approvalPolicy",
      "stopControl", "executableScheduleIncluded",
    ])
      && value.materialization === "editor_prefill"
      && value.targetSurface === "automation"
      && value.name === "One suggested automation"
      && isSafeOneSuggestionText(value.triggerPreview)
      && ["read_only", "draft_only", "approval_before_external_change"].includes(String(value.permission))
      && value.approvalPolicy === "explicit_approval_before_external_change"
      && isSafeOneSuggestionText(value.stopControl)
      && value.executableScheduleIncluded === false;
  }
  if (value.kind === "hub_derivative") {
    return exactKeys(value, [...BASE_KEYS, "excludedPrivateCategories", "publishingStarted"])
      && value.materialization === "scope_review"
      && value.targetSurface === "work"
      && hasAllPrivateExclusions(value.excludedPrivateCategories)
      && value.publishingStarted === false;
  }
  if (value.kind === "blocked") {
    return exactKeys(value, [...BASE_KEYS, "reason"])
      && value.materialization === "blocked"
      && ["build", "automation", "work"].includes(String(value.targetSurface))
      && [
        "source_evidence_changed", "installed_agent_unavailable", "proposal_not_materializable",
        "unsupported_review_surface",
      ].includes(String(value.reason));
  }
  return false;
}
