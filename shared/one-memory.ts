import { redactSecrets } from "./secret-patterns";

export const ONE_MEMORY_CONTRACT_VERSION = "1.0.0" as const;

export type OneMemoryScope = "personal" | "project" | "agent" | "team";
export type OneMemoryCandidateStatus = "pending" | "saved" | "used_once" | "rejected";
export type OneMemoryCandidateResolution = "saved" | "used_once" | "rejected";
export type OneMemoryProposalBasis = "inferred" | "explicit_user_statement" | "user_correction";
export type OneMemoryProvenanceStatus = "verified" | "legacy_unversioned";

export interface OneMemoryCandidateSource {
  provenanceStatus: OneMemoryProvenanceStatus;
  sourceTaskId: string;
  sourceTaskVersion: number | null;
  sourceRunId: string | null;
  sourceValueClosureId: string | null;
  sourceValueClosureVersion: number | null;
  sourceRef: string;
  evidenceRefs: string[];
  basis: OneMemoryProposalBasis;
}

export interface OneMemoryCandidate {
  id: string;
  version: number;
  normalizedPreview: string;
  scope: OneMemoryScope;
  scopeRef: string | null;
  source: OneMemoryCandidateSource;
  suppressionKey: string;
  status: OneMemoryCandidateStatus;
  resolution: OneMemoryCandidateResolution | null;
  memoryId: string | null;
  reviewAfter: string;
  cooldownUntil: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export interface OneMemoryAsset {
  id: string;
  version: number;
  content: string;
  scope: OneMemoryScope;
  scopeRef: string | null;
  sourceCandidateId: string;
  provenanceStatus: OneMemoryProvenanceStatus;
  sourceTaskId: string;
  sourceTaskVersion: number | null;
  sourceRunId: string | null;
  sourceValueClosureId: string | null;
  sourceValueClosureVersion: number | null;
  sourceRef: string;
  evidenceRefs: string[];
  approvalSource: "explicit_user";
  approvedAt: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  disabledAt: string | null;
}

export interface OneMemorySuppression {
  id: string;
  suppressionKey: string;
  scope: OneMemoryScope;
  scopeRef: string | null;
  candidateId: string;
  createdAt: string;
  until: string;
}

export interface OneMemoryState {
  contractVersion: typeof ONE_MEMORY_CONTRACT_VERSION;
  version: number;
  candidates: OneMemoryCandidate[];
  memories: OneMemoryAsset[];
  suppressions: OneMemorySuppression[];
  createdAt: string;
  updatedAt: string;
}

export interface ProposeOneMemoryCandidateInput {
  expectedStoreVersion: number;
  normalizedPreview: string;
  scope: OneMemoryScope;
  scopeRef?: string | null;
  source: OneMemoryCandidateSource;
  suppressionKey: string;
  reviewAfter?: string;
}

export interface SaveOneMemoryCandidateInput {
  expectedStoreVersion: number;
  candidateId: string;
  expectedCandidateVersion: number;
  approvedByUser: true;
}

export interface EditAndSaveOneMemoryCandidateInput extends SaveOneMemoryCandidateInput {
  content: string;
  scope?: OneMemoryScope;
  scopeRef?: string | null;
}

export interface UseOneMemoryCandidateOnceInput {
  expectedStoreVersion: number;
  candidateId: string;
  expectedCandidateVersion: number;
  target: OneMemoryUseOnceTarget;
  confirmedByUser: true;
}

/**
 * The exact One context in which a one-time Memory may be claimed. Main
 * re-derives project/agent/team scope from chatId; renderer-supplied scope
 * values are deliberately absent.
 */
export interface OneMemoryUseOnceTarget {
  chatId: string;
  expectedTaskId: string | null;
  expectedTaskVersion: number | null;
}

export interface RejectOneMemoryCandidateInput {
  expectedStoreVersion: number;
  candidateId: string;
  expectedCandidateVersion: number;
  rejectedByUser: true;
  cooldownMs?: number;
}

export interface DeleteOneMemoryCandidateInput {
  expectedStoreVersion: number;
  candidateId: string;
  expectedCandidateVersion: number;
  confirmedByUser: true;
}

export interface UpdateOneMemoryAssetInput {
  expectedStoreVersion: number;
  memoryId: string;
  expectedMemoryVersion: number;
  content?: string;
  scope?: OneMemoryScope;
  scopeRef?: string | null;
  approvedByUser: true;
}

export interface SetOneMemoryAssetEnabledInput {
  expectedStoreVersion: number;
  memoryId: string;
  expectedMemoryVersion: number;
  enabled: boolean;
  confirmedByUser: true;
}

export interface DeleteOneMemoryAssetInput {
  expectedStoreVersion: number;
  memoryId: string;
  expectedMemoryVersion: number;
  confirmedByUser: true;
}

export interface OneMemoryMutationResult<T> {
  storeVersion: number;
  updatedAt: string;
  value: T;
}

export interface OneMemoryInvocationScope {
  projectId?: string | null;
  agentId?: string | null;
  teamId?: string | null;
}

export interface OneMemorySavedResult {
  candidate: OneMemoryCandidate;
  memory: OneMemoryAsset;
}

export interface OneMemoryUseOnceRef {
  contractVersion: typeof ONE_MEMORY_CONTRACT_VERSION;
  receiptId: string;
}

/** Renderer-safe capability receipt. Candidate content and bindings stay in Main. */
export interface OneMemoryUseOnceReceipt extends OneMemoryUseOnceRef {
  issuedAt: string;
  expiresAt: string;
  persisted: false;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const CANDIDATE_ID_RE = /^memory_candidate_[a-f0-9]{32}$/;
const MEMORY_ID_RE = /^memory_[a-f0-9]{32}$/;
const VALUE_CLOSURE_ID_RE = /^value_closure_[a-f0-9]{32}$/;
const SUPPRESSION_ID_RE = /^memory_suppression_[a-f0-9]{32}$/;
const USE_ONCE_RECEIPT_ID_RE = /^memory_once_receipt_[a-f0-9]{32}$/;
const SCOPES = new Set<OneMemoryScope>(["personal", "project", "agent", "team"]);
const STATUSES = new Set<OneMemoryCandidateStatus>(["pending", "saved", "used_once", "rejected"]);
const BASES = new Set<OneMemoryProposalBasis>(["inferred", "explicit_user_statement", "user_correction"]);
const POSIX_ABSOLUTE_PATH_RE = /(^|[\s("'=:\[{])\/[^\s,;:"'`<>|}\]]+/m;
const WINDOWS_ABSOLUTE_PATH_RE = /\b[A-Za-z]:\\(?:[^\\,\r\n"'`<>|}\]]+\\)*[^\s\\,\r\n"'`<>|}\]]+/;
const UNC_PATH_RE = /\\\\[^\\\s,;:"'`<>|}\]]+(?:\\[^\\\s,;:"'`<>|}\]]+)+/;
const EXECUTABLE_OR_TRANSPORT_RE = /(?:<\/?(?:html|body|script|iframe|object|embed)\b|javascript\s*:|data\s*:|\b(?:https?|file):\/\/|dangerouslySetInnerHTML|\bon(?:error|load|click)\s*=)/i;
const RAW_TRANSCRIPT_RE = /(?:^|\n)\s*(?:user|assistant|system|customer|agent|사용자|어시스턴트)\s*:/i;

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

function isSafeId(value: unknown): value is string {
  return typeof value === "string" && ID_RE.test(value);
}

function isPositiveVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function hasValidProvenance(value: Record<string, unknown>): boolean {
  if (value.provenanceStatus === "verified") {
    return isPositiveVersion(value.sourceTaskVersion)
      && isSafeId(value.sourceRunId)
      && typeof value.sourceValueClosureId === "string"
      && VALUE_CLOSURE_ID_RE.test(value.sourceValueClosureId)
      && isPositiveVersion(value.sourceValueClosureVersion);
  }
  return value.provenanceStatus === "legacy_unversioned"
    && value.sourceTaskVersion === null
    && value.sourceRunId === null
    && value.sourceValueClosureId === null
    && value.sourceValueClosureVersion === null;
}

function isScope(value: unknown): value is OneMemoryScope {
  return typeof value === "string" && SCOPES.has(value as OneMemoryScope);
}

function validScopeRef(scope: OneMemoryScope, value: unknown): boolean {
  return scope === "personal" ? value === null : isSafeId(value);
}

export function isOneMemoryUseOnceRef(value: unknown): value is OneMemoryUseOnceRef {
  if (!isRecord(value) || !exactKeys(value, ["contractVersion", "receiptId"])) return false;
  return value.contractVersion === ONE_MEMORY_CONTRACT_VERSION
    && typeof value.receiptId === "string"
    && USE_ONCE_RECEIPT_ID_RE.test(value.receiptId);
}

export type OneMemoryUnsafeTextReason =
  | "secret"
  | "local_path"
  | "transport_or_markup"
  | "raw_transcript";

export function unsafeOneMemoryTextReason(value: string): OneMemoryUnsafeTextReason | null {
  if (redactSecrets(value) !== value) return "secret";
  if (EXECUTABLE_OR_TRANSPORT_RE.test(value)) return "transport_or_markup";
  if (POSIX_ABSOLUTE_PATH_RE.test(value) || WINDOWS_ABSOLUTE_PATH_RE.test(value) || UNC_PATH_RE.test(value)) {
    return "local_path";
  }
  if (RAW_TRANSCRIPT_RE.test(value)) return "raw_transcript";
  return null;
}

export function isSafeOneMemoryText(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 500 && !unsafeOneMemoryTextReason(value);
}

function isSource(value: unknown): value is OneMemoryCandidateSource {
  if (!isRecord(value) || !exactKeys(value, [
    "provenanceStatus", "sourceTaskId", "sourceTaskVersion", "sourceRunId",
    "sourceValueClosureId", "sourceValueClosureVersion", "sourceRef", "evidenceRefs", "basis",
  ])) return false;
  return isSafeId(value.sourceTaskId)
    && hasValidProvenance(value)
    && isSafeId(value.sourceRef)
    && Array.isArray(value.evidenceRefs)
    && value.evidenceRefs.length >= 1
    && value.evidenceRefs.length <= 32
    && value.evidenceRefs.every(isSafeId)
    && new Set(value.evidenceRefs).size === value.evidenceRefs.length
    && typeof value.basis === "string"
    && BASES.has(value.basis as OneMemoryProposalBasis);
}

function isCandidate(value: unknown): value is OneMemoryCandidate {
  if (!isRecord(value) || !exactKeys(value, [
    "id", "version", "normalizedPreview", "scope", "scopeRef", "source", "suppressionKey",
    "status", "resolution", "memoryId", "reviewAfter", "cooldownUntil", "createdAt", "updatedAt", "resolvedAt",
  ])) return false;
  if (
    typeof value.id !== "string" || !CANDIDATE_ID_RE.test(value.id) ||
    !Number.isSafeInteger(value.version) || Number(value.version) <= 0 ||
    !isSafeOneMemoryText(value.normalizedPreview) ||
    !isScope(value.scope) || !validScopeRef(value.scope, value.scopeRef) ||
    !isSource(value.source) || !isSafeId(value.suppressionKey) ||
    typeof value.status !== "string" || !STATUSES.has(value.status as OneMemoryCandidateStatus) ||
    !isTimestamp(value.reviewAfter) || !isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt) ||
    Date.parse(value.updatedAt) !== value.version ||
    !(value.resolvedAt === null || isTimestamp(value.resolvedAt)) ||
    !(value.cooldownUntil === null || isTimestamp(value.cooldownUntil)) ||
    !(value.memoryId === null || (typeof value.memoryId === "string" && MEMORY_ID_RE.test(value.memoryId)))
  ) return false;
  if (
    Date.parse(value.reviewAfter) <= Date.parse(value.createdAt) ||
    Date.parse(value.updatedAt) < Date.parse(value.createdAt) ||
    (value.resolvedAt !== null && Date.parse(value.resolvedAt) < Date.parse(value.createdAt)) ||
    (value.cooldownUntil !== null && value.resolvedAt !== null && Date.parse(value.cooldownUntil) <= Date.parse(value.resolvedAt))
  ) return false;
  if (value.status === "pending") {
    return value.resolution === null && value.memoryId === null && value.resolvedAt === null && value.cooldownUntil === null;
  }
  if (value.status === "saved") {
    return value.resolution === "saved" && value.memoryId !== null && value.resolvedAt !== null && value.cooldownUntil === null;
  }
  if (value.status === "used_once") {
    return value.resolution === "used_once" && value.memoryId === null && value.resolvedAt !== null && value.cooldownUntil === null;
  }
  return value.resolution === "rejected" && value.memoryId === null && value.resolvedAt !== null && value.cooldownUntil !== null;
}

function isMemory(value: unknown): value is OneMemoryAsset {
  if (!isRecord(value) || !exactKeys(value, [
    "id", "version", "content", "scope", "scopeRef", "sourceCandidateId", "provenanceStatus",
    "sourceTaskId", "sourceTaskVersion", "sourceRunId", "sourceValueClosureId", "sourceValueClosureVersion", "sourceRef",
    "evidenceRefs", "approvalSource", "approvedAt", "enabled", "createdAt", "updatedAt", "disabledAt",
  ])) return false;
  return typeof value.id === "string" && MEMORY_ID_RE.test(value.id)
    && Number.isSafeInteger(value.version) && Number(value.version) > 0
    && isSafeOneMemoryText(value.content)
    && isScope(value.scope) && validScopeRef(value.scope, value.scopeRef)
    && typeof value.sourceCandidateId === "string" && CANDIDATE_ID_RE.test(value.sourceCandidateId)
    && isSafeId(value.sourceTaskId) && hasValidProvenance(value) && isSafeId(value.sourceRef)
    && Array.isArray(value.evidenceRefs) && value.evidenceRefs.length >= 1 && value.evidenceRefs.length <= 32
    && value.evidenceRefs.every(isSafeId) && new Set(value.evidenceRefs).size === value.evidenceRefs.length
    && value.approvalSource === "explicit_user" && isTimestamp(value.approvedAt)
    && typeof value.enabled === "boolean" && isTimestamp(value.createdAt) && isTimestamp(value.updatedAt)
    && Date.parse(value.updatedAt) === value.version
    && (value.disabledAt === null || isTimestamp(value.disabledAt))
    && ((value.enabled && value.disabledAt === null) || (!value.enabled && value.disabledAt !== null))
    && Date.parse(value.updatedAt) >= Date.parse(value.createdAt)
    && Date.parse(value.approvedAt) >= Date.parse(value.createdAt)
    && Date.parse(value.approvedAt) <= Date.parse(value.updatedAt)
    && (value.disabledAt === null || Date.parse(value.disabledAt) >= Date.parse(value.createdAt));
}

function isSuppression(value: unknown): value is OneMemorySuppression {
  if (!isRecord(value) || !exactKeys(value, [
    "id", "suppressionKey", "scope", "scopeRef", "candidateId", "createdAt", "until",
  ])) return false;
  return typeof value.id === "string" && SUPPRESSION_ID_RE.test(value.id)
    && isSafeId(value.suppressionKey) && isScope(value.scope) && validScopeRef(value.scope, value.scopeRef)
    && typeof value.candidateId === "string" && CANDIDATE_ID_RE.test(value.candidateId)
    && isTimestamp(value.createdAt) && isTimestamp(value.until) && Date.parse(value.until) > Date.parse(value.createdAt);
}

export function isOneMemoryState(value: unknown): value is OneMemoryState {
  if (!isRecord(value) || !exactKeys(value, [
    "contractVersion", "version", "candidates", "memories", "suppressions", "createdAt", "updatedAt",
  ])) return false;
  if (
    value.contractVersion !== ONE_MEMORY_CONTRACT_VERSION ||
    !Number.isSafeInteger(value.version) || Number(value.version) <= 0 ||
    !Array.isArray(value.candidates) || value.candidates.length > 512 || !value.candidates.every(isCandidate) ||
    !Array.isArray(value.memories) || value.memories.length > 512 || !value.memories.every(isMemory) ||
    !Array.isArray(value.suppressions) || value.suppressions.length > 512 || !value.suppressions.every(isSuppression) ||
    !isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt) || Date.parse(value.updatedAt) !== value.version
  ) return false;
  return new Set(value.candidates.map((item) => item.id)).size === value.candidates.length
    && new Set(value.memories.map((item) => item.id)).size === value.memories.length
    && new Set(value.suppressions.map((item) => item.id)).size === value.suppressions.length;
}
