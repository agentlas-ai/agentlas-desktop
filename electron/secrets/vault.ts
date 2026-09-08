// macOS Keychain (keytar) wrapper.
// PRD 6.2 보안 모델 — 모든 비밀은 메인 프로세스만 접근, renderer는 has* boolean과
// 메인에서 생성한 "마스킹 미리보기"(전체 값 아님)만 받는다. 전체 평문은 절대 renderer로 안 나간다.
//
// 두 종류의 비밀:
//   1) BYOK LLM API 키       — account "byok:<backend>"  (Anthropic/OpenAI/Google)
//   2) 글로벌 env (외부 API)  — account "env:<KEY_NAME>" (NOTION_API_KEY, SLACK_TOKEN 등)
//
// 두 namespace 모두 같은 SERVICE 안에 있지만 prefix로 구분.
import { developmentEffectsSuppressed, assertDevelopmentEffectAllowed } from "../development-effect-policy";

import { createHash, randomUUID } from "node:crypto";
import type { RuntimeBackend } from "../../shared/types";
import type { CredentialRecoveryFailure, CredentialRecoveryResult } from "../../shared/credential-recovery";
import { readCredentialRecoveryRecords, type CredentialRecoveryResource } from "./recovery-state";
import {
  requireConfiguredInstallIdentity,
} from "../install-identity";
import {
  keychainDelete,
  keychainGet,
  keychainListAccounts,
  keychainSet,
  retryKeychainReadFromUser,
  retryKeychainListFromUser,
} from "./keychain-host";

let keytarBackend: typeof import("keytar") | null = null;
function keytarApi(): typeof import("keytar") {
  assertDevelopmentEffectAllowed("credentials.native-backend");
  if (!keytarBackend) keytarBackend = require("keytar") as typeof import("keytar");
  return keytarBackend;
}

const BYOK_PREFIX = "byok:";
const BYOK_META_PREFIX = "byok-meta:";
const ENV_PREFIX = "env:";
const SECRET_PREFIX = "secret:";
const USE_MEMORY_VAULT = process.env.AGENTLAS_E2E === "1" && process.env.AGENTLAS_E2E_KEYCHAIN !== "1";
const memoryVault = new Map<string, string>();
const keychainCache = new Map<string, string | null>();
const passwordReads = new Map<string, Promise<string | null>>();
const passwordOperations = new Map<string, Promise<unknown>>();
const userPasswordRetries = new Map<string, Promise<string | null>>();
type RecoveryToken = { resource: CredentialRecoveryResource; generation: string; consumed: boolean; pending?: Promise<CredentialRecoveryResult> };
const recoveryTokens = new Map<string, RecoveryToken>();
const resourceTokens = new Map<string, string>();
const userListRetries = new Map<string, Promise<string[]>>();
let envKeyCache: string[] | null = null;
let envKeyCacheService: string | null = null;
let envKeyRead: Promise<string[]> | null = null;

function keychainService(): string {
  // An unconfigured test, plugin, or temporary Electron host must never inherit
  // the official application's credential namespace merely by importing vault.
  return requireConfiguredInstallIdentity().keychainService;
}

function passwordKey(service: string, account: string): string {
  return JSON.stringify([service, account]);
}

function queuePasswordOperation<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = passwordOperations.get(key) ?? Promise.resolve();
  const next = previous.then(run, run);
  passwordOperations.set(key, next);
  void next.then(() => {
    if (passwordOperations.get(key) === next) passwordOperations.delete(key);
  }, () => {
    if (passwordOperations.get(key) === next) passwordOperations.delete(key);
  });
  return next;
}

/*
 * ★키체인 호출은 전부 keychain-host 를 지난다(그 파일에 사유가 적혀 있다).
 *   화면이 있는 호스트에서는 예전 그대로 직접 부르고, 화면이 없는 호스트
 *   (플러그인 CLI·hep-graph·cron)에서는 죽일 수 있는 자식 프로세스로 옮긴다.
 *   여기서 직접 `keytar.*` 를 부르는 새 코드를 만들지 말 것 — 그 한 줄이
 *   헤드리스 호스트에서 제품 전체를 멈춘다(2026-08-19 실측).
 */
async function getPassword(account: string): Promise<string | null> {
  if (developmentEffectsSuppressed() || USE_MEMORY_VAULT) return memoryVault.get(account) ?? null;
  const service = keychainService();
  const key = passwordKey(service, account);
  const pending = passwordReads.get(key);
  if (pending) return pending;
  if (!passwordOperations.has(key) && keychainCache.has(key)) return keychainCache.get(key) ?? null;
  const started = queuePasswordOperation(key, async () => {
    if (keychainCache.has(key)) return keychainCache.get(key) ?? null;
    const value = await keychainGet(service, account, () => keytarApi().getPassword(service, account));
    keychainCache.set(key, value);
    return value;
  });
  passwordReads.set(key, started);
  void started.then(() => {
    if (passwordReads.get(key) === started) passwordReads.delete(key);
  }, () => {
    if (passwordReads.get(key) === started) passwordReads.delete(key);
  });
  return started;
}

async function setPassword(account: string, value: string): Promise<void> {
  if (developmentEffectsSuppressed() || USE_MEMORY_VAULT) {
    memoryVault.set(account, value);
    return;
  } else {
    const service = keychainService();
    const key = passwordKey(service, account);
    passwordReads.delete(key);
    await queuePasswordOperation(key, async () => {
      await keychainSet(service, account, value, () => keytarApi().setPassword(service, account, value));
      keychainCache.set(key, value);
    });
  }
}

async function deletePassword(account: string): Promise<void> {
  if (developmentEffectsSuppressed() || USE_MEMORY_VAULT) {
    memoryVault.delete(account);
    return;
  } else {
    const service = keychainService();
    const key = passwordKey(service, account);
    passwordReads.delete(key);
    await queuePasswordOperation(key, async () => {
      await keychainDelete(service, account, async () => { await keytarApi().deletePassword(service, account); });
      keychainCache.set(key, null);
    });
  }
}

/** Main-only entrypoint for a deliberate retry of one existing credential.
 * Returns no secret. The IPC caller must bind its user action to this exact
 * resource; never call this from presence probes or automatic retry loops.
 */
export function retryCredentialReadFromUser(kind: "api" | "env" | "secret", name: string): Promise<void> {
  if (!["api", "env", "secret"].includes(kind) || !name || name !== name.trim() || name.length > 256) {
    return Promise.reject(new Error("credential_retry_resource_invalid"));
  }
  if (developmentEffectsSuppressed() || USE_MEMORY_VAULT) return Promise.resolve();
  const account = `${kind === "api" ? BYOK_PREFIX : kind === "env" ? ENV_PREFIX : SECRET_PREFIX}${name}`;
  const service = keychainService();
  return retryAccountFromUser(service, account).then(() => {});
}

function retryAccountFromUser(service: string, account: string): Promise<string | null> {
  const key = passwordKey(service, account);
  const current = userPasswordRetries.get(key);
  if (current) return current;
  passwordReads.delete(key);
  const started = queuePasswordOperation(key, async () => {
    const value = await retryKeychainReadFromUser(service, account, () => keytarApi().getPassword(service, account));
    keychainCache.set(key, value);
    return value;
  });
  userPasswordRetries.set(key, started);
  void started.then(() => { if (userPasswordRetries.get(key) === started) userPasswordRetries.delete(key); },
    () => { if (userPasswordRetries.get(key) === started) userPasswordRetries.delete(key); });
  return started;
}

function recoveryResourceKey(resource: CredentialRecoveryResource): string {
  return JSON.stringify([resource.service, resource.operation, resource.account]);
}

function recoveryDisplay(resource: CredentialRecoveryResource): Pick<CredentialRecoveryFailure, "kind" | "operation" | "name"> | null {
  if (resource.operation === "list") return { kind: "env", operation: "list", name: null };
  for (const [prefix, kind] of [[BYOK_META_PREFIX, "api-metadata"], [BYOK_PREFIX, "api"], [ENV_PREFIX, "env"], [SECRET_PREFIX, "secret"]] as const) {
    if (resource.account.startsWith(prefix)) {
      return { kind, operation: "read", name: resource.account.slice(prefix.length).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 256) };
    }
  }
  return null;
}

/** Lists only previously failed/incomplete resources, without native discovery. */
export async function listCredentialRecoveryFailures(): Promise<CredentialRecoveryFailure[]> {
  if (developmentEffectsSuppressed() || USE_MEMORY_VAULT) return [];
  const records = await readCredentialRecoveryRecords();
  const out: CredentialRecoveryFailure[] = [];
  for (const record of records) {
    const display = recoveryDisplay(record.resource);
    if (!display) continue;
    const key = recoveryResourceKey(record.resource);
    let retryToken = resourceTokens.get(key);
    let entry = retryToken ? recoveryTokens.get(retryToken) : undefined;
    if (!entry?.pending && (!entry || entry.consumed || entry.generation !== record.generation)) {
      if (retryToken) recoveryTokens.delete(retryToken);
      retryToken = randomUUID();
      entry = { resource: { ...record.resource }, generation: record.generation, consumed: false };
      recoveryTokens.set(retryToken, entry);
      resourceTokens.set(key, retryToken);
    }
    out.push({ ...display, retryToken: retryToken!, status: entry?.pending ? "retrying" : "unavailable", errorCode: record.errorCode });
  }
  return out.sort((a, b) => `${a.kind}:${a.operation}:${a.name ?? ""}`.localeCompare(`${b.kind}:${b.operation}:${b.name ?? ""}`));
}

function retryEnvListFromUser(service: string): Promise<string[]> {
  const current = userListRetries.get(service);
  if (current) return current;
  const started = retryKeychainListFromUser(service, async () => (await keytarApi().findCredentials(service)).map((item) => item.account))
    .then((accounts) => {
      const keys = accounts.filter((account) => account.startsWith(ENV_PREFIX)).map((account) => account.slice(ENV_PREFIX.length));
      if (keychainService() === service) { envKeyCacheService = service; envKeyCache = keys; }
      return keys;
    });
  userListRetries.set(service, started);
  void started.then(() => { if (userListRetries.get(service) === started) userListRetries.delete(service); },
    () => { if (userListRetries.get(service) === started) userListRetries.delete(service); });
  return started;
}

/** The renderer supplies a Main-issued handle, never a namespace or account. */
export function retryCredentialRecoveryFromUser(retryToken: string): Promise<CredentialRecoveryResult> {
  assertDevelopmentEffectAllowed("credentials.recovery-retry");
  const entry = typeof retryToken === "string" ? recoveryTokens.get(retryToken) : undefined;
  if (!entry || entry.consumed && !entry.pending) return Promise.resolve({ status: "invalid-token" });
  if (entry.pending) return entry.pending;
  entry.consumed = true;
  const started = Promise.resolve().then(async (): Promise<CredentialRecoveryResult> => {
    if (keychainService() !== entry.resource.service) return { status: "invalid-token" };
    const current = (await readCredentialRecoveryRecords()).find((record) => recoveryResourceKey(record.resource) === recoveryResourceKey(entry.resource));
    if (!current || current.generation !== entry.generation) return { status: "invalid-token" };
    if (entry.resource.operation === "list") {
      await retryEnvListFromUser(entry.resource.service);
      return { status: "restored" };
    }
    const value = await retryAccountFromUser(entry.resource.service, entry.resource.account);
    return {
      status: value ? "restored" : "missing",
      ...(entry.resource.account.startsWith(ENV_PREFIX) ? {
        env: { key: entry.resource.account.slice(ENV_PREFIX.length), hasValue: !!value, preview: value ? maskSecret(value) : null },
      } : {}),
    };
  }).catch((): CredentialRecoveryResult => ({ status: "unavailable" }));
  entry.pending = started;
  void started.then(() => {
    entry.pending = undefined;
    const key = recoveryResourceKey(entry.resource);
    if (resourceTokens.get(key) === retryToken) resourceTokens.delete(key);
    recoveryTokens.delete(retryToken);
  });
  return started;
}

// ── BYOK LLM API ────────────────────────────────────────────
function byokAccount(backend: RuntimeBackend): string {
  return `${BYOK_PREFIX}${backend}`;
}

function byokMetaAccount(backend: RuntimeBackend): string {
  return `${BYOK_META_PREFIX}${backend}`;
}

export type ApiKeyDescriptor = {
  backend: RuntimeBackend;
  version: string;
  fingerprint: string;
  updatedAt: string;
};

function apiKeyFingerprint(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function writeApiKeyDescriptor(backend: RuntimeBackend, key: string): Promise<ApiKeyDescriptor> {
  const descriptor: ApiKeyDescriptor = {
    backend,
    version: randomUUID(),
    fingerprint: apiKeyFingerprint(key),
    updatedAt: new Date().toISOString(),
  };
  await setPassword(byokMetaAccount(backend), JSON.stringify(descriptor));
  return descriptor;
}

export async function saveApiKey(backend: RuntimeBackend, key: string): Promise<void> {
  const trimmed = key.trim();
  if (!trimmed) {
    await deletePassword(byokAccount(backend));
    await deletePassword(byokMetaAccount(backend));
    return;
  }
  await setPassword(byokAccount(backend), trimmed);
  await writeApiKeyDescriptor(backend, trimmed);
}

export async function hasApiKey(backend: RuntimeBackend): Promise<boolean> {
  const v = await getPassword(byokAccount(backend));
  return typeof v === "string" && v.length > 0;
}

export async function deleteApiKey(backend: RuntimeBackend): Promise<void> {
  await deletePassword(byokAccount(backend));
  await deletePassword(byokMetaAccount(backend));
}

/** main 내부 사용 — MCP 호출 시 자식 env에 주입. renderer 노출 X */
export async function readApiKey(backend: RuntimeBackend): Promise<string | null> {
  return getPassword(byokAccount(backend));
}

/** Value-free key identity for native approval UI. Never returns the secret. */
export async function describeApiKey(backend: RuntimeBackend): Promise<ApiKeyDescriptor | null> {
  const raw = await getPassword(byokMetaAccount(backend));
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<ApiKeyDescriptor>;
    if (
      value.backend !== backend ||
      typeof value.version !== "string" ||
      !/^[a-f0-9-]{16,80}$/i.test(value.version) ||
      typeof value.fingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.fingerprint) ||
      typeof value.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(value.updatedAt))
    ) return null;
    return {
      backend,
      version: value.version,
      fingerprint: value.fingerprint,
      updatedAt: value.updatedAt,
    };
  } catch {
    return null;
  }
}

/** Backfill value-free metadata only after native approval allowed reading the key. */
export async function ensureApiKeyDescriptor(
  backend: RuntimeBackend,
  key: string,
): Promise<ApiKeyDescriptor> {
  const current = await describeApiKey(backend);
  if (current?.fingerprint === apiKeyFingerprint(key)) return current;
  return writeApiKeyDescriptor(backend, key);
}

// ── 글로벌 env (외부 통합 API 키) ───────────────────────────
let envConfigurationRevision = 0;
/** Value-free process-local epoch for optional credential prompt invalidation. */
export function getEnvConfigurationRevision(): number { return envConfigurationRevision; }
function envAccount(key: string): string {
  return `${ENV_PREFIX}${key}`;
}

export async function setEnvVar(key: string, value: string): Promise<void> {
  const trimmedKey = key.trim();
  if (!trimmedKey) throw new Error("env key cannot be empty");
  const trimmedValue = value.trim();
  if (!trimmedValue) {
    await deletePassword(envAccount(trimmedKey));
    envConfigurationRevision += 1;
    if (envKeyCache) envKeyCache = envKeyCache.filter((item) => item !== trimmedKey);
    return;
  }
  await setPassword(envAccount(trimmedKey), trimmedValue);
  envConfigurationRevision += 1;
  if (envKeyCache && !envKeyCache.includes(trimmedKey)) envKeyCache = [...envKeyCache, trimmedKey].sort();
}

export async function hasEnvVar(key: string): Promise<boolean> {
  const v = await getPassword(envAccount(key));
  return typeof v === "string" && v.length > 0;
}

export async function deleteEnvVar(key: string): Promise<void> {
  await deletePassword(envAccount(key));
  envConfigurationRevision += 1;
  if (envKeyCache) envKeyCache = envKeyCache.filter((item) => item !== key);
}

/** main 내부 — MCP 서버 spawn 시 envRequirements 매칭해 자식 env로 주입 (M1) */
export async function readEnvVar(key: string): Promise<string | null> {
  return getPassword(envAccount(key));
}

/**
 * 시크릿을 화면 표시용으로 마스킹한다. **메인 프로세스에서만** 호출하고,
 * 전체 평문은 절대 반환하지 않는다 — 양끝 일부만 드러내고 가운데를 점으로 가린다.
 * 짧은 값(≤6자)은 식별 위험이 커서 전부 가린다.
 */
export function maskSecret(value: string): string {
  const v = value ?? "";
  const len = v.length;
  if (len === 0) return "";
  if (len <= 6) return "•".repeat(len); // 너무 짧으면 끝자리도 드러내지 않는다
  const reveal = Math.min(4, Math.floor(len / 4)); // 양끝 최대 4자만 노출
  const head = v.slice(0, reveal);
  const tail = v.slice(len - reveal);
  const dots = Math.min(8, Math.max(3, len - reveal * 2)); // 가운데 점 (레이아웃 위해 최대 8)
  return `${head}${"•".repeat(dots)}${tail}`;
}

/** renderer 노출용 — 저장된 값의 마스킹 미리보기. 미저장이면 null. 전체 값은 안 나간다. */
export async function previewEnvVar(key: string): Promise<string | null> {
  const v = await getPassword(envAccount(key));
  if (typeof v !== "string" || v.length === 0) return null;
  return maskSecret(v);
}

/** keychain에 저장된 env 키 전체 — keytar.findCredentials로 prefix filter */
export async function listEnvKeys(): Promise<string[]> {
  const service = (developmentEffectsSuppressed() || USE_MEMORY_VAULT) ? "memory" : keychainService();
  if (envKeyCacheService !== service) {
    envKeyCacheService = service;
    envKeyCache = null;
    envKeyRead = null;
  }
  if (envKeyCache) return envKeyCache;
  if (envKeyRead) return envKeyRead;
  const started = Promise.resolve().then(async () => {
    const accounts = developmentEffectsSuppressed() || USE_MEMORY_VAULT
      ? [...memoryVault.keys()]
      : await keychainListAccounts(service, async () =>
          (await keytarApi().findCredentials(service)).map((c) => c.account));
    const keys = accounts.filter((a) => a.startsWith(ENV_PREFIX)).map((a) => a.slice(ENV_PREFIX.length));
    if (envKeyCacheService === service) envKeyCache = keys;
    return keys;
  });
  envKeyRead = started;
  void started.then(() => { if (envKeyRead === started) envKeyRead = null; },
    () => { if (envKeyRead === started) envKeyRead = null; });
  return started;
}

function secretAccount(key: string): string {
  return `${SECRET_PREFIX}${key}`;
}

export async function setSecret(key: string, value: string): Promise<void> {
  const trimmedKey = key.trim();
  if (!trimmedKey) throw new Error("secret key cannot be empty");
  const trimmedValue = value.trim();
  if (!trimmedValue) {
    await deletePassword(secretAccount(trimmedKey));
    return;
  }
  await setPassword(secretAccount(trimmedKey), trimmedValue);
}

export async function readSecret(key: string): Promise<string | null> {
  return getPassword(secretAccount(key));
}

export async function deleteSecret(key: string): Promise<void> {
  await deletePassword(secretAccount(key));
}

export async function previewSecret(key: string): Promise<string | null> {
  const v = await readSecret(key);
  if (typeof v !== "string" || v.length === 0) return null;
  return maskSecret(v);
}
