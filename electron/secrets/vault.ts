// macOS Keychain (keytar) wrapper.
// PRD 6.2 보안 모델 — 모든 비밀은 메인 프로세스만 접근, renderer는 has* boolean과
// 메인에서 생성한 "마스킹 미리보기"(전체 값 아님)만 받는다. 전체 평문은 절대 renderer로 안 나간다.
//
// 두 종류의 비밀:
//   1) BYOK LLM API 키       — account "byok:<backend>"  (Anthropic/OpenAI/Google)
//   2) 글로벌 env (외부 API)  — account "env:<KEY_NAME>" (NOTION_API_KEY, SLACK_TOKEN 등)
//
// 두 namespace 모두 같은 SERVICE 안에 있지만 prefix로 구분.
import keytar from "keytar";
import { createHash, randomUUID } from "node:crypto";
import type { RuntimeBackend } from "../../shared/types";

const SERVICE = "com.agentlas.desktop";
const BYOK_PREFIX = "byok:";
const BYOK_META_PREFIX = "byok-meta:";
const ENV_PREFIX = "env:";
const SECRET_PREFIX = "secret:";
const USE_MEMORY_VAULT = process.env.AGENTLAS_E2E === "1" && process.env.AGENTLAS_E2E_KEYCHAIN !== "1";
const memoryVault = new Map<string, string>();
const keychainCache = new Map<string, string | null>();
let envKeyCache: string[] | null = null;

async function getPassword(account: string): Promise<string | null> {
  if (USE_MEMORY_VAULT) return memoryVault.get(account) ?? null;
  if (keychainCache.has(account)) return keychainCache.get(account) ?? null;
  const value = await keytar.getPassword(SERVICE, account);
  keychainCache.set(account, value);
  return value;
}

async function setPassword(account: string, value: string): Promise<void> {
  if (USE_MEMORY_VAULT) {
    memoryVault.set(account, value);
  } else {
    await keytar.setPassword(SERVICE, account, value);
  }
  keychainCache.set(account, value);
}

async function deletePassword(account: string): Promise<void> {
  if (USE_MEMORY_VAULT) {
    memoryVault.delete(account);
  } else {
    await keytar.deletePassword(SERVICE, account);
  }
  keychainCache.delete(account);
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
function envAccount(key: string): string {
  return `${ENV_PREFIX}${key}`;
}

export async function setEnvVar(key: string, value: string): Promise<void> {
  const trimmedKey = key.trim();
  if (!trimmedKey) throw new Error("env key cannot be empty");
  const trimmedValue = value.trim();
  if (!trimmedValue) {
    await deletePassword(envAccount(trimmedKey));
    if (envKeyCache) envKeyCache = envKeyCache.filter((item) => item !== trimmedKey);
    return;
  }
  await setPassword(envAccount(trimmedKey), trimmedValue);
  if (envKeyCache && !envKeyCache.includes(trimmedKey)) envKeyCache = [...envKeyCache, trimmedKey].sort();
}

export async function hasEnvVar(key: string): Promise<boolean> {
  const v = await getPassword(envAccount(key));
  return typeof v === "string" && v.length > 0;
}

export async function deleteEnvVar(key: string): Promise<void> {
  await deletePassword(envAccount(key));
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
  if (envKeyCache) return envKeyCache;
  const creds = USE_MEMORY_VAULT
    ? [...memoryVault.keys()].map((account) => ({ account, password: memoryVault.get(account) ?? "" }))
    : await keytar.findCredentials(SERVICE);
  envKeyCache = creds
    .map((c) => c.account)
    .filter((a) => a.startsWith(ENV_PREFIX))
    .map((a) => a.slice(ENV_PREFIX.length));
  return envKeyCache;
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
