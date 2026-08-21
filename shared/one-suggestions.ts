import { redactSecrets } from "./secret-patterns";

export const ONE_SUGGESTION_CONTRACT_VERSION = "1.0.0" as const;
export const ONE_SUGGESTION_REVIEW_HANDOFF_CONTRACT_VERSION = "1.0.0" as const;

export const ONE_SUGGESTION_PRIORITY = [
  "plugin_build",
  "agent_build",
  "retain_team",
  "automation",
  "hub_derivative",
] as const;

export const ONE_HUB_PRIVATE_EXCLUSIONS = [
  "memory",
  "credentials",
  "local_paths",
  "customer_data",
  "private_examples",
  "raw_task_context",
] as const;

export type OneSuggestionType = typeof ONE_SUGGESTION_PRIORITY[number];
export type OneHubPrivateExclusion = typeof ONE_HUB_PRIVATE_EXCLUSIONS[number];
export type OneSuggestionStatus =
  | "open"
  | "accepted_for_review"
  | "snoozed"
  | "dismissed"
  | "never_ask_again"
  | "ignored";
export type OneSuggestionReviewKind =
  | "plugin_definition_draft"
  | "agent_definition_draft"
  | "team_definition_draft"
  | "automation_proposal_draft"
  | "hub_derivative_draft";
export type OneSuggestionArbitrationReason =
  | "created"
  | "important_briefing_active"
  | "host_verified_success_required"
  | "verified_completion_receipt_required"
  | "insufficient_verified_successes"
  | "insufficient_verified_completions"
  | "completed_task_already_arbitrated"
  | "no_eligible_candidate"
  | "duplicate_active"
  | "suppressed"
  | "ignored_pattern_cooldown";

interface OneSuggestionTaskEvidenceBase {
  taskId: string;
  taskVersion: number;
  patternKey: string;
  status: "completed";
  hostId: string;
  runId: string;
  completionReceiptRef: string;
  verificationRef: string;
  evidenceRefs: string[];
  completedAt: string;
}

/**
 * Legacy/manual evidence for a separately verified successful outcome. The
 * accepted-result producer below never manufactures this stronger claim.
 */
export interface OneSuggestionVerifiedSuccessEvidence extends OneSuggestionTaskEvidenceBase {
  outcome: "success";
  hostVerified: true;
}

/**
 * Truth-bounded evidence emitted only after Main has matched a durable internal
 * run receipt to the user's exact Canonical Task result acceptance. It does not
 * claim that publishing, purchasing, delivery, or any other external outcome
 * succeeded.
 */
export interface OneSuggestionAcceptedResultEvidence extends OneSuggestionTaskEvidenceBase {
  outcome: "accepted_internal_result";
  acceptanceReceiptVerified: true;
}

export type OneSuggestionTaskEvidence =
  | OneSuggestionVerifiedSuccessEvidence
  | OneSuggestionAcceptedResultEvidence;

export interface OneDeclaredAgentBuildSignal {
  roleRef: string;
  inputSchemaRef: string;
  outputContractRef: string;
  reuseIntentRef: string;
  userReuseIntentConfirmed: true;
}

/** A content-free repeated-use observation. Accepting it still starts review only. */
export interface OneObservedAgentBuildSignal {
  signalSource: "accepted_result_pattern";
  participantRef: string;
  roleRef: string;
  taskKindRef: string;
  toolRefs: string[];
  observationRefs: string[];
  acceptedResultCount: number;
  reviewRequired: true;
}

export type OneAgentBuildSignal = OneDeclaredAgentBuildSignal | OneObservedAgentBuildSignal;

export interface OneDeclaredPluginBuildSignal {
  procedureRef: string;
  toolRefs: string[];
  reuseIntentRef: string;
  userReuseIntentConfirmed: true;
}

export interface OneObservedPluginBuildSignal {
  signalSource: "accepted_result_pattern";
  patternKey: string;
  taskKindRef: string;
  toolRefs: string[];
  observationRefs: string[];
  acceptedResultCount: number;
  reviewRequired: true;
}

export type OnePluginBuildSignal = OneDeclaredPluginBuildSignal | OneObservedPluginBuildSignal;

export interface OneVerifiedRetainTeamSignal {
  teamSignatureRef: string;
  assignmentRefs: string[];
  roleRefs: string[];
  contributionEvidenceRefs: string[];
  teamBenefitEvidenceRef: string;
}

/**
 * A lower-claim team candidate: Main observed the same participant roster in
 * repeated accepted internal results, but has not inferred quality or speed.
 */
export interface OneObservedRetainTeamSignal {
  signalSource: "accepted_result_pattern";
  teamSignatureRef: string;
  participantRefs: string[];
  roleRefs: string[];
  toolRefs: string[];
  contributionReceiptRefs: string[];
  acceptedResultRefs: string[];
  acceptedResultCount: number;
  reviewRequired: true;
}

export type OneRetainTeamSignal = OneVerifiedRetainTeamSignal | OneObservedRetainTeamSignal;

export type OneAutomationPermissionPreview =
  | "read_only"
  | "draft_only"
  | "approval_before_external_change";

export interface OneAutomationPreview {
  trigger: string;
  nextRunAt: string;
  permission: OneAutomationPermissionPreview;
  stopControl: string;
  approvalPolicy: "explicit_approval_before_external_change";
}

export interface OneAutomationSignal {
  intentRef: string;
  startConditionRef: string;
  endConditionRef: string;
  repeatedIntentCount: number;
  reversible: true;
  riskControlsVerified: true;
  preview: OneAutomationPreview;
}

export interface OneHubEconomyAvailability {
  available: true;
  policyRef: string;
  feeScheduleRef: string;
  settlementRuleRef: string;
}

export interface OneHubDerivativeSignal {
  privateSourceId: string;
  ownerVerified: true;
  publicReleaseIntentConfirmed: true;
  privateInputExcluded: true;
  publicSuitability: "passed";
  publicSuitabilityRef: string;
  sanitizedManifestRef: string;
  rightsReviewRef: string;
  economy: OneHubEconomyAvailability;
  excludedPrivateCategories: OneHubPrivateExclusion[];
}

export interface OneSuggestionCandidateSignals {
  pluginBuild: OnePluginBuildSignal | null;
  agentBuild: OneAgentBuildSignal | null;
  retainTeam: OneRetainTeamSignal | null;
  automation: OneAutomationSignal | null;
  hubDerivative: OneHubDerivativeSignal | null;
}

export type OnePluginBuildProposal = OnePluginBuildSignal & { type: "plugin_build" };

export type OneAgentBuildProposal = OneAgentBuildSignal & { type: "agent_build" };

export type OneRetainTeamProposal = OneRetainTeamSignal & { type: "retain_team" };

export interface OneAutomationProposal extends OneAutomationSignal {
  type: "automation";
}

export interface OneHubDerivativeProposal extends OneHubDerivativeSignal {
  type: "hub_derivative";
}

export type OneSuggestionProposal =
  | OnePluginBuildProposal
  | OneAgentBuildProposal
  | OneRetainTeamProposal
  | OneAutomationProposal
  | OneHubDerivativeProposal;

export interface OneEcosystemSuggestion {
  id: string;
  version: number;
  type: OneSuggestionType;
  originTaskId: string;
  patternKey: string;
  evidence: OneSuggestionTaskEvidence[];
  evidenceRefs: string[];
  proposal: OneSuggestionProposal;
  status: OneSuggestionStatus;
  reviewRequestId: string | null;
  resumeAfter: string | null;
  cooldownUntil: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export interface OneSuggestionReviewRequest {
  id: string;
  suggestionId: string;
  originTaskId: string;
  type: OneSuggestionType;
  reviewKind: OneSuggestionReviewKind;
  draftId: string;
  status: "review_required";
  sourceTaskRefs: string[];
  createdAt: string;
}

export type OneSuggestionReviewSurface =
  | "plugin"
  | "build"
  | "automation"
  | "work";

/**
 * Opaque, read-only reference used to reopen an accepted suggestion in a real
 * Desktop review surface. It intentionally carries no prompt, transcript,
 * local path, credential, Memory, or draft body.
 */
export interface OneSuggestionReviewHandoffInput {
  suggestionId: string;
  expectedSuggestionVersion: number;
  reviewRequestId: string;
  draftId: string;
  originTaskId: string;
}

export interface OneSuggestionReviewHandoff {
  contractVersion: typeof ONE_SUGGESTION_REVIEW_HANDOFF_CONTRACT_VERSION;
  suggestionId: string;
  suggestionVersion: number;
  reviewRequestId: string;
  draftId: string;
  originTaskId: string;
  type: OneSuggestionType;
  reviewKind: OneSuggestionReviewKind;
  reviewOnly: true;
  actionState: "not_started";
  createdAt: string;
  sourceTaskCount: number;
  evidenceBasis: "accepted_internal_results" | "verified_outcomes";
  externalOutcomeVerified: boolean;
  targetSurface: OneSuggestionReviewSurface;
  targetRoute: string;
  fallbackToOriginTaskWork: boolean;
  fallbackReason: "no_public_derivative_editor" | null;
}

export type OneSuggestionSuppressionMode =
  | "snooze"
  | "cooldown"
  | "never_ask_again"
  | "ignored_frequency";

export interface OneSuggestionSuppression {
  id: string;
  suggestionId: string;
  patternKey: string;
  type: OneSuggestionType;
  scope: "pattern" | "type";
  mode: OneSuggestionSuppressionMode;
  createdAt: string;
  until: string | null;
}

export interface OneSuggestionPatternFeedback {
  patternKey: string;
  ignoredCount: number;
  consecutiveIgnoredCount: number;
  frequencyDivisor: number;
  lastShownAt: string;
  lastIgnoredAt: string | null;
  nextEligibleAt: string | null;
}

export interface OneSuggestionTaskArbitration {
  taskId: string;
  patternKey: string;
  suggestionId: string;
  selectedType: OneSuggestionType;
  arbitratedAt: string;
}

export interface OneSuggestionState {
  contractVersion: typeof ONE_SUGGESTION_CONTRACT_VERSION;
  version: number;
  suggestions: OneEcosystemSuggestion[];
  reviewRequests: OneSuggestionReviewRequest[];
  suppressions: OneSuggestionSuppression[];
  patternFeedback: OneSuggestionPatternFeedback[];
  taskArbitrations: OneSuggestionTaskArbitration[];
  createdAt: string;
  updatedAt: string;
}

export interface ArbitrateOneSuggestionInput {
  expectedStoreVersion: number;
  originTaskId: string;
  patternKey: string;
  importantBriefingActive: boolean;
  evidence: OneSuggestionTaskEvidence[];
  signals: OneSuggestionCandidateSignals;
}

export interface OneSuggestionArbitrationResult {
  storeVersion: number;
  reason: OneSuggestionArbitrationReason;
  suggestion: OneEcosystemSuggestion | null;
}

export interface AcceptOneSuggestionForReviewInput {
  expectedStoreVersion: number;
  suggestionId: string;
  expectedSuggestionVersion: number;
  confirmedByUser: true;
  reviewOnly: true;
  /** Required only for Hub derivatives; proves the user selected the distinct public-review action. */
  publicDerivativeReview?: true;
}

export interface SnoozeOneSuggestionInput {
  expectedStoreVersion: number;
  suggestionId: string;
  expectedSuggestionVersion: number;
  confirmedByUser: true;
  snoozeMs?: number;
}

export interface DismissOneSuggestionInput {
  expectedStoreVersion: number;
  suggestionId: string;
  expectedSuggestionVersion: number;
  confirmedByUser: true;
  cooldownMs?: number;
}

export interface NeverAskOneSuggestionInput {
  expectedStoreVersion: number;
  suggestionId: string;
  expectedSuggestionVersion: number;
  confirmedByUser: true;
}

export interface MarkOneSuggestionIgnoredInput {
  expectedStoreVersion: number;
  suggestionId: string;
  expectedSuggestionVersion: number;
  observationConfirmed: true;
}

export interface OneSuggestionMutationResult<T> {
  storeVersion: number;
  updatedAt: string;
  value: T;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const SUGGESTION_ID_RE = /^one_suggestion_[a-f0-9]{32}$/;
const REVIEW_ID_RE = /^one_suggestion_review_[a-f0-9]{32}$/;
const DRAFT_ID_RE = /^one_(?:plugin|agent|team|automation|hub)_draft_[a-f0-9]{32}$/;
const SUPPRESSION_ID_RE = /^one_suggestion_suppression_[a-f0-9]{32}$/;
const POSIX_ABSOLUTE_PATH_RE = /(^|[\s("'=:\[{])\/[^\s,;:"'`<>|}\]]+/m;
const WINDOWS_ABSOLUTE_PATH_RE = /\b[A-Za-z]:\\(?:[^\\,\r\n"'`<>|}\]]+\\)*[^\s\\,\r\n"'`<>|}\]]+/;
const UNC_PATH_RE = /\\\\[^\\\s,;:"'`<>|}\]]+(?:\\[^\\\s,;:"'`<>|}\]]+)+/;
const EXECUTABLE_OR_TRANSPORT_RE = /(?:<\/?(?:html|body|script|iframe|object|embed)\b|javascript\s*:|data\s*:|\b(?:https?|file):\/\/|dangerouslySetInnerHTML|\bon(?:error|load|click)\s*=)/i;
const RAW_TRANSCRIPT_RE = /(?:^|\n)\s*(?:user|assistant|system|customer|agent|사용자|어시스턴트)\s*:/i;
const TYPES = new Set<string>(ONE_SUGGESTION_PRIORITY);
const STATUSES = new Set<OneSuggestionStatus>([
  "open", "accepted_for_review", "snoozed", "dismissed", "never_ask_again", "ignored",
]);
const PERMISSIONS = new Set<OneAutomationPermissionPreview>([
  "read_only", "draft_only", "approval_before_external_change",
]);
const SUPPRESSION_MODES = new Set<OneSuggestionSuppressionMode>([
  "snooze", "cooldown", "never_ask_again", "ignored_frequency",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isPositiveVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

export function isSafeOneSuggestionId(value: unknown): value is string {
  return typeof value === "string" && ID_RE.test(value) && redactSecrets(value) === value;
}

export type OneSuggestionUnsafeTextReason =
  | "secret"
  | "local_path"
  | "transport_or_markup"
  | "raw_transcript";

export function unsafeOneSuggestionTextReason(value: string): OneSuggestionUnsafeTextReason | null {
  if (redactSecrets(value) !== value) return "secret";
  if (EXECUTABLE_OR_TRANSPORT_RE.test(value)) return "transport_or_markup";
  if (POSIX_ABSOLUTE_PATH_RE.test(value) || WINDOWS_ABSOLUTE_PATH_RE.test(value) || UNC_PATH_RE.test(value)) {
    return "local_path";
  }
  if (RAW_TRANSCRIPT_RE.test(value)) return "raw_transcript";
  return null;
}

export function isSafeOneSuggestionText(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 240
    && !unsafeOneSuggestionTextReason(value);
}

function uniqueSafeIds(value: unknown, minimum = 1, maximum = 64): value is string[] {
  return Array.isArray(value)
    && value.length >= minimum
    && value.length <= maximum
    && value.every(isSafeOneSuggestionId)
    && new Set(value).size === value.length;
}

function isEvidence(value: unknown): value is OneSuggestionTaskEvidence {
  if (!isRecord(value)) return false;
  const acceptedInternal = value.outcome === "accepted_internal_result";
  if (!exactKeys(value, [
    "taskId", "taskVersion", "patternKey", "status", "outcome", "hostVerified", "hostId", "runId",
    "acceptanceReceiptVerified", "completionReceiptRef", "verificationRef", "evidenceRefs", "completedAt",
  ])) return false;
  const claimIsValid = acceptedInternal
    ? value.acceptanceReceiptVerified === true && value.hostVerified === undefined
    : value.outcome === "success" && value.hostVerified === true && value.acceptanceReceiptVerified === undefined;
  return claimIsValid
    && isSafeOneSuggestionId(value.taskId)
    && isPositiveVersion(value.taskVersion)
    && isSafeOneSuggestionId(value.patternKey)
    && value.status === "completed"
    && isSafeOneSuggestionId(value.hostId)
    && isSafeOneSuggestionId(value.runId)
    && value.completionReceiptRef === value.runId
    && isSafeOneSuggestionId(value.completionReceiptRef)
    && isSafeOneSuggestionId(value.verificationRef)
    && uniqueSafeIds(value.evidenceRefs, 1, 32)
    && isTimestamp(value.completedAt);
}

function isAgentBuildSignal(value: unknown): value is OneAgentBuildSignal {
  if (!isRecord(value)) return false;
  if (value.signalSource === "accepted_result_pattern") {
    return exactKeys(value, [
      "signalSource", "participantRef", "roleRef", "taskKindRef", "toolRefs", "observationRefs",
      "acceptedResultCount", "reviewRequired",
    ])
      && isSafeOneSuggestionId(value.participantRef)
      && isSafeOneSuggestionId(value.roleRef)
      && isSafeOneSuggestionId(value.taskKindRef)
      && uniqueSafeIds(value.toolRefs, 0, 64)
      && uniqueSafeIds(value.observationRefs, 2, 16)
      && Number.isSafeInteger(value.acceptedResultCount)
      && Number(value.acceptedResultCount) === value.observationRefs.length
      && value.reviewRequired === true;
  }
  if (!exactKeys(value, [
    "roleRef", "inputSchemaRef", "outputContractRef", "reuseIntentRef", "userReuseIntentConfirmed",
  ])) return false;
  return isSafeOneSuggestionId(value.roleRef)
    && isSafeOneSuggestionId(value.inputSchemaRef)
    && isSafeOneSuggestionId(value.outputContractRef)
    && isSafeOneSuggestionId(value.reuseIntentRef)
    && value.userReuseIntentConfirmed === true;
}

export function isOnePluginBuildSignal(value: unknown): value is OnePluginBuildSignal {
  if (!isRecord(value)) return false;
  if (value.signalSource === "accepted_result_pattern") {
    return exactKeys(value, [
      "signalSource", "patternKey", "taskKindRef", "toolRefs", "observationRefs",
      "acceptedResultCount", "reviewRequired",
    ])
      && isSafeOneSuggestionId(value.patternKey)
      && isSafeOneSuggestionId(value.taskKindRef)
      && uniqueSafeIds(value.toolRefs, 2, 64)
      && uniqueSafeIds(value.observationRefs, 3, 16)
      && Number.isSafeInteger(value.acceptedResultCount)
      && Number(value.acceptedResultCount) === value.observationRefs.length
      && Number(value.acceptedResultCount) >= 3
      && value.reviewRequired === true;
  }
  return exactKeys(value, ["procedureRef", "toolRefs", "reuseIntentRef", "userReuseIntentConfirmed"])
    && isSafeOneSuggestionId(value.procedureRef)
    && uniqueSafeIds(value.toolRefs, 2, 64)
    && isSafeOneSuggestionId(value.reuseIntentRef)
    && value.userReuseIntentConfirmed === true;
}

function isRetainTeamSignal(value: unknown): value is OneRetainTeamSignal {
  if (!isRecord(value)) return false;
  if (value.signalSource === "accepted_result_pattern") {
    return exactKeys(value, [
      "signalSource", "teamSignatureRef", "participantRefs", "roleRefs", "toolRefs",
      "contributionReceiptRefs", "acceptedResultRefs", "acceptedResultCount", "reviewRequired",
    ])
      && isSafeOneSuggestionId(value.teamSignatureRef)
      && uniqueSafeIds(value.participantRefs, 2, 32)
      && uniqueSafeIds(value.roleRefs, 1, 32)
      && uniqueSafeIds(value.toolRefs, 0, 64)
      && uniqueSafeIds(value.contributionReceiptRefs, 2, 64)
      && uniqueSafeIds(value.acceptedResultRefs, 2, 16)
      && Number.isSafeInteger(value.acceptedResultCount)
      && Number(value.acceptedResultCount) === value.acceptedResultRefs.length
      && value.reviewRequired === true;
  }
  if (!exactKeys(value, [
    "teamSignatureRef", "assignmentRefs", "roleRefs", "contributionEvidenceRefs", "teamBenefitEvidenceRef",
  ])) return false;
  return isSafeOneSuggestionId(value.teamSignatureRef)
    && uniqueSafeIds(value.assignmentRefs, 2, 32)
    && uniqueSafeIds(value.roleRefs, 2, 32)
    && uniqueSafeIds(value.contributionEvidenceRefs, 2, 64)
    && isSafeOneSuggestionId(value.teamBenefitEvidenceRef);
}

function isAutomationPreview(value: unknown): value is OneAutomationPreview {
  if (!isRecord(value) || !exactKeys(value, [
    "trigger", "nextRunAt", "permission", "stopControl", "approvalPolicy",
  ])) return false;
  return isSafeOneSuggestionText(value.trigger)
    && isTimestamp(value.nextRunAt)
    && typeof value.permission === "string"
    && PERMISSIONS.has(value.permission as OneAutomationPermissionPreview)
    && isSafeOneSuggestionText(value.stopControl)
    && value.approvalPolicy === "explicit_approval_before_external_change";
}

function isAutomationSignal(value: unknown): value is OneAutomationSignal {
  if (!isRecord(value) || !exactKeys(value, [
    "intentRef", "startConditionRef", "endConditionRef", "repeatedIntentCount",
    "reversible", "riskControlsVerified", "preview",
  ])) return false;
  return isSafeOneSuggestionId(value.intentRef)
    && isSafeOneSuggestionId(value.startConditionRef)
    && isSafeOneSuggestionId(value.endConditionRef)
    && Number.isSafeInteger(value.repeatedIntentCount)
    && Number(value.repeatedIntentCount) >= 3
    && value.reversible === true
    && value.riskControlsVerified === true
    && isAutomationPreview(value.preview);
}

function hasExactHubExclusions(value: unknown): value is OneHubPrivateExclusion[] {
  return Array.isArray(value)
    && value.length === ONE_HUB_PRIVATE_EXCLUSIONS.length
    && value.every((item) => typeof item === "string" && ONE_HUB_PRIVATE_EXCLUSIONS.includes(item as OneHubPrivateExclusion))
    && new Set(value).size === ONE_HUB_PRIVATE_EXCLUSIONS.length;
}

function isHubEconomy(value: unknown): value is OneHubEconomyAvailability {
  if (!isRecord(value) || !exactKeys(value, ["available", "policyRef", "feeScheduleRef", "settlementRuleRef"])) return false;
  return value.available === true
    && isSafeOneSuggestionId(value.policyRef)
    && isSafeOneSuggestionId(value.feeScheduleRef)
    && isSafeOneSuggestionId(value.settlementRuleRef);
}

function isHubDerivativeSignal(value: unknown): value is OneHubDerivativeSignal {
  if (!isRecord(value) || !exactKeys(value, [
    "privateSourceId", "ownerVerified", "publicReleaseIntentConfirmed", "privateInputExcluded", "publicSuitability",
    "publicSuitabilityRef", "sanitizedManifestRef", "rightsReviewRef", "economy",
    "excludedPrivateCategories",
  ])) return false;
  return isSafeOneSuggestionId(value.privateSourceId)
    && value.ownerVerified === true
    && value.publicReleaseIntentConfirmed === true
    && value.privateInputExcluded === true
    && value.publicSuitability === "passed"
    && isSafeOneSuggestionId(value.publicSuitabilityRef)
    && isSafeOneSuggestionId(value.sanitizedManifestRef)
    && isSafeOneSuggestionId(value.rightsReviewRef)
    && isHubEconomy(value.economy)
    && hasExactHubExclusions(value.excludedPrivateCategories);
}

function isProposal(value: unknown): value is OneSuggestionProposal {
  if (!isRecord(value) || typeof value.type !== "string" || !TYPES.has(value.type)) return false;
  const { type, ...signal } = value;
  if (type === "plugin_build") return isOnePluginBuildSignal(signal);
  if (type === "agent_build") return isAgentBuildSignal(signal);
  if (type === "retain_team") return isRetainTeamSignal(signal);
  if (type === "automation") return isAutomationSignal(signal);
  return isHubDerivativeSignal(signal);
}

function isSuggestion(value: unknown): value is OneEcosystemSuggestion {
  if (!isRecord(value) || !exactKeys(value, [
    "id", "version", "type", "originTaskId", "patternKey", "evidence", "evidenceRefs", "proposal",
    "status", "reviewRequestId", "resumeAfter", "cooldownUntil", "createdAt", "updatedAt", "resolvedAt",
  ])) return false;
  if (
    typeof value.id !== "string" || !SUGGESTION_ID_RE.test(value.id)
    || !isPositiveVersion(value.version)
    || typeof value.type !== "string" || !TYPES.has(value.type)
    || !isSafeOneSuggestionId(value.originTaskId)
    || !isSafeOneSuggestionId(value.patternKey)
    || !Array.isArray(value.evidence) || value.evidence.length < 2 || value.evidence.length > 16
    || !value.evidence.every(isEvidence)
    || new Set(value.evidence.map((item) => item.taskId)).size !== value.evidence.length
    || new Set(value.evidence.map((item) => item.hostId)).size !== 1
    || new Set(value.evidence.map((item) => item.outcome)).size !== 1
    || !value.evidence.every((item) => item.patternKey === value.patternKey)
    || !value.evidence.some((item) => item.taskId === value.originTaskId)
    || !uniqueSafeIds(value.evidenceRefs, 2, 64)
    || !isProposal(value.proposal) || value.proposal.type !== value.type
    || typeof value.status !== "string" || !STATUSES.has(value.status as OneSuggestionStatus)
    || !(value.reviewRequestId === null || (typeof value.reviewRequestId === "string" && REVIEW_ID_RE.test(value.reviewRequestId)))
    || !(value.resumeAfter === null || isTimestamp(value.resumeAfter))
    || !(value.cooldownUntil === null || isTimestamp(value.cooldownUntil))
    || !isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt)
    || Date.parse(value.updatedAt) !== value.version
    || !(value.resolvedAt === null || isTimestamp(value.resolvedAt))
  ) return false;
  const evidence = value.evidence;
  const evidenceRefs = value.evidenceRefs;
  const exactEvidenceRefs = [...new Set(evidence.flatMap((item) => [
    item.completionReceiptRef,
    item.verificationRef,
    ...item.evidenceRefs,
  ]))];
  if (
    exactEvidenceRefs.length !== evidenceRefs.length
    || exactEvidenceRefs.some((item) => !evidenceRefs.includes(item))
  ) return false;
  const latestCompletedAt = Math.max(...evidence.map((item) => Date.parse(item.completedAt)));
  const origin = evidence.find((item) => item.taskId === value.originTaskId);
  if (!origin || Date.parse(origin.completedAt) !== latestCompletedAt) return false;
  if ((value.type === "automation" || value.type === "plugin_build") && value.evidence.length < 3) return false;
  if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) return false;
  if (value.status === "open") {
    return value.reviewRequestId === null && value.resumeAfter === null && value.cooldownUntil === null && value.resolvedAt === null;
  }
  if (value.status === "accepted_for_review") {
    return value.reviewRequestId !== null && value.resumeAfter === null && value.cooldownUntil === null && value.resolvedAt !== null;
  }
  if (value.status === "snoozed") {
    return value.reviewRequestId === null && value.resumeAfter !== null && value.cooldownUntil !== null && value.resolvedAt === null;
  }
  if (value.status === "never_ask_again") {
    return value.reviewRequestId === null && value.resumeAfter === null && value.cooldownUntil === null && value.resolvedAt !== null;
  }
  return value.reviewRequestId === null && value.resumeAfter === null && value.cooldownUntil !== null && value.resolvedAt !== null;
}

function isReviewRequest(value: unknown): value is OneSuggestionReviewRequest {
  if (!isRecord(value) || !exactKeys(value, [
    "id", "suggestionId", "originTaskId", "type", "reviewKind", "draftId", "status", "sourceTaskRefs", "createdAt",
  ])) return false;
  if (!(typeof value.id === "string" && REVIEW_ID_RE.test(value.id)
    && typeof value.suggestionId === "string" && SUGGESTION_ID_RE.test(value.suggestionId)
    && isSafeOneSuggestionId(value.originTaskId)
    && typeof value.type === "string" && TYPES.has(value.type)
    && ["plugin_definition_draft", "agent_definition_draft", "team_definition_draft", "automation_proposal_draft", "hub_derivative_draft"].includes(String(value.reviewKind))
    && typeof value.draftId === "string" && DRAFT_ID_RE.test(value.draftId)
    && value.status === "review_required"
    && uniqueSafeIds(value.sourceTaskRefs, 2, 16)
    && isTimestamp(value.createdAt))) return false;
  const expectedKind: Record<OneSuggestionType, OneSuggestionReviewKind> = {
    plugin_build: "plugin_definition_draft",
    agent_build: "agent_definition_draft",
    retain_team: "team_definition_draft",
    automation: "automation_proposal_draft",
    hub_derivative: "hub_derivative_draft",
  };
  const expectedDraftPrefix: Record<OneSuggestionType, string> = {
    plugin_build: "one_plugin_draft_",
    agent_build: "one_agent_draft_",
    retain_team: "one_team_draft_",
    automation: "one_automation_draft_",
    hub_derivative: "one_hub_draft_",
  };
  return value.reviewKind === expectedKind[value.type as OneSuggestionType]
    && value.draftId.startsWith(expectedDraftPrefix[value.type as OneSuggestionType]);
}

function isSuppression(value: unknown): value is OneSuggestionSuppression {
  if (!isRecord(value) || !exactKeys(value, [
    "id", "suggestionId", "patternKey", "type", "scope", "mode", "createdAt", "until",
  ])) return false;
  if (
    typeof value.id !== "string" || !SUPPRESSION_ID_RE.test(value.id)
    || typeof value.suggestionId !== "string" || !SUGGESTION_ID_RE.test(value.suggestionId)
    || !isSafeOneSuggestionId(value.patternKey)
    || typeof value.type !== "string" || !TYPES.has(value.type)
    || !["pattern", "type"].includes(String(value.scope))
    || typeof value.mode !== "string" || !SUPPRESSION_MODES.has(value.mode as OneSuggestionSuppressionMode)
    || !isTimestamp(value.createdAt)
    || !(value.until === null || isTimestamp(value.until))
  ) return false;
  if (value.mode === "never_ask_again") return value.scope === "type" && value.until === null;
  if (value.until === null || Date.parse(value.until) <= Date.parse(value.createdAt)) return false;
  if (value.mode === "cooldown") return value.scope === "type";
  return value.scope === "pattern";
}

function isPatternFeedback(value: unknown): value is OneSuggestionPatternFeedback {
  if (!isRecord(value) || !exactKeys(value, [
    "patternKey", "ignoredCount", "consecutiveIgnoredCount", "frequencyDivisor",
    "lastShownAt", "lastIgnoredAt", "nextEligibleAt",
  ])) return false;
  return isSafeOneSuggestionId(value.patternKey)
    && Number.isSafeInteger(value.ignoredCount) && Number(value.ignoredCount) >= 0
    && Number.isSafeInteger(value.consecutiveIgnoredCount) && Number(value.consecutiveIgnoredCount) >= 0
    && Number(value.consecutiveIgnoredCount) <= Number(value.ignoredCount)
    && [1, 2, 4, 8].includes(Number(value.frequencyDivisor))
    && isTimestamp(value.lastShownAt)
    && (value.lastIgnoredAt === null || isTimestamp(value.lastIgnoredAt))
    && (value.nextEligibleAt === null || isTimestamp(value.nextEligibleAt));
}

function isTaskArbitration(value: unknown): value is OneSuggestionTaskArbitration {
  if (!isRecord(value) || !exactKeys(value, [
    "taskId", "patternKey", "suggestionId", "selectedType", "arbitratedAt",
  ])) return false;
  return isSafeOneSuggestionId(value.taskId)
    && isSafeOneSuggestionId(value.patternKey)
    && typeof value.suggestionId === "string" && SUGGESTION_ID_RE.test(value.suggestionId)
    && typeof value.selectedType === "string" && TYPES.has(value.selectedType)
    && isTimestamp(value.arbitratedAt);
}

export function isOneSuggestionState(value: unknown): value is OneSuggestionState {
  if (!isRecord(value) || !exactKeys(value, [
    "contractVersion", "version", "suggestions", "reviewRequests", "suppressions",
    "patternFeedback", "taskArbitrations", "createdAt", "updatedAt",
  ])) return false;
  if (
    value.contractVersion !== ONE_SUGGESTION_CONTRACT_VERSION
    || !isPositiveVersion(value.version)
    || !Array.isArray(value.suggestions) || value.suggestions.length > 512 || !value.suggestions.every(isSuggestion)
    || !Array.isArray(value.reviewRequests) || value.reviewRequests.length > 512 || !value.reviewRequests.every(isReviewRequest)
    || !Array.isArray(value.suppressions) || value.suppressions.length > 1_024 || !value.suppressions.every(isSuppression)
    || !Array.isArray(value.patternFeedback) || value.patternFeedback.length > 512 || !value.patternFeedback.every(isPatternFeedback)
    || !Array.isArray(value.taskArbitrations) || value.taskArbitrations.length > 512 || !value.taskArbitrations.every(isTaskArbitration)
    || !isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt) || Date.parse(value.updatedAt) !== value.version
  ) return false;
  const suggestionIds = new Set(value.suggestions.map((item) => item.id));
  const reviewIds = new Set(value.reviewRequests.map((item) => item.id));
  if (
    suggestionIds.size !== value.suggestions.length
    || reviewIds.size !== value.reviewRequests.length
    || new Set(value.suppressions.map((item) => item.id)).size !== value.suppressions.length
    || new Set(value.patternFeedback.map((item) => item.patternKey)).size !== value.patternFeedback.length
    || new Set(value.taskArbitrations.map((item) => item.taskId)).size !== value.taskArbitrations.length
  ) return false;
  if (value.reviewRequests.some((item) => !suggestionIds.has(item.suggestionId))) return false;
  if (value.suppressions.some((item) => !suggestionIds.has(item.suggestionId))) return false;
  const suggestions = value.suggestions;
  const reviewRequests = value.reviewRequests;
  if (new Set(reviewRequests.map((item) => item.suggestionId)).size !== reviewRequests.length) return false;
  if (suggestions.some((suggestion) => {
    const review = reviewRequests.find((item) => item.id === suggestion.reviewRequestId);
    return suggestion.status === "accepted_for_review"
      ? !review || review.suggestionId !== suggestion.id || review.type !== suggestion.type
      : suggestion.reviewRequestId !== null;
  })) return false;
  if (value.suppressions.some((item) => {
    const suggestion = suggestions.find((candidate) => candidate.id === item.suggestionId);
    return !suggestion || suggestion.patternKey !== item.patternKey || suggestion.type !== item.type;
  })) return false;
  return value.taskArbitrations.every((item) => {
    const suggestion = suggestions.find((candidate) => candidate.id === item.suggestionId);
    return suggestion?.originTaskId === item.taskId && suggestion.type === item.selectedType;
  });
}
