import { looksSecret } from "./secret-patterns";

export const ONE_VALUE_CLOSURE_CONTRACT_VERSION = "1.0.0" as const;

export type OneValueClosureOutcomeStatus = "verified" | "partially_verified";
export type OneValueClosurePhase = "discovery" | "preparation" | "execution" | "verification";
export type OneValueClosurePhaseStatus =
  | "not_started"
  | "prepared"
  | "in_progress"
  | "completed"
  | "failed"
  | "not_applicable";
export type OneValueClosureRemainingOwner = "user" | "one" | "external";
export type OneValueClosureRemainingStatus = "pending" | "blocked" | "not_required";
export type OneOriginalPreservationStatus = "preserved" | "not_applicable" | "modified_with_approval";

export interface OneValueClosureLifecycleClaim {
  phase: OneValueClosurePhase;
  status: OneValueClosurePhaseStatus;
  summary: string;
  evidenceRefs: string[];
}

export interface OneValueClosureFactItem {
  valueItemId: string;
  kind: "fact";
  statement: string;
  evidenceRefs: string[];
}

export interface OneValueClosureEstimate {
  value?: number;
  lowerBound?: number;
  upperBound?: number;
  unit: string;
  basis: string;
  method: string;
  evidenceRefs: string[];
}

export interface OneValueClosureEstimateItem {
  valueItemId: string;
  kind: "estimate";
  statement: string;
  estimate: OneValueClosureEstimate;
}

export type OneValueClosureValueItem = OneValueClosureFactItem | OneValueClosureEstimateItem;

export interface OneValueClosureOriginalPreservation {
  status: OneOriginalPreservationStatus;
  artifactRefs: string[];
  receiptRefs: string[];
  explanation?: string;
}

export interface OneValueClosureRemainingWork {
  itemRef: string;
  action: string;
  owner: OneValueClosureRemainingOwner;
  status: OneValueClosureRemainingStatus;
  reason?: string;
}

export interface OneValueClosureReflection {
  eligible: boolean;
  userOptedIn: boolean;
  included: boolean;
}

/** The renderer-safe contract defined by value-closure.v1.schema.json. */
export interface OneValueClosureV1 {
  contractVersion: typeof ONE_VALUE_CLOSURE_CONTRACT_VERSION;
  valueClosureId: string;
  taskId: string;
  status: "ready";
  outcomeStatus: OneValueClosureOutcomeStatus;
  generatedAt: string;
  outcomeRefs: string[];
  lifecycleClaims: OneValueClosureLifecycleClaim[];
  valueItems: OneValueClosureValueItem[];
  originalPreservation: OneValueClosureOriginalPreservation;
  remainingWork: OneValueClosureRemainingWork[];
  receiptRefs: string[];
  reflection: OneValueClosureReflection;
}

export type OneTrustedOutcomeEvidenceKind =
  | "discovery_receipt"
  | "preparation_receipt"
  | "execution_receipt"
  | "outcome_verification"
  | "artifact_verification"
  | "original_preservation"
  | "estimate_baseline"
  | "approval_receipt"
  | "result_acceptance";

export type OneTrustedOutcomeEvidenceSource =
  | "host_connector"
  | "artifact_verifier"
  | "filesystem_guard"
  | "explicit_user_observation"
  | "invocation_runtime"
  | "canonical_task_runtime";

/**
 * A content-free attestation produced in Electron Main after the host observed
 * evidence. It deliberately carries opaque references, not source payloads.
 */
export interface OneTrustedOutcomeEvidence {
  evidenceRef: string;
  receiptRef: string;
  taskId: string;
  taskVersion: number;
  kind: OneTrustedOutcomeEvidenceKind;
  source: OneTrustedOutcomeEvidenceSource;
  verificationStatus: OneValueClosureOutcomeStatus;
  observedAt: string;
  sourceRef: string;
  outcomeRef?: string;
  artifactRef?: string;
  sourceRunRef?: string;
}

export interface OneValueClosureRecord {
  closure: OneValueClosureV1;
  version: number;
  taskVersion: number;
  trustedEvidenceRefs: string[];
  artifactRefs: string[];
  estimateRefs: string[];
  createdAt: string;
  updatedAt: string;
}

export interface OneValueClosureState {
  contractVersion: typeof ONE_VALUE_CLOSURE_CONTRACT_VERSION;
  version: number;
  evidence: OneTrustedOutcomeEvidence[];
  closures: OneValueClosureRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateOneValueClosureInput {
  expectedStoreVersion: number;
  /** Main-only trust-boundary assertion. This input must never be renderer IPC. */
  trustedHostAttested: true;
  taskId: string;
  expectedTaskVersion: number;
  outcomeStatus: OneValueClosureOutcomeStatus;
  outcomeRefs: string[];
  lifecycleClaims: OneValueClosureLifecycleClaim[];
  valueItems: OneValueClosureValueItem[];
  originalPreservation: OneValueClosureOriginalPreservation;
  remainingWork: OneValueClosureRemainingWork[];
  receiptRefs: string[];
  reflectionEligible: boolean;
  trustedHostEvidence: OneTrustedOutcomeEvidence[];
}

export interface SetOneValueClosureReflectionInput {
  expectedStoreVersion: number;
  valueClosureId: string;
  expectedClosureVersion: number;
  userOptedIn: boolean;
  included: boolean;
  confirmedByUser: true;
}

export interface OneValueClosureMutationResult<T> {
  storeVersion: number;
  updatedAt: string;
  value: T;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const CLOSURE_ID_RE = /^value_closure_[a-f0-9]{32}$/;
const PHASES: readonly OneValueClosurePhase[] = ["discovery", "preparation", "execution", "verification"];
const PHASE_STATUSES = new Set<OneValueClosurePhaseStatus>([
  "not_started", "prepared", "in_progress", "completed", "failed", "not_applicable",
]);
const EVIDENCE_KINDS = new Set<OneTrustedOutcomeEvidenceKind>([
  "discovery_receipt", "preparation_receipt", "execution_receipt", "outcome_verification",
  "artifact_verification", "original_preservation", "estimate_baseline", "approval_receipt",
  "result_acceptance",
]);
const EVIDENCE_SOURCES = new Set<OneTrustedOutcomeEvidenceSource>([
  "host_connector", "artifact_verifier", "filesystem_guard", "explicit_user_observation",
  "invocation_runtime", "canonical_task_runtime",
]);
const POSIX_ABSOLUTE_PATH_RE = /(^|[\s("'=:\[{])\/[^\s,;:"'`<>|}\]]+/m;
const WINDOWS_ABSOLUTE_PATH_RE = /\b[A-Za-z]:\\(?:[^\\,\r\n"'`<>|}\]]+\\)*[^\s\\,\r\n"'`<>|}\]]+/;
const UNC_PATH_RE = /\\\\[^\\\s,;:"'`<>|}\]]+(?:\\[^\\\s,;:"'`<>|}\]]+)+/;
const TRANSPORT_OR_MARKUP_RE = /(?:<|\b(?:https?|file|javascript|data):(?:\/\/)?|dangerouslySetInnerHTML|\bon(?:error|load|click)\s*=)/i;
const RAW_TRANSCRIPT_RE = /(?:^|\n)\s*(?:user|assistant|system|customer|agent|사용자|어시스턴트)\s*:/i;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const KOREAN_ID_RE = /\b\d{6}\s*-\s*[1-8]\d{6}\b/;
const PHONE_RE = /(?:^|\D)(?:\+?82[-.\s]?)?0?1[016789][-.\s]?\d{3,4}[-.\s]?\d{4}(?:\D|$)/;
const COMPLETION_CLAIM_RE = /(?:\b(?:sent|published|posted|booked|reserved|purchased|paid|delivered|submitted|deployed|completed)\b|보냈|전송(?:이|을| 완료)|게시(?:했|가 완료)|예약(?:했|이 완료)|구매(?:했|가 완료)|결제(?:했|가 완료)|제출(?:했|이 완료)|배포(?:했|가 완료))/i;

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

export type OneValueClosureUnsafeTextReason =
  | "secret"
  | "local_path"
  | "transport_or_markup"
  | "raw_transcript"
  | "private_data";

export function unsafeOneValueClosureTextReason(value: string): OneValueClosureUnsafeTextReason | null {
  if (looksSecret(value)) return "secret";
  if (TRANSPORT_OR_MARKUP_RE.test(value)) return "transport_or_markup";
  if (POSIX_ABSOLUTE_PATH_RE.test(value) || WINDOWS_ABSOLUTE_PATH_RE.test(value) || UNC_PATH_RE.test(value)) {
    return "local_path";
  }
  if (RAW_TRANSCRIPT_RE.test(value)) return "raw_transcript";
  if (EMAIL_RE.test(value) || KOREAN_ID_RE.test(value) || PHONE_RE.test(value) || luhnLikePrivateNumber(value)) {
    return "private_data";
  }
  return null;
}

export function isSafeOneValueClosureText(value: unknown, maxLength = 4_000): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= maxLength
    && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)
    && !unsafeOneValueClosureTextReason(value);
}

export function isSafeOneValueClosureId(value: unknown): value is string {
  return typeof value === "string" && ID_RE.test(value) && !looksSecret(value);
}

function isUniqueIdArray(value: unknown, min: number, max: number): value is string[] {
  return Array.isArray(value)
    && value.length >= min
    && value.length <= max
    && value.every(isSafeOneValueClosureId)
    && new Set(value).size === value.length;
}

function isLifecycleClaim(value: unknown, expectedPhase: OneValueClosurePhase): value is OneValueClosureLifecycleClaim {
  if (!isRecord(value) || !exactKeys(value, ["phase", "status", "summary", "evidenceRefs"])) return false;
  if (value.phase !== expectedPhase || typeof value.status !== "string" || !PHASE_STATUSES.has(value.status as OneValueClosurePhaseStatus)) return false;
  if (!isSafeOneValueClosureText(value.summary) || !isUniqueIdArray(value.evidenceRefs, 0, 32)) return false;
  if ((value.status === "completed" && (expectedPhase === "execution" || expectedPhase === "verification")) && value.evidenceRefs.length < 1) {
    return false;
  }
  return true;
}

function isEstimate(value: unknown): value is OneValueClosureEstimate {
  if (!isRecord(value) || !exactKeys(value, ["value", "lowerBound", "upperBound", "unit", "basis", "method", "evidenceRefs"])) return false;
  if (!isSafeOneValueClosureText(value.unit, 160) || !isSafeOneValueClosureText(value.basis) || !isSafeOneValueClosureText(value.method)) return false;
  if (!isUniqueIdArray(value.evidenceRefs, 1, 32)) return false;
  const scalar = value.value !== undefined && typeof value.value === "number" && Number.isFinite(value.value);
  const range = value.lowerBound !== undefined && value.upperBound !== undefined
    && typeof value.lowerBound === "number" && Number.isFinite(value.lowerBound)
    && typeof value.upperBound === "number" && Number.isFinite(value.upperBound)
    && value.lowerBound <= value.upperBound;
  if (scalar === range) return false;
  if (!range && (value.lowerBound !== undefined || value.upperBound !== undefined)) return false;
  return true;
}

function isValueItem(value: unknown): value is OneValueClosureValueItem {
  if (!isRecord(value) || !isSafeOneValueClosureId(value.valueItemId) || !isSafeOneValueClosureText(value.statement)) return false;
  if (value.kind === "fact") {
    return exactKeys(value, ["valueItemId", "kind", "statement", "evidenceRefs"])
      && isUniqueIdArray(value.evidenceRefs, 1, 32);
  }
  if (value.kind === "estimate") {
    return exactKeys(value, ["valueItemId", "kind", "statement", "estimate"])
      && isEstimate(value.estimate);
  }
  return false;
}

function isOriginalPreservation(value: unknown): value is OneValueClosureOriginalPreservation {
  if (!isRecord(value) || !exactKeys(value, ["status", "artifactRefs", "receiptRefs", "explanation"])) return false;
  if (!["preserved", "not_applicable", "modified_with_approval"].includes(String(value.status))) return false;
  if (!isUniqueIdArray(value.artifactRefs, 0, 64) || !isUniqueIdArray(value.receiptRefs, 0, 64)) return false;
  if (value.explanation !== undefined && !isSafeOneValueClosureText(value.explanation)) return false;
  if (value.status === "modified_with_approval") {
    return value.receiptRefs.length >= 1 && isSafeOneValueClosureText(value.explanation);
  }
  return value.explanation === undefined || isSafeOneValueClosureText(value.explanation);
}

function isRemainingWork(value: unknown): value is OneValueClosureRemainingWork {
  if (!isRecord(value) || !exactKeys(value, ["itemRef", "action", "owner", "status", "reason"])) return false;
  return isSafeOneValueClosureId(value.itemRef)
    && isSafeOneValueClosureText(value.action)
    && ["user", "one", "external"].includes(String(value.owner))
    && ["pending", "blocked", "not_required"].includes(String(value.status))
    && (value.reason === undefined || isSafeOneValueClosureText(value.reason));
}

function isReflection(value: unknown): value is OneValueClosureReflection {
  if (!isRecord(value) || !exactKeys(value, ["eligible", "userOptedIn", "included"])) return false;
  if (typeof value.eligible !== "boolean" || typeof value.userOptedIn !== "boolean" || typeof value.included !== "boolean") return false;
  return !value.included || (value.eligible && value.userOptedIn);
}

export function isOneValueClosureV1(value: unknown): value is OneValueClosureV1 {
  if (!isRecord(value) || !exactKeys(value, [
    "contractVersion", "valueClosureId", "taskId", "status", "outcomeStatus", "generatedAt",
    "outcomeRefs", "lifecycleClaims", "valueItems", "originalPreservation", "remainingWork",
    "receiptRefs", "reflection",
  ])) return false;
  if (value.contractVersion !== ONE_VALUE_CLOSURE_CONTRACT_VERSION || !CLOSURE_ID_RE.test(String(value.valueClosureId))) return false;
  if (!isSafeOneValueClosureId(value.taskId) || value.status !== "ready") return false;
  if (!["verified", "partially_verified"].includes(String(value.outcomeStatus)) || !isTimestamp(value.generatedAt)) return false;
  if (!isUniqueIdArray(value.outcomeRefs, 1, 32) || !isUniqueIdArray(value.receiptRefs, 1, 128)) return false;
  const lifecycleClaims = value.lifecycleClaims;
  if (!Array.isArray(lifecycleClaims) || lifecycleClaims.length !== PHASES.length) return false;
  if (!PHASES.every((phase, index) => isLifecycleClaim(lifecycleClaims[index], phase))) return false;
  const valueItems = value.valueItems;
  if (!Array.isArray(valueItems) || valueItems.length < 1 || valueItems.length > 24 || !valueItems.every(isValueItem)) return false;
  if (new Set(valueItems.map((item) => item.valueItemId)).size !== valueItems.length) return false;
  if (!isOriginalPreservation(value.originalPreservation)) return false;
  const remainingWork = value.remainingWork;
  if (!Array.isArray(remainingWork) || remainingWork.length > 32 || !remainingWork.every(isRemainingWork)) return false;
  if (new Set(remainingWork.map((item) => item.itemRef)).size !== remainingWork.length) return false;
  if (!isReflection(value.reflection)) return false;
  const verification = lifecycleClaims[3] as OneValueClosureLifecycleClaim;
  return value.outcomeStatus !== "verified" || verification.status === "completed";
}

export function parseOneValueClosureJson(raw: string): OneValueClosureV1 | null {
  const bytes = typeof TextEncoder !== "undefined" ? new TextEncoder().encode(raw).byteLength : raw.length * 3;
  if (bytes > 256 * 1024) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return isOneValueClosureV1(value) ? value : null;
  } catch {
    return null;
  }
}

export function isOneTrustedOutcomeEvidence(value: unknown): value is OneTrustedOutcomeEvidence {
  if (!isRecord(value) || !exactKeys(value, [
    "evidenceRef", "receiptRef", "taskId", "taskVersion", "kind", "source", "verificationStatus",
    "observedAt", "sourceRef", "outcomeRef", "artifactRef", "sourceRunRef",
  ])) return false;
  if (!isSafeOneValueClosureId(value.evidenceRef) || !isSafeOneValueClosureId(value.receiptRef) || !isSafeOneValueClosureId(value.taskId)) return false;
  if (!isPositiveVersion(value.taskVersion) || typeof value.kind !== "string" || !EVIDENCE_KINDS.has(value.kind as OneTrustedOutcomeEvidenceKind)) return false;
  if (typeof value.source !== "string" || !EVIDENCE_SOURCES.has(value.source as OneTrustedOutcomeEvidenceSource)) return false;
  if (!["verified", "partially_verified"].includes(String(value.verificationStatus)) || !isTimestamp(value.observedAt)) return false;
  if (!isSafeOneValueClosureId(value.sourceRef)) return false;
  if (value.outcomeRef !== undefined && !isSafeOneValueClosureId(value.outcomeRef)) return false;
  if (value.artifactRef !== undefined && !isSafeOneValueClosureId(value.artifactRef)) return false;
  if (value.sourceRunRef !== undefined && !isSafeOneValueClosureId(value.sourceRunRef)) return false;
  if (value.source === "explicit_user_observation" && value.verificationStatus === "verified") return false;
  if (["outcome_verification", "result_acceptance"].includes(value.kind as string) && value.outcomeRef === undefined) return false;
  if (["artifact_verification", "original_preservation"].includes(value.kind as string) && value.artifactRef === undefined) return false;
  if (value.kind === "result_acceptance" && (
    value.source !== "canonical_task_runtime"
    || value.verificationStatus !== "verified"
    || value.sourceRunRef === undefined
    || value.artifactRef !== undefined
  )) return false;
  if (value.source === "canonical_task_runtime" && value.kind !== "result_acceptance") return false;
  if (value.source === "invocation_runtime" && (
    value.kind !== "execution_receipt"
    || value.verificationStatus !== "verified"
    || value.sourceRunRef === undefined
    || value.outcomeRef !== undefined
    || value.artifactRef !== undefined
  )) return false;
  return true;
}

function isValueClosureRecord(value: unknown): value is OneValueClosureRecord {
  if (!isRecord(value) || !exactKeys(value, [
    "closure", "version", "taskVersion", "trustedEvidenceRefs", "artifactRefs", "estimateRefs",
    "createdAt", "updatedAt",
  ])) return false;
  return isOneValueClosureV1(value.closure)
    && isPositiveVersion(value.version)
    && isPositiveVersion(value.taskVersion)
    && isUniqueIdArray(value.trustedEvidenceRefs, 1, 128)
    && isUniqueIdArray(value.artifactRefs, 0, 64)
    && isUniqueIdArray(value.estimateRefs, 0, 128)
    && isTimestamp(value.createdAt)
    && isTimestamp(value.updatedAt)
    && Date.parse(value.updatedAt) >= Date.parse(value.createdAt);
}

export function isOneValueClosureState(value: unknown): value is OneValueClosureState {
  if (!isRecord(value) || !exactKeys(value, ["contractVersion", "version", "evidence", "closures", "createdAt", "updatedAt"])) return false;
  if (value.contractVersion !== ONE_VALUE_CLOSURE_CONTRACT_VERSION || !isPositiveVersion(value.version)) return false;
  if (!Array.isArray(value.evidence) || value.evidence.length > 4_096 || !value.evidence.every(isOneTrustedOutcomeEvidence)) return false;
  if (!Array.isArray(value.closures) || value.closures.length > 2_048 || !value.closures.every(isValueClosureRecord)) return false;
  if (!isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt) || Date.parse(value.updatedAt) < Date.parse(value.createdAt)) return false;
  if (new Set(value.evidence.map((item) => item.evidenceRef)).size !== value.evidence.length) return false;
  if (new Set(value.evidence.map((item) => item.receiptRef)).size !== value.evidence.length) return false;
  if (new Set(value.closures.map((item) => item.closure.valueClosureId)).size !== value.closures.length) return false;
  const evidenceByRef = new Map(value.evidence.map((item) => [item.evidenceRef, item]));
  return value.closures.every((record) => record.trustedEvidenceRefs.every((ref) => {
    const evidence = evidenceByRef.get(ref);
    return evidence?.taskId === record.closure.taskId && evidence.taskVersion === record.taskVersion;
  }));
}

/** Judgment-cache kind shared by the async electron warm pass and synchronous peeks. */
export const ONE_COMPLETION_CLAIM_JUDGMENT_KIND = "one-completion-claim";

/**
 * Does this value statement claim an external/irreversible action already happened?
 * This gates a trust invariant (a completion claim needs execution/outcome evidence),
 * so under-firing is the dangerous direction: the English/Korean regex misses the
 * same claim in any other language. The connected model decides when a judged
 * verdict exists — `judged` is a synchronous reader of the resident judgment cache
 * (electron passes a peek warmed by prejudgeCompletionClaim). No verdict = today's
 * regex result, the labeled fallback.
 */
export function oneValueClosureContainsCompletionClaim(
  value: string,
  judged?: (text: string) => boolean | null,
): boolean {
  const judgedVerdict = judged?.(value) ?? null;
  if (judgedVerdict !== null) return judgedVerdict;
  return COMPLETION_CLAIM_RE.test(value);
}
