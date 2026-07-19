export const ONE_ACTIVATION_CONTRACT_VERSION = "1.0.0" as const;

export const ONE_ACTIVATION_ELIGIBILITIES = [
  "eligible_first_use",
  "ineligible_preexisting_activity",
] as const;

export const ONE_ACTIVATION_STATUSES = [
  "active",
  "completed",
  "skipped",
  "ineligible",
] as const;

export const ONE_ACTIVATION_MOBILE_RESOLUTIONS = [
  "opened_settings",
  "continued_without_pairing",
] as const;

export type OneActivationEligibility = typeof ONE_ACTIVATION_ELIGIBILITIES[number];
export type OneActivationStatus = typeof ONE_ACTIVATION_STATUSES[number];
export type OneActivationMobileResolution = typeof ONE_ACTIVATION_MOBILE_RESOLUTIONS[number];

export interface OneActivationRoute {
  route: "desktop_first";
  platform: "desktop";
  locale: "ko" | "en";
  selectedAt: string;
}

export interface OneActivationConcernStep {
  status: "pending" | "resolved";
  /** Value-free canonical conversation binding. The concern text is never stored here. */
  originChatId: string | null;
  resolvedAt: string | null;
}

export interface OneActivationFirstValueStep {
  status: "pending" | "resolved";
  taskId: string | null;
  taskVersion: number | null;
  valueClosureId: string | null;
  valueClosureVersion: number | null;
  resolvedAt: string | null;
}

export interface OneActivationWorkNavigationStep {
  status: "pending" | "resolved";
  resolvedAt: string | null;
}

export interface OneActivationMobileStep {
  status: "locked" | "offered" | "resolved";
  resolution: OneActivationMobileResolution | null;
  resolvedAt: string | null;
}

/**
 * Main-owned first-use activation. The contract deliberately stores no prompt,
 * concern, filename, path, output text, or renderer-owned completion flag.
 */
export interface OneActivationState {
  contractVersion: typeof ONE_ACTIVATION_CONTRACT_VERSION;
  oneId: string;
  version: number;
  eligibility: OneActivationEligibility;
  status: OneActivationStatus;
  route: OneActivationRoute | null;
  concern: OneActivationConcernStep;
  workNavigation: OneActivationWorkNavigationStep;
  firstValue: OneActivationFirstValueStep;
  mobileConnection: OneActivationMobileStep;
  completionReason: "verified_first_value" | "explicit_skip" | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface GetOneActivationStateInput {
  platform: "desktop";
  locale: "ko" | "en";
}

export interface ResolveOneActivationConcernInput {
  expectedStoreVersion: number;
  originChatId: string;
  confirmedByUser: true;
}

export interface SkipOneActivationInput {
  expectedStoreVersion: number;
  confirmedByUser: true;
}

export interface ResolveOneActivationWorkInput {
  expectedStoreVersion: number;
  confirmedByUser: true;
}

export interface ResolveOneActivationMobileInput {
  expectedStoreVersion: number;
  resolution: OneActivationMobileResolution;
  confirmedByUser: true;
}

const ONE_ID_RE = /^one_[a-f0-9]{32}$/;
const CHAT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const TASK_ID_RE = /^task_[A-Za-z0-9._:-]{3,122}$/;
const VALUE_CLOSURE_ID_RE = /^value_closure_[a-f0-9]{32}$/;
const ELIGIBILITIES = new Set<string>(ONE_ACTIVATION_ELIGIBILITIES);
const STATUSES = new Set<string>(ONE_ACTIVATION_STATUSES);
const MOBILE_RESOLUTIONS = new Set<string>(ONE_ACTIVATION_MOBILE_RESOLUTIONS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  const expected = new Set(allowed);
  return keys.length === allowed.length && keys.every((key) => expected.has(key));
}

function isPositiveVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function isNullableTimestamp(value: unknown): value is string | null {
  return value === null || isTimestamp(value);
}

function isSafeChatId(value: unknown): value is string {
  return typeof value === "string" && CHAT_ID_RE.test(value);
}

function isRoute(value: unknown): value is OneActivationRoute {
  return isRecord(value)
    && exactKeys(value, ["route", "platform", "locale", "selectedAt"])
    && value.route === "desktop_first"
    && value.platform === "desktop"
    && (value.locale === "ko" || value.locale === "en")
    && isTimestamp(value.selectedAt);
}

function isConcern(value: unknown): value is OneActivationConcernStep {
  if (!isRecord(value) || !exactKeys(value, ["status", "originChatId", "resolvedAt"])) return false;
  if (value.status === "pending") return value.originChatId === null && value.resolvedAt === null;
  return value.status === "resolved" && isSafeChatId(value.originChatId) && isTimestamp(value.resolvedAt);
}

function isFirstValue(value: unknown): value is OneActivationFirstValueStep {
  if (!isRecord(value) || !exactKeys(value, [
    "status", "taskId", "taskVersion", "valueClosureId", "valueClosureVersion", "resolvedAt",
  ])) return false;
  if (value.status === "pending") {
    return value.taskId === null
      && value.taskVersion === null
      && value.valueClosureId === null
      && value.valueClosureVersion === null
      && value.resolvedAt === null;
  }
  return value.status === "resolved"
    && typeof value.taskId === "string"
    && TASK_ID_RE.test(value.taskId)
    && isPositiveVersion(value.taskVersion)
    && typeof value.valueClosureId === "string"
    && VALUE_CLOSURE_ID_RE.test(value.valueClosureId)
    && isPositiveVersion(value.valueClosureVersion)
    && isTimestamp(value.resolvedAt);
}

function isWorkNavigation(value: unknown): value is OneActivationWorkNavigationStep {
  if (!isRecord(value) || !exactKeys(value, ["status", "resolvedAt"])) return false;
  if (value.status === "pending") return value.resolvedAt === null;
  return value.status === "resolved" && isTimestamp(value.resolvedAt);
}

function isMobile(value: unknown): value is OneActivationMobileStep {
  if (!isRecord(value) || !exactKeys(value, ["status", "resolution", "resolvedAt"])) return false;
  if (value.status === "locked" || value.status === "offered") {
    return value.resolution === null && value.resolvedAt === null;
  }
  return value.status === "resolved"
    && typeof value.resolution === "string"
    && MOBILE_RESOLUTIONS.has(value.resolution)
    && isTimestamp(value.resolvedAt);
}

export function isOneActivationMobileResolution(value: unknown): value is OneActivationMobileResolution {
  return typeof value === "string" && MOBILE_RESOLUTIONS.has(value);
}

export function isOneActivationState(value: unknown): value is OneActivationState {
  if (!isRecord(value) || !exactKeys(value, [
    "contractVersion", "oneId", "version", "eligibility", "status", "route",
    "concern", "workNavigation", "firstValue", "mobileConnection", "completionReason",
    "createdAt", "updatedAt", "completedAt",
  ])) return false;
  if (
    value.contractVersion !== ONE_ACTIVATION_CONTRACT_VERSION
    || typeof value.oneId !== "string"
    || !ONE_ID_RE.test(value.oneId)
    || !isPositiveVersion(value.version)
    || typeof value.eligibility !== "string"
    || !ELIGIBILITIES.has(value.eligibility)
    || typeof value.status !== "string"
    || !STATUSES.has(value.status)
    || !(value.route === null || isRoute(value.route))
    || !isConcern(value.concern)
    || !isWorkNavigation(value.workNavigation)
    || !isFirstValue(value.firstValue)
    || !isMobile(value.mobileConnection)
    || ![null, "verified_first_value", "explicit_skip"].includes(value.completionReason as never)
    || !isTimestamp(value.createdAt)
    || !isTimestamp(value.updatedAt)
    || !isNullableTimestamp(value.completedAt)
    || Date.parse(value.updatedAt as string) !== value.version
    || Date.parse(value.updatedAt as string) < Date.parse(value.createdAt as string)
  ) return false;

  const eligibility = value.eligibility as OneActivationEligibility;
  const status = value.status as OneActivationStatus;
  const route = value.route as OneActivationRoute | null;
  const concern = value.concern as OneActivationConcernStep;
  const workNavigation = value.workNavigation as OneActivationWorkNavigationStep;
  const firstValue = value.firstValue as OneActivationFirstValueStep;
  const mobile = value.mobileConnection as OneActivationMobileStep;
  const completionReason = value.completionReason as OneActivationState["completionReason"];
  const createdAt = value.createdAt as string;
  const updatedAt = value.updatedAt as string;
  const completedAt = value.completedAt as string | null;
  const timestamps = [
    route?.selectedAt,
    concern.resolvedAt,
    workNavigation.resolvedAt,
    firstValue.resolvedAt,
    mobile.resolvedAt,
    completedAt,
  ].filter((item): item is string => Boolean(item));
  if (timestamps.some((item) => Date.parse(item) < Date.parse(createdAt) || Date.parse(item) > Date.parse(updatedAt))) return false;

  if (eligibility === "ineligible_preexisting_activity") {
    return status === "ineligible"
      && route === null
      && concern.status === "pending"
      && workNavigation.status === "pending"
      && firstValue.status === "pending"
      && mobile.status === "locked"
      && completionReason === null
      && completedAt === null;
  }
  if (!route) return false;
  if (status === "active") {
    return completionReason === null
      && completedAt === null
      && firstValue.status === "pending"
      && mobile.status === "locked";
  }
  if (status === "skipped") {
    return completionReason === "explicit_skip"
      && completedAt !== null
      && firstValue.status === "pending"
      && mobile.status === "locked";
  }
  if (status === "completed") {
    return completionReason === "verified_first_value"
      && completedAt !== null
      && concern.status === "resolved"
      && firstValue.status === "resolved"
      && (mobile.status === "offered" || mobile.status === "resolved");
  }
  return false;
}
