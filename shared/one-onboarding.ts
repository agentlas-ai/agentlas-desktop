export const ONE_ONBOARDING_CONTRACT_VERSION = "1.0.0" as const;
export const ONE_ONBOARDING_CURRENT_VERSION = 1 as const;

export type OneOnboardingScene = "s0" | "s1" | "s2" | "s3" | "s4" | "s5" | "s6";
export type OneOnboardingStatus = "pending" | "in-progress" | "completed" | "migrated";
export type OneOnboardingResolution = "completed" | "expert_skip" | "existing_user" | null;
export type OneOnboardingExperience = "new" | "chat" | "cli" | "expert" | null;
export type OneOnboardingSubscription = "paid" | "free" | "none" | null;
export type OneOnboardingProvider = "openai" | "anthropic" | "kimi" | "google" | null;
export type OneOnboardingBrainStatus = "unchecked" | "connecting" | "connected" | "limited";

export interface OneOnboardingStarterAgent {
  slug: string;
  nameKo: string;
  nameEn: string;
  roleKo: string;
  roleEn: string;
  entityKind: "agent" | "team";
  packageHash: string;
  trustGrade: "A" | "B";
  tone: "blue" | "purple" | "green" | "yellow";
}

/**
 * Immutable starter identities verified against the public Hub manifests on
 * 2026-07-20. Runtime resolution is exact-match-or-fail; republishing one of
 * these slugs must never silently change a saved beginner team.
 */
export const ONE_ONBOARDING_STARTER_AGENTS: readonly OneOnboardingStarterAgent[] = [
  {
    slug: "frontend-developer",
    nameKo: "프론트엔드",
    nameEn: "Frontend",
    roleKo: "보이는 예쁜 화면을 만들어요",
    roleEn: "Builds the polished screen people use",
    entityKind: "agent",
    packageHash: "b0d0f8aeed20fbf8d2f10a97879dcfb85db9333a1059cf31044ddf5f29e209e5",
    trustGrade: "A",
    tone: "blue",
  },
  {
    slug: "backend-architect",
    nameKo: "백엔드/서버",
    nameEn: "Backend / server",
    roleKo: "뒤에서 데이터가 오가게 해요",
    roleEn: "Keeps data moving behind the scenes",
    entityKind: "agent",
    packageHash: "91cb94380450c3f6b5ee840b6e2dd4e4d2fedac6cbe919f31d4d10b33e2e8550",
    trustGrade: "A",
    tone: "purple",
  },
  {
    slug: "devops-automator",
    nameKo: "인프라",
    nameEn: "Infrastructure",
    roleKo: "전 세계에 배포되게 해요",
    roleEn: "Gets the product deployed worldwide",
    entityKind: "agent",
    packageHash: "5a2a4944161e3b7d268e3cc96a9baf6581710c39c8024e4c168209e787c3ee6c",
    trustGrade: "B",
    tone: "green",
  },
  {
    slug: "bug-payment-security-hunter",
    nameKo: "버그 헌터",
    nameEn: "Bug hunter",
    roleKo: "숨은 오류와 보안 구멍을 잡아요",
    roleEn: "Finds hidden bugs and security gaps",
    entityKind: "team",
    packageHash: "4455239c4f86635712e23a614a3770c4dbfce07b7a2050092b468cc43b8c81d1",
    trustGrade: "A",
    tone: "green",
  },
  {
    slug: "no-ai-slop-copywriter",
    nameKo: "No AI Slop",
    nameEn: "No AI Slop",
    roleKo: "AI 티 안 나게 다듬어요",
    roleEn: "Makes the copy sound specific and human",
    entityKind: "agent",
    packageHash: "f1e0ef7277df4314eb1d6e7ddbc16782dc94c92a1ca25723a6d1f156f9934fd8",
    trustGrade: "A",
    tone: "yellow",
  },
] as const;

export interface OneOnboardingState {
  contractVersion: typeof ONE_ONBOARDING_CONTRACT_VERSION;
  oneId: string;
  version: number;
  tutorialVersion: typeof ONE_ONBOARDING_CURRENT_VERSION;
  status: OneOnboardingStatus;
  resolution: OneOnboardingResolution;
  currentScene: OneOnboardingScene;
  experience: OneOnboardingExperience;
  subscription: OneOnboardingSubscription;
  provider: OneOnboardingProvider;
  brainStatus: OneOnboardingBrainStatus;
  restrictedMode: boolean;
  soundEnabled: boolean;
  rephraseUsed: boolean;
  selectedStarterSlugs: string[];
  starterTeamGroupId: string | null;
  projectSeed: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateOneOnboardingInput {
  expectedVersion: number;
  patch: Partial<Pick<
    OneOnboardingState,
    | "currentScene"
    | "experience"
    | "subscription"
    | "provider"
    | "soundEnabled"
    | "rephraseUsed"
    | "selectedStarterSlugs"
    | "projectSeed"
  >>;
}

export interface VerifyOneOnboardingProviderInput {
  expectedVersion: number;
  provider: Exclude<OneOnboardingProvider, null>;
}

export interface LimitOneOnboardingProviderInput {
  expectedVersion: number;
  provider: Exclude<OneOnboardingProvider, null>;
}

export interface ReopenOneOnboardingProviderInput {
  expectedVersion: number;
}

export interface OneOnboardingExecutionAuthorization {
  allowed: boolean;
  groupId: string | null;
  reason: "ready" | "not_completed" | "starter_team_changed" | "provider_not_ready";
}

export interface ProvisionOneOnboardingStarterTeamInput {
  expectedVersion: number;
  memberSlugs: string[];
}

export interface CompleteOneOnboardingInput {
  expectedVersion: number;
  projectSeed: string;
  expertSkip?: boolean;
  confirmedByUser: true;
}

const SCENES = new Set<OneOnboardingScene>(["s0", "s1", "s2", "s3", "s4", "s5", "s6"]);
const STATUSES = new Set<OneOnboardingStatus>(["pending", "in-progress", "completed", "migrated"]);
const RESOLUTIONS = new Set<Exclude<OneOnboardingResolution, null>>(["completed", "expert_skip", "existing_user"]);
const EXPERIENCES = new Set<Exclude<OneOnboardingExperience, null>>(["new", "chat", "cli", "expert"]);
const SUBSCRIPTIONS = new Set<Exclude<OneOnboardingSubscription, null>>(["paid", "free", "none"]);
const PROVIDERS = new Set<Exclude<OneOnboardingProvider, null>>(["openai", "anthropic", "kimi", "google"]);
const BRAIN_STATUSES = new Set<OneOnboardingBrainStatus>(["unchecked", "connecting", "connected", "limited"]);
const STARTER_SLUGS = new Set(ONE_ONBOARDING_STARTER_AGENTS.map((agent) => agent.slug));
const ONE_ID_RE = /^one_[a-f0-9]{32}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function nullableEnum<T extends string>(value: unknown, values: Set<T>): value is T | null {
  return value === null || (typeof value === "string" && values.has(value as T));
}

export function isOneOnboardingState(value: unknown): value is OneOnboardingState {
  if (!isRecord(value)) return false;
  const keys = new Set([
    "contractVersion", "oneId", "version", "tutorialVersion", "status", "resolution", "currentScene",
    "experience", "subscription", "provider", "brainStatus", "restrictedMode", "soundEnabled", "rephraseUsed",
    "selectedStarterSlugs", "starterTeamGroupId", "projectSeed", "startedAt", "completedAt", "createdAt", "updatedAt",
  ]);
  if (Object.keys(value).some((key) => !keys.has(key))) return false;
  if (
    value.contractVersion !== ONE_ONBOARDING_CONTRACT_VERSION ||
    typeof value.oneId !== "string" || !ONE_ID_RE.test(value.oneId) ||
    !Number.isSafeInteger(value.version) || Number(value.version) <= 0 ||
    value.tutorialVersion !== ONE_ONBOARDING_CURRENT_VERSION ||
    typeof value.status !== "string" || !STATUSES.has(value.status as OneOnboardingStatus) ||
    !nullableEnum(value.resolution, RESOLUTIONS) ||
    typeof value.currentScene !== "string" || !SCENES.has(value.currentScene as OneOnboardingScene) ||
    !nullableEnum(value.experience, EXPERIENCES) ||
    !nullableEnum(value.subscription, SUBSCRIPTIONS) ||
    !nullableEnum(value.provider, PROVIDERS) ||
    typeof value.brainStatus !== "string" || !BRAIN_STATUSES.has(value.brainStatus as OneOnboardingBrainStatus) ||
    typeof value.restrictedMode !== "boolean" ||
    typeof value.soundEnabled !== "boolean" ||
    typeof value.rephraseUsed !== "boolean" ||
    !Array.isArray(value.selectedStarterSlugs) ||
    value.selectedStarterSlugs.length > ONE_ONBOARDING_STARTER_AGENTS.length ||
    !value.selectedStarterSlugs.every((slug) => typeof slug === "string" && STARTER_SLUGS.has(slug)) ||
    new Set(value.selectedStarterSlugs).size !== value.selectedStarterSlugs.length ||
    !(value.starterTeamGroupId === null || (typeof value.starterTeamGroupId === "string" && value.starterTeamGroupId.length <= 128)) ||
    typeof value.projectSeed !== "string" || value.projectSeed.length > 500 ||
    !(value.startedAt === null || isIso(value.startedAt)) ||
    !(value.completedAt === null || isIso(value.completedAt)) ||
    !isIso(value.createdAt) || !isIso(value.updatedAt)
  ) return false;
  if ((value.status === "completed" || value.status === "migrated") && !value.completedAt) return false;
  if (value.restrictedMode !== (value.brainStatus === "limited")) return false;
  return true;
}

export function isOneOnboardingScene(value: unknown): value is OneOnboardingScene {
  return typeof value === "string" && SCENES.has(value as OneOnboardingScene);
}

export function isOneOnboardingExperience(value: unknown): value is Exclude<OneOnboardingExperience, null> {
  return typeof value === "string" && EXPERIENCES.has(value as Exclude<OneOnboardingExperience, null>);
}

export function isOneOnboardingSubscription(value: unknown): value is Exclude<OneOnboardingSubscription, null> {
  return typeof value === "string" && SUBSCRIPTIONS.has(value as Exclude<OneOnboardingSubscription, null>);
}

export function isOneOnboardingProvider(value: unknown): value is Exclude<OneOnboardingProvider, null> {
  return typeof value === "string" && PROVIDERS.has(value as Exclude<OneOnboardingProvider, null>);
}

export function isOneOnboardingBrainStatus(value: unknown): value is OneOnboardingBrainStatus {
  return typeof value === "string" && BRAIN_STATUSES.has(value as OneOnboardingBrainStatus);
}
