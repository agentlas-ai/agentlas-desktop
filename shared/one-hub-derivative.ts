export const ONE_HUB_DERIVATIVE_CONTRACT_VERSION = "1.0.0" as const;

export const ONE_HUB_DERIVATIVE_ALWAYS_EXCLUDED = [
  "memory",
  "credentials",
  "customer_data",
  "internal_docs",
  "raw_task_context",
  "local_paths",
  "secrets",
  "private_examples",
  "private_experience",
] as const;

export const ONE_HUB_DERIVATIVE_EXCLUSION_CATEGORIES = [
  ...ONE_HUB_DERIVATIVE_ALWAYS_EXCLUDED,
  "symlink",
  "non_allowlisted",
  "unsafe_content",
  "size_policy",
] as const;

export type OneHubDerivativeExclusionCategory =
  typeof ONE_HUB_DERIVATIVE_EXCLUSION_CATEGORIES[number];

export interface OneHubDerivativeIncludedFile {
  path: string;
  bytes: number;
  sha256: string;
  source: "generated";
}

export interface OneHubDerivativeExcludedSummary {
  category: OneHubDerivativeExclusionCategory;
  count: number;
  reasonCode: OneHubDerivativeExclusionCategory;
}

export interface OneHubDerivativeUnknownGate {
  status: "unknown";
  ref: null;
}

export interface OneHubDerivativeDraft {
  contractVersion: typeof ONE_HUB_DERIVATIVE_CONTRACT_VERSION;
  draftId: string;
  version: number;
  suggestionId: string;
  reviewRequestId: string;
  originTaskId: string;
  privateSourceId: string;
  sourcePackageHash: string;
  sourceAssetSource: "agent-cloud";
  /** Safe logical path only. The absolute userData path remains Main-only. */
  draftPathRef: string;
  status: "local_review";
  includedFiles: OneHubDerivativeIncludedFile[];
  excluded: OneHubDerivativeExcludedSummary[];
  alwaysExcludedCategories: Array<typeof ONE_HUB_DERIVATIVE_ALWAYS_EXCLUDED[number]>;
  gates: {
    entitlement: OneHubDerivativeUnknownGate;
    rights: OneHubDerivativeUnknownGate;
    economy: OneHubDerivativeUnknownGate;
    fee: OneHubDerivativeUnknownGate;
    explicitPublishApproval: false;
    publishAllowed: false;
    publishingStarted: false;
    revenueGuaranteed: false;
  };
  original: {
    sourceUnchanged: true;
    privateSourceIncluded: false;
  };
  createdAt: string;
  updatedAt: string;
}

export interface OneHubDerivativeState {
  contractVersion: typeof ONE_HUB_DERIVATIVE_CONTRACT_VERSION;
  version: number;
  drafts: OneHubDerivativeDraft[];
  createdAt: string;
  updatedAt: string;
}

export interface GetOneHubDerivativeDraftInput {
  suggestionId: string;
  expectedSuggestionVersion: number;
  reviewRequestId: string;
  draftId: string;
  originTaskId: string;
}

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const DRAFT_ID_RE = /^one_hub_draft_[a-f0-9]{32}$/;
const SUGGESTION_ID_RE = /^one_suggestion_[a-f0-9]{32}$/;
const REVIEW_ID_RE = /^one_suggestion_review_[a-f0-9]{32}$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const SAFE_PATH_RE = /^[A-Za-z0-9._/-]{1,260}$/;

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  const allowed = new Set(expected);
  return actual.length === expected.length && actual.every((key) => allowed.has(key));
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function positiveVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function safePath(value: unknown): value is string {
  if (typeof value !== "string" || !SAFE_PATH_RE.test(value) || value.startsWith("/") || value.includes("//")) return false;
  return value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function includedFile(value: unknown): value is OneHubDerivativeIncludedFile {
  if (!record(value)) return false;
  if (!exactKeys(value, ["path", "bytes", "sha256", "source"]) || !safePath(value.path)) return false;
  if (!Number.isSafeInteger(value.bytes)
    || Number(value.bytes) < 0
    || Number(value.bytes) > 512 * 1024
    || typeof value.sha256 !== "string" || !HASH_RE.test(value.sha256)
    || value.source !== "generated") return false;
  const generatedPath = value.path === "package/PUBLIC_DERIVATIVE.md"
    || value.path === "package/.agentlas/routing-card.json";
  return generatedPath;
}

function excludedSummary(value: unknown): value is OneHubDerivativeExcludedSummary {
  return record(value)
    && exactKeys(value, ["category", "count", "reasonCode"])
    && typeof value.category === "string"
    && ONE_HUB_DERIVATIVE_EXCLUSION_CATEGORIES.includes(value.category as OneHubDerivativeExclusionCategory)
    && value.reasonCode === value.category
    && Number.isSafeInteger(value.count)
    && Number(value.count) >= 1
    && Number(value.count) <= 10_000;
}

function unknownGate(value: unknown): value is OneHubDerivativeUnknownGate {
  return record(value)
    && exactKeys(value, ["status", "ref"])
    && value.status === "unknown"
    && value.ref === null;
}

export function isOneHubDerivativeDraft(value: unknown): value is OneHubDerivativeDraft {
  if (!record(value) || !exactKeys(value, [
    "contractVersion", "draftId", "version", "suggestionId", "reviewRequestId", "originTaskId",
    "privateSourceId", "sourcePackageHash", "sourceAssetSource", "draftPathRef", "status",
    "includedFiles", "excluded", "alwaysExcludedCategories", "gates", "original", "createdAt", "updatedAt",
  ])) return false;
  const alwaysExcludedCategories = value.alwaysExcludedCategories;
  if (!Array.isArray(alwaysExcludedCategories)) return false;
  if (
    value.contractVersion !== ONE_HUB_DERIVATIVE_CONTRACT_VERSION
    || typeof value.draftId !== "string" || !DRAFT_ID_RE.test(value.draftId)
    || !positiveVersion(value.version)
    || typeof value.suggestionId !== "string" || !SUGGESTION_ID_RE.test(value.suggestionId)
    || typeof value.reviewRequestId !== "string" || !REVIEW_ID_RE.test(value.reviewRequestId)
    || typeof value.originTaskId !== "string" || !SAFE_ID_RE.test(value.originTaskId)
    || typeof value.privateSourceId !== "string" || !SAFE_ID_RE.test(value.privateSourceId)
    || typeof value.sourcePackageHash !== "string" || !HASH_RE.test(value.sourcePackageHash)
    || value.sourceAssetSource !== "agent-cloud"
    || value.draftPathRef !== `one/hub-derivative-drafts/${value.draftId}`
    || value.status !== "local_review"
    || !Array.isArray(value.includedFiles) || value.includedFiles.length < 2 || value.includedFiles.length > 64
    || !value.includedFiles.every(includedFile)
    || new Set(value.includedFiles.map((item) => item.path.toLowerCase())).size !== value.includedFiles.length
    || value.includedFiles.filter((item) => item.path === "package/PUBLIC_DERIVATIVE.md" && item.source === "generated").length !== 1
    || value.includedFiles.filter((item) => item.path === "package/.agentlas/routing-card.json" && item.source === "generated").length !== 1
    || value.includedFiles.reduce((sum, item) => sum + item.bytes, 0) > 768 * 1024
    || !Array.isArray(value.excluded) || value.excluded.length > ONE_HUB_DERIVATIVE_EXCLUSION_CATEGORIES.length
    || !value.excluded.every(excludedSummary)
    || new Set(value.excluded.map((item) => item.category)).size !== value.excluded.length
    || alwaysExcludedCategories.length !== ONE_HUB_DERIVATIVE_ALWAYS_EXCLUDED.length
    || !ONE_HUB_DERIVATIVE_ALWAYS_EXCLUDED.every((item) => alwaysExcludedCategories.includes(item))
    || !record(value.gates) || !exactKeys(value.gates, [
      "entitlement", "rights", "economy", "fee", "explicitPublishApproval", "publishAllowed",
      "publishingStarted", "revenueGuaranteed",
    ])
    || !unknownGate(value.gates.entitlement)
    || !unknownGate(value.gates.rights)
    || !unknownGate(value.gates.economy)
    || !unknownGate(value.gates.fee)
    || value.gates.explicitPublishApproval !== false
    || value.gates.publishAllowed !== false
    || value.gates.publishingStarted !== false
    || value.gates.revenueGuaranteed !== false
    || !record(value.original) || !exactKeys(value.original, ["sourceUnchanged", "privateSourceIncluded"])
    || value.original.sourceUnchanged !== true
    || value.original.privateSourceIncluded !== false
    || !timestamp(value.createdAt) || !timestamp(value.updatedAt)
    || Date.parse(value.updatedAt) !== value.version
    || Date.parse(value.updatedAt) < Date.parse(value.createdAt)
  ) return false;
  return true;
}

export function isOneHubDerivativeState(value: unknown): value is OneHubDerivativeState {
  if (!record(value) || !exactKeys(value, ["contractVersion", "version", "drafts", "createdAt", "updatedAt"])) return false;
  return value.contractVersion === ONE_HUB_DERIVATIVE_CONTRACT_VERSION
    && positiveVersion(value.version)
    && timestamp(value.createdAt)
    && timestamp(value.updatedAt)
    && Date.parse(value.updatedAt) === value.version
    && Date.parse(value.updatedAt) >= Date.parse(value.createdAt)
    && Array.isArray(value.drafts)
    && value.drafts.length <= 256
    && value.drafts.every(isOneHubDerivativeDraft)
    && new Set(value.drafts.map((item) => item.draftId)).size === value.drafts.length
    && new Set(value.drafts.map((item) => item.suggestionId)).size === value.drafts.length
    && new Set(value.drafts.map((item) => item.reviewRequestId)).size === value.drafts.length;
}
