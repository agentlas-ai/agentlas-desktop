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
  // 처음 실행 세팅(8스텝 온보딩)이 화면을 갖고 있는 동안. 실측(2026-08-20 dev QA)에서
  // 대시보드에 들어가자 온보딩과 One 소개가 **동시에** 떠 어느 쪽을 먼저 봐야 할지
  // 알 수 없었다. 소개·업데이트 안내는 세팅이 끝난 뒤에 나온다(사라지는 게 아니라 밀린다).
  "first_run_setup",
  // 실행 시 뜨는 계정 안내(대회·마감일)가 열려 있는 동안. 같은 실측에서 세팅을 닫자
  // 이번엔 그 안내와 One 소개가 겹쳤다 — 한 겹 아래 같은 결함이었다. 마감일이 있는
  // 쪽을 먼저 보이고(클릭 한 번), 4쪽짜리 소개는 그 뒤로 밀린다.
  "launch_notice",
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

/** 첫 실행 표면들의 순서를 정하는 입력. 모두 렌더러가 이미 알고 있는 사실이다. */
export interface FirstRunSurfaceInputs {
  /** 소개를 아직 확인하지 않았는가(확인했으면 아무것도 막을 게 없다). */
  introPending: boolean;
  /** 처음 실행 세팅(8스텝 온보딩)이 지금 화면을 갖고 있는가. */
  firstRunSetupVisible: boolean;
  /** 실행 시 계정 안내(대회·마감일)가 지금 열려 있는가. */
  launchNoticeVisible: boolean;
  pendingConfirmations: number;
  /** 도는 대화 수. null 은 "아직 모른다" — 모르면 띄우지 않는다. */
  activeChatCount: number | null;
  appUpdateBusy: boolean;
  backgroundWorkActive: boolean;
  importFlowOpen: boolean;
  routeEligible: boolean;
}

/**
 * 지금 소개·업데이트 안내를 막는 것이 무엇인가. 막는 게 없으면 null.
 *
 * 한 곳에서 정하는 이유: One 소개·온톨로지 안내·페이지 투어가 각자 판단하면 첫 실행에
 * 모달이 겹쳐 뜬다(2026-08-20 dev QA 실측: 온보딩 8스텝과 One 소개 1/4가 동시 표시).
 * 순서는 **위에서부터** — 세팅이 가장 세고, 그다음이 사람이 답해야 하는 승인이다.
 * 여기서 나오는 값은 사유로 기록에 남으므로, 밀린 사실이 조용히 사라지지 않는다.
 */
export function resolveOneFeatureIntroBlocker(
  input: FirstRunSurfaceInputs,
): OneFeatureIntroBlockingStateCategory | null {
  if (!input.introPending) return null;
  if (input.firstRunSetupVisible) return "first_run_setup";
  if (input.launchNoticeVisible) return "launch_notice";
  if (input.pendingConfirmations > 0) return "pending_approval";
  if (input.activeChatCount === null) return "authority_unknown";
  if (input.activeChatCount > 0) return "active_task";
  if (input.appUpdateBusy) return "app_update";
  if (input.backgroundWorkActive) return "active_background_work";
  if (input.importFlowOpen) return "import_flow";
  if (!input.routeEligible) return "route_ineligible";
  return null;
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
