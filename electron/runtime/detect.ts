// CLI 자동 감지 통합 + 활성 백엔드 선택 상태 관리.
// PRD 3.1 FRE 6단계 — 사용자가 입력 안 해도 한 번 클릭으로 연결되도록.
import { probeClaudeCode, probeClaudeEfforts } from "./claude-code";
import { probeCodex } from "./codex";
import { readCodexModelInventory } from "./codex-models";
import { probeGemini } from "./gemini";
import { probeKimi } from "./kimi";
import { probeGrok } from "./grok";
import { probeCursor } from "./cursor";
import { probeOllama } from "./ollama";
import { probeLMStudio } from "./lmstudio";
import { probeMLX } from "./mlx";
import { hasApiKey } from "../secrets/vault";
import { getDb } from "../store/db";
import { listResolvedModelRoles, setModelRole } from "../store/model-roles";
import type {
  RuntimeBackend,
  RuntimeKind,
  RuntimeSelection,
  RuntimeStatus,
} from "../../shared/types";
import { byokModels, cliModels, defaultByokModel } from "../../shared/models";
import { recallRuntimeSelection, rememberRuntimeSelection } from "./selection-memory";
import { clearCliVersionProbeCache } from "./exec";

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
    allocationModels: runtime.allocationModels ? [...runtime.allocationModels] : runtime.allocationModels,
    allocationModelProfiles: runtime.allocationModelProfiles
      ? Object.fromEntries(Object.entries(runtime.allocationModelProfiles).map(([modelId, profile]) => [
        modelId,
        {
          ...profile,
          capabilities: profile.capabilities ? [...profile.capabilities] : profile.capabilities,
          efforts: profile.efforts ? [...profile.efforts] : profile.efforts,
        },
      ]))
      : runtime.allocationModelProfiles,
    activeRoles: runtime.activeRoles ? [...runtime.activeRoles] : runtime.activeRoles,
    roleSelections: runtime.roleSelections
      ? Object.fromEntries(
          Object.entries(runtime.roleSelections).map(([role, selection]) => [
            role,
            selection ? { ...selection } : selection,
          ]),
        )
      : runtime.roleSelections,
    efforts: runtime.efforts ? runtime.efforts.map((effort) => ({ ...effort })) : runtime.efforts,
  }));
}

const LOCAL_RUNTIME_CONTEXT_WINDOW = 32_000;

/**
 * Local OpenAI-compatible runners expose model IDs but no trustworthy model
 * capability metadata or reasoning-effort control. Advertise only facts the
 * host itself enforces so the parent LLM can author an exactly executable
 * allocation instead of being rejected after planning.
 */
export function conservativeLocalRuntimeAllocation(models: string[]): Pick<
  RuntimeStatus,
  "allocationModels" | "allocationModelProfiles" | "effort" | "efforts"
> {
  const allocationModels = [...new Set(models)];
  return {
    allocationModels,
    allocationModelProfiles: Object.fromEntries(allocationModels.map((modelId) => [
      modelId,
      {
        costTier: "balanced" as const,
        contextWindow: LOCAL_RUNTIME_CONTEXT_WINDOW,
        capabilities: [],
        supportsTools: false,
        supportsMultimodal: false,
        efforts: ["none"],
      },
    ])),
    effort: "none",
    efforts: [{ id: "none", label: "None" }],
  };
}

/** 감지 캐시 무효화 — 활성 런타임 변경·CLI 재로그인 직후 등 "연결" 칩이 낡으면 안 되는 시점에 호출. */
export function clearDetectCache(): void {
  detectCache = null;
}

/**
 * BYOK 백엔드의 활성 모델. Picker는 provider /models의 라이브 ID를 저장할 수 있으므로
 * 정적 카탈로그 포함 여부로 복원을 거부하면 안 된다. 현재 백엔드에 저장된 비어 있지 않은
 * ID는 그대로 복원하고, 사용자가 아직 고른 적이 없을 때만 기본값을 쓴다.
 */
function byokModelOf(backend: RuntimeBackend, active: ActiveRuntimeRow | null): string | undefined {
  if (active?.kind === "byok" && active.backend === backend && active.model) {
    return active.model;
  }
  return recallRuntimeSelection("byok", backend)?.model ?? defaultByokModel(backend);
}

/** BYOK 1M 토글 상태 — 활성 백엔드일 때만 저장값 반영, 그 외엔 off. */
function byokLongOf(backend: RuntimeBackend, active: ActiveRuntimeRow | null): boolean {
  if (active?.kind === "byok" && active.backend === backend) return !!active.long_context;
  return recallRuntimeSelection("byok", backend)?.longContext ?? false;
}

/** CLI 런타임의 활성 모델 — 설치된 CLI가 실제 노출한 목록에 있으면 복원한다. */
function cliModelOf(
  kind: RuntimeKind,
  active: ActiveRuntimeRow | null,
  availableModels = cliModels(kind).map((model) => model.id),
  backend?: RuntimeBackend,
): string | undefined {
  const candidate =
    active?.kind === kind && (!backend || active.backend === backend)
      ? active.model
      : recallRuntimeSelection(kind, backend)?.model;
  return candidate && availableModels.includes(candidate) ? candidate : undefined;
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
  // ollama/lmstudio/mlx는 단일 런타임 — kind만 맞으면 활성. 모델은 status.model로 따로 반영.
  if (status.kind === "ollama" || status.kind === "lmstudio" || status.kind === "mlx") {
    return active.kind === status.kind;
  }
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

function runtimeMatchesSelection(
  status: RuntimeStatus,
  selection: RuntimeSelection,
): boolean {
  return isActiveRuntime(status, {
    kind: selection.kind,
    backend: selection.backend ?? null,
    source: selection.source ?? null,
    model: selection.model ?? null,
    long_context: selection.longContext ? 1 : 0,
  });
}

function saveActiveRuntime(status: RuntimeStatus | RuntimeSelection): void {
  // RuntimeSelection(longContext)과 RuntimeStatus(longContextEnabled) 양쪽에서 1M 토글을 읽는다.
  const longCtx =
    ("longContext" in status ? status.longContext : undefined) ??
    ("longContextEnabled" in status ? status.longContextEnabled : undefined) ??
    false;
  const db = getDb();
  const outgoing = db
    .prepare("SELECT kind, backend, source, model, long_context FROM active_runtime WHERE id = 1")
    .get() as ActiveRuntimeRow | undefined;
  db.transaction(() => {
    // Seed an install that predates per-runtime memory before replacing id=1.
    if (outgoing) {
      rememberRuntimeSelection(
        outgoing.kind,
        outgoing.backend,
        outgoing.model,
        !!outgoing.long_context,
      );
    }
    rememberRuntimeSelection(status.kind, status.backend, status.model, longCtx);
    db.prepare(
      "INSERT OR REPLACE INTO active_runtime(id, kind, backend, source, model, long_context) VALUES (1, ?, ?, ?, ?, ?)",
    ).run(
      status.kind,
      status.backend ?? null,
      status.source ?? null,
      status.model ?? null,
      longCtx ? 1 : 0,
    );
  })();
}

/**
 * 모든 런타임을 병렬로 감지. 메인 프로세스에서만 호출.
 * - 로컬 CLI 3종 + BYOK API 키 3종 = 최대 6개 후보 반환
 */
export async function detectRuntimes(force = false): Promise<RuntimeStatus[]> {
  if (process.env.AGENTLAS_DISABLE_RUNTIME_PROBES === "1") return [];
  if (force) {
    // A normal Dashboard/Sidebar probe may already be running. Reusing it would
    // make the explicit "Run checks" action stale even after cache invalidation.
    // Let that generation settle, then clear both layers again and start (or
    // join) the first post-request generation.
    const previousFlight = detectInFlight;
    if (previousFlight) await previousFlight.catch(() => []);
    clearDetectCache();
    clearCliVersionProbeCache();
  }
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
    codexModelInventory,
    gm,
    kimiCli,
    gr,
    cursor,
    ollama,
    lmstudio,
    mlx,
    anthropicByok,
    openaiByok,
    googleByok,
    glmByok,
    kimiByok,
    deepseekByok,
    minimaxByok,
    xaiByok,
    openrouterByok,
    upstageByok,
    customByok,
    claudeEfforts,
  ] = await Promise.all([
    probeClaudeCode(),
    probeCodex(),
    readCodexModelInventory(),
    probeGemini(),
    probeKimi(),
    probeGrok(),
    probeCursor(),
    probeOllama(),
    probeLMStudio(),
    probeMLX(),
    hasApiKey("anthropic"),
    hasApiKey("openai"),
    hasApiKey("google"),
    hasApiKey("glm"),
    hasApiKey("kimi"),
    hasApiKey("deepseek"),
    hasApiKey("minimax"),
    hasApiKey("xai"),
    hasApiKey("openrouter"),
    hasApiKey("upstage"),
    hasApiKey("custom"),
    probeClaudeEfforts(),
  ]);

  const list: RuntimeStatus[] = [];
  const codexDiscoveredModels = codexModelInventory.map((model) => model.id);
  const codexHostCatalog = new Map(cliModels("codex").map((model) => [model.id, model]));
  const codexModelProfiles: NonNullable<RuntimeStatus["allocationModelProfiles"]> =
    Object.fromEntries(codexModelInventory.map((model) => [
      model.id,
      {
        ...(codexHostCatalog.get(model.id)?.workforceTier
          ? { costTier: codexHostCatalog.get(model.id)!.workforceTier }
          : {}),
        ...(model.contextWindow !== null ? { contextWindow: model.contextWindow } : {}),
        capabilities: [...model.capabilities],
        ...(model.supportsTools !== null ? { supportsTools: model.supportsTools } : {}),
        ...(model.supportsMultimodal !== null
          ? { supportsMultimodal: model.supportsMultimodal }
          : {}),
        ...(model.efforts !== null ? { efforts: [...model.efforts] } : {}),
      },
    ]));

  if (cc) {
    const selectedClaudeModel = cliModelOf("claude-code", active, undefined, "anthropic");
    const claudeHostCatalog = cliModels("claude-code");
    list.push({
      kind: "claude-code",
      backend: "anthropic",
      source: cc.path,
      version: cc.version,
      active: false,
      // 컨텍스트는 CLI가 자동 관리하지만 모델은 --model로 선택 가능 (opus/sonnet/haiku).
      model: selectedClaudeModel,
      availableModels: cliModels("claude-code").map((m) => m.id),
      allocationModels: selectedClaudeModel ? [selectedClaudeModel] : [],
      allocationModelProfiles: Object.fromEntries(claudeHostCatalog.flatMap((model) => (
        model.workforceTier
          ? [[model.id, {
              costTier: model.workforceTier,
              contextWindow: 200_000,
              capabilities: ["tools", "multimodal"],
              supportsTools: true,
              supportsMultimodal: true,
              efforts: claudeEfforts.map((effort) => effort.id),
            }]]
          : []
      ))),
      // 작업량 — 현재 선택값 + 이 CLI가 지원하는 레벨(--help 파싱으로 자동 동기화).
      effort: getStoredEffort(),
      efforts: claudeEfforts,
    });
  }
  if (cx) {
    const codexModels =
      codexDiscoveredModels.length > 0
        ? codexDiscoveredModels
        : cliModels("codex").map((model) => model.id);
    list.push({
      kind: "codex",
      backend: "openai",
      source: cx.path,
      version: cx.version,
      active: false,
      // Codex도 선택 모델을 저장·복원해야 --model이 다음 대화까지 유지된다.
      model: cliModelOf("codex", active, codexModels, "openai"),
      availableModels: codexModels,
      allocationModels: codexDiscoveredModels,
      allocationModelProfiles: codexModelProfiles,
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
  if (kimiCli) {
    list.push({
      kind: "kimi",
      backend: "kimi",
      source: kimiCli.path,
      version: kimiCli.version,
      active: false,
    });
  }
  if (gr) {
    // 모델: `grok models` 라이브 목록 우선(새 모델 자동 반영) → 없으면 정적 카탈로그로 폴백.
    const grokModels = gr.models.length > 0 ? gr.models : cliModels("grok").map((m) => m.id);
    const storedGrok = cliModelOf("grok", active, grokModels, "custom");
    list.push({
      kind: "grok",
      backend: "custom",
      source: gr.path,
      version: gr.version,
      active: false,
      model: storedGrok ?? grokModels[0],
      availableModels: grokModels,
      allocationModels: gr.models,
    });
  }
  if (cursor) {
    // Current Cursor CLI exposes `agent models`; retain Auto as a safe fallback
    // and preserve an operator selection, but never fabricate entitlement from
    // the display catalog when live discovery returned nothing.
    const rememberedCursor =
      (active?.kind === "cursor" && active.backend === "cursor" ? active.model : undefined) ??
      recallRuntimeSelection("cursor", "cursor")?.model;
    const cursorModels = [
      "auto",
      ...(cursor.models ?? []),
      ...(rememberedCursor && rememberedCursor !== "auto" ? [rememberedCursor] : []),
    ].filter((model, index, list) => Boolean(model) && list.indexOf(model) === index);
    list.push({
      kind: "cursor",
      backend: "cursor",
      source: cursor.path,
      version: cursor.version,
      active: false,
      model: cliModelOf("cursor", active, cursorModels, "cursor") ?? "auto",
      availableModels: cursorModels,
      allocationModels: ["auto", ...(cursor.models ?? [])].filter(
        (model, index, models) => models.indexOf(model) === index,
      ),
    });
  }
  if (ollama) {
    // 활성 모델: 이전에 고른 모델이 아직 존재하면 그대로, 아니면 첫 모델로 폴백.
    const rememberedOllama =
      active?.kind === "ollama"
        ? active.model
        : recallRuntimeSelection("ollama", "ollama")?.model;
    const preferred =
      rememberedOllama && ollama.models.includes(rememberedOllama)
        ? rememberedOllama
        : ollama.models[0] ?? null;
    list.push({
      kind: "ollama",
      backend: "ollama",
      source: "ollama",
      version: ollama.version,
      active: false,
      model: preferred,
      availableModels: ollama.models,
      ...conservativeLocalRuntimeAllocation(ollama.models),
    });
  }
  // LM Studio / MLX — OpenAI 호환 로컬 서버. Ollama와 동일한 "단일 런타임 + 동적 모델 목록" 모양.
  if (lmstudio && lmstudio.models.length > 0) {
    const remembered =
      active?.kind === "lmstudio"
        ? active.model
        : recallRuntimeSelection("lmstudio", "lmstudio")?.model;
    const preferred =
      remembered && lmstudio.models.includes(remembered) ? remembered : lmstudio.models[0] ?? null;
    list.push({
      kind: "lmstudio",
      backend: "lmstudio",
      source: "lmstudio",
      version: null,
      active: false,
      model: preferred,
      availableModels: lmstudio.models,
      ...conservativeLocalRuntimeAllocation(lmstudio.models),
    });
  }
  if (mlx && mlx.models.length > 0) {
    const remembered =
      active?.kind === "mlx" ? active.model : recallRuntimeSelection("mlx", "mlx")?.model;
    const preferred =
      remembered && mlx.models.includes(remembered) ? remembered : mlx.models[0] ?? null;
    list.push({
      kind: "mlx",
      backend: "mlx",
      source: "mlx",
      version: null,
      active: false,
      model: preferred,
      availableModels: mlx.models,
      ...conservativeLocalRuntimeAllocation(mlx.models),
    });
  }
  if (anthropicByok) {
    const selectedModel = byokModelOf("anthropic", active);
    list.push({
      kind: "byok",
      backend: "anthropic",
      source: "byok:anthropic",
      version: null,
      active: false,
      model: selectedModel,
      availableModels: byokModels("anthropic").map((m) => m.id),
      allocationModels: selectedModel ? [selectedModel] : [],
      longContextEnabled: byokLongOf("anthropic", active),
    });
  }
  if (openaiByok) {
    const selectedModel = byokModelOf("openai", active);
    list.push({
      kind: "byok",
      backend: "openai",
      source: "byok:openai",
      version: null,
      active: false,
      model: selectedModel,
      availableModels: byokModels("openai").map((m) => m.id),
      allocationModels: selectedModel ? [selectedModel] : [],
      longContextEnabled: byokLongOf("openai", active),
    });
  }
  if (googleByok) {
    const selectedModel = byokModelOf("google", active);
    list.push({
      kind: "byok",
      backend: "google",
      source: "byok:google",
      version: null,
      active: false,
      model: selectedModel,
      availableModels: byokModels("google").map((m) => m.id),
      allocationModels: selectedModel ? [selectedModel] : [],
      longContextEnabled: byokLongOf("google", active),
    });
  }

  // Anthropic/OpenAI 호환 서드파티(GLM/Kimi/DeepSeek/Upstage) + custom(사용자 base URL) —
  // 키가 저장돼 있으면 엔진으로 노출한다. upstage/custom을 빠뜨리면 Settings에서 고를 수 있어도
  // detect가 목록에 안 넣어 선택이 조용히 되돌려진다(감사 P0 데드코드).
  const compatFlags: Record<"glm" | "kimi" | "deepseek" | "minimax" | "xai" | "openrouter" | "upstage" | "custom", boolean> = {
    glm: glmByok,
    kimi: kimiByok,
    deepseek: deepseekByok,
    minimax: minimaxByok,
    xai: xaiByok,
    openrouter: openrouterByok,
    upstage: upstageByok,
    custom: customByok,
  };
  for (const backend of ["glm", "kimi", "deepseek", "minimax", "xai", "openrouter", "upstage", "custom"] as const) {
    if (!compatFlags[backend]) continue;
    const selectedModel = byokModelOf(backend, active);
    list.push({
      kind: "byok",
      backend,
      source: `byok:${backend}`,
      version: null,
      active: false,
      model: selectedModel,
      availableModels: byokModels(backend).map((m) => m.id),
      allocationModels: selectedModel ? [selectedModel] : [],
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
    setModelRole({
      kind: list[0].kind,
      backend: list[0].backend,
      source: list[0].source,
      model: list[0].model ?? undefined,
      longContext: list[0].longContextEnabled,
      effort: list[0].effort ?? undefined,
      role: "orchestrator",
    });
  }

  const roleAssignments = listResolvedModelRoles();
  for (const runtime of list) {
    const activeRoles = (["orchestrator", "worker"] as const).filter((role) => {
      const selection = roleAssignments[role]?.selection;
      return selection ? runtimeMatchesSelection(runtime, selection) : false;
    });
    runtime.activeRoles = activeRoles;
    runtime.roleSelections = Object.fromEntries(
      activeRoles.map((role) => [role, { ...roleAssignments[role]!.selection }]),
    );
    // Legacy `active` remains the orchestrator alias.
    runtime.active = activeRoles.includes("orchestrator");
  }

  return list;
}

export async function setActiveRuntime(selection: RuntimeSelection): Promise<RuntimeStatus[]> {
  const role = selection.role ?? "orchestrator";
  setModelRole({ ...selection, role });
  if (role === "orchestrator") {
    // active_runtime is the orchestrator compatibility mirror.
    saveActiveRuntime(selection);
    // effort가 명시된 경우에만 갱신 — 모델만 바꾸는 호출은 기존 작업량을 유지.
    if (selection.effort !== undefined) setStoredEffort(selection.effort);
  } else if (!selection.inherit) {
    rememberRuntimeSelection(
      selection.kind,
      selection.backend,
      selection.model,
      Boolean(selection.longContext),
    );
  }
  clearDetectCache();
  return detectRuntimes();
}
