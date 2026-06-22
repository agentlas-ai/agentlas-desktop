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
import type { RuntimeBackend } from "../../shared/types";

const SERVICE = "com.agentlas.desktop";
const BYOK_PREFIX = "byok:";
const ENV_PREFIX = "env:";

// ── BYOK LLM API ────────────────────────────────────────────
function byokAccount(backend: RuntimeBackend): string {
  return `${BYOK_PREFIX}${backend}`;
}

export async function saveApiKey(backend: RuntimeBackend, key: string): Promise<void> {
  const trimmed = key.trim();
  if (!trimmed) {
    await keytar.deletePassword(SERVICE, byokAccount(backend));
    return;
  }
  await keytar.setPassword(SERVICE, byokAccount(backend), trimmed);
}

export async function hasApiKey(backend: RuntimeBackend): Promise<boolean> {
  const v = await keytar.getPassword(SERVICE, byokAccount(backend));
  return typeof v === "string" && v.length > 0;
}

export async function deleteApiKey(backend: RuntimeBackend): Promise<void> {
  await keytar.deletePassword(SERVICE, byokAccount(backend));
}

/** main 내부 사용 — MCP 호출 시 자식 env에 주입. renderer 노출 X */
export async function readApiKey(backend: RuntimeBackend): Promise<string | null> {
  return keytar.getPassword(SERVICE, byokAccount(backend));
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
    await keytar.deletePassword(SERVICE, envAccount(trimmedKey));
    return;
  }
  await keytar.setPassword(SERVICE, envAccount(trimmedKey), trimmedValue);
}

export async function hasEnvVar(key: string): Promise<boolean> {
  const v = await keytar.getPassword(SERVICE, envAccount(key));
  return typeof v === "string" && v.length > 0;
}

export async function deleteEnvVar(key: string): Promise<void> {
  await keytar.deletePassword(SERVICE, envAccount(key));
}

/** main 내부 — MCP 서버 spawn 시 envRequirements 매칭해 자식 env로 주입 (M1) */
export async function readEnvVar(key: string): Promise<string | null> {
  return keytar.getPassword(SERVICE, envAccount(key));
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
  const v = await keytar.getPassword(SERVICE, envAccount(key));
  if (typeof v !== "string" || v.length === 0) return null;
  return maskSecret(v);
}

/** keychain에 저장된 env 키 전체 — keytar.findCredentials로 prefix filter */
export async function listEnvKeys(): Promise<string[]> {
  const creds = await keytar.findCredentials(SERVICE);
  return creds
    .map((c) => c.account)
    .filter((a) => a.startsWith(ENV_PREFIX))
    .map((a) => a.slice(ENV_PREFIX.length));
}
