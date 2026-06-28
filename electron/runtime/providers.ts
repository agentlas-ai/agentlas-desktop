// 모델 목록 동적 동기화 — 하드코딩 대신 실제 소스에서 가져온다.
//   - BYOK: 각 provider의 /models 엔드포인트를 사용자 키로 조회 (Anthropic/OpenAI/Google)
//   - 실패/무키: shared/models.ts의 카탈로그로 fallback
// 5분 메모리 캐시 — detect/picker가 자주 호출해도 네트워크는 가끔만.
import { readApiKey } from "../secrets/vault";
import {
  BYOK_MODELS,
  byokModels,
  cliModels,
  type ByokBackend,
  type CliModelOption,
} from "../../shared/models";

type ModelOption = CliModelOption;

const TTL_MS = 5 * 60 * 1000;
const cache = new Map<ByokBackend, { at: number; models: ModelOption[] }>();

function isByok(backend: string): backend is ByokBackend {
  return backend === "anthropic" || backend === "openai" || backend === "google";
}

async function fetchWithTimeout(url: string, init: RequestInit, ms = 4000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── provider별 /models 조회 ───────────────────────────────
async function fetchAnthropic(key: string): Promise<ModelOption[]> {
  const res = await fetchWithTimeout("https://api.anthropic.com/v1/models?limit=100", {
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
  });
  if (!res.ok) throw new Error(`models endpoint returned HTTP ${res.status}`);
  const json = (await res.json()) as { data?: Array<{ id?: string; display_name?: string }> };
  return (json.data ?? [])
    .filter((m): m is { id: string; display_name?: string } => typeof m.id === "string")
    .map((m) => ({ id: m.id, label: m.display_name ?? m.id }));
}

async function fetchOpenAI(key: string): Promise<ModelOption[]> {
  const res = await fetchWithTimeout("https://api.openai.com/v1/models", {
    headers: { authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`models endpoint returned HTTP ${res.status}`);
  const json = (await res.json()) as { data?: Array<{ id?: string }> };
  return (json.data ?? [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === "string")
    // 채팅 가능한 모델만 — 임베딩/오디오/이미지 모델 제외.
    .filter((id) => /^(gpt-|o\d|chatgpt)/.test(id) && !/(embedding|whisper|tts|audio|image|dall-e|moderation|realtime|transcribe)/.test(id))
    .sort()
    .map((id) => ({ id, label: id }));
}

async function fetchGoogle(key: string): Promise<ModelOption[]> {
  const res = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(key)}`,
    {},
  );
  if (!res.ok) throw new Error(`models endpoint returned HTTP ${res.status}`);
  const json = (await res.json()) as {
    models?: Array<{ name?: string; displayName?: string; supportedGenerationMethods?: string[] }>;
  };
  return (json.models ?? [])
    .filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
    .map((m) => ({ id: (m.name ?? "").replace(/^models\//, ""), label: m.displayName || (m.name ?? "").replace(/^models\//, "") }))
    .filter((m) => m.id && m.id.includes("gemini"));
}

/** BYOK 백엔드의 실제 모델 목록 — provider API 조회(키 필요), 실패 시 카탈로그 fallback. now는 캐시 TTL용. */
export async function fetchByokModels(backend: ByokBackend, now: number): Promise<ModelOption[]> {
  const hit = cache.get(backend);
  if (hit && now - hit.at < TTL_MS) return hit.models;

  let models: ModelOption[] = [];
  try {
    const key = await readApiKey(backend);
    if (key) {
      models =
        backend === "anthropic"
          ? await fetchAnthropic(key)
          : backend === "openai"
            ? await fetchOpenAI(key)
            : await fetchGoogle(key);
    }
  } catch (err) {
    // 실시간 조회 실패를 조용히 삼키지 않는다 — 카탈로그로 표시하더라도 이유를 로그로 남겨
    // "라이브 목록인 줄 알고 넘어가는" 일을 막는다.
    console.warn(
      `[providers] live ${backend} model fetch failed; falling back to built-in catalog:`,
      err instanceof Error ? err.message : err,
    );
  }
  if (models.length === 0) {
    models = byokModels(backend).map((m) => ({ id: m.id, label: m.label }));
  }
  cache.set(backend, { at: now, models });
  return models;
}

/**
 * 런타임의 모델 옵션 목록 (picker용).
 *   - byok: provider 실시간 조회 (fallback = 카탈로그)
 *   - ollama: 호출부가 넘긴 availableModels
 *   - CLI: 카탈로그(별칭은 항상 최신이라 동기화 불필요) + 호출부가 넘긴 동적분
 */
export async function listRuntimeModels(
  kind: string,
  backend: string | null | undefined,
  availableModels: string[] | null | undefined,
  now: number,
): Promise<ModelOption[]> {
  if (kind === "byok" && backend && isByok(backend)) {
    return fetchByokModels(backend, now);
  }
  if (kind === "ollama") {
    return (availableModels ?? []).map((m) => ({ id: m, label: m }));
  }
  return cliModels(kind);
}

/** 디버그/테스트용 — 캐시 비우기. */
export function clearModelCache(): void {
  cache.clear();
}

export { BYOK_MODELS };
