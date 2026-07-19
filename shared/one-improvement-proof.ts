import { looksSecret } from "./secret-patterns";

export const ONE_IMPROVEMENT_PROOF_CONTRACT_VERSION = "1.0.0" as const;

export type OneImprovementAssetType = "memory" | "agent" | "team" | "experience" | "automation";
export type OneImprovementRuntimeAssetKind = Exclude<OneImprovementAssetType, "experience">;
export type OneImprovementAssetControl = "edit" | "use_once" | "disable" | "delete";
export type OneImprovementChangeKind =
  | "instruction_reduction"
  | "time_reduction"
  | "revision_reduction"
  | "quality_improvement"
  | "risk_avoidance";
export type OneImprovementEvidenceType = "measured" | "qualitative" | "estimate";
export type OneImprovementResult = "improved" | "no_change" | "regression";
export type OneImprovementAttributionStatus = "established" | "not_established";
export type OneImprovementComparisonDirection = "lower_is_better" | "higher_is_better";
export type OneImprovementNumericValueType = "fact" | "estimate";

export interface OneImprovementReusedAssetV1 {
  assetRef: string;
  assetType: OneImprovementAssetType;
  label: string;
  sourceTaskRef: string;
  receiptRefs: string[];
  controls: OneImprovementAssetControl[];
}

export interface OneImprovementMeasuredChangeV1 {
  changeRef: string;
  kind: OneImprovementChangeKind;
  evidenceType: "measured";
  statement: string;
  baseline: number;
  current: number;
  unit: string;
  comparisonDirection: OneImprovementComparisonDirection;
  evidenceRefs: string[];
}

export interface OneImprovementQualitativeChangeV1 {
  changeRef: string;
  kind: OneImprovementChangeKind;
  evidenceType: "qualitative";
  statement: string;
  baselineRefs: string[];
  currentRefs: string[];
  evidenceRefs: string[];
}

export interface OneImprovementEstimateV1 {
  value: number;
  unit: string;
  basis: string;
  method: string;
  evidenceRefs: string[];
}

export interface OneImprovementEstimateChangeV1 {
  changeRef: string;
  kind: OneImprovementChangeKind;
  evidenceType: "estimate";
  statement: string;
  estimate: OneImprovementEstimateV1;
}

export type OneImprovementChangeV1 =
  | OneImprovementMeasuredChangeV1
  | OneImprovementQualitativeChangeV1
  | OneImprovementEstimateChangeV1;

/** Exact renderer-safe document defined by improvement-proof.v1.schema.json. */
export interface OneImprovementProofV1 {
  contractVersion: typeof ONE_IMPROVEMENT_PROOF_CONTRACT_VERSION;
  improvementProofId: string;
  taskId: string;
  status: "verified";
  generatedAt: string;
  placement: "after_value_closure";
  collapsedByDefault: true;
  compoundingStep: "remembered" | "reused" | "improved_result";
  attributionStatus: OneImprovementAttributionStatus;
  reusedAssets: OneImprovementReusedAssetV1[];
  changes: OneImprovementChangeV1[];
  receiptRefs: string[];
  convertedToEngagementScore: false;
}

export interface OneImprovementControlRef {
  control: OneImprovementAssetControl;
  controlRef: string;
}

export interface OneImprovementAssetVersionRef {
  assetId: string;
  assetVersion: number;
}

interface OneTrustedImprovementEvidenceBase {
  evidenceRef: string;
  receiptRef: string;
  taskKind: string;
  observedAt: string;
  sourceRef: string;
}

export interface OneTrustedImprovementTaskEvidence extends OneTrustedImprovementEvidenceBase {
  kind: "output_verification" | "outcome_verification";
  source: "host_connector" | "artifact_verifier" | "outcome_verifier";
  taskId: string;
  taskVersion: number;
  verificationRef: string;
}

export interface OneTrustedImprovementAssetReuseEvidence extends OneTrustedImprovementEvidenceBase {
  kind: "asset_reuse";
  source: "memory_runtime" | "agent_runtime" | "team_runtime" | "automation_runtime";
  taskId: string;
  taskVersion: number;
  sourceTaskId: string;
  sourceTaskVersion: number;
  assetId: string;
  assetVersion: number;
  assetKind: OneImprovementRuntimeAssetKind;
  sourceControlRef: string;
  controlRefs: OneImprovementControlRef[];
  rollbackRef: string;
  removeRef: string;
}

export interface OneTrustedImprovementMeasurementEvidence extends OneTrustedImprovementEvidenceBase {
  kind: "measurement";
  source: "measurement_engine";
  baselineTaskId: string;
  baselineTaskVersion: number;
  currentTaskId: string;
  currentTaskVersion: number;
  comparisonRef: string;
  role: "baseline" | "current";
  valueType: OneImprovementNumericValueType;
  value: number;
  unit: string;
  method: string;
  sampleSize: number;
  comparable: boolean;
  comparabilityBasis: string;
  comparisonDirection: OneImprovementComparisonDirection;
}

export interface OneTrustedImprovementRubricEvidence extends OneTrustedImprovementEvidenceBase {
  kind: "rubric_assessment";
  source: "rubric_evaluator";
  taskId: string;
  taskVersion: number;
  comparisonRef: string;
  role: "baseline" | "current";
  rubricRef: string;
  criterionRefs: string[];
  assessmentRef: string;
  ordinalRank: number;
  comparisonDirection: OneImprovementComparisonDirection;
}

export interface OneTrustedImprovementComparisonEvidence extends OneTrustedImprovementEvidenceBase {
  kind: "comparison_verification";
  source: "comparison_verifier";
  baselineTaskId: string;
  baselineTaskVersion: number;
  currentTaskId: string;
  currentTaskVersion: number;
  comparisonRef: string;
  evidenceType: OneImprovementEvidenceType;
  result: OneImprovementResult;
  baselineOutputVerificationRef: string;
  baselineOutcomeVerificationRef: string;
  currentOutputVerificationRef: string;
  currentOutcomeVerificationRef: string;
  reusedAssetVersions: OneImprovementAssetVersionRef[];
}

/** Main-only, content-free attestations. They must never cross renderer IPC. */
export type OneTrustedImprovementEvidence =
  | OneTrustedImprovementTaskEvidence
  | OneTrustedImprovementAssetReuseEvidence
  | OneTrustedImprovementMeasurementEvidence
  | OneTrustedImprovementRubricEvidence
  | OneTrustedImprovementComparisonEvidence;

export interface OneImprovementAssetBinding {
  assetId: string;
  assetVersion: number;
  assetKind: OneImprovementRuntimeAssetKind;
  sourceTaskId: string;
  sourceTaskVersion: number;
  currentTaskId: string;
  currentTaskVersion: number;
  taskKind: string;
  reuseEvidenceRef: string;
  reuseReceiptRef: string;
  sourceControlRef: string;
  controlRefs: OneImprovementControlRef[];
  rollbackRef: string;
  removeRef: string;
}

export interface OneImprovementComparisonRecord {
  comparisonRef: string;
  changeRef: string;
  taskKind: string;
  baselineTaskId: string;
  baselineTaskVersion: number;
  currentTaskId: string;
  currentTaskVersion: number;
  evidenceType: OneImprovementEvidenceType;
  result: OneImprovementResult;
  baselineOutputVerificationRef: string;
  baselineOutcomeVerificationRef: string;
  currentOutputVerificationRef: string;
  currentOutcomeVerificationRef: string;
  reusedAssetVersions: OneImprovementAssetVersionRef[];
  comparisonEvidenceRef: string;
  measurementEvidenceRefs?: string[];
  rubricEvidenceRefs?: string[];
  evidenceRefs: string[];
  receiptRefs: string[];
}

export interface OneImprovementBaselineTaskRef {
  taskId: string;
  taskVersion: number;
}

export interface OneImprovementProofRecord {
  proof: OneImprovementProofV1;
  version: number;
  taskKind: string;
  currentTaskVersion: number;
  baselineTasks: OneImprovementBaselineTaskRef[];
  assetBindings: OneImprovementAssetBinding[];
  comparisons: OneImprovementComparisonRecord[];
  trustedEvidenceRefs: string[];
  createdAt: string;
  updatedAt: string;
}

export interface OneImprovementProofState {
  contractVersion: typeof ONE_IMPROVEMENT_PROOF_CONTRACT_VERSION;
  version: number;
  evidence: OneTrustedImprovementEvidence[];
  proofs: OneImprovementProofRecord[];
  createdAt: string;
  updatedAt: string;
}

/** Renderer/mobile-safe read model. Main-only attestations never cross IPC. */
export interface OneImprovementProofReadState {
  contractVersion: typeof ONE_IMPROVEMENT_PROOF_CONTRACT_VERSION;
  version: number;
  proofs: OneImprovementProofRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateOneImprovementProofInput {
  expectedStoreVersion: number;
  /** Main-only trust-boundary assertion; renderer IPC must never expose this API. */
  trustedHostAttested: true;
  currentTaskId: string;
  currentTaskVersion: number;
  taskKind: string;
  attributionStatus: OneImprovementAttributionStatus;
  reusedAssets: OneImprovementReusedAssetV1[];
  changes: OneImprovementChangeV1[];
  assetBindings: OneImprovementAssetBinding[];
  comparisons: OneImprovementComparisonRecord[];
  receiptRefs: string[];
  trustedHostEvidence: OneTrustedImprovementEvidence[];
}

export interface OneImprovementProofMutationResult<T> {
  storeVersion: number;
  updatedAt: string;
  value: T;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const INTERNAL_PROOF_ID_RE = /^improvement_proof_[a-f0-9]{32}$/;
const ASSET_TYPES = new Set<OneImprovementAssetType>(["memory", "agent", "team", "experience", "automation"]);
const RUNTIME_ASSET_KINDS = new Set<OneImprovementRuntimeAssetKind>(["memory", "agent", "team", "automation"]);
const CONTROLS = new Set<OneImprovementAssetControl>(["edit", "use_once", "disable", "delete"]);
const ATTRIBUTION_STATUSES = new Set<OneImprovementAttributionStatus>(["established", "not_established"]);
const CHANGE_KINDS = new Set<OneImprovementChangeKind>([
  "instruction_reduction", "time_reduction", "revision_reduction", "quality_improvement", "risk_avoidance",
]);
const POSIX_ABSOLUTE_PATH_RE = /(^|[\s("'=:\[{])\/[^\s,;:"'`<>|}\]]+/m;
const WINDOWS_ABSOLUTE_PATH_RE = /\b[A-Za-z]:\\(?:[^\\,\r\n"'`<>|}\]]+\\)*[^\s\\,\r\n"'`<>|}\]]+/;
const UNC_PATH_RE = /\\\\[^\\\s,;:"'`<>|}\]]+(?:\\[^\\\s,;:"'`<>|}\]]+)+/;
const TRANSPORT_OR_MARKUP_RE = /(?:<|\b(?:https?|file|javascript|data):(?:\/\/)?|dangerouslySetInnerHTML|\bon(?:error|load|click)\s*=)/i;
const RAW_TRANSCRIPT_RE = /(?:^|\n)\s*(?:user|assistant|system|customer|agent|사용자|어시스턴트)\s*:/i;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const KOREAN_ID_RE = /\b\d{6}\s*-\s*[1-8]\d{6}\b/;
const PHONE_RE = /(?:^|\D)(?:\+?82[-.\s]?)?0?1[016789][-.\s]?\d{3,4}[-.\s]?\d{4}(?:\D|$)/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function isPositiveVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function luhnLikePrivateNumber(value: string): boolean {
  const candidates = value.match(/(?:\d[ -]?){13,19}/g) ?? [];
  return candidates.some((candidate) => {
    const digits = candidate.replace(/\D/g, "");
    if (digits.length < 13 || digits.length > 19 || /^(\d)\1+$/.test(digits)) return false;
    let sum = 0;
    let double = false;
    for (let index = digits.length - 1; index >= 0; index -= 1) {
      let digit = Number(digits[index]);
      if (double) {
        digit *= 2;
        if (digit > 9) digit -= 9;
      }
      sum += digit;
      double = !double;
    }
    return sum % 10 === 0;
  });
}

export type OneImprovementUnsafeTextReason =
  | "secret"
  | "local_path"
  | "transport_or_markup"
  | "raw_transcript"
  | "private_data";

export function unsafeOneImprovementTextReason(value: string): OneImprovementUnsafeTextReason | null {
  if (looksSecret(value)) return "secret";
  if (TRANSPORT_OR_MARKUP_RE.test(value)) return "transport_or_markup";
  if (POSIX_ABSOLUTE_PATH_RE.test(value) || WINDOWS_ABSOLUTE_PATH_RE.test(value) || UNC_PATH_RE.test(value)) return "local_path";
  if (RAW_TRANSCRIPT_RE.test(value)) return "raw_transcript";
  if (EMAIL_RE.test(value) || KOREAN_ID_RE.test(value) || PHONE_RE.test(value) || luhnLikePrivateNumber(value)) return "private_data";
  return null;
}

export function isSafeOneImprovementText(value: unknown, maxLength = 4_000): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= maxLength
    && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)
    && !unsafeOneImprovementTextReason(value);
}

export function isSafeOneImprovementId(value: unknown): value is string {
  return typeof value === "string" && ID_RE.test(value) && !looksSecret(value);
}

function isUniqueIdArray(value: unknown, min: number, max: number): value is string[] {
  return Array.isArray(value)
    && value.length >= min
    && value.length <= max
    && value.every(isSafeOneImprovementId)
    && new Set(value).size === value.length;
}

function isControlArray(value: unknown): value is OneImprovementAssetControl[] {
  return Array.isArray(value)
    && value.length >= 1
    && value.length <= 4
    && value.every((item) => typeof item === "string" && CONTROLS.has(item as OneImprovementAssetControl))
    && new Set(value).size === value.length;
}

function isReusedAsset(value: unknown): value is OneImprovementReusedAssetV1 {
  if (!isRecord(value) || !exactKeys(value, ["assetRef", "assetType", "label", "sourceTaskRef", "receiptRefs", "controls"])) return false;
  return isSafeOneImprovementId(value.assetRef)
    && typeof value.assetType === "string" && ASSET_TYPES.has(value.assetType as OneImprovementAssetType)
    && isSafeOneImprovementText(value.label, 160)
    && isSafeOneImprovementId(value.sourceTaskRef)
    && isUniqueIdArray(value.receiptRefs, 1, 32)
    && isControlArray(value.controls);
}

function isImprovementChange(value: unknown): value is OneImprovementChangeV1 {
  if (!isRecord(value) || !isSafeOneImprovementId(value.changeRef) || !isSafeOneImprovementText(value.statement)) return false;
  if (typeof value.kind !== "string" || !CHANGE_KINDS.has(value.kind as OneImprovementChangeKind)) return false;
  if (value.evidenceType === "measured") {
    return exactKeys(value, ["changeRef", "kind", "evidenceType", "statement", "baseline", "current", "unit", "comparisonDirection", "evidenceRefs"])
      && isFiniteNumber(value.baseline) && isFiniteNumber(value.current)
      && isSafeOneImprovementText(value.unit, 160)
      && ["lower_is_better", "higher_is_better"].includes(String(value.comparisonDirection))
      && isUniqueIdArray(value.evidenceRefs, 2, 32);
  }
  if (value.evidenceType === "qualitative") {
    return exactKeys(value, ["changeRef", "kind", "evidenceType", "statement", "baselineRefs", "currentRefs", "evidenceRefs"])
      && isUniqueIdArray(value.baselineRefs, 1, 32)
      && isUniqueIdArray(value.currentRefs, 1, 32)
      && isUniqueIdArray(value.evidenceRefs, 1, 32);
  }
  if (value.evidenceType === "estimate") {
    if (!exactKeys(value, ["changeRef", "kind", "evidenceType", "statement", "estimate"]) || !isRecord(value.estimate)) return false;
    return exactKeys(value.estimate, ["value", "unit", "basis", "method", "evidenceRefs"])
      && isFiniteNumber(value.estimate.value)
      && isSafeOneImprovementText(value.estimate.unit, 160)
      && isSafeOneImprovementText(value.estimate.basis)
      && isSafeOneImprovementText(value.estimate.method)
      && isUniqueIdArray(value.estimate.evidenceRefs, 1, 32);
  }
  return false;
}

export function isOneImprovementProofV1(value: unknown): value is OneImprovementProofV1 {
  if (!isRecord(value) || !exactKeys(value, [
    "contractVersion", "improvementProofId", "taskId", "status", "generatedAt", "placement",
    "collapsedByDefault", "compoundingStep", "attributionStatus", "reusedAssets", "changes", "receiptRefs",
    "convertedToEngagementScore",
  ])) return false;
  if (value.contractVersion !== ONE_IMPROVEMENT_PROOF_CONTRACT_VERSION) return false;
  if (!isSafeOneImprovementId(value.improvementProofId) || !isSafeOneImprovementId(value.taskId)) return false;
  if (value.status !== "verified" || !isTimestamp(value.generatedAt) || value.placement !== "after_value_closure") return false;
  if (value.collapsedByDefault !== true || !["remembered", "reused", "improved_result"].includes(String(value.compoundingStep))) return false;
  if (typeof value.attributionStatus !== "string" || !ATTRIBUTION_STATUSES.has(value.attributionStatus as OneImprovementAttributionStatus)) return false;
  if (value.compoundingStep === "improved_result" && value.attributionStatus !== "established") return false;
  if (!Array.isArray(value.reusedAssets) || value.reusedAssets.length < 1 || value.reusedAssets.length > 16 || !value.reusedAssets.every(isReusedAsset)) return false;
  if (!Array.isArray(value.changes) || value.changes.length < 1 || value.changes.length > 16 || !value.changes.every(isImprovementChange)) return false;
  if (!isUniqueIdArray(value.receiptRefs, 1, 128) || value.convertedToEngagementScore !== false) return false;
  const receiptRefs = value.receiptRefs;
  if (new Set(value.reusedAssets.map((item) => item.assetRef)).size !== value.reusedAssets.length) return false;
  if (new Set(value.changes.map((item) => item.changeRef)).size !== value.changes.length) return false;
  return value.reusedAssets.every((asset) => asset.receiptRefs.every((ref) => receiptRefs.includes(ref)));
}

export function parseOneImprovementProofJson(raw: string): OneImprovementProofV1 | null {
  const bytes = typeof TextEncoder !== "undefined" ? new TextEncoder().encode(raw).byteLength : raw.length * 3;
  if (bytes > 256 * 1024) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return isOneImprovementProofV1(value) ? value : null;
  } catch {
    return null;
  }
}

function isControlRef(value: unknown): value is OneImprovementControlRef {
  return isRecord(value)
    && exactKeys(value, ["control", "controlRef"])
    && typeof value.control === "string" && CONTROLS.has(value.control as OneImprovementAssetControl)
    && isSafeOneImprovementId(value.controlRef);
}

function isControlRefs(value: unknown): value is OneImprovementControlRef[] {
  return Array.isArray(value)
    && value.length >= 1
    && value.length <= 4
    && value.every(isControlRef)
    && new Set(value.map((item) => item.control)).size === value.length
    && new Set(value.map((item) => item.controlRef)).size === value.length;
}

function isAssetVersionRef(value: unknown): value is OneImprovementAssetVersionRef {
  return isRecord(value)
    && exactKeys(value, ["assetId", "assetVersion"])
    && isSafeOneImprovementId(value.assetId)
    && isPositiveVersion(value.assetVersion);
}

function isAssetVersionRefs(value: unknown): value is OneImprovementAssetVersionRef[] {
  return Array.isArray(value)
    && value.length >= 1
    && value.length <= 16
    && value.every(isAssetVersionRef)
    && new Set(value.map((item) => `${item.assetId}:${item.assetVersion}`)).size === value.length;
}

export function isOneTrustedImprovementEvidence(value: unknown): value is OneTrustedImprovementEvidence {
  if (!isRecord(value) || !isSafeOneImprovementId(value.evidenceRef) || !isSafeOneImprovementId(value.receiptRef)) return false;
  if (!isSafeOneImprovementId(value.taskKind) || !isTimestamp(value.observedAt) || !isSafeOneImprovementId(value.sourceRef)) return false;
  if (value.kind === "output_verification" || value.kind === "outcome_verification") {
    return exactKeys(value, ["evidenceRef", "receiptRef", "kind", "source", "taskKind", "observedAt", "sourceRef", "taskId", "taskVersion", "verificationRef"])
      && ["host_connector", "artifact_verifier", "outcome_verifier"].includes(String(value.source))
      && isSafeOneImprovementId(value.taskId) && isPositiveVersion(value.taskVersion)
      && isSafeOneImprovementId(value.verificationRef);
  }
  if (value.kind === "asset_reuse") {
    const expectedSource: Record<OneImprovementRuntimeAssetKind, string> = {
      memory: "memory_runtime", agent: "agent_runtime", team: "team_runtime", automation: "automation_runtime",
    };
    return exactKeys(value, [
      "evidenceRef", "receiptRef", "kind", "source", "taskKind", "observedAt", "sourceRef",
      "taskId", "taskVersion", "sourceTaskId", "sourceTaskVersion", "assetId", "assetVersion",
      "assetKind", "sourceControlRef", "controlRefs", "rollbackRef", "removeRef",
    ])
      && isSafeOneImprovementId(value.taskId) && isPositiveVersion(value.taskVersion)
      && isSafeOneImprovementId(value.sourceTaskId) && isPositiveVersion(value.sourceTaskVersion)
      && isSafeOneImprovementId(value.assetId) && isPositiveVersion(value.assetVersion)
      && typeof value.assetKind === "string" && RUNTIME_ASSET_KINDS.has(value.assetKind as OneImprovementRuntimeAssetKind)
      && value.source === expectedSource[value.assetKind as OneImprovementRuntimeAssetKind]
      && isSafeOneImprovementId(value.sourceControlRef) && isControlRefs(value.controlRefs)
      && isSafeOneImprovementId(value.rollbackRef) && isSafeOneImprovementId(value.removeRef);
  }
  if (value.kind === "measurement") {
    return exactKeys(value, [
      "evidenceRef", "receiptRef", "kind", "source", "taskKind", "observedAt", "sourceRef",
      "baselineTaskId", "baselineTaskVersion", "currentTaskId", "currentTaskVersion", "comparisonRef",
      "role", "valueType", "value", "unit", "method", "sampleSize", "comparable", "comparabilityBasis",
      "comparisonDirection",
    ])
      && value.source === "measurement_engine"
      && isSafeOneImprovementId(value.baselineTaskId) && isPositiveVersion(value.baselineTaskVersion)
      && isSafeOneImprovementId(value.currentTaskId) && isPositiveVersion(value.currentTaskVersion)
      && isSafeOneImprovementId(value.comparisonRef)
      && ["baseline", "current"].includes(String(value.role))
      && ["fact", "estimate"].includes(String(value.valueType))
      && isFiniteNumber(value.value) && isSafeOneImprovementText(value.unit, 160)
      && isSafeOneImprovementText(value.method) && isPositiveVersion(value.sampleSize)
      && typeof value.comparable === "boolean" && isSafeOneImprovementText(value.comparabilityBasis)
      && ["lower_is_better", "higher_is_better"].includes(String(value.comparisonDirection));
  }
  if (value.kind === "rubric_assessment") {
    return exactKeys(value, [
      "evidenceRef", "receiptRef", "kind", "source", "taskKind", "observedAt", "sourceRef",
      "taskId", "taskVersion", "comparisonRef", "role", "rubricRef", "criterionRefs", "assessmentRef",
      "ordinalRank", "comparisonDirection",
    ])
      && value.source === "rubric_evaluator"
      && isSafeOneImprovementId(value.taskId) && isPositiveVersion(value.taskVersion)
      && isSafeOneImprovementId(value.comparisonRef) && ["baseline", "current"].includes(String(value.role))
      && isSafeOneImprovementId(value.rubricRef) && isUniqueIdArray(value.criterionRefs, 1, 32)
      && isSafeOneImprovementId(value.assessmentRef) && isFiniteNumber(value.ordinalRank)
      && ["lower_is_better", "higher_is_better"].includes(String(value.comparisonDirection));
  }
  if (value.kind === "comparison_verification") {
    return exactKeys(value, [
      "evidenceRef", "receiptRef", "kind", "source", "taskKind", "observedAt", "sourceRef",
      "baselineTaskId", "baselineTaskVersion", "currentTaskId", "currentTaskVersion", "comparisonRef",
      "evidenceType", "result", "baselineOutputVerificationRef", "baselineOutcomeVerificationRef",
      "currentOutputVerificationRef", "currentOutcomeVerificationRef", "reusedAssetVersions",
    ])
      && value.source === "comparison_verifier"
      && isSafeOneImprovementId(value.baselineTaskId) && isPositiveVersion(value.baselineTaskVersion)
      && isSafeOneImprovementId(value.currentTaskId) && isPositiveVersion(value.currentTaskVersion)
      && isSafeOneImprovementId(value.comparisonRef)
      && ["measured", "qualitative", "estimate"].includes(String(value.evidenceType))
      && ["improved", "no_change", "regression"].includes(String(value.result))
      && isSafeOneImprovementId(value.baselineOutputVerificationRef)
      && isSafeOneImprovementId(value.baselineOutcomeVerificationRef)
      && isSafeOneImprovementId(value.currentOutputVerificationRef)
      && isSafeOneImprovementId(value.currentOutcomeVerificationRef)
      && isAssetVersionRefs(value.reusedAssetVersions);
  }
  return false;
}

function isAssetBinding(value: unknown): value is OneImprovementAssetBinding {
  if (!isRecord(value) || !exactKeys(value, [
    "assetId", "assetVersion", "assetKind", "sourceTaskId", "sourceTaskVersion", "currentTaskId",
    "currentTaskVersion", "taskKind", "reuseEvidenceRef", "reuseReceiptRef", "sourceControlRef",
    "controlRefs", "rollbackRef", "removeRef",
  ])) return false;
  return isSafeOneImprovementId(value.assetId) && isPositiveVersion(value.assetVersion)
    && typeof value.assetKind === "string" && RUNTIME_ASSET_KINDS.has(value.assetKind as OneImprovementRuntimeAssetKind)
    && isSafeOneImprovementId(value.sourceTaskId) && isPositiveVersion(value.sourceTaskVersion)
    && isSafeOneImprovementId(value.currentTaskId) && isPositiveVersion(value.currentTaskVersion)
    && isSafeOneImprovementId(value.taskKind) && isSafeOneImprovementId(value.reuseEvidenceRef)
    && isSafeOneImprovementId(value.reuseReceiptRef) && isSafeOneImprovementId(value.sourceControlRef)
    && isControlRefs(value.controlRefs) && isSafeOneImprovementId(value.rollbackRef) && isSafeOneImprovementId(value.removeRef);
}

function isComparisonRecord(value: unknown): value is OneImprovementComparisonRecord {
  if (!isRecord(value) || !exactKeys(value, [
    "comparisonRef", "changeRef", "taskKind", "baselineTaskId", "baselineTaskVersion", "currentTaskId",
    "currentTaskVersion", "evidenceType", "result", "baselineOutputVerificationRef",
    "baselineOutcomeVerificationRef", "currentOutputVerificationRef", "currentOutcomeVerificationRef",
    "reusedAssetVersions", "comparisonEvidenceRef", "measurementEvidenceRefs", "rubricEvidenceRefs",
    "evidenceRefs", "receiptRefs",
  ])) return false;
  if (!isSafeOneImprovementId(value.comparisonRef) || !isSafeOneImprovementId(value.changeRef) || !isSafeOneImprovementId(value.taskKind)) return false;
  if (!isSafeOneImprovementId(value.baselineTaskId) || !isPositiveVersion(value.baselineTaskVersion)) return false;
  if (!isSafeOneImprovementId(value.currentTaskId) || !isPositiveVersion(value.currentTaskVersion)) return false;
  if (!["measured", "qualitative", "estimate"].includes(String(value.evidenceType))) return false;
  if (!["improved", "no_change", "regression"].includes(String(value.result))) return false;
  if (![value.baselineOutputVerificationRef, value.baselineOutcomeVerificationRef, value.currentOutputVerificationRef, value.currentOutcomeVerificationRef, value.comparisonEvidenceRef].every(isSafeOneImprovementId)) return false;
  if (!isAssetVersionRefs(value.reusedAssetVersions)) return false;
  if (!isUniqueIdArray(value.evidenceRefs, 1, 64) || !isUniqueIdArray(value.receiptRefs, 1, 64)) return false;
  if (value.evidenceType === "qualitative") {
    return value.measurementEvidenceRefs === undefined && isUniqueIdArray(value.rubricEvidenceRefs, 2, 2);
  }
  return value.rubricEvidenceRefs === undefined && isUniqueIdArray(value.measurementEvidenceRefs, 2, 2);
}

function isBaselineTask(value: unknown): value is OneImprovementBaselineTaskRef {
  return isRecord(value) && exactKeys(value, ["taskId", "taskVersion"])
    && isSafeOneImprovementId(value.taskId) && isPositiveVersion(value.taskVersion);
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item) => right.includes(item));
}

function resultForNumbers(
  baseline: number,
  current: number,
  direction: OneImprovementComparisonDirection,
): OneImprovementResult {
  if (current === baseline) return "no_change";
  if (direction === "lower_is_better") return current < baseline ? "improved" : "regression";
  return current > baseline ? "improved" : "regression";
}

function recordCrossLinksAreValid(record: OneImprovementProofRecord, evidenceByRef: Map<string, OneTrustedImprovementEvidence>): boolean {
  const hasImprovement = record.comparisons.some((comparison) => comparison.result === "improved");
  if (record.proof.compoundingStep === "improved_result"
    && (!hasImprovement || record.proof.attributionStatus !== "established")) return false;
  if (record.proof.taskId !== record.assetBindings[0]?.currentTaskId) return false;
  if (record.assetBindings.some((item) => item.currentTaskId !== record.proof.taskId || item.currentTaskVersion !== record.currentTaskVersion || item.taskKind !== record.taskKind)) return false;
  if (record.comparisons.some((item) => item.currentTaskId !== record.proof.taskId || item.currentTaskVersion !== record.currentTaskVersion || item.taskKind !== record.taskKind)) return false;
  if (record.proof.reusedAssets.length !== record.assetBindings.length || record.proof.changes.length !== record.comparisons.length) return false;
  if (!record.proof.reusedAssets.every((asset) => {
    const binding = record.assetBindings.find((item) => item.assetId === asset.assetRef);
    if (!binding || asset.assetType !== binding.assetKind || asset.sourceTaskRef !== binding.sourceTaskId) return false;
    if (!sameSet(asset.controls, binding.controlRefs.map((item) => item.control)) || !asset.receiptRefs.includes(binding.reuseReceiptRef)) return false;
    const attestation = evidenceByRef.get(binding.reuseEvidenceRef);
    return attestation?.kind === "asset_reuse" && attestation.receiptRef === binding.reuseReceiptRef
      && attestation.assetId === binding.assetId && attestation.assetVersion === binding.assetVersion
      && attestation.taskId === binding.currentTaskId && attestation.taskVersion === binding.currentTaskVersion;
  })) return false;
  const expectedBaselines = [...new Set(record.comparisons.map((item) => `${item.baselineTaskId}:${item.baselineTaskVersion}`))];
  if (!sameSet(expectedBaselines, record.baselineTasks.map((item) => `${item.taskId}:${item.taskVersion}`))) return false;
  const allEvidence = [...evidenceByRef.values()];
  if (!record.proof.changes.every((change) => {
    const comparison = record.comparisons.find((item) => item.changeRef === change.changeRef);
    if (!comparison || comparison.evidenceType !== change.evidenceType) return false;
    const attestation = evidenceByRef.get(comparison.comparisonEvidenceRef);
    if (!(attestation?.kind === "comparison_verification" && attestation.comparisonRef === comparison.comparisonRef
      && attestation.result === comparison.result && attestation.currentTaskId === comparison.currentTaskId
      && attestation.currentTaskVersion === comparison.currentTaskVersion
      && attestation.baselineTaskId === comparison.baselineTaskId
      && attestation.baselineTaskVersion === comparison.baselineTaskVersion
      && attestation.taskKind === comparison.taskKind
      && attestation.evidenceType === comparison.evidenceType
      && attestation.baselineOutputVerificationRef === comparison.baselineOutputVerificationRef
      && attestation.baselineOutcomeVerificationRef === comparison.baselineOutcomeVerificationRef
      && attestation.currentOutputVerificationRef === comparison.currentOutputVerificationRef
      && attestation.currentOutcomeVerificationRef === comparison.currentOutcomeVerificationRef
      && sameSet(
        attestation.reusedAssetVersions.map((item) => `${item.assetId}:${item.assetVersion}`),
        comparison.reusedAssetVersions.map((item) => `${item.assetId}:${item.assetVersion}`),
      ))) return false;
    if (!comparison.reusedAssetVersions.every((ref) => record.assetBindings.some((binding) =>
      binding.assetId === ref.assetId && binding.assetVersion === ref.assetVersion,
    ))) return false;
    const taskEvidence = (
      kind: "output_verification" | "outcome_verification",
      verificationRef: string,
      taskId: string,
      taskVersion: number,
    ) => allEvidence.filter((item): item is OneTrustedImprovementTaskEvidence =>
      item.kind === kind && item.verificationRef === verificationRef && item.taskId === taskId
        && item.taskVersion === taskVersion && item.taskKind === comparison.taskKind,
    ).length === 1;
    if (!taskEvidence("output_verification", comparison.baselineOutputVerificationRef, comparison.baselineTaskId, comparison.baselineTaskVersion)
      || !taskEvidence("outcome_verification", comparison.baselineOutcomeVerificationRef, comparison.baselineTaskId, comparison.baselineTaskVersion)
      || !taskEvidence("output_verification", comparison.currentOutputVerificationRef, comparison.currentTaskId, comparison.currentTaskVersion)
      || !taskEvidence("outcome_verification", comparison.currentOutcomeVerificationRef, comparison.currentTaskId, comparison.currentTaskVersion)) return false;
    const publicEvidenceRefs = change.evidenceType === "estimate" ? change.estimate.evidenceRefs : change.evidenceRefs;
    if (!sameSet(publicEvidenceRefs, comparison.evidenceRefs)) return false;
    const comparisonEvidence = comparison.evidenceRefs.map((ref) => evidenceByRef.get(ref));
    if (comparisonEvidence.some((item) => !item)
      || !sameSet(comparison.receiptRefs, comparisonEvidence.map((item) => item!.receiptRef))) return false;
    if (change.evidenceType === "qualitative") {
      const assessments = (comparison.rubricEvidenceRefs ?? []).map((ref) => evidenceByRef.get(ref))
        .filter((item): item is OneTrustedImprovementRubricEvidence => item?.kind === "rubric_assessment");
      if (assessments.length !== 2) return false;
      const baseline = assessments.find((item) => item.role === "baseline");
      const current = assessments.find((item) => item.role === "current");
      return Boolean(baseline && current
        && baseline.taskId === comparison.baselineTaskId && baseline.taskVersion === comparison.baselineTaskVersion
        && current.taskId === comparison.currentTaskId && current.taskVersion === comparison.currentTaskVersion
        && baseline.comparisonRef === comparison.comparisonRef && current.comparisonRef === comparison.comparisonRef
        && baseline.rubricRef === current.rubricRef && sameSet(baseline.criterionRefs, current.criterionRefs)
        && baseline.comparisonDirection === current.comparisonDirection
        && sameSet(change.baselineRefs, [baseline.assessmentRef]) && sameSet(change.currentRefs, [current.assessmentRef])
        && resultForNumbers(baseline.ordinalRank, current.ordinalRank, baseline.comparisonDirection) === comparison.result);
    }
    const measurements = (comparison.measurementEvidenceRefs ?? []).map((ref) => evidenceByRef.get(ref))
      .filter((item): item is OneTrustedImprovementMeasurementEvidence => item?.kind === "measurement");
    if (measurements.length !== 2) return false;
    const baseline = measurements.find((item) => item.role === "baseline");
    const current = measurements.find((item) => item.role === "current");
    if (!baseline || !current || !baseline.comparable || !current.comparable
      || baseline.baselineTaskId !== comparison.baselineTaskId || baseline.baselineTaskVersion !== comparison.baselineTaskVersion
      || baseline.currentTaskId !== comparison.currentTaskId || baseline.currentTaskVersion !== comparison.currentTaskVersion
      || current.baselineTaskId !== comparison.baselineTaskId || current.baselineTaskVersion !== comparison.baselineTaskVersion
      || current.currentTaskId !== comparison.currentTaskId || current.currentTaskVersion !== comparison.currentTaskVersion
      || baseline.comparisonRef !== comparison.comparisonRef || current.comparisonRef !== comparison.comparisonRef
      || baseline.unit !== current.unit || baseline.method !== current.method
      || baseline.comparabilityBasis !== current.comparabilityBasis
      || baseline.comparisonDirection !== current.comparisonDirection
      || resultForNumbers(baseline.value, current.value, baseline.comparisonDirection) !== comparison.result) return false;
    if (change.evidenceType === "measured") {
      return baseline.valueType === "fact" && current.valueType === "fact"
        && change.baseline === baseline.value && change.current === current.value
        && change.unit === baseline.unit && change.comparisonDirection === baseline.comparisonDirection;
    }
    return baseline.valueType === "estimate" && current.valueType === "estimate"
      && change.estimate.value === Math.abs(current.value - baseline.value)
      && change.estimate.unit === baseline.unit && change.estimate.method === baseline.method
      && change.estimate.basis === baseline.comparabilityBasis;
  })) return false;
  const evidence = record.trustedEvidenceRefs.map((ref) => evidenceByRef.get(ref));
  if (evidence.some((item) => !item)) return false;
  return sameSet(record.proof.receiptRefs, evidence.map((item) => item!.receiptRef));
}

function isImprovementProofRecord(value: unknown, evidenceByRef: Map<string, OneTrustedImprovementEvidence>): value is OneImprovementProofRecord {
  if (!isRecord(value) || !exactKeys(value, [
    "proof", "version", "taskKind", "currentTaskVersion", "baselineTasks", "assetBindings", "comparisons",
    "trustedEvidenceRefs", "createdAt", "updatedAt",
  ])) return false;
  if (!isOneImprovementProofV1(value.proof) || !INTERNAL_PROOF_ID_RE.test(value.proof.improvementProofId)) return false;
  if (!isPositiveVersion(value.version) || !isSafeOneImprovementId(value.taskKind) || !isPositiveVersion(value.currentTaskVersion)) return false;
  if (!Array.isArray(value.baselineTasks) || value.baselineTasks.length < 1 || value.baselineTasks.length > 16 || !value.baselineTasks.every(isBaselineTask)) return false;
  if (!Array.isArray(value.assetBindings) || value.assetBindings.length < 1 || value.assetBindings.length > 16 || !value.assetBindings.every(isAssetBinding)) return false;
  if (!Array.isArray(value.comparisons) || value.comparisons.length < 1 || value.comparisons.length > 16 || !value.comparisons.every(isComparisonRecord)) return false;
  if (!isUniqueIdArray(value.trustedEvidenceRefs, 1, 256) || !isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt)) return false;
  if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) return false;
  if (new Set(value.baselineTasks.map((item) => `${item.taskId}:${item.taskVersion}`)).size !== value.baselineTasks.length) return false;
  if (new Set(value.assetBindings.map((item) => `${item.assetId}:${item.assetVersion}`)).size !== value.assetBindings.length) return false;
  if (new Set(value.comparisons.map((item) => item.comparisonRef)).size !== value.comparisons.length) return false;
  return recordCrossLinksAreValid(value as unknown as OneImprovementProofRecord, evidenceByRef);
}

export function isOneImprovementProofState(value: unknown): value is OneImprovementProofState {
  if (!isRecord(value) || !exactKeys(value, ["contractVersion", "version", "evidence", "proofs", "createdAt", "updatedAt"])) return false;
  if (value.contractVersion !== ONE_IMPROVEMENT_PROOF_CONTRACT_VERSION || !isPositiveVersion(value.version)) return false;
  if (!Array.isArray(value.evidence) || value.evidence.length > 8_192 || !value.evidence.every(isOneTrustedImprovementEvidence)) return false;
  if (!isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt) || Date.parse(value.updatedAt) < Date.parse(value.createdAt)) return false;
  if (new Set(value.evidence.map((item) => item.evidenceRef)).size !== value.evidence.length) return false;
  if (new Set(value.evidence.map((item) => item.receiptRef)).size !== value.evidence.length) return false;
  const evidenceByRef = new Map(value.evidence.map((item) => [item.evidenceRef, item]));
  if (!Array.isArray(value.proofs) || value.proofs.length > 4_096 || !value.proofs.every((item) => isImprovementProofRecord(item, evidenceByRef))) return false;
  return new Set(value.proofs.map((item) => item.proof.improvementProofId)).size === value.proofs.length;
}
