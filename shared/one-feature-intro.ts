export const ONE_FEATURE_INTRO_CONTRACT_VERSION = "1.0.0" as const;
export const ONE_FEATURE_INTRO_CURRENT_VERSION = 1 as const;

export const ONE_FEATURE_INTRO_RESOLUTIONS = [
  "skipped",
  "opened_one",
  "kept_work",
  "legacy_migrated",
] as const;

export const ONE_FEATURE_INTRO_BLOCKING_STATE_CATEGORIES = [
  "pending_approval",
  "active_task",
  "app_update",
  "active_background_work",
  "blocking_error",
  "failed_task",
  "import_flow",
  "route_ineligible",
  "authority_unknown",
] as const;

export type OneFeatureIntroResolution = typeof ONE_FEATURE_INTRO_RESOLUTIONS[number];
export type OneFeatureIntroBlockingStateCategory = typeof ONE_FEATURE_INTRO_BLOCKING_STATE_CATEGORIES[number];

export interface OneFeatureIntroAcknowledgement {
  introVersion: number;
  resolution: OneFeatureIntroResolution;
  acknowledgementRef: string;
  acknowledgedAt: string;
}

export interface OneFeatureIntroDeferral {
  introVersion: number;
  blockingStateCategory: OneFeatureIntroBlockingStateCategory;
  deferralRef: string;
  deferredAt: string;
}

/** Main-owned, renderer-safe state. It contains no profile text or local paths. */
export interface OneFeatureIntroState {
  contractVersion: typeof ONE_FEATURE_INTRO_CONTRACT_VERSION;
  oneId: string;
  /** Main-owned compare-and-swap version. */
  version: number;
  currentIntroVersion: number;
  acknowledgedIntroVersion: number;
  acknowledgements: OneFeatureIntroAcknowledgement[];
  deferrals: OneFeatureIntroDeferral[];
  createdAt: string;
  updatedAt: string;
}

export interface AcknowledgeOneFeatureIntroInput {
  expectedStoreVersion: number;
  introVersion: number;
  resolution: OneFeatureIntroResolution;
  confirmedByUser: true;
}

export interface DeferOneFeatureIntroInput {
  expectedStoreVersion: number;
  introVersion: number;
  blockingStateCategory: OneFeatureIntroBlockingStateCategory;
}

const ONE_ID_RE = /^one_[a-f0-9]{32}$/;
const ACKNOWLEDGEMENT_REF_RE = /^one_intro_ack_[a-f0-9]{32}$/;
const DEFERRAL_REF_RE = /^one_intro_defer_[a-f0-9]{32}$/;
const RESOLUTIONS = new Set<string>(ONE_FEATURE_INTRO_RESOLUTIONS);
const BLOCKING_CATEGORIES = new Set<string>(ONE_FEATURE_INTRO_BLOCKING_STATE_CATEGORIES);

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

function isIntroVersion(value: unknown, currentVersion: number): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= currentVersion;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
}

export function isOneFeatureIntroResolution(value: unknown): value is OneFeatureIntroResolution {
  return typeof value === "string" && RESOLUTIONS.has(value);
}

export function isOneFeatureIntroBlockingStateCategory(value: unknown): value is OneFeatureIntroBlockingStateCategory {
  return typeof value === "string" && BLOCKING_CATEGORIES.has(value);
}

function isAcknowledgement(value: unknown, currentVersion: number): value is OneFeatureIntroAcknowledgement {
  return isRecord(value)
    && exactKeys(value, ["introVersion", "resolution", "acknowledgementRef", "acknowledgedAt"])
    && isIntroVersion(value.introVersion, currentVersion)
    && isOneFeatureIntroResolution(value.resolution)
    && typeof value.acknowledgementRef === "string"
    && ACKNOWLEDGEMENT_REF_RE.test(value.acknowledgementRef)
    && isTimestamp(value.acknowledgedAt);
}

function isDeferral(value: unknown, currentVersion: number): value is OneFeatureIntroDeferral {
  return isRecord(value)
    && exactKeys(value, ["introVersion", "blockingStateCategory", "deferralRef", "deferredAt"])
    && isIntroVersion(value.introVersion, currentVersion)
    && isOneFeatureIntroBlockingStateCategory(value.blockingStateCategory)
    && typeof value.deferralRef === "string"
    && DEFERRAL_REF_RE.test(value.deferralRef)
    && isTimestamp(value.deferredAt);
}

export function isOneFeatureIntroState(value: unknown): value is OneFeatureIntroState {
  if (!isRecord(value) || !exactKeys(value, [
    "contractVersion",
    "oneId",
    "version",
    "currentIntroVersion",
    "acknowledgedIntroVersion",
    "acknowledgements",
    "deferrals",
    "createdAt",
    "updatedAt",
  ])) return false;
  if (
    value.contractVersion !== ONE_FEATURE_INTRO_CONTRACT_VERSION
    || typeof value.oneId !== "string"
    || !ONE_ID_RE.test(value.oneId)
    || !isPositiveVersion(value.version)
    || value.currentIntroVersion !== ONE_FEATURE_INTRO_CURRENT_VERSION
    || !Number.isSafeInteger(value.acknowledgedIntroVersion)
    || Number(value.acknowledgedIntroVersion) < 0
    || Number(value.acknowledgedIntroVersion) > ONE_FEATURE_INTRO_CURRENT_VERSION
    || !Array.isArray(value.acknowledgements)
    || value.acknowledgements.length > ONE_FEATURE_INTRO_CURRENT_VERSION
    || !value.acknowledgements.every((item) => isAcknowledgement(item, value.currentIntroVersion as number))
    || !Array.isArray(value.deferrals)
    || value.deferrals.length > ONE_FEATURE_INTRO_CURRENT_VERSION * ONE_FEATURE_INTRO_BLOCKING_STATE_CATEGORIES.length
    || !value.deferrals.every((item) => isDeferral(item, value.currentIntroVersion as number))
    || !isTimestamp(value.createdAt)
    || !isTimestamp(value.updatedAt)
    || Date.parse(value.updatedAt) !== value.version
    || Date.parse(value.updatedAt) < Date.parse(value.createdAt)
  ) return false;

  const acknowledgements = value.acknowledgements as OneFeatureIntroAcknowledgement[];
  const deferrals = value.deferrals as OneFeatureIntroDeferral[];
  const createdAt = value.createdAt as string;
  const updatedAt = value.updatedAt as string;
  const acknowledgementVersions = acknowledgements.map((item) => item.introVersion);
  const highestAcknowledged = acknowledgementVersions.length > 0 ? Math.max(...acknowledgementVersions) : 0;
  if (highestAcknowledged !== value.acknowledgedIntroVersion) return false;
  if (new Set(acknowledgementVersions).size !== acknowledgements.length) return false;
  if (new Set(acknowledgements.map((item) => item.acknowledgementRef)).size !== acknowledgements.length) return false;
  if (acknowledgements.some((item) => Date.parse(item.acknowledgedAt) < Date.parse(createdAt)
    || Date.parse(item.acknowledgedAt) > Date.parse(updatedAt))) return false;
  if (new Set(deferrals.map((item) => `${item.introVersion}:${item.blockingStateCategory}`)).size !== deferrals.length) return false;
  if (new Set(deferrals.map((item) => item.deferralRef)).size !== deferrals.length) return false;
  if (deferrals.some((item) => Date.parse(item.deferredAt) < Date.parse(createdAt)
    || Date.parse(item.deferredAt) > Date.parse(updatedAt))) return false;
  return true;
}
