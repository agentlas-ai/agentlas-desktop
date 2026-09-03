import { randomUUID } from "node:crypto";
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

function readOrCreateRawProfile(): { raw: string; profile: OneProfile } {
  const db = getDb();
  let row = db.prepare("SELECT value FROM meta WHERE key = ? LIMIT 1").get(META_KEY) as
    | { value: string }
    | undefined;
  if (!row) {
    const candidate = JSON.stringify(defaultProfile());
    db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)").run(META_KEY, candidate);
    row = db.prepare("SELECT value FROM meta WHERE key = ? LIMIT 1").get(META_KEY) as
      | { value: string }
      | undefined;
  }
  if (!row) throw new Error("Could not initialize the One profile");
  return { raw: row.value, profile: parseProfile(row.value) };
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
    .run(JSON.stringify(next), META_KEY, current.raw);
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

export function updateOneProfile(input: OneProfileUpdateInput): OneProfile {
  if (!isRecord(input)) throw new TypeError("Invalid One profile update");
  assertOnlyKeys(input, ["expectedVersion", "patch"], "One profile update");
  assertExpectedVersion(input.expectedVersion);
  if (!isRecord(input.patch)) throw new TypeError("One profile patch must be an object");
  assertOnlyKeys(input.patch, PROFILE_PATCH_KEYS, "One profile patch");
  if (Object.keys(input.patch).length === 0) throw new TypeError("One profile patch is empty");

  const changedFields: string[] = [];
  const updated = mutateProfile(input.expectedVersion, (current, timestamp) => {
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
