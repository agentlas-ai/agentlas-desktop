// CLI 자동 감지 통합 + 활성 백엔드 선택 상태 관리.
// PRD 3.1 FRE 6단계 — 사용자가 입력 안 해도 한 번 클릭으로 연결되도록.
import { probeClaudeCode, probeClaudeEfforts } from "./claude-code";
import { probeCodex } from "./codex";
import { probeGemini } from "./gemini";
import { probeGrok } from "./grok";
import { probeOllama } from "./ollama";
import { hasApiKey } from "../secrets/vault";
import { getDb } from "../store/db";
import type {
  RuntimeBackend,
  RuntimeKind,
  RuntimeSelection,
  RuntimeStatus,
} from "../../shared/types";
import { byokModels, cliModels, defaultByokModel, findByokModel } from "../../shared/models";

type ActiveRuntimeRow = {
  kind: RuntimeKind;
  backend: RuntimeBackend | null;
  source: string | null;
  model: string | null;
  long_context: number;
};

let detectCache: { at: number; list: RuntimeStatus[] } | null = null;
let detectInFlight: Promise<RuntimeStatus[]> | null = null;

function runtimeDetectCacheMs(): number {
  return Number(process.env.AGENTLAS_RUNTIME_DETECT_CACHE_MS ?? 10_000);
}

function cloneRuntimeStatuses(list: RuntimeStatus[]): RuntimeStatus[] {
  return list.map((runtime) => ({
    ...runtime,
    availableModels: runtime.availableModels ? [...runtime.availableModels] : runtime.availableModels,
    efforts: runtime.efforts ? runtime.efforts.map((effort) => ({ ...effort })) : runtime.efforts,
  }));
}

/** 감지 캐시 무효화 — 활성 런타임 변경·CLI 재로그인 직후 등 "연결" 칩이 낡으면 안 되는 시점에 호출. */
export function clearDetectCache(): void {
  detectCache = null;
}

/** BYOK 백엔드의 활성 모델 — 저장된 선택이 카탈로그에 있으면 그대로, 아니면 기본값. */
function byokModelOf(backend: RuntimeBackend, active: ActiveRuntimeRow | null): string | undefined {
  if (active?.kind === "byok" && active.backend === backend && findByokModel(backend, active.model)) {
    return active.model ?? undefined;
  }
  return defaultByokModel(backend);
}

/** BYOK 1M 토글 상태 — 활성 백엔드일 때만 저장값 반영, 그 외엔 off. */
function byokLongOf(backend: RuntimeBackend, active: ActiveRuntimeRow | null): boolean {
  return !!(active?.kind === "byok" && active.backend === backend && active.long_context);
}

/** CLI 런타임의 활성 모델 — 저장된 선택이 카탈로그에 있으면 그대로, 아니면 undefined(구독 기본). */
function cliModelOf(kind: RuntimeKind, active: ActiveRuntimeRow | null): string | undefined {
  const opts = cliModels(kind);
  if (active?.kind === kind && active.model && opts.some((o) => o.id === active.model)) {
    return active.model;
  }
  return undefined;
}

// 작업량(effort) 영속 — active_runtime 컬럼 추가(마이그레이션) 대신 meta(key/value) 테이블 사용.
// 동시 편집 중인 스키마와 충돌하지 않게 무-마이그레이션으로 처리.
function getStoredEffort(): string | null {
  try {
    const row = getDb()
      .prepare("SELECT value FROM meta WHERE key = 'claude_effort'")
      .get() as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}
function setStoredEffort(effort: string | null | undefined): void {
  try {
    const db = getDb();
    if (effort && effort.trim()) {
      db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('claude_effort', ?)").run(
        effort.trim(),
      );
    } else {
      db.prepare("DELETE FROM meta WHERE key = 'claude_effort'").run();
    }
  } catch {
    // meta 테이블이 아직 없으면(구버전 DB) 무시 — 작업량 미설정으로 동작.
  }
}

function isActiveRuntime(status: RuntimeStatus, active: ActiveRuntimeRow | null): boolean {
  if (!active) return false;
  // ollama는 단일 런타임 — kind만 맞으면 활성. 모델은 status.model로 따로 반영.
  if (status.kind === "ollama") return active.kind === "ollama";
  if (active.source) {
    return (
      status.kind === active.kind &&
      status.backend === active.backend &&
      status.source === active.source
    );
  }
  if (active.backend) {
    return status.kind === active.kind && status.backend === active.backend;
  }
  return status.kind === active.kind;
}

function saveActiveRuntime(status: RuntimeStatus | RuntimeSelection): void {
  // RuntimeSelection(longContext)과 RuntimeStatus(longContextEnabled) 양쪽에서 1M 토글을 읽는다.
  const longCtx =
    ("longContext" in status ? status.longContext : undefined) ??
    ("longContextEnabled" in status ? status.longContextEnabled : undefined) ??
    false;
  getDb()
    .prepare(
      "INSERT OR REPLACE INTO active_runtime(id, kind, backend, source, model, long_context) VALUES (1, ?, ?, ?, ?, ?)",
    )
    .run(
      status.kind,
      status.backend ?? null,
      status.source ?? null,
      status.model ?? null,
      longCtx ? 1 : 0,
    );
}

/**
 * 모든 런타임을 병렬로 감지. 메인 프로세스에서만 호출.
 * - 로컬 CLI 3종 + BYOK API 키 3종 = 최대 6개 후보 반환
 */
export async function detectRuntimes(): Promise<RuntimeStatus[]> {
  if (process.env.AGENTLAS_DISABLE_RUNTIME_PROBES === "1") return [];
  const now = Date.now();
  if (detectCache && now - detectCache.at < runtimeDetectCacheMs()) {
    return cloneRuntimeStatuses(detectCache.list);
  }
  if (detectInFlight) return cloneRuntimeStatuses(await detectInFlight);

  detectInFlight = detectRuntimesUncached();
  try {
    const list = await detectInFlight;
    detectCache = { at: Date.now(), list: cloneRuntimeStatuses(list) };
    return cloneRuntimeStatuses(list);
  } finally {
    detectInFlight = null;
  }
}

async function detectRuntimesUncached(): Promise<RuntimeStatus[]> {
  const db = getDb();
  const activeRow = db
    .prepare("SELECT kind, backend, source, model, long_context FROM active_runtime WHERE id = 1")
    .get() as ActiveRuntimeRow | undefined;
  const active = activeRow ?? null;

  const [
    cc,
    cx,
    gm,
    gr,
    ollama,
    anthropicByok,
    openaiByok,
    googleByok,
    glmByok,
    kimiByok,
    deepseekByok,
    claudeEfforts,
  ] = await Promise.all([
    probeClaudeCode(),
    probeCodex(),
    probeGemini(),
    probeGrok(),
    probeOllama(),
    hasApiKey("anthropic"),
    hasApiKey("openai"),
    hasApiKey("google"),
    hasApiKey("glm"),
    hasApiKey("kimi"),
    hasApiKey("deepseek"),
    probeClaudeEfforts(),
  ]);

  const list: RuntimeStatus[] = [];

  if (cc) {
    list.push({
      kind: "claude-code",
      backend: "anthropic",
      source: cc.path,
      version: cc.version,
      active: false,
      // 컨텍스트는 CLI가 자동 관리하지만 모델은 --model로 선택 가능 (opus/sonnet/haiku).
      model: cliModelOf("claude-code", active),
      availableModels: cliModels("claude-code").map((m) => m.id),
      // 작업량 — 현재 선택값 + 이 CLI가 지원하는 레벨(--help 파싱으로 자동 동기화).
      effort: getStoredEffort(),
      efforts: claudeEfforts,
    });
  }
  if (cx) {
    list.push({
      kind: "codex",
      backend: "openai",
      source: cx.path,
      version: cx.version,
      active: false,
    });
  }
  if (gm) {
    list.push({
      kind: "gemini",
      backend: "google",
      source: gm.path,
      version: gm.version,
      active: false,
    });
  }
  if (gr) {
    // 모델: `grok models` 라이브 목록 우선(새 모델 자동 반영) → 없으면 정적 카탈로그로 폴백.
    const grokModels = gr.models.length > 0 ? gr.models : cliModels("grok").map((m) => m.id);
    const storedGrok =
      active?.kind === "grok" && active.model && grokModels.includes(active.model)
        ? active.model
        : undefined;
    list.push({
      kind: "grok",
      backend: "custom",
      source: gr.path,
      version: gr.version,
      active: false,
      model: storedGrok ?? grokModels[0],
      availableModels: grokModels,
    });
  }
  if (ollama) {
    // 활성 모델: 이전에 고른 모델이 아직 존재하면 그대로, 아니면 첫 모델로 폴백.
    const preferred =
      active?.kind === "ollama" && active.model && ollama.models.includes(active.model)
        ? active.model
        : ollama.models[0] ?? null;
    list.push({
      kind: "ollama",
      backend: "ollama",
      source: "ollama",
      version: ollama.version,
      active: false,
      model: preferred,
      availableModels: ollama.models,
    });
  }
  if (anthropicByok) {
    list.push({
      kind: "byok",
      backend: "anthropic",
      source: "byok:anthropic",
      version: null,
      active: false,
      model: byokModelOf("anthropic", active),
      availableModels: byokModels("anthropic").map((m) => m.id),
      longContextEnabled: byokLongOf("anthropic", active),
    });
  }
  if (openaiByok) {
    list.push({
      kind: "byok",
      backend: "openai",
      source: "byok:openai",
      version: null,
      active: false,
      model: byokModelOf("openai", active),
      availableModels: byokModels("openai").map((m) => m.id),
      longContextEnabled: byokLongOf("openai", active),
    });
  }
  if (googleByok) {
    list.push({
      kind: "byok",
      backend: "google",
      source: "byok:google",
      version: null,
      active: false,
      model: byokModelOf("google", active),
      availableModels: byokModels("google").map((m) => m.id),
      longContextEnabled: byokLongOf("google", active),
    });
  }

  // Anthropic 호환 서드파티(GLM/Kimi/DeepSeek) — 키가 저장돼 있으면 엔진으로 노출. base URL은 프리셋 자동.
  const compatFlags: Record<"glm" | "kimi" | "deepseek", boolean> = {
    glm: glmByok,
    kimi: kimiByok,
    deepseek: deepseekByok,
  };
  for (const backend of ["glm", "kimi", "deepseek"] as const) {
    if (!compatFlags[backend]) continue;
    list.push({
      kind: "byok",
      backend,
      source: `byok:${backend}`,
      version: null,
      active: false,
      model: byokModelOf(backend, active),
      availableModels: byokModels(backend).map((m) => m.id),
      longContextEnabled: byokLongOf(backend, active),
    });
  }

  let activeAssigned = false;
  for (const runtime of list) {
    const matchesActive = isActiveRuntime(runtime, active);
    runtime.active = matchesActive && !activeAssigned;
    if (runtime.active) activeAssigned = true;
  }

  // 활성 백엔드 없으면 첫 후보를 자동 활성 — FRE 마찰 0
  if (!list.some((runtime) => runtime.active) && list.length > 0) {
    list[0].active = true;
    saveActiveRuntime(list[0]);
  }

  return list;
}

export async function setActiveRuntime(selection: RuntimeSelection): Promise<RuntimeStatus[]> {
  saveActiveRuntime(selection);
  // effort가 명시된 경우에만 갱신 — 모델만 바꾸는 호출은 기존 작업량을 유지.
  if (selection.effort !== undefined) setStoredEffort(selection.effort);
  clearDetectCache();
  return detectRuntimes();
}
