// 모델 목록 동적 동기화 — 하드코딩 대신 실제 소스에서 가져온다.
//   - BYOK: 각 provider의 /models 엔드포인트를 사용자 키로 조회
//   - 실패/무키: 빈 목록 + UI의 manual model ID 입력 (버전 ID를 앱에 고정하지 않음)
// 5분 메모리 캐시 — detect/picker가 자주 호출해도 네트워크는 가끔만.
import { readApiKey } from "../secrets/vault";
import { getDb } from "../store/db";
import {
  BYOK_BACKENDS_ALL,
  BYOK_MODELS,
  byokModels,
  cliModels,
  type ByokBackend,
  type CliModelOption,
} from "../../shared/models";

type ModelOption = CliModelOption;

const TTL_MS = 5 * 60 * 1000;
const cache = new Map<ByokBackend, { at: number; models: ModelOption[] }>();

const BYOK_BACKENDS: readonly ByokBackend[] = BYOK_BACKENDS_ALL;

const OPENAI_COMPAT_BASE_URL: Partial<Record<ByokBackend, string>> = {
  openai: "https://api.openai.com/v1",
  upstage: "https://api.upstage.ai/v1",
  glm: "https://api.z.ai/api/paas/v4",
  kimi: "https://api.moonshot.ai/v1",
  deepseek: "https://api.deepseek.com",
  minimax: "https://api.minimax.io/v1",
  xai: "https://api.x.ai/v1",
  openrouter: "https://openrouter.ai/api/v1",
};

function isByok(backend: string): backend is ByokBackend {
  return (BYOK_BACKENDS as readonly string[]).includes(backend);
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

function customBaseUrl(): string | null {
  try {
    const row = getDb().prepare("SELECT value FROM meta WHERE key = 'custom_base_url'").get() as
      | { value?: string }
      | undefined;
    return row?.value?.trim().replace(/\/$/, "") || null;
  } catch {
    return null;
  }
}

async function fetchOpenAICompatible(baseUrl: string, key: string): Promise<ModelOption[]> {
  const res = await fetchWithTimeout(`${baseUrl.replace(/\/$/, "")}/models`, {
    headers: { authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`models endpoint returned HTTP ${res.status}`);
  const json = (await res.json()) as {
    data?: Array<{ id?: string; name?: string; display_name?: string }>;
    models?: Array<{ id?: string; name?: string; display_name?: string }>;
  };
  const rows = json.data ?? json.models ?? [];
  return rows
    .filter((model): model is { id: string; name?: string; display_name?: string } =>
      typeof model.id === "string" && model.id.trim().length > 0,
    )
    .map((model) => ({
      id: model.id,
      label: model.display_name?.trim() || model.name?.trim() || model.id,
    }));
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
    .filter((m) => m.id);
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
          : backend === "google"
            ? await fetchGoogle(key)
            : await fetchOpenAICompatible(
                backend === "custom" ? customBaseUrl() ?? "" : OPENAI_COMPAT_BASE_URL[backend] ?? "",
                key,
              );
    }
  } catch (err) {
    // 실시간 조회 실패를 조용히 삼키지 않는다. UI는 manual ID 입력을 계속 제공한다.
    console.warn(
      `[providers] live ${backend} model fetch failed; manual model selection remains available:`,
      err instanceof Error ? err.message : err,
    );
  }
  if (models.length === 0) models = byokModels(backend).map((m) => ({ id: m.id, label: m.label }));
  cache.set(backend, { at: now, models });
  return models;
}

/**
 * 런타임의 모델 옵션 목록 (picker용).
 *   - byok: provider 실시간 조회 (fallback = 카탈로그)
 *   - ollama: 호출부가 넘긴 availableModels
 *   - CLI: 설치된 CLI가 발견한 목록을 우선한다.
 *     정적 카탈로그는 label/tag 보강과 탐색 실패 시 fallback으로만 사용한다.
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
  const catalog = cliModels(kind);
  const catalogById = new Map(catalog.map((model) => [model.id, model] as const));
  const discoveredIds = [...new Set(availableModels ?? [])];
  if (discoveredIds.length === 0) return catalog;
  return discoveredIds.map((id) => catalogById.get(id) ?? { id, label: id });
}

/** 디버그/테스트용 — 캐시 비우기. */
export function clearModelCache(): void {
  cache.clear();
}

export { BYOK_MODELS };
