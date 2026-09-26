import { createHash, randomUUID } from "node:crypto";
import { looksSecret } from "../../shared/secret-patterns";
import {
  ONE_PROFILE_CONTRACT_VERSION,
  isOneProfile,
  projectOneProfileForDevice,
  type OneOperatingPrinciple,
  type OneOperatingPrincipleCreateInput,
  type OneOperatingPrincipleDeleteInput,
  type OneOperatingPrincipleEnabledInput,
  type OneOperatingPrincipleScope,
  type OneOperatingPrincipleUpdateInput,
  type OneProfile,
  type OneProfileDeviceProjection,
  type OneProfileLocale,
  type OneProfileUpdateInput,
} from "../../shared/one-profile";
import { emitDesktopStoreChange } from "./change-bus";
import { getDb } from "./db";
import { tryRecordOneDomainEvent } from "../one/domain-events";

const META_KEY = "agentlas.one.profile.v1";
const PROFILE_PATCH_KEYS = ["displayName", "role", "profileContext", "preferredLocale", "timeZone", "avatarIcon"] as const;
const PROFILE_LOCALES = new Set<OneProfileLocale>(["system", "ko", "en"]);
const PRINCIPLE_SCOPES = new Set<OneOperatingPrincipleScope>([
  "personal",
  "project",
  "agent",
  "team",
]);
const SCOPE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PRINCIPLE_ID_RE = /^principle_[a-f0-9]{32}$/;
const UNSAFE_CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const valid = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !valid.has(key));
  if (unexpected.length > 0) throw new TypeError(`${label} contains unsupported fields`);
}

function cleanText(value: unknown, label: string, min: number, max: number): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be text`);
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (normalized.length < min || normalized.length > max) {
    throw new RangeError(`${label} must contain ${min}-${max} characters`);
  }
  if (UNSAFE_CONTROL_RE.test(normalized)) throw new TypeError(`${label} contains unsupported control characters`);
  if (looksSecret(normalized)) throw new TypeError(`${label} must not contain credentials or secrets`);
  return normalized;
}

function assertExpectedVersion(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new TypeError("expectedVersion must be a positive safe integer");
  }
}

function nextTimestamp(currentVersion: number): { version: number; iso: string } {
  const version = Math.max(Date.now(), currentVersion + 1);
  return { version, iso: new Date(version).toISOString() };
}

function newOpaqueId(prefix: "one" | "principle"): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function defaultTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

function defaultProfile(): OneProfile {
  const version = Math.max(1, Date.now());
  const now = new Date(version).toISOString();
  return {
    contractVersion: ONE_PROFILE_CONTRACT_VERSION,
    oneId: newOpaqueId("one"),
    version,
    displayName: "One",
    role: "Agentlas One",
    profileContext: "",
    preferredLocale: "system",
    timeZone: defaultTimeZone(),
    avatarIcon: "character:orange-dino",
    operatingPrinciples: [],
    createdAt: now,
    updatedAt: now,
  };
}

function parseProfile(raw: string): OneProfile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Stored One profile is corrupt; it was not overwritten");
  }
  if (!isOneProfile(parsed)) {
    throw new Error("Stored One profile violates the One profile contract; it was not overwritten");
  }
  return parsed;
}

/*
 * One 프로필은 계정마다 하나다(오너 제품 모델 2026-09-26: 계정 하나 = One 하나).
 *
 * 전에는 기계 전역 한 줄(`agentlas.one.profile.v1`)이라, A 가 바꾼 One 이름·원칙이 같은
 * 기계에 로그인한 B 에게도 보였고, B 는 그 때문에 첫 설정이 뜨지 않았다(사전 부검 O2).
 *
 * 이관 규칙(한 번만):
 *  - 업데이트 뒤 처음으로 로그인한 계정이 보이는 순간, 기계 전역 프로필을 그 계정 자리로
 *    복사하고 "누가 가져갔는지" 표식을 남긴다(INSERT OR IGNORE — 두 번 일어나지 않는다).
 *    옛 줄은 지우지 않고 그대로 둔다(백업).
 *  - 그 뒤 다른 계정은 기본값으로 새로 시작하고, 첫 설정이 그 계정의 프로필을 본다.
 *  - 로그아웃 상태: 아직 아무도 가져가지 않았으면 예전처럼 기계 전역 줄을 쓴다(업데이트
 *    전과 같은 동작). 이미 가져갔으면 누구의 One 도 보여 주지 않도록 따로 둔 "로그아웃" 자리
 *    (기본값)를 쓴다 — 로그인 화면 뒤에 A 의 이름이 새지 않게 하는 보수적 선택.
 */
const LEGACY_CLAIM_KEY = "agentlas.one.profile.v1.legacy-claim";
const SIGNED_OUT_KEY = `${META_KEY}#signed-out`;
const ACCOUNT_KEY_RE = /^[a-f0-9]{32}$/;

type AccountResolver = () => string | null;
let accountResolver: AccountResolver | null = null;
let authListenersInstalled = false;
let lastSlotKey: string | null = null;
/** The claim never changes once written; a different DB (tests) resets it via setOneProfileAccountResolver. */
let cachedClaim: { accountKey: string } | null = null;

function defaultAccountResolver(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const auth = require("../auth") as typeof import("../auth");
    installAuthListeners(auth);
    return auth.getAuthenticatedActorIds()?.userId ?? null;
  } catch {
    return null;
  }
}

function installAuthListeners(auth: typeof import("../auth")): void {
  if (authListenersInstalled) return;
  authListenersInstalled = true;
  try {
    auth.onAuthSessionRestored(() => noteOneProfileAccountMaybeChanged());
    auth.onAuthSessionInvalidated(() => noteOneProfileAccountMaybeChanged());
  } catch {
    /* 리스너가 없는 호스트(테스트·CLI)는 다음 읽기 때 자리를 다시 계산한다 */
  }
}

/** Tests and hosts without the Main auth module inject who is signed in (a stable user id, never shown). */
export function setOneProfileAccountResolver(resolver: AccountResolver | null): void {
  accountResolver = resolver;
  cachedClaim = null;
  lastSlotKey = null;
}

function accountKeyFor(userId: string): string {
  return createHash("sha256").update("agentlas-one-profile-account-v1\0").update(userId).digest("hex").slice(0, 32);
}

function currentAccountKey(): string | null {
  let userId: string | null = null;
  try {
    userId = (accountResolver ?? defaultAccountResolver)();
  } catch {
    userId = null;
  }
  return typeof userId === "string" && userId.length > 0 ? accountKeyFor(userId) : null;
}

function readClaim(): { accountKey: string } | null {
  const row = getDb().prepare("SELECT value FROM meta WHERE key = ? LIMIT 1").get(LEGACY_CLAIM_KEY) as
    | { value: string }
    | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as { accountKey?: unknown };
    if (typeof parsed.accountKey === "string" && ACCOUNT_KEY_RE.test(parsed.accountKey)) return { accountKey: parsed.accountKey };
  } catch { /* fall through */ }
  // 표식이 망가졌으면 아무 계정에도 다시 주지 않는다(두 번 이관 금지).
  return { accountKey: "" };
}

/** The meta row that holds the profile for whoever is signed in right now. */
interface ProfileSlot {
  key: string;
  /** true when this slot carries the pre-update machine-wide One (same oneId, same per-One state). */
  legacyLineage: boolean;
}

function resolveSlot(): ProfileSlot {
  const accountKey = currentAccountKey();
  const db = getDb();
  if (!accountKey) {
    return (cachedClaim ?? readClaim()) ? { key: SIGNED_OUT_KEY, legacyLineage: false } : { key: META_KEY, legacyLineage: true };
  }
  const slotKey = `${META_KEY}#acct:${accountKey}`;
  const claim = cachedClaim ?? readClaim() ?? db.transaction(() => {
    const existing = readClaim();
    if (existing) return existing;
    const legacy = db.prepare("SELECT value FROM meta WHERE key = ? LIMIT 1").get(META_KEY) as
      | { value: string }
      | undefined;
    if (legacy) db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)").run(slotKey, legacy.value);
    db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)").run(
      LEGACY_CLAIM_KEY,
      JSON.stringify({ accountKey, claimedAt: new Date().toISOString(), legacyPresent: Boolean(legacy) }),
    );
    return readClaim();
  })();
  if (claim) cachedClaim = claim;
  return { key: slotKey, legacyLineage: claim?.accountKey === accountKey };
}

/**
 * Per-One state stored beside the profile (activation, feature intro) is bound to the
 * profile's oneId. The One that inherited the machine-wide profile keeps the old key;
 * every other account gets its own.
 */
export function oneScopedMetaKey(baseKey: string): string {
  const slot = resolveSlot();
  if (slot.legacyLineage) return baseKey;
  return slot.key === SIGNED_OUT_KEY ? `${baseKey}#signed-out` : `${baseKey}#${slot.key.slice(META_KEY.length + 1)}`;
}

/**
 * Where the signed-in account's One came from — first-run uses it so an account that
 * never had a One on this machine sees the first-run flow even when the machine has
 * other accounts' chats and projects.
 *  - "inherited": this account took over the pre-update machine-wide profile
 *  - "fresh": another account; its One started from defaults
 *  - "machine": signed out, nobody has taken the machine-wide profile yet
 *  - "signed-out": signed out after the machine-wide profile was taken
 */
export type OneProfileOrigin = "inherited" | "fresh" | "machine" | "signed-out";
export function getOneProfileOrigin(): OneProfileOrigin {
  const slot = resolveSlot();
  if (slot.key === META_KEY) return "machine";
  if (slot.key === SIGNED_OUT_KEY) return "signed-out";
  return slot.legacyLineage ? "inherited" : "fresh";
}

/** Directory segment for One's own portrait: null = the pre-update shared location. */
export function oneProfileAvatarSegment(): string | null {
  const slot = resolveSlot();
  if (slot.legacyLineage) return null;
  return slot.key === SIGNED_OUT_KEY ? "signed-out" : slot.key.slice(`${META_KEY}#acct:`.length);
}

/**
 * Main calls this whenever the signed-in account may have changed. When the profile
 * slot actually moved, renderers and the mobile mirror re-read One (name, face, principles).
 */
export function noteOneProfileAccountMaybeChanged(): void {
  let key: string;
  try {
    key = resolveSlot().key;
  } catch {
    return;
  }
  if (lastSlotKey === key) return;
  const hadPrevious = lastSlotKey !== null;
  lastSlotKey = key;
  if (!hadPrevious) return;
  try {
    const profile = readOrCreateRawProfile().profile;
    emitDesktopStoreChange({ entity: "one-profile", id: profile.oneId });
  } catch {
    emitDesktopStoreChange({ entity: "one-profile" });
  }
}

function readOrCreateRawProfile(): { raw: string; profile: OneProfile; key: string } {
  const db = getDb();
  const key = resolveSlot().key;
  if (lastSlotKey !== null && lastSlotKey !== key) {
    lastSlotKey = key;
    queueMicrotask(() => emitDesktopStoreChange({ entity: "one-profile" }));
  } else {
    lastSlotKey = key;
  }
  let row = db.prepare("SELECT value FROM meta WHERE key = ? LIMIT 1").get(key) as
    | { value: string }
    | undefined;
  if (!row) {
    const candidate = JSON.stringify(defaultProfile());
    db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)").run(key, candidate);
    row = db.prepare("SELECT value FROM meta WHERE key = ? LIMIT 1").get(key) as
      | { value: string }
      | undefined;
  }
  if (!row) throw new Error("Could not initialize the One profile");
  return { raw: row.value, profile: parseProfile(row.value), key };
}

function mutateProfile(
  expectedVersion: number,
  update: (current: OneProfile, timestamp: { version: number; iso: string }) => OneProfile,
): OneProfile {
  assertExpectedVersion(expectedVersion);
  const current = readOrCreateRawProfile();
  if (current.profile.version !== expectedVersion) {
    throw new Error(`One profile changed (expected ${expectedVersion}, current ${current.profile.version})`);
  }
  const next = update(current.profile, nextTimestamp(current.profile.version));
  if (!isOneProfile(next)) throw new Error("One profile mutation violated the storage contract");
  if (next === current.profile) return current.profile;
  const result = getDb()
    .prepare("UPDATE meta SET value = ? WHERE key = ? AND value = ?")
    .run(JSON.stringify(next), current.key, current.raw);
  if (result.changes !== 1) throw new Error("One profile changed concurrently; reload and try again");
  emitDesktopStoreChange({ entity: "one-profile", id: next.oneId });
  return next;
}

function normalizeScope(
  scopeValue: unknown,
  scopeRefValue: unknown,
): { scope: OneOperatingPrincipleScope; scopeRef: string | null } {
  if (typeof scopeValue !== "string" || !PRINCIPLE_SCOPES.has(scopeValue as OneOperatingPrincipleScope)) {
    throw new TypeError("Invalid operating principle scope");
  }
  const scope = scopeValue as OneOperatingPrincipleScope;
  if (scope === "personal") {
    if (scopeRefValue != null && scopeRefValue !== "") {
      throw new TypeError("A personal principle cannot have a scopeRef");
    }
    return { scope, scopeRef: null };
  }
  if (typeof scopeRefValue !== "string" || !SCOPE_REF_RE.test(scopeRefValue.trim())) {
    throw new TypeError(`${scope} principles require a safe scopeRef`);
  }
  return { scope, scopeRef: scopeRefValue.trim() };
}

function findPrinciple(profile: OneProfile, principleId: unknown): OneOperatingPrinciple {
  if (typeof principleId !== "string" || !PRINCIPLE_ID_RE.test(principleId)) {
    throw new TypeError("Invalid operating principle id");
  }
  const principle = profile.operatingPrinciples.find((item) => item.id === principleId);
  if (!principle) throw new Error("Operating principle not found");
  return principle;
}

function recordProfileUpdated(profile: OneProfile, changedFields: string[], scope: string): void {
  tryRecordOneDomainEvent({
    eventType: "one.profile.updated",
    occurredAt: profile.updatedAt,
    actor: "user",
    entityId: profile.oneId,
    version: profile.version,
    visibility: "personal",
    entries: [
      { name: "changedFields", value: changedFields },
      { name: "scope", value: scope },
    ],
  });
}

export function getOneProfile(): OneProfile {
  return readOrCreateRawProfile().profile;
}

export function getOneProfileDeviceProjection(): OneProfileDeviceProjection {
  return projectOneProfileForDevice(getOneProfile());
}

const displayNameListeners = new Set<(next: string, previous: string) => void>();

/**
 * Main-only: told after One's display name actually changed, whichever channel
 * saved it (Desktop dialog, profile sheet, paired mobile). The agent mail sync
 * uses it so the mail sender name follows One's name.
 */
export function onOneDisplayNameChanged(listener: (next: string, previous: string) => void): () => void {
  displayNameListeners.add(listener);
  return () => displayNameListeners.delete(listener);
}

export function updateOneProfile(input: OneProfileUpdateInput): OneProfile {
  if (!isRecord(input)) throw new TypeError("Invalid One profile update");
  assertOnlyKeys(input, ["expectedVersion", "patch"], "One profile update");
  assertExpectedVersion(input.expectedVersion);
  if (!isRecord(input.patch)) throw new TypeError("One profile patch must be an object");
  assertOnlyKeys(input.patch, PROFILE_PATCH_KEYS, "One profile patch");
  if (Object.keys(input.patch).length === 0) throw new TypeError("One profile patch is empty");

  const changedFields: string[] = [];
  let previousDisplayName = "";
  const updated = mutateProfile(input.expectedVersion, (current, timestamp) => {
    previousDisplayName = current.displayName;
    const next: OneProfile = { ...current };
    if ("displayName" in input.patch) next.displayName = cleanText(input.patch.displayName, "displayName", 1, 64);
    if ("role" in input.patch) next.role = cleanText(input.patch.role, "role", 1, 120);
    if ("profileContext" in input.patch) next.profileContext = cleanText(input.patch.profileContext, "profileContext", 0, 4_000);
    if ("preferredLocale" in input.patch) {
      if (typeof input.patch.preferredLocale !== "string" || !PROFILE_LOCALES.has(input.patch.preferredLocale)) {
        throw new TypeError("Invalid preferredLocale");
      }
      next.preferredLocale = input.patch.preferredLocale;
    }
    if ("avatarIcon" in input.patch) {
      // 캐릭터 id 하나만 받는다. 임의 문자열을 그대로 저장하면 화면이 그리지 못하는 값이
      // 남고, 그때는 "고장"이 아니라 "얼굴이 사라짐"으로 보인다.
      const icon = cleanText(input.patch.avatarIcon, "avatarIcon", 1, 160);
      // 프리셋 캐릭터이거나, One 자신의 초상 자리 하나. 그 밖의 문자열은 화면이 그리지 못한다.
      if (!/^character:[a-z0-9][a-z0-9-]{0,60}$/.test(icon) && icon !== "one-avatar:self") {
        throw new TypeError("Invalid avatarIcon");
      }
      next.avatarIcon = icon;
    }
    if ("timeZone" in input.patch) {
      if (input.patch.timeZone === null) {
        next.timeZone = null;
      } else {
        const timeZone = cleanText(input.patch.timeZone, "timeZone", 1, 128);
        try {
          new Intl.DateTimeFormat("en", { timeZone });
        } catch {
          throw new TypeError("Invalid IANA timeZone");
        }
        next.timeZone = timeZone;
      }
    }
    for (const key of PROFILE_PATCH_KEYS) {
      if (key in input.patch && next[key] !== current[key]) changedFields.push(key);
    }
    if (
      next.displayName === current.displayName &&
      next.role === current.role &&
      next.profileContext === current.profileContext &&
      next.preferredLocale === current.preferredLocale &&
      next.timeZone === current.timeZone &&
      next.avatarIcon === current.avatarIcon
    ) return current;
    return { ...next, version: timestamp.version, updatedAt: timestamp.iso };
  });
  if (updated.version !== input.expectedVersion) {
    recordProfileUpdated(updated, changedFields.sort(), "profile");
    if (changedFields.includes("displayName") && previousDisplayName !== updated.displayName) {
      for (const listener of displayNameListeners) {
        try { listener(updated.displayName, previousDisplayName); } catch { /* a listener never fails the save */ }
      }
    }
  }
  return updated;
}

export function addOneOperatingPrinciple(input: OneOperatingPrincipleCreateInput): OneProfile {
  if (!isRecord(input)) throw new TypeError("Invalid operating principle create request");
  assertOnlyKeys(input, ["expectedVersion", "content", "scope", "scopeRef", "approvedByUser"], "Operating principle create request");
  assertExpectedVersion(input.expectedVersion);
  if (input.approvedByUser !== true) throw new Error("Operating principles require explicit user approval");
  const content = cleanText(input.content, "Operating principle", 1, 500);
  const scope = normalizeScope(input.scope, input.scopeRef);
  const updated = mutateProfile(input.expectedVersion, (current, timestamp) => ({
    ...current,
    version: timestamp.version,
    updatedAt: timestamp.iso,
    operatingPrinciples: [
      ...current.operatingPrinciples,
      {
        id: newOpaqueId("principle"),
        content,
        scope: scope.scope,
        scopeRef: scope.scopeRef,
        approvalSource: "explicit_user",
        approvedAt: timestamp.iso,
        enabled: true,
        createdAt: timestamp.iso,
        updatedAt: timestamp.iso,
        disabledAt: null,
      },
    ],
  }));
  recordProfileUpdated(updated, ["operatingPrinciples"], scope.scope);
  return updated;
}

export function updateOneOperatingPrinciple(input: OneOperatingPrincipleUpdateInput): OneProfile {
  if (!isRecord(input)) throw new TypeError("Invalid operating principle update request");
  assertOnlyKeys(input, ["expectedVersion", "principleId", "content", "scope", "scopeRef", "approvedByUser"], "Operating principle update request");
  assertExpectedVersion(input.expectedVersion);
  if (input.approvedByUser !== true) throw new Error("Edited operating principles require explicit user approval");
  if (!("content" in input) && !("scope" in input) && !("scopeRef" in input)) {
    throw new TypeError("Operating principle update is empty");
  }
  const updated = mutateProfile(input.expectedVersion, (current, timestamp) => {
    const existing = findPrinciple(current, input.principleId);
    const content = "content" in input
      ? cleanText(input.content, "Operating principle", 1, 500)
      : existing.content;
    const scope = normalizeScope(input.scope ?? existing.scope, "scopeRef" in input ? input.scopeRef : existing.scopeRef);
    return {
      ...current,
      version: timestamp.version,
      updatedAt: timestamp.iso,
      operatingPrinciples: current.operatingPrinciples.map((item) => item.id === existing.id
        ? {
            ...item,
            content,
            scope: scope.scope,
            scopeRef: scope.scopeRef,
            approvalSource: "explicit_user",
            approvedAt: timestamp.iso,
            updatedAt: timestamp.iso,
          }
        : item),
    };
  });
  const principle = updated.operatingPrinciples.find((item) => item.id === input.principleId);
  recordProfileUpdated(updated, ["operatingPrinciples"], principle?.scope ?? "operating-principles");
  return updated;
}

export function setOneOperatingPrincipleEnabled(input: OneOperatingPrincipleEnabledInput): OneProfile {
  if (!isRecord(input)) throw new TypeError("Invalid operating principle state request");
  assertOnlyKeys(input, ["expectedVersion", "principleId", "enabled"], "Operating principle state request");
  assertExpectedVersion(input.expectedVersion);
  if (typeof input.enabled !== "boolean") throw new TypeError("enabled must be boolean");
  const updated = mutateProfile(input.expectedVersion, (current, timestamp) => {
    const existing = findPrinciple(current, input.principleId);
    if (existing.enabled === input.enabled) return current;
    return {
      ...current,
      version: timestamp.version,
      updatedAt: timestamp.iso,
      operatingPrinciples: current.operatingPrinciples.map((item) => item.id === existing.id
        ? {
            ...item,
            enabled: input.enabled,
            updatedAt: timestamp.iso,
            disabledAt: input.enabled ? null : timestamp.iso,
          }
        : item),
    };
  });
  if (updated.version !== input.expectedVersion) {
    const principle = updated.operatingPrinciples.find((item) => item.id === input.principleId);
    recordProfileUpdated(updated, ["operatingPrinciples"], principle?.scope ?? "operating-principles");
  }
  return updated;
}

export function deleteOneOperatingPrinciple(input: OneOperatingPrincipleDeleteInput): OneProfile {
  if (!isRecord(input)) throw new TypeError("Invalid operating principle delete request");
  assertOnlyKeys(input, ["expectedVersion", "principleId"], "Operating principle delete request");
  assertExpectedVersion(input.expectedVersion);
  const updated = mutateProfile(input.expectedVersion, (current, timestamp) => {
    const existing = findPrinciple(current, input.principleId);
    return {
      ...current,
      version: timestamp.version,
      updatedAt: timestamp.iso,
      operatingPrinciples: current.operatingPrinciples.filter((item) => item.id !== existing.id),
    };
  });
  recordProfileUpdated(updated, ["operatingPrinciples"], "operating-principles");
  return updated;
}
