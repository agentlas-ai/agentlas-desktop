export const ONE_EXPERIENCE_REUSE_CONTRACT_VERSION = "1.0.0" as const;

export type OneExperienceReuseScope = "personal" | "project" | "agent" | "team";

export interface OneExperienceReuseAssetBinding {
  assetId: string;
  assetVersion: number;
  provenanceStatus: "verified";
  sourceTaskId: string;
  sourceTaskVersion: number;
  sourceRunId: string;
  sourceValueClosureId: string;
  sourceValueClosureVersion: number;
  scope: OneExperienceReuseScope;
}

export interface OneExperienceReuseReceiptV1 {
  contractVersion: typeof ONE_EXPERIENCE_REUSE_CONTRACT_VERSION;
  reuseReceiptId: string;
  taskId: string;
  taskVersion: number;
  runId: string;
  valueClosureId: string;
  valueClosureVersion: number;
  memoryStoreVersion: number;
  assetBindings: OneExperienceReuseAssetBinding[];
  reuseStatus: "approved_experience_reused";
  comparisonStatus: "not_yet_measured";
  improvementClaimed: false;
  createdAt: string;
}

export interface OneExperienceReuseRecord {
  receipt: OneExperienceReuseReceiptV1;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface OneExperienceReuseState {
  contractVersion: typeof ONE_EXPERIENCE_REUSE_CONTRACT_VERSION;
  version: number;
  receipts: OneExperienceReuseRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface EnsureOneExperienceReuseReceiptInput {
  taskId: string;
  expectedTaskVersion: number;
  expectedTaskUpdatedAt: string;
  expectedRunId: string;
  valueClosureId: string;
  expectedValueClosureVersion: number;
  confirmedByUser: true;
}

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const RECEIPT_ID_RE = /^one_reuse_receipt_[a-f0-9]{32}$/;
const MEMORY_ID_RE = /^memory_[a-f0-9]{32}$/;
const VALUE_CLOSURE_ID_RE = /^value_closure_[a-f0-9]{32}$/;
const SCOPES = new Set<OneExperienceReuseScope>(["personal", "project", "agent", "team"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  const actual = Object.keys(value);
  return actual.length === allowed.length && actual.every((key) => keys.has(key));
}

function isSafeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID_RE.test(value);
}

function isPositiveVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && new Date(parsed).toISOString() === value;
}

function isAssetBinding(value: unknown): value is OneExperienceReuseAssetBinding {
  if (!isRecord(value) || !exactKeys(value, [
    "assetId", "assetVersion", "provenanceStatus", "sourceTaskId", "sourceTaskVersion", "sourceRunId",
    "sourceValueClosureId", "sourceValueClosureVersion", "scope",
  ])) return false;
  return typeof value.assetId === "string"
    && MEMORY_ID_RE.test(value.assetId)
    && isPositiveVersion(value.assetVersion)
    && value.provenanceStatus === "verified"
    && isSafeId(value.sourceTaskId)
    && isPositiveVersion(value.sourceTaskVersion)
    && isSafeId(value.sourceRunId)
    && typeof value.sourceValueClosureId === "string"
    && VALUE_CLOSURE_ID_RE.test(value.sourceValueClosureId)
    && isPositiveVersion(value.sourceValueClosureVersion)
    && typeof value.scope === "string"
    && SCOPES.has(value.scope as OneExperienceReuseScope);
}

export function isOneExperienceReuseReceiptV1(value: unknown): value is OneExperienceReuseReceiptV1 {
  if (!isRecord(value) || !exactKeys(value, [
    "contractVersion", "reuseReceiptId", "taskId", "taskVersion", "runId", "valueClosureId",
    "valueClosureVersion", "memoryStoreVersion", "assetBindings", "reuseStatus", "comparisonStatus",
    "improvementClaimed", "createdAt",
  ])) return false;
  return value.contractVersion === ONE_EXPERIENCE_REUSE_CONTRACT_VERSION
    && typeof value.reuseReceiptId === "string"
    && RECEIPT_ID_RE.test(value.reuseReceiptId)
    && isSafeId(value.taskId)
    && isPositiveVersion(value.taskVersion)
    && isSafeId(value.runId)
    && typeof value.valueClosureId === "string"
    && VALUE_CLOSURE_ID_RE.test(value.valueClosureId)
    && isPositiveVersion(value.valueClosureVersion)
    && isPositiveVersion(value.memoryStoreVersion)
    && Array.isArray(value.assetBindings)
    && value.assetBindings.length >= 1
    && value.assetBindings.length <= 32
    && value.assetBindings.every(isAssetBinding)
    && new Set(value.assetBindings.map((item) => item.assetId)).size === value.assetBindings.length
    && value.assetBindings.every((item) => item.sourceTaskId !== value.taskId)
    && value.reuseStatus === "approved_experience_reused"
    && value.comparisonStatus === "not_yet_measured"
    && value.improvementClaimed === false
    && isTimestamp(value.createdAt)
    && Date.parse(value.createdAt) === value.taskVersion;
}

function isRecordEntry(value: unknown): value is OneExperienceReuseRecord {
  if (!isRecord(value) || !exactKeys(value, ["receipt", "version", "createdAt", "updatedAt"])) return false;
  return isOneExperienceReuseReceiptV1(value.receipt)
    && isPositiveVersion(value.version)
    && isTimestamp(value.createdAt)
    && isTimestamp(value.updatedAt)
    && value.createdAt === value.receipt.createdAt
    && Date.parse(value.updatedAt) === value.version
    && value.receipt.memoryStoreVersion <= value.version
    && value.receipt.valueClosureVersion <= value.version
    && Date.parse(value.updatedAt) >= Date.parse(value.createdAt);
}

export function isOneExperienceReuseState(value: unknown): value is OneExperienceReuseState {
  if (!isRecord(value) || !exactKeys(value, [
    "contractVersion", "version", "receipts", "createdAt", "updatedAt",
  ])) return false;
  if (
    value.contractVersion !== ONE_EXPERIENCE_REUSE_CONTRACT_VERSION
    || !isPositiveVersion(value.version)
    || !isTimestamp(value.createdAt)
    || !isTimestamp(value.updatedAt)
    || Date.parse(value.updatedAt) !== value.version
    || Date.parse(value.updatedAt) < Date.parse(value.createdAt)
    || !Array.isArray(value.receipts)
    || value.receipts.length > 4_096
    || !value.receipts.every(isRecordEntry)
  ) return false;
  return new Set(value.receipts.map((item) => item.receipt.reuseReceiptId)).size === value.receipts.length
    && new Set(value.receipts.map((item) => `${item.receipt.taskId}:${item.receipt.taskVersion}:${item.receipt.runId}`)).size === value.receipts.length;
}
