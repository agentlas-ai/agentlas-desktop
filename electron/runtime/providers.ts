// 모델 목록 동적 동기화 — 하드코딩 대신 실제 소스에서 가져온다.
//   - BYOK: 각 provider의 /models 엔드포인트를 사용자 키로 조회
//   - 실패/무키: 빈 목록 + UI의 manual model ID 입력 (버전 ID를 앱에 고정하지 않음)
// 5분 메모리 캐시 — detect/picker가 자주 호출해도 네트워크는 가끔만.
import { apiKeyPresenceHint, getCredentialStateRevision, readApiKey } from "../secrets/vault";
import { getDb } from "../store/db";
import {
  BYOK_BACKENDS_ALL,
  BYOK_MODELS,
  cliModels,
  type ByokBackend,
  type CliModelOption,
} from "../../shared/models";

type ModelOption = CliModelOption;

const TTL_MS = 5 * 60 * 1000;
export interface ByokModelDiscovery {
  backend: ByokBackend;
  credentialRevision: number;
  customEndpoint: string | null;
  models: ModelOption[];
  /** Only provider-confirmed conversational models; opaque /models IDs are display inventory. */
  chatModels: string[];
  status: "ok" | "failed" | "unsupported";
  reason?: string;
  stale: boolean;
  at: number;
}
const cache = new Map<ByokBackend, ByokModelDiscovery>();
const flights = new Map<ByokBackend, { identity: string; promise: Promise<ByokModelDiscovery> }>();
let cacheGeneration = 0;

/*
 * ★keychain_unavailable is a fact about the credential store, not about this
 *   poll. The renderer asks for every listed BYOK runtime's models on a 5-min
 *   TTL, and this cache expired on the same TTL, so one failed store produced
 *   11 warnings every 5 minutes for as long as the app ran (94 rounds x 11
 *   providers = 1,034 lines in main.log 2026-09-24..26), each round re-entering
 *   the vault. A failure is now remembered per provider: a latched failure
 *   ("automatic retry suppressed") waits until credential state actually
 *   changes (save/delete/user retry/any successful native read); other
 *   keychain failures back off 5m -> 10m -> ... -> 1h. It is logged once per
 *   distinct failure, not once per poll.
 */
const KEYCHAIN_BACKOFF_MAX_MS = 60 * 60 * 1000;
type KeychainFailure = { until: number; streak: number; revision: number; signature: string };
const keychainFailures = new Map<ByokBackend, KeychainFailure>();

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
    return await fetch(url, { ...init, signal: ctrl.signal, redirect: "error" });
  } finally {
    clearTimeout(timer);
  }
}

// ── provider별 /models 조회 ───────────────────────────────
const MAX_MODEL_PAGES = 50;

async function fetchAnthropic(key: string): Promise<ModelOption[]> {
  const models: ModelOption[] = [];
  const cursors = new Set<string>();
  let after: string | undefined;
  for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
    const url = new URL("https://api.anthropic.com/v1/models");
    url.searchParams.set("limit", "100");
    if (after) url.searchParams.set("after_id", after);
    const res = await fetchWithTimeout(url.href, {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    });
    if (!res.ok) throw new Error(`http:${res.status}`);
    const json = await res.json() as { data?: ModelOption[]; has_more?: boolean; last_id?: string };
    if (!Array.isArray(json.data)) throw new Error("invalid-response");
    models.push(...json.data.map((row: ModelOption & { display_name?: string }) => ({ id: row.id, label: row.display_name || row.id })));
    if (!json.has_more) return models;
    if (typeof json.last_id !== "string" || !json.last_id || cursors.has(json.last_id)) throw new Error("pagination-invalid");
    after = json.last_id;
    cursors.add(after);
  }
  throw new Error("pagination-limit");
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

function safeBaseUrl(base: string): string | null {
  try {
    const url = new URL(base);
    const host = url.hostname.toLowerCase();
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(host);
    const privateLan = /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && (loopback || privateLan)))
      || url.username || url.password || url.search || url.hash) return null;
    return url.href.replace(/\/$/, "");
  } catch { return null; }
}

async function fetchOpenAICompatible(baseUrl: string, key: string): Promise<ModelOption[]> {
  const base = safeBaseUrl(baseUrl);
  if (!base) throw new Error("invalid-endpoint");
  const res = await fetchWithTimeout(`${base}/models`, { headers: { authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`http:${res.status}`);
  const json = await res.json() as {
    data?: Array<{ id?: string; name?: string; display_name?: string }>;
    models?: Array<{ id?: string; name?: string; display_name?: string }>;
  };
  const rows = json.data ?? json.models;
  if (!Array.isArray(rows)) throw new Error("invalid-response");
  return rows.filter((model): model is { id: string; name?: string; display_name?: string } => typeof model?.id === "string")
    .map((model) => ({ id: model.id, label: model.display_name || model.name || model.id }));
}

async function fetchGoogle(key: string): Promise<ModelOption[]> {
  const models: ModelOption[] = [];
  const tokens = new Set<string>();
  let token: string | undefined;
  for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
    const url = new URL("https://generativelanguage.googleapis.com/v1beta/models");
    url.searchParams.set("pageSize", "200");
    if (token) url.searchParams.set("pageToken", token);
    const res = await fetchWithTimeout(url.href, { headers: { "x-goog-api-key": key } });
    if (!res.ok) throw new Error(`http:${res.status}`);
    const json = await res.json() as {
      models?: Array<{ name?: string; displayName?: string; supportedGenerationMethods?: string[] }>;
      nextPageToken?: string;
    };
    if (!Array.isArray(json.models)) throw new Error("invalid-response");
    models.push(...json.models.filter((row) => Array.isArray(row?.supportedGenerationMethods)
      && row.supportedGenerationMethods.includes("generateContent") && typeof row.name === "string")
      .map((row) => ({ id: row.name!.replace(/^models\//, ""), label: row.displayName || row.name!.replace(/^models\//, "") })));
    if (!json.nextPageToken) return models;
    if (typeof json.nextPageToken !== "string" || tokens.has(json.nextPageToken)) throw new Error("pagination-invalid");
    token = json.nextPageToken;
    tokens.add(token);
  }
  throw new Error("pagination-limit");
}

function discoveryIdentity(backend: ByokBackend): Pick<ByokModelDiscovery, "backend" | "credentialRevision" | "customEndpoint"> {
  return { backend, credentialRevision: getCredentialStateRevision(),
    customEndpoint: backend === "custom" ? safeBaseUrl(customBaseUrl() ?? "https://api.openai.com/v1") : null };
}

function sameIdentity(a: ReturnType<typeof discoveryIdentity>, b: ReturnType<typeof discoveryIdentity>): boolean {
  return a.backend === b.backend && a.credentialRevision === b.credentialRevision && a.customEndpoint === b.customEndpoint;
}

function cloneDiscovery(value: ByokModelDiscovery): ByokModelDiscovery {
  return { ...value, models: value.models.map(model => ({ ...model })), chatModels: [...value.chatModels] };
}

/** Local cache identity, checked before detect/picker reuse; never contains credential material. */
export function byokDiscoveryIdentity(): string {
  return JSON.stringify([getCredentialStateRevision(), safeBaseUrl(customBaseUrl() ?? "https://api.openai.com/v1")]);
}

async function discoverByokModels(backend: ByokBackend, now: number): Promise<ByokModelDiscovery> {
  let identity = discoveryIdentity(backend);
  const hit = cache.get(backend);
  const previous = hit && sameIdentity(hit, identity) ? hit : undefined;
  if (previous && now - previous.at < TTL_MS) return cloneDiscovery(previous);
  const generation = cacheGeneration;
  const result = (status: ByokModelDiscovery["status"], reason: string | undefined, models: ModelOption[] = [], stale = false): ByokModelDiscovery => {
    const value: ByokModelDiscovery = { ...identity, status, reason, models, stale, at: now,
      chatModels: backend === "anthropic" || backend === "google" ? models.map(model => model.id) : [] };
    // A key/endpoint change during an in-flight request must not return or cache old inventory.
    if (generation !== cacheGeneration || !sameIdentity(identity, discoveryIdentity(backend))) {
      return { ...discoveryIdentity(backend), status: "failed", reason: "identity-changed", models: [], chatModels: [], stale: false, at: now };
    }
    cache.set(backend, value);
    return cloneDiscovery(value);
  };
  const failed = (reason: string): ByokModelDiscovery => {
    const retained = previous && sameIdentity(previous, identity) ? previous.models : [];
    return result("failed", reason, retained, retained.length > 0);
  };
  const failure = keychainFailures.get(backend);
  if (failure && failure.revision === identity.credentialRevision && now < failure.until) return failed("keychain_unavailable");
  if (apiKeyPresenceHint(backend) === "missing") {
    keychainFailures.delete(backend);
    return result("unsupported", "missing-key");
  }
  if (backend === "custom" && !identity.customEndpoint) return result("unsupported", "invalid-endpoint");
  let keyRead = false;
  try {
    const key = await readApiKey(backend);
    keyRead = true;
    keychainFailures.delete(backend);
    // A successful native keychain read itself advances the vault revision.
    const afterRead = discoveryIdentity(backend);
    if (afterRead.customEndpoint !== identity.customEndpoint) return failed("identity-changed");
    identity = afterRead;
    if (!key) return result("unsupported", "missing-key");
    const rows = backend === "anthropic" ? await fetchAnthropic(key)
      : backend === "google" ? await fetchGoogle(key)
      : await fetchOpenAICompatible(backend === "custom" ? identity.customEndpoint! : OPENAI_COMPAT_BASE_URL[backend] ?? "", key);
    const models = [...new Map(rows.filter(row => typeof row?.id === "string" && row.id.trim())
      .map(row => [row.id.trim(), { id: row.id.trim(), label: typeof row.label === "string" && row.label.trim() ? row.label.trim() : row.id.trim() }])).values()];
    return result("ok", models.length ? undefined : "empty-inventory", models);
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? (err as { code?: unknown }).code : undefined;
    if (!keyRead && code === "keychain_unavailable") {
      const suppressed = (err as { automaticRetrySuppressed?: unknown }).automaticRetrySuppressed === true;
      const signature = suppressed ? "keychain_unavailable:latched" : "keychain_unavailable";
      const streak = failure?.revision === identity.credentialRevision ? failure.streak + 1 : 1;
      const until = suppressed ? Number.POSITIVE_INFINITY : now + Math.min(TTL_MS * 2 ** Math.min(streak - 1, 10), KEYCHAIN_BACKOFF_MAX_MS);
      if (failure?.signature !== signature || failure.revision !== identity.credentialRevision) {
        console.warn(`[providers] ${backend} discovery: ${signature}; manual model selection remains available`);
      }
      keychainFailures.set(backend, { until, streak, revision: identity.credentialRevision, signature });
      return failed("keychain_unavailable");
    }
    // Provider errors can contain credentials or endpoint details; expose only bounded machine reasons.
    const message = err instanceof Error ? err.message : "";
    const reason = /^(http:\d{3}|invalid-response|pagination-invalid|pagination-limit|invalid-endpoint)$/.test(message)
      ? message : keyRead ? "discovery-failed" : "credential-read-failed";
    console.warn(`[providers] ${backend} discovery: ${reason}; manual model selection remains available`);
    return failed(reason);
  }
}

export async function fetchByokModelDiscovery(backend: ByokBackend, now: number): Promise<ByokModelDiscovery> {
  const identity = JSON.stringify(discoveryIdentity(backend));
  const pending = flights.get(backend);
  if (pending?.identity === identity) return cloneDiscovery(await pending.promise);
  const flight = { identity, promise: discoverByokModels(backend, now) };
  flights.set(backend, flight);
  try { return cloneDiscovery(await flight.promise); }
  finally { if (flights.get(backend) === flight) flights.delete(backend); }
}

/** Public picker contract stays an array. Discovery status and identity remain internal. */
export async function fetchByokModels(backend: ByokBackend, now: number): Promise<ModelOption[]> {
  return (await fetchByokModelDiscovery(backend, now)).models;
}

/**
 * 런타임의 모델 옵션 목록 (picker용).
 *   - byok: provider 실시간 조회 (실패 시 같은 자격의 last-good 또는 빈 목록)
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
  cacheGeneration += 1;
  cache.clear();
  flights.clear();
  keychainFailures.clear();
}

export { BYOK_MODELS };
