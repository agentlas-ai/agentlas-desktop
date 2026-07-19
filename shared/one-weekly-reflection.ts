import {
  isSafeOneValueClosureId,
  isSafeOneValueClosureText,
  type OneOriginalPreservationStatus,
  type OneValueClosureRemainingOwner,
  type OneValueClosureRemainingStatus,
} from "./one-value-closure";

export const ONE_WEEKLY_REFLECTION_CONTRACT_VERSION = "1.0.0" as const;
export const ONE_WEEKLY_REFLECTION_SELECTION_BASIS = "latest_included_verified_outcome" as const;

export type OneWeeklyReflectionStatus = "open" | "acknowledged" | "hidden";
export type OneWeeklyReflectionTimeZoneSource = "profile" | "system" | "utc";

export interface OneWeeklyReflectionFactV1 {
  valueItemRef: string;
  statement: string;
  evidenceRefs: string[];
}

export interface OneWeeklyReflectionEstimateV1 {
  valueItemRef: string;
  label: "estimate";
  statement: string;
  value?: number;
  lowerBound?: number;
  upperBound?: number;
  unit: string;
  basis: string;
  method: string;
  evidenceRefs: string[];
}

export interface OneWeeklyReflectionPreservationV1 {
  status: OneOriginalPreservationStatus;
  artifactRefs: string[];
  receiptRefs: string[];
  explanation?: string;
}

export interface OneWeeklyReflectionRemainingWorkV1 {
  itemRef: string;
  action: string;
  owner: OneValueClosureRemainingOwner;
  status: OneValueClosureRemainingStatus;
  reason?: string;
}

export interface OneWeeklyReflectionOutcomeV1 {
  valueClosureRef: string;
  valueClosureVersion: number;
  taskId: string;
  taskVersion: number;
  generatedAt: string;
  outcomeRefs: string[];
  facts: OneWeeklyReflectionFactV1[];
  estimates: OneWeeklyReflectionEstimateV1[];
  evidenceRefs: string[];
  originalPreservation: OneWeeklyReflectionPreservationV1;
  remainingWork: OneWeeklyReflectionRemainingWorkV1[];
}

export interface OneWeeklyReflectionV1 {
  contractVersion: typeof ONE_WEEKLY_REFLECTION_CONTRACT_VERSION;
  reflectionId: string;
  contentDigest: string;
  weekKey: string;
  periodStart: string;
  periodEnd: string;
  timeZone: string;
  timeZoneSource: OneWeeklyReflectionTimeZoneSource;
  selectionBasis: typeof ONE_WEEKLY_REFLECTION_SELECTION_BASIS;
  generatedAt: string;
  status: OneWeeklyReflectionStatus;
  statusUpdatedAt: string | null;
  outcomes: OneWeeklyReflectionOutcomeV1[];
  corrections: {
    wrong: number;
    notImportant: number;
  };
}

export interface OneWeeklyReflectionSnapshotV1 {
  contractVersion: typeof ONE_WEEKLY_REFLECTION_CONTRACT_VERSION;
  stateVersion: number;
  reflection: OneWeeklyReflectionV1 | null;
}

export interface ResolveOneWeeklyReflectionInputV1 {
  expectedStateVersion: number;
  reflectionId: string;
  weekKey: string;
  expectedContentDigest: string;
  action: "acknowledge" | "hide_week";
  confirmedByUser: true;
}

export interface OneWeeklyReflectionPresentationContext {
  onHome: boolean;
  hasOpenReflection: boolean;
  activationForeground: boolean;
  busy: boolean;
  briefingKind: "decision" | "working" | "failed" | "result_ready" | "quiet";
  hasProactiveBriefing: boolean;
}

/**
 * Weekly reflection is ambient, retrospective material. It must never compete
 * with activation, live work, a decision, a failure, or a proactive finding.
 */
export function shouldPresentOneWeeklyReflection(
  context: OneWeeklyReflectionPresentationContext,
): boolean {
  return context.onHome
    && context.hasOpenReflection
    && !context.activationForeground
    && !context.busy
    && context.briefingKind === "quiet"
    && !context.hasProactiveBriefing;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const REFLECTION_ID_RE = /^weekly_reflection_[a-f0-9]{32}$/;
const VALUE_CLOSURE_ID_RE = /^value_closure_[a-f0-9]{32}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const WEEK_KEY_RE = /^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function isPositiveVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function isSafeId(value: unknown): value is string {
  return typeof value === "string" && ID_RE.test(value) && isSafeOneValueClosureId(value);
}

function isUniqueIds(value: unknown, min: number, max: number): value is string[] {
  return Array.isArray(value)
    && value.length >= min
    && value.length <= max
    && value.every(isSafeId)
    && new Set(value).size === value.length;
}

function isIanaTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function isFact(value: unknown): value is OneWeeklyReflectionFactV1 {
  if (!isRecord(value) || !exactKeys(value, ["valueItemRef", "statement", "evidenceRefs"])) return false;
  return isSafeId(value.valueItemRef)
    && isSafeOneValueClosureText(value.statement)
    && isUniqueIds(value.evidenceRefs, 1, 32);
}

function isEstimate(value: unknown): value is OneWeeklyReflectionEstimateV1 {
  if (!isRecord(value) || !exactKeys(value, [
    "valueItemRef", "label", "statement", "value", "lowerBound", "upperBound",
    "unit", "basis", "method", "evidenceRefs",
  ])) return false;
  if (!isSafeId(value.valueItemRef) || value.label !== "estimate") return false;
  if (!isSafeOneValueClosureText(value.statement)
    || !isSafeOneValueClosureText(value.unit, 160)
    || !isSafeOneValueClosureText(value.basis)
    || !isSafeOneValueClosureText(value.method)
    || !isUniqueIds(value.evidenceRefs, 1, 32)) return false;
  const scalar = typeof value.value === "number" && Number.isFinite(value.value);
  const range = typeof value.lowerBound === "number" && Number.isFinite(value.lowerBound)
    && typeof value.upperBound === "number" && Number.isFinite(value.upperBound)
    && value.lowerBound <= value.upperBound;
  if (scalar === range) return false;
  if (!scalar && value.value !== undefined) return false;
  if (!range && (value.lowerBound !== undefined || value.upperBound !== undefined)) return false;
  return true;
}

function isPreservation(value: unknown): value is OneWeeklyReflectionPreservationV1 {
  if (!isRecord(value) || !exactKeys(value, ["status", "artifactRefs", "receiptRefs", "explanation"])) return false;
  if (!["preserved", "not_applicable", "modified_with_approval"].includes(String(value.status))) return false;
  if (!isUniqueIds(value.artifactRefs, 0, 64) || !isUniqueIds(value.receiptRefs, 0, 64)) return false;
  if (value.explanation !== undefined && !isSafeOneValueClosureText(value.explanation)) return false;
  if (value.status === "not_applicable") {
    return value.artifactRefs.length === 0 && value.receiptRefs.length === 0 && value.explanation === undefined;
  }
  return value.receiptRefs.length >= 1
    && (value.status !== "modified_with_approval" || isSafeOneValueClosureText(value.explanation));
}

function isRemainingWork(value: unknown): value is OneWeeklyReflectionRemainingWorkV1 {
  if (!isRecord(value) || !exactKeys(value, ["itemRef", "action", "owner", "status", "reason"])) return false;
  return isSafeId(value.itemRef)
    && isSafeOneValueClosureText(value.action)
    && ["user", "one", "external"].includes(String(value.owner))
    && ["pending", "blocked", "not_required"].includes(String(value.status))
    && (value.reason === undefined || isSafeOneValueClosureText(value.reason));
}

function isOutcome(value: unknown): value is OneWeeklyReflectionOutcomeV1 {
  if (!isRecord(value) || !exactKeys(value, [
    "valueClosureRef", "valueClosureVersion", "taskId", "taskVersion", "generatedAt",
    "outcomeRefs", "facts", "estimates", "evidenceRefs", "originalPreservation", "remainingWork",
  ])) return false;
  if (typeof value.valueClosureRef !== "string" || !VALUE_CLOSURE_ID_RE.test(value.valueClosureRef)
    || !isPositiveVersion(value.valueClosureVersion)
    || !isSafeId(value.taskId)
    || !isPositiveVersion(value.taskVersion)
    || !isTimestamp(value.generatedAt)
    || !isUniqueIds(value.outcomeRefs, 1, 32)
    || !isUniqueIds(value.evidenceRefs, 1, 128)) return false;
  if (!Array.isArray(value.facts) || value.facts.length < 1 || value.facts.length > 3 || !value.facts.every(isFact)) return false;
  if (!Array.isArray(value.estimates) || value.estimates.length > 1 || !value.estimates.every(isEstimate)) return false;
  if (!isPreservation(value.originalPreservation)) return false;
  if (!Array.isArray(value.remainingWork) || value.remainingWork.length > 3 || !value.remainingWork.every(isRemainingWork)) return false;
  const evidence = new Set(value.evidenceRefs);
  return value.facts.every((item) => item.evidenceRefs.every((ref) => evidence.has(ref)))
    && value.estimates.every((item) => item.evidenceRefs.every((ref) => evidence.has(ref)));
}

export function isOneWeeklyReflectionV1(value: unknown): value is OneWeeklyReflectionV1 {
  if (!isRecord(value) || !exactKeys(value, [
    "contractVersion", "reflectionId", "contentDigest", "weekKey", "periodStart", "periodEnd",
    "timeZone", "timeZoneSource", "selectionBasis", "generatedAt", "status", "statusUpdatedAt",
    "outcomes", "corrections",
  ])) return false;
  if (value.contractVersion !== ONE_WEEKLY_REFLECTION_CONTRACT_VERSION
    || typeof value.reflectionId !== "string" || !REFLECTION_ID_RE.test(value.reflectionId)
    || typeof value.contentDigest !== "string" || !DIGEST_RE.test(value.contentDigest)
    || typeof value.weekKey !== "string" || !WEEK_KEY_RE.test(value.weekKey)
    || !isTimestamp(value.periodStart) || !isTimestamp(value.periodEnd)
    || Date.parse(value.periodEnd) <= Date.parse(value.periodStart)
    || !isIanaTimeZone(value.timeZone)
    || !["profile", "system", "utc"].includes(String(value.timeZoneSource))
    || value.selectionBasis !== ONE_WEEKLY_REFLECTION_SELECTION_BASIS
    || !isTimestamp(value.generatedAt)
    || !["open", "acknowledged", "hidden"].includes(String(value.status))
    || !(value.statusUpdatedAt === null || isTimestamp(value.statusUpdatedAt))) return false;
  if (value.status === "open" ? value.statusUpdatedAt !== null : value.statusUpdatedAt === null) return false;
  if (!Array.isArray(value.outcomes) || value.outcomes.length < 1 || value.outcomes.length > 5 || !value.outcomes.every(isOutcome)) return false;
  if (!isRecord(value.corrections) || !exactKeys(value.corrections, ["wrong", "notImportant"])) return false;
  if (![value.corrections.wrong, value.corrections.notImportant].every((item) => Number.isSafeInteger(item) && Number(item) >= 0 && Number(item) <= 500)) return false;
  for (let index = 1; index < value.outcomes.length; index += 1) {
    const prior = value.outcomes[index - 1];
    const current = value.outcomes[index];
    if (prior.generatedAt < current.generatedAt) return false;
    if (prior.generatedAt === current.generatedAt && prior.valueClosureRef > current.valueClosureRef) return false;
  }
  return new Set(value.outcomes.map((item) => item.valueClosureRef)).size === value.outcomes.length;
}

export function isOneWeeklyReflectionSnapshotV1(value: unknown): value is OneWeeklyReflectionSnapshotV1 {
  if (!isRecord(value) || !exactKeys(value, ["contractVersion", "stateVersion", "reflection"])) return false;
  return value.contractVersion === ONE_WEEKLY_REFLECTION_CONTRACT_VERSION
    && isPositiveVersion(value.stateVersion)
    && (value.reflection === null || isOneWeeklyReflectionV1(value.reflection));
}
