import { redactSecrets } from "./secret-patterns";

export const ONE_PROFILE_CONTRACT_VERSION = "1.0.0" as const;

export type OneProfileLocale = "system" | "ko" | "en";
export type OneOperatingPrincipleScope = "personal" | "project" | "agent" | "team";

export interface OneOperatingPrinciple {
  id: string;
  content: string;
  scope: OneOperatingPrincipleScope;
  /** Required for a scoped Project, Agent, or Team principle; never projected to a device. */
  scopeRef: string | null;
  approvalSource: "explicit_user";
  approvedAt: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  disabledAt: string | null;
}

export interface OneProfile {
  contractVersion: typeof ONE_PROFILE_CONTRACT_VERSION;
  oneId: string;
  /** Main-owned compare-and-swap version. It advances on every material mutation. */
  version: number;
  displayName: string;
  role: string;
  /** User-authored local context. It is deliberately excluded from device projection. */
  profileContext: string;
  preferredLocale: OneProfileLocale;
  timeZone: string | null;
  /**
   * One 의 얼굴. 프리셋 캐릭터면 `character:<id>`, 직접 넣은 그림이면 `one-avatar:self`.
   * 없으면 지금까지의 기본 얼굴을 쓴다.
   *
   * 만들기·편집이 한 창을 쓰게 되면서(오너 지시 2026-08-23) One 도 팀원처럼 캐릭터를
   * 고를 수 있어야 했다. 프로필은 meta 한 줄에 담긴 JSON 이라 칸을 늘리는 데 스키마
   * 사다리가 필요 없다 — 다만 예전 저장본에는 이 칸이 없으므로 항상 선택 항목이다.
   */
  avatarIcon?: string;
  operatingPrinciples: OneOperatingPrinciple[];
  createdAt: string;
  updatedAt: string;
}

export interface OneProfileUpdateInput {
  expectedVersion: number;
  patch: Partial<Pick<OneProfile, "displayName" | "role" | "profileContext" | "preferredLocale" | "timeZone" | "avatarIcon">>;
}

export interface OneOperatingPrincipleCreateInput {
  expectedVersion: number;
  content: string;
  scope: OneOperatingPrincipleScope;
  scopeRef?: string | null;
  /** Main rejects every non-explicit path. A model or inference job cannot set this implicitly. */
  approvedByUser: true;
}

export interface OneOperatingPrincipleUpdateInput {
  expectedVersion: number;
  principleId: string;
  content?: string;
  scope?: OneOperatingPrincipleScope;
  scopeRef?: string | null;
  /** Editing changes the approved text/scope, so it requires a new explicit user action. */
  approvedByUser: true;
}

export interface OneOperatingPrincipleEnabledInput {
  expectedVersion: number;
  principleId: string;
  enabled: boolean;
}

export interface OneOperatingPrincipleDeleteInput {
  expectedVersion: number;
  principleId: string;
}

export interface OneProfileDeviceProjection {
  contractVersion: typeof ONE_PROFILE_CONTRACT_VERSION;
  oneId: string;
  version: number;
  displayName: string;
  role: string;
  preferredLocale: OneProfileLocale;
  timeZone: string | null;
  updatedAt: string;
  operatingPrinciples: Array<Pick<
    OneOperatingPrinciple,
    "id" | "content" | "scope" | "approvalSource" | "approvedAt" | "updatedAt"
  >>;
  omittedOperatingPrincipleCount: number;
}

export interface OneProfileInvocationScope {
  projectId?: string | null;
  agentId?: string | null;
  teamId?: string | null;
}

const ONE_ID_RE = /^one_[a-f0-9]{32}$/;
const PRINCIPLE_ID_RE = /^principle_[a-f0-9]{32}$/;
const SCOPE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROFILE_LOCALES = new Set<OneProfileLocale>(["system", "ko", "en"]);
const PRINCIPLE_SCOPES = new Set<OneOperatingPrincipleScope>([
  "personal",
  "project",
  "agent",
  "team",
]);
const POSIX_ABSOLUTE_PATH_RE = /(^|[\s("'=:\[{])\/[^\s,;:"'`<>|}\]]+/gm;
const WINDOWS_ABSOLUTE_PATH_RE = /\b[A-Za-z]:\\(?:[^\\,\r\n"'`<>|}\]]+\\)*[^\s\\,\r\n"'`<>|}\]]+/g;
const UNC_PATH_RE = /\\\\[^\\\s,;:"'`<>|}\]]+(?:\\[^\\\s,;:"'`<>|}\]]+)+/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isBoundedString(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max;
}

function isPrinciple(value: unknown): value is OneOperatingPrinciple {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "id",
    "content",
    "scope",
    "scopeRef",
    "approvalSource",
    "approvedAt",
    "enabled",
    "createdAt",
    "updatedAt",
    "disabledAt",
  ])) return false;
  if (
    typeof value.id !== "string" || !PRINCIPLE_ID_RE.test(value.id) ||
    !isBoundedString(value.content, 1, 500) ||
    typeof value.scope !== "string" || !PRINCIPLE_SCOPES.has(value.scope as OneOperatingPrincipleScope) ||
    value.approvalSource !== "explicit_user" ||
    !isIsoTimestamp(value.approvedAt) ||
    typeof value.enabled !== "boolean" ||
    !isIsoTimestamp(value.createdAt) ||
    !isIsoTimestamp(value.updatedAt) ||
    !(value.disabledAt === null || isIsoTimestamp(value.disabledAt))
  ) return false;
  if (value.scope === "personal") return value.scopeRef === null;
  return typeof value.scopeRef === "string" && SCOPE_REF_RE.test(value.scopeRef);
}

export function isOneProfile(value: unknown): value is OneProfile {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "contractVersion",
    "oneId",
    "version",
    "displayName",
    "role",
    "profileContext",
    "preferredLocale",
    "timeZone",
    "avatarIcon",
    "operatingPrinciples",
    "createdAt",
    "updatedAt",
  ])) return false;
  if (
    value.contractVersion !== ONE_PROFILE_CONTRACT_VERSION ||
    typeof value.oneId !== "string" || !ONE_ID_RE.test(value.oneId) ||
    !Number.isSafeInteger(value.version) || Number(value.version) <= 0 ||
    !isBoundedString(value.displayName, 1, 64) ||
    !isBoundedString(value.role, 1, 120) ||
    !isBoundedString(value.profileContext, 0, 4_000) ||
    typeof value.preferredLocale !== "string" || !PROFILE_LOCALES.has(value.preferredLocale as OneProfileLocale) ||
    !(value.timeZone === null || isBoundedString(value.timeZone, 1, 128)) ||
    // 예전 저장본에는 이 칸이 아예 없다. 없는 것과 잘못된 것은 다르다.
    !(value.avatarIcon === undefined || isBoundedString(value.avatarIcon, 1, 160)) ||
    !Array.isArray(value.operatingPrinciples) || value.operatingPrinciples.length > 128 ||
    !value.operatingPrinciples.every(isPrinciple) ||
    !isIsoTimestamp(value.createdAt) ||
    !isIsoTimestamp(value.updatedAt) ||
    Date.parse(value.updatedAt) !== value.version
  ) return false;
  return new Set(value.operatingPrinciples.map((item) => item.id)).size === value.operatingPrinciples.length;
}

function redactAbsolutePaths(value: string): string {
  return value
    .replace(POSIX_ABSOLUTE_PATH_RE, (_match, prefix: string) => `${prefix}[redacted-local-path]`)
    .replace(WINDOWS_ABSOLUTE_PATH_RE, "[redacted-local-path]")
    .replace(UNC_PATH_RE, "[redacted-local-path]");
}

function deviceSafeText(value: string): { value: string; redacted: boolean } {
  const withoutSecrets = redactSecrets(value);
  const withoutPaths = redactAbsolutePaths(withoutSecrets);
  return {
    value: withoutPaths,
    redacted: withoutPaths !== value,
  };
}

/**
 * Minimal paired-device projection. Local profile context and exact scope refs
 * never leave Desktop. A principle that requires redaction is omitted instead
 * of being rewritten into a misleading "approved" instruction.
 */
export function projectOneProfileForDevice(profile: OneProfile): OneProfileDeviceProjection {
  if (!isOneProfile(profile)) throw new TypeError("Invalid One profile");
  const enabled = profile.operatingPrinciples.filter((item) => item.enabled);
  const safePrinciples = enabled.flatMap((item) => {
    const safe = deviceSafeText(item.content);
    if (safe.redacted) return [];
    return [{
      id: item.id,
      content: safe.value,
      scope: item.scope,
      approvalSource: item.approvalSource,
      approvedAt: item.approvedAt,
      updatedAt: item.updatedAt,
    }];
  });
  return {
    contractVersion: ONE_PROFILE_CONTRACT_VERSION,
    oneId: profile.oneId,
    version: profile.version,
    displayName: deviceSafeText(profile.displayName).value,
    role: deviceSafeText(profile.role).value,
    preferredLocale: profile.preferredLocale,
    timeZone: profile.timeZone,
    updatedAt: profile.updatedAt,
    operatingPrinciples: safePrinciples,
    omittedOperatingPrincipleCount: enabled.length - safePrinciples.length,
  };
}

/**
 * Resolve only enabled principles whose approved scope matches this exact
 * invocation. Scoped rules must never leak into an unrelated Project, Agent,
 * or Team merely because the same One owns both chats.
 */
export function selectApprovedOneOperatingPrinciples(
  profile: OneProfile,
  scope: OneProfileInvocationScope = {},
): OneOperatingPrinciple[] {
  if (!isOneProfile(profile)) throw new TypeError("Invalid One profile");
  return profile.operatingPrinciples.filter((item) => {
    if (!item.enabled) return false;
    if (item.scope === "personal") return true;
    if (item.scope === "project") return Boolean(scope.projectId) && item.scopeRef === scope.projectId;
    if (item.scope === "agent") return Boolean(scope.agentId) && item.scopeRef === scope.agentId;
    return Boolean(scope.teamId) && item.scopeRef === scope.teamId;
  });
}

/** Local-only model context; callers must never label any inferred preference as approved. */
export function buildApprovedOneProfileContext(
  profile: OneProfile,
  scope: OneProfileInvocationScope = {},
): string {
  if (!isOneProfile(profile)) throw new TypeError("Invalid One profile");
  const enabled = selectApprovedOneOperatingPrinciples(profile, scope);
  const principles = enabled.length > 0
    ? enabled.map((item) => `- [${item.scope}${item.scopeRef ? `:${item.scopeRef}` : ""}] ${item.content}`).join("\n")
    : "- None approved.";
  return [
    "[Agentlas One profile — explicitly provided by the user]",
    `Identity: ${profile.displayName} (${profile.role})`,
    profile.profileContext ? `User-authored context: ${profile.profileContext}` : "User-authored context: none.",
    "Approved operating principles:",
    principles,
    "Do not present inferred preferences as approved operating principles.",
  ].join("\n");
}
