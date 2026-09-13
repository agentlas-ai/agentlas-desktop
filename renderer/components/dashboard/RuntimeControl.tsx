"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { effortLabel, effortOptions } from "@/lib/effort-label";
import { ipc, ipcEvents } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import { loadViewData, readViewData, writeViewData } from "@/lib/view-data-cache";
import type {
  RuntimeRole,
  RuntimeRolePoolState,
  RuntimeSelection,
  RuntimeStatus,
} from "@/lib/types";
import {
  RuntimeModelPicker,
  runtimeModelFallbackLabel,
  type RuntimeModelPickerOption,
} from "./RuntimeModelPicker";
import { runtimeUsesEngineModelSetting } from "@shared/models";
import { describeRoleWriteFailure } from "@/lib/runtime-role-failure";

// resolvedId: 별칭이 실제로 어느 모델로 풀렸는지(실행이 알려준 값). 없으면 모르는 것.
type ModelRow = { id: string; label: string; tag?: string; resolvedId?: string };

/**
 * 이 행이 고를 수 있는 작업량.
 *
 * ★런타임 하나에 하나가 아니라 **모델마다 다르다**. Codex 는 모델이 광고하는
 * `supported_reasoning_levels` 를 그대로 쓰고(순서가 곧 능력 랭크다), Claude Code 는
 * CLI 가 알려 준 목록을 런타임 수준에 싣는다. 예전에는 런타임 수준만 읽어서 Codex 행의
 * 작업량 칸이 언제나 비어 있었다 — 고를 수 있는데 고를 자리가 없었다.
 *
 * 판별 순서는 커널(`supportedEfforts`)과 같다: 모델 프로필이 있으면 그것, 없으면 런타임.
 */
function effortsFor(
  runtime: RuntimeStatus | null | undefined,
  modelId: string | null | undefined,
): Array<{ id: string; label: string }> {
  const perModel = modelId ? runtime?.allocationModelProfiles?.[modelId]?.efforts : undefined;
  if (perModel && perModel.length > 0) {
    return perModel.map((id) => ({ id, label: effortLabel(id) }));
  }
  /* ★엔진이 준 영어 라벨을 그대로 올리던 자리 (실측 2026-09-08). */
  return effortOptions(runtime?.efforts);
}

/**
 * Stored pools can predate per-model capability discovery. An effort is
 * displayable only when the selected model advertises it; an empty capability
 * list means the host did not expose a model-specific list and must remain
 * backward-compatible with the runtime-level value.
 */
function effortIsSupported(
  runtime: RuntimeStatus | null | undefined,
  modelId: string | null | undefined,
  effort: string | null | undefined,
): boolean {
  if (!effort) return true;
  const supported = effortsFor(runtime, modelId);
  return supported.length === 0 || supported.some((entry) => entry.id === effort);
}
type RoleView = {
  role: RuntimeRole;
  runtime: RuntimeStatus | null;
  selection: RuntimeSelection | null;
  index: number;
  inherited: boolean;
};

const RUNTIME_LABEL: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  antigravity: "Antigravity",
  kimi: "Kimi Code",
  grok: "Grok",
  cursor: "Cursor Agent",
  byok: "BYOK API",
  ollama: "Ollama",
  lmstudio: "LM Studio",
  mlx: "MLX",
  agentlas: "Agentlas",
};

const BACKEND_LABEL: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  ollama: "Ollama",
  lmstudio: "LM Studio",
  mlx: "MLX",
  upstage: "Upstage",
  custom: "Custom",
  glm: "GLM",
  kimi: "Kimi",
  deepseek: "DeepSeek",
  minimax: "MiniMax",
  xai: "xAI",
  openrouter: "OpenRouter",
  cursor: "Cursor",
  agentlas: "Agentlas",
};

function runtimeKey(runtime: Pick<RuntimeStatus, "kind" | "backend" | "source">): string {
  return `${runtime.kind}\u0000${runtime.backend}\u0000${runtime.source}`;
}

function runtimeMatchesSelection(
  runtime: RuntimeStatus,
  selection: RuntimeSelection,
): boolean {
  if (runtime.kind !== selection.kind) return false;
  if (selection.backend && runtime.backend !== selection.backend) return false;
  if (selection.source && runtime.source !== selection.source) return false;
  return true;
}

function selectionKey(selection: RuntimeSelection): string {
  return [
    selection.kind,
    selection.backend ?? "",
    selection.source ?? "",
    selection.model ?? "",
    selection.effort ?? "",
    selection.longContext ? "long" : "standard",
  ].join("\u0000");
}

function runtimeLabel(runtime: RuntimeStatus): string {
  if (runtime.kind === "byok") {
    return `${BACKEND_LABEL[runtime.backend] ?? runtime.backend} API`;
  }
  // kind "acp" carries the agent's own name (RuntimeStatus.label).
  return runtime.label ?? RUNTIME_LABEL[runtime.kind] ?? runtime.kind;
}

function modelOptionKey(runtime: RuntimeStatus, model: string | undefined): string {
  return `${runtimeKey(runtime)}\u0000${model ?? ""}`;
}

function runtimeWithSelection(
  runtime: RuntimeStatus,
  selection: RuntimeSelection | null,
): RuntimeStatus {
  if (!selection) return runtime;
  return {
    ...runtime,
    model: selection.model ?? runtime.model,
    effort: selection.effort ?? runtime.effort,
    longContextEnabled:
      selection.longContext ?? runtime.longContextEnabled,
  };
}

function roleView(runtimes: RuntimeStatus[], role: RuntimeRole): RoleView {
  const index = runtimes.findIndex(
    (runtime) =>
      runtime.activeRoles?.includes(role) ||
      (role === "orchestrator" && runtime.active),
  );
  const fallbackIndex =
    role === "worker"
      ? runtimes.findIndex(
          (runtime) =>
            runtime.activeRoles?.includes("orchestrator") || runtime.active,
        )
      : -1;
  const resolvedIndex = index >= 0 ? index : fallbackIndex;
  const runtime = resolvedIndex >= 0 ? runtimes[resolvedIndex] : null;
  const selection = runtime?.roleSelections?.[role] ?? null;
  return {
    role,
    runtime: runtime ? runtimeWithSelection(runtime, selection) : null,
    selection,
    index: Math.max(0, resolvedIndex),
    inherited:
      role === "worker" &&
      (selection?.inherit === true || (index < 0 && fallbackIndex >= 0)),
  };
}

export function RuntimeControl() {
  const { locale } = useT();
  const ko = locale === "ko";
  const [runtimes, setRuntimes] = useState<RuntimeStatus[]>(() => (
    readViewData<RuntimeStatus[]>("dashboard.runtimes")?.value ?? []
  ));
  const [modelsByRuntime, setModelsByRuntime] = useState<Record<string, ModelRow[]>>({});
  const [loading, setLoading] = useState(() => !readViewData<RuntimeStatus[]>("dashboard.runtimes"));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<"info" | "error">("info");
  /**
   * ★실패는 화면에 도착해야 한다 (QA 실측 2026-09-08, 오너 2026-09-07 "안된다 금지").
   *
   * 이 화면의 쓰기 경로 세 곳이 전부 `catch { setMessage(""); }` 였다. 저장이 거절되면
   * 문구가 **지워진다** — 즉 "아무 일도 안 일어난 화면"과 "거절당한 화면"이 픽셀 단위로
   * 같았다. QA 가 오케스트레이터 행의 × 를 다섯 번 누르고도 이유를 못 본 것이 이것이고,
   * 옛 저장소에서 멀티모달 저장이 CHECK 로 막히는 것도 같은 방식으로 안 보인다.
   *
   * 그래서 문구를 지우는 대신 **왜 거절됐는지와 푸는 길**을 적는다.
   */
  const say = (text: string, tone: "info" | "error" = "info") => {
    setMessage(text);
    setMessageTone(tone);
  };
  const [pool, setPool] = useState<RuntimeRolePoolState | null>(() => (
    readViewData<RuntimeRolePoolState>("dashboard.runtime-role-pool")?.value ?? null
  ));
  const [dragState, setDragState] = useState<{
    role: RuntimeRole;
    from: number;
    over: number;
  } | null>(null);
  const pointerDragRef = useRef<{ role: RuntimeRole; from: number; startX: number; startY: number } | null>(null);
  const multimodalRuntimes = useMemo(
    // The local generate_image tool has executable adapters only for these
    // two CLIs. Input-vision support on a chat model is not image generation.
    () => runtimes.filter(
      (runtime) => runtime.kind === "codex" || runtime.kind === "antigravity",
    ),
    [runtimes],
  );

  const loadPool = useCallback(async () => {
    const api = ipc();
    if (!api?.runtime.listRoleMembers) return;
    try {
      const next = await loadViewData(
        "dashboard.runtime-role-pool",
        () => api.runtime.listRoleMembers(),
        { maxAgeMs: 300_000 },
      );
      setPool(next);
    } catch (error) {
      /*
       * 풀을 지원하지 않는 빌드는 위에서 이미 return 했다. 여기에 도달했다는 것은
       * **지원하는데 실패한 것**이다 — 그때 빈 목록을 조용히 그리면 사용자는 그것을
       * "후보가 하나도 없음"으로 읽고 다시 만들려 한다. 사실은 못 읽은 것이다.
       */
      setMessage(describeRoleWriteFailure(error, ko));
      setMessageTone("error");
    }
  }, [ko]);

  useEffect(() => {
    void loadPool();
  }, [loadPool]);

  const views = useMemo(
    () => ({
      orchestrator: roleView(runtimes, "orchestrator"),
      worker: roleView(runtimes, "worker"),
      // 멀티모달은 대화 역할이 아니다 — 이미지·영상을 실제로 그리는 CLI 를 앉히는 자리다.
      // orchestrator 가 프롬프트를 쓰고, 이 슬롯의 런타임이 헤드리스로 그린다.
      multimodal: roleView(multimodalRuntimes, "multimodal"),
    }),
    [multimodalRuntimes, runtimes],
  );

  const load = useCallback(async () => {
    const api = ipc();
    if (!api) {
      setLoading(false);
      return;
    }
    try {
      const detected = await loadViewData(
        "dashboard.runtimes",
        () => api.runtime.detect(),
        { maxAgeMs: 300_000 },
      );
      setRuntimes(detected);
      setMessage("");
      setMessageTone("info");
    } catch {
      // Keep the last verified projection -- but say that it is the last one.
      // 조용히 낡은 목록을 보여주면 사용자는 그것을 '지금'으로 읽는다.
      setMessage(
        ko
          ? "런타임을 새로 확인하지 못했습니다. 아래 목록은 마지막으로 확인된 상태입니다 — 새로고침으로 다시 시도하세요."
          : "Runtimes could not be re-checked. The list below is the last verified state -- refresh to try again.",
      );
      setMessageTone("error");
    } finally {
      setLoading(false);
    }
  }, [ko]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const events = ipcEvents();
    if (!events?.onStoreChanged) return;
    return events.onStoreChanged((change) => {
      if (change.entity !== "runtime") return;
      void Promise.all([load(), loadPool()]);
    });
  }, [load, loadPool]);

  useEffect(() => {
    const api = ipc();
    if (!api) return;
    let alive = true;
    void Promise.all(
      runtimes.map(async (runtime) => {
        const fallback = (runtime.availableModels ?? []).map((id) => ({
          id,
          label: id,
        }));
        try {
          const rows = await api.runtime.listModels({
            kind: runtime.kind,
            backend: runtime.backend,
            availableModels: runtime.availableModels,
          });
          return [runtimeKey(runtime), rows.length > 0 ? rows : fallback] as const;
        } catch {
          return [runtimeKey(runtime), fallback] as const;
        }
      }),
    ).then((entries) => {
      if (alive) {
        setModelsByRuntime(Object.fromEntries(entries));
      }
    });
    return () => {
      alive = false;
    };
  }, [runtimes]);

  function runtimesForRole(role: RuntimeRole): RuntimeStatus[] {
    return role === "multimodal" ? multimodalRuntimes : runtimes;
  }

  function runtimeOptionsForRole(role: RuntimeRole) {
    return runtimesForRole(role).filter((runtime) => runtime.kind !== "ollama" && runtime.credentialAccess?.status !== "unavailable").map((runtime, index) => ({
      runtime,
      index,
      label: runtimeLabel(runtime),
    }));
  }

  function modelOptionsForRole(
    role: RuntimeRole,
    currentSelection: RuntimeSelection,
  ): RuntimeModelPickerOption[] {
    const options: RuntimeModelPickerOption[] = [];
    for (const runtime of runtimesForRole(role)) {
      if (runtime.kind === "ollama") continue;
      const models = modelsByRuntime[runtimeKey(runtime)] ?? (runtime.availableModels ?? []).map((id) => ({ id, label: id }));
      if (runtimeUsesEngineModelSetting(runtime.kind)) {
        options.push({
          key: modelOptionKey(runtime, undefined),
          label: "",
          runtime,
          isDefault: true,
          // 기본값 행이 실제로 무엇으로 풀렸는지 — 실행이 알려준 값, 없으면 CLI 설정 파일의
          // 기본 모델이 카탈로그에서 풀린 값만 붙는다. 기본값으로 쓰는 사람이 대다수라,
          // 이 행이 비어 있으면 아무도 실제 모델을 못 본다.
          ...((): { resolvedId?: string } => {
            const fromCatalog = runtime.cliDefaultModel
              ? models.find((model) => model.id === runtime.cliDefaultModel)?.resolvedId
              : undefined;
            const resolved = runtime.observedDefaultModel ?? fromCatalog;
            return resolved ? { resolvedId: resolved } : {};
          })(),
        });
      }
      for (const model of models) {
        options.push({
          key: modelOptionKey(runtime, model.id),
          model: model.id,
          label: model.label,
          tag: model.tag,
          ...(model.resolvedId ? { resolvedId: model.resolvedId } : {}),
          runtime,
        });
      }
      // A stale runtime projection may expose only its current model. Keep it
      // selectable until the live model inventory catches up, rather than
      // silently turning a persisted selection into a different provider.
      if (models.length === 0 && runtime.model) {
        options.push({
          key: modelOptionKey(runtime, runtime.model),
          model: runtime.model,
          label: runtime.model,
          runtime,
        });
      }
    }

    const currentRuntime = runtimeForSelection(currentSelection);
    const currentKey = currentRuntime
      ? modelOptionKey(currentRuntime, currentSelection.model)
      : `unavailable\u0000${selectionKey(currentSelection)}`;
    if (!options.some((option) => option.key === currentKey)) {
      const unavailableRuntime: RuntimeStatus = currentRuntime ?? {
        kind: currentSelection.kind,
        backend: currentSelection.backend ?? "custom",
        source: currentSelection.source ?? "unavailable",
        version: null,
        active: false,
      };
      options.unshift({
        key: currentKey,
        model: currentSelection.model,
        label: currentSelection.model ?? runtimeModelFallbackLabel(currentSelection.kind, locale),
        runtime: unavailableRuntime,
        unavailable: true,
      });
    }
    return options;
  }

  async function writePool(
    role: RuntimeRole,
    selections: RuntimeSelection[],
    success = ko ? "후보 풀을 저장했습니다." : "Candidate pool saved.",
  ): Promise<boolean> {
    const api = ipc();
    if (!api?.runtime.setRoleMembers || busy) return false;
    setBusy(true);
    try {
      const nextPool = await api.runtime.setRoleMembers(role, selections);
      writeViewData("dashboard.runtime-role-pool", nextPool);
      setPool(nextPool);
      const detected = await api.runtime.detect();
      writeViewData("dashboard.runtimes", detected);
      setRuntimes(detected);
      say(success);
      return true;
    } catch (error) {
      say(describeRoleWriteFailure(error, ko), "error");
      return false;
    } finally {
      setBusy(false);
    }
  }

  function poolSelections(role: RuntimeRole): RuntimeSelection[] {
    return (pool?.members[role] ?? []).map((member) => member.selection);
  }

  function runtimeForSelection(selection: RuntimeSelection): RuntimeStatus | null {
    // The migration-only Ollama projection is not an executable runtime (same filter as the option lists).
    const roleRuntimes = runtimesForRole(selection.role ?? "orchestrator").filter((runtime) => runtime.kind !== "ollama");
    return roleRuntimes.find((runtime) => runtimeMatchesSelection(runtime, selection)) ?? null;
  }

  function selectionFromRuntime(
    runtime: RuntimeStatus,
    role: RuntimeRole,
  ): RuntimeSelection {
    return {
      kind: runtime.kind,
      backend: runtime.backend,
      source: runtime.source,
      model: runtime.model ?? undefined,
      longContext:
        runtime.kind === "byok"
          ? runtime.longContextEnabled ?? false
          : undefined,
      effort: runtime.effort ?? undefined,
      role,
      inherit: false,
    };
  }

  function selectionCandidatesForRuntime(
    runtime: RuntimeStatus,
    role: RuntimeRole,
  ): RuntimeSelection[] {
    if (runtime.credentialAccess?.status === "unavailable") return [];
    const base = selectionFromRuntime(runtime, role);
    const modelRows = modelsByRuntime[runtimeKey(runtime)]
      ?? (runtime.availableModels ?? []).map((id) => ({ id, label: id }));
    const candidates: RuntimeSelection[] = [];
    const append = (model: string | undefined) => {
      const effort = model && base.effort && effortsFor(runtime, model).some((entry) => entry.id === base.effort)
        ? base.effort
        : model
          ? undefined
          : base.effort;
      const candidate = { ...base, model, effort };
      if (!candidates.some((existing) => selectionKey(existing) === selectionKey(candidate))) {
        candidates.push(candidate);
      }
    };
    if (runtimeUsesEngineModelSetting(runtime.kind)) append(undefined);
    if (runtime.model?.trim()) append(runtime.model.trim());
    for (const model of modelRows) append(model.id);
    return candidates;
  }

  async function updateMember(
    role: RuntimeRole,
    index: number,
    nextSelection: RuntimeSelection,
  ) {
    const selections = poolSelections(role);
    if (!selections[index]) return;
    const next = selections.map((selection, rowIndex) =>
      rowIndex === index
        ? { ...nextSelection, role, inherit: false }
        : selection,
    );
    await writePool(role, next);
  }

  async function updateMemberModelSelection(
    role: RuntimeRole,
    index: number,
    option: RuntimeModelPickerOption,
  ) {
    const current = poolSelections(role)[index];
    if (!current) return;
    const runtime = option.runtime;
    const nextModel = option.model || undefined;
    const nextEfforts = effortsFor(runtime, nextModel);
    // An explicit effort belongs to the selected model. Keeping `max` while
    // switching to Spark made the row advertise an impossible pair and left a
    // stale option selected until the provider rejected the turn. Clear it
    // unless the new model explicitly exposes the same effort; the runner will
    // still apply the host-provided default when the field is omitted.
    const nextEffort = nextModel && current.effort && nextEfforts.some((entry) => entry.id === current.effort)
      ? current.effort
      : undefined;
    await updateMember(role, index, {
      ...selectionFromRuntime(runtime, role),
      model: nextModel,
      effort: nextEffort,
      longContext: runtime.kind === "byok"
        ? current.longContext ?? runtime.longContextEnabled ?? false
        : undefined,
    });
  }

  async function updateMemberEffort(
    role: RuntimeRole,
    index: number,
    effort: string,
  ) {
    const current = poolSelections(role)[index];
    if (!current) return;
    await updateMember(role, index, {
      ...current,
      effort: effort || undefined,
    });
  }

  function autoSelections(role: RuntimeRole): RuntimeSelection[] {
    const direct = runtimes.find((runtime) =>
      runtime.activeRoles?.includes(role),
    );
    const inheritedOrchestrator =
      role === "worker"
        ? runtimes.find(
            (runtime) =>
              runtime.activeRoles?.includes("orchestrator") || runtime.active,
          )
        : null;
    const primary = direct ?? inheritedOrchestrator ?? runtimes[0] ?? null;
    const ordered = primary
      ? [primary, ...runtimes.filter((runtime) => runtime !== primary)]
      : [];
    const seen = new Set<string>();
    return ordered.flatMap((runtime) => {
      const key = runtimeKey(runtime);
      if (seen.has(key)) return [];
      seen.add(key);
      return selectionCandidatesForRuntime(runtime, role).slice(0, 1);
    });
  }

  async function autoConfigureRoles() {
    const api = ipc();
    if (!api?.runtime.setRoleMembers || !api.runtime.detect || busy) return;
    const orchestrator = autoSelections("orchestrator");
    const worker = autoSelections("worker");
    if (orchestrator.length === 0 || worker.length === 0) return;
    setBusy(true);
    try {
      await api.runtime.setRoleMembers("orchestrator", orchestrator);
      const nextPool = await api.runtime.setRoleMembers("worker", worker);
      const detected = await api.runtime.detect();
      writeViewData("dashboard.runtime-role-pool", nextPool);
      writeViewData("dashboard.runtimes", detected);
      setPool(nextPool);
      setRuntimes(detected);
      say(
        ko
          ? "연결된 런타임과 현재 역할을 기준으로 우선순위를 자동 설정했습니다."
          : "Priority tables were configured from connected runtimes and current roles.",
      );
    } catch (error) {
      say(describeRoleWriteFailure(error, ko), "error");
    } finally {
      setBusy(false);
    }
  }

  async function reorderMember(
    role: RuntimeRole,
    from: number,
    to: number,
  ) {
    const selections = poolSelections(role);
    if (
      from === to ||
      from < 0 ||
      to < 0 ||
      from >= selections.length ||
      to >= selections.length
    ) {
      return;
    }
    const next = [...selections];
    const [moved] = next.splice(from, 1);
    if (!moved) return;
    next.splice(to, 0, moved);
    await writePool(
      role,
      next,
      ko ? "우선순위를 변경했습니다." : "Priority updated.",
    );
  }

  async function moveMember(role: RuntimeRole, index: number, delta: number) {
    await reorderMember(role, index, index + delta);
  }

  function beginPointerReorder(event: ReactPointerEvent<HTMLElement>, role: RuntimeRole, from: number) {
    if (busy) return;
    pointerDragRef.current = { role, from, startX: event.clientX, startY: event.clientY };
    setDragState({ role, from, over: from });
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function updatePointerReorder(event: ReactPointerEvent<HTMLElement>) {
    const drag = pointerDragRef.current;
    if (!drag) return;
    const target = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
    const row = target?.closest<HTMLElement>("[data-runtime-pool-row]");
    if (row?.dataset.runtimePoolRole !== drag.role) return;
    const over = Number(row.dataset.runtimePoolIndex);
    if (Number.isInteger(over) && dragState?.over !== over) setDragState({ role: drag.role, from: drag.from, over });
  }

  function finishPointerReorder(event: ReactPointerEvent<HTMLElement>) {
    const drag = pointerDragRef.current;
    pointerDragRef.current = null;
    setDragState(null);
    if (!drag || busy || Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) <= 4) return;
    const target = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
    const row = target?.closest<HTMLElement>("[data-runtime-pool-row]");
    if (row?.dataset.runtimePoolRole !== drag.role) return;
    const to = Number(row.dataset.runtimePoolIndex);
    if (Number.isInteger(to)) void reorderMember(drag.role, drag.from, to);
  }

  async function removeMember(role: RuntimeRole, index: number) {
    const selections = poolSelections(role);
    const next = selections.filter((_, i) => i !== index);
    await writePool(role, next);
  }

  async function addMember(role: RuntimeRole) {
    const roleRuntimes = runtimesForRole(role);
    if (roleRuntimes.length === 0) return;
    const selections = poolSelections(role);
    const used = new Set(selections.map(selectionKey));
    const firstUnusedRuntime = roleRuntimes.find(
      (runtime) =>
        !selections.some((selection) =>
          runtimeMatchesSelection(runtime, selection),
        ),
    );
    const available = roleRuntimes.flatMap((runtime) => {
      return selectionCandidatesForRuntime(runtime, role);
    });
    const firstUnusedCandidate = firstUnusedRuntime
      ? available.find((selection) => runtimeMatchesSelection(firstUnusedRuntime, selection))
      : null;
    const candidate =
      (firstUnusedCandidate ?? available.find((selection) => !used.has(selectionKey(selection)))) ??
      (selections.length > 0
        ? { ...selections[selections.length - 1], role, inherit: false }
        : available[0]);
    if (!candidate) return;
    const added = await writePool(
      role,
      [...selections, candidate],
      ko ? "후보 행을 추가했습니다." : "Candidate row added.",
    );
    if (added) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          document
            .querySelector<HTMLButtonElement>(
              `[data-role="${role}"] [data-pool-position="${selections.length + 1}"] [data-testid="runtime-model-picker"]`,
            )
            ?.focus();
        });
      });
    }
  }

  function memberBadge(role: RuntimeRole, position: number): {
    label: string;
    tone: "active" | "skip" | "idle";
  } {
    const pick = pool?.picks[role];
    if (pick?.position === position && !pick.inherited) {
      /*
       * ★영어가 자리에 안 들어갔다 (실측 2026-09-08, 창 1180px: 98px 자리에 111px).
       *   한국어("기본 선택")는 들어가는데 영어만 잘렸다 — 한 언어만 재면 이런 것을
       *   원리적으로 못 본다. 뜻을 잃지 않는 선에서 줄인다("이 역할의 기본 선택"이
       *   이 배지가 붙은 자리에서 이미 자명하다).
       */
      return { label: ko ? "기본 선택" : "Default", tone: "active" };
    }
    const skip = pick?.skipped.find((entry) => entry.position === position);
    if (skip) {
      const label =
        skip.reason === "quota-exceeded"
          ? ko
            ? "쿼터 초과 · 건너뜀"
            : "Quota exceeded · skipped"
          : skip.reason === "model-unavailable"
            ? ko
              ? "이 엔진에 없는 모델 · 건너뜀"
              : "Model not in this engine · skipped"
            : ko
              ? "미설치 · 건너뜀"
              : "Not installed · skipped";
      return { label, tone: "skip" };
    }
    return { label: ko ? "예비 후보" : "Fallback", tone: "idle" };
  }

  function renderPool(role: RuntimeRole) {
    const members = pool?.members[role] ?? [];
    const runtimeOptions = runtimeOptionsForRole(role);
    return (
      <div className="dashboard-runtime-pool">
        {members.length === 0 ? (
          <div className="dashboard-runtime-pool-empty">
            {role === "worker"
              ? ko
                ? "비어 있음 — 오케스트레이터 풀을 따릅니다."
                : "Empty — follows the orchestrator pool."
              : role === "multimodal" && runtimeOptions.length === 0
                ? ko
                  ? "연결된 이미지 생성 CLI가 없습니다 — Codex 또는 Antigravity를 연결하세요."
                  : "No image-generation CLI is connected — connect Codex or Antigravity."
              : ko
                ? "비어 있음 — 후보 행을 추가하세요."
                : "Empty — add a candidate row."}
          </div>
        ) : (
          <>
            <div className="dashboard-runtime-pool-columns" aria-hidden="true">
              <span>{ko ? "순위" : "Priority"}</span>
              <span>{ko ? "모델 · 공급자" : "Model · provider"}</span>
              <span>{ko ? "작업량" : "Effort"}</span>
              <span>{ko ? "선택" : "Selection"}</span>
              <span>{ko ? "관리" : "Manage"}</span>
            </div>
            <ol className="dashboard-runtime-pool-list">
              {members.map((member, index) => {
              const badge = memberBadge(role, member.position);
              const selection = member.selection;
              const runtime = runtimeForSelection(selection);
              const modelOptions = modelOptionsForRole(role, selection);
              const modelValue = runtime
                ? modelOptionKey(runtime, selection.model)
                : `unavailable\u0000${selectionKey(selection)}`;
              const efforts = effortsFor(runtime, selection.model);
              const effortValue = effortIsSupported(runtime, selection.model, selection.effort)
                ? selection.effort ?? ""
                : "";
              const duplicate =
                members.filter(
                  (candidate) =>
                    selectionKey(candidate.selection) === selectionKey(selection),
                ).length > 1;
              const roleLabel = role === "orchestrator"
                ? ko ? "오케스트레이터" : "Orchestrator"
                : role === "multimodal"
                  ? ko ? "이미지 생성" : "Image generation"
                  : ko ? "워커" : "Worker";
              const rowLabel = `${roleLabel} ${ko ? "후보" : "candidate"} ${index + 1}`;
              return (
                <li
                  data-runtime-pool-row
                  data-runtime-pool-role={role}
                  data-runtime-pool-index={index}
                  key={`${member.position}:${selectionKey(selection)}`}
                  data-pool-position={member.position}
                  /*
                   * ★행은 5칸짜리 격자인데, 못 지우는 이유 문구가 붙으면 항목이 6개가 된다
                   *   (fieldset 이 display:contents 라 그 안의 label 두 개가 각각 한 칸이다).
                   *   그래서 문구가 42px 짜리 마지막 칸으로 밀리고 × 는 격자 밖으로 나갔다.
                   *   문구가 있는 행만 칸을 하나 더 연다.
                   */
                  data-has-note={role === "orchestrator" && members.length === 1 ? "true" : undefined}
                  data-primary={index === 0 ? "true" : "false"}
                  data-dragging={
                    dragState?.role === role && dragState.from === index
                      ? "true"
                      : "false"
                  }
                  data-drop-target={
                    dragState?.role === role && dragState.over === index
                      ? "true"
                      : "false"
                  }
                  onDragOver={(event) => {
                    if (busy || dragState?.role !== role) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    if (dragState.over !== index) {
                      setDragState({ ...dragState, over: index });
                    }
                  }}
                  onDrop={(event) => {
                    if (busy || dragState?.role !== role) return;
                    event.preventDefault();
                    const from = dragState.from;
                    setDragState(null);
                    void reorderMember(role, from, index);
                  }}
                >
                  <button
                    type="button"
                    className="dashboard-runtime-pool-order"
                    draggable={false}
                    disabled={busy}
                    aria-label={
                      ko
                        ? `${rowLabel} 순위 ${index + 1}. 드래그하거나 방향키로 순위 변경`
                        : `${rowLabel}, priority ${index + 1}. Drag or use arrow keys to reorder`
                    }
                    title={
                      ko
                        ? "드래그해서 순위 변경"
                        : "Drag to change priority"
                    }
                    onPointerDown={(event) => beginPointerReorder(event, role, index)}
                    onPointerMove={updatePointerReorder}
                    onPointerUp={finishPointerReorder}
                    onPointerCancel={() => { pointerDragRef.current = null; setDragState(null); }}
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData(
                        "text/plain",
                        `${role}:${index}`,
                      );
                      setDragState({ role, from: index, over: index });
                    }}
                    onDragEnd={() => setDragState(null)}
                    onKeyDown={(event) => {
                      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") {
                        return;
                      }
                      event.preventDefault();
                      const delta = event.key === "ArrowUp" ? -1 : 1;
                      void moveMember(role, index, delta);
                    }}
                  >
                    {index + 1}
                  </button>
                  <fieldset className="dashboard-runtime-pool-fields">
                    <legend className="sr-only">{rowLabel}</legend>
                    <label>
                      <span>{ko ? "모델 · 공급자" : "Model · provider"}</span>
                      <RuntimeModelPicker
                        ariaLabel={`${rowLabel} ${ko ? "모델" : "model"}`}
                        value={modelValue}
                        options={modelOptions}
                        locale={locale}
                        disabled={busy}
                        onSelect={(option) => void updateMemberModelSelection(role, index, option)}
                      />
                    </label>
                    <label>
                      <span>{ko ? "작업량" : "Effort"}</span>
                      {efforts.length > 0 || selection.effort ? (
                        <select
                          aria-label={`${rowLabel} ${ko ? "작업량" : "effort"}`}
                          value={effortValue}
                          aria-invalid={selection.effort && effortValue === "" ? "true" : undefined}
                          onChange={(event) =>
                            void updateMemberEffort(role, index, event.target.value)
                          }
                          disabled={busy}
                          >
                            <option value="">{ko ? "기본" : "Default"}</option>
                          {efforts.map((effort) => (
                            <option key={effort.id} value={effort.id}>
                              {effort.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="dashboard-runtime-field-value">
                          {ko ? "기본" : "Default"}
                        </span>
                      )}
                    </label>
                  </fieldset>
                  <span
                    className="dashboard-runtime-pool-badge"
                    data-tone={duplicate ? "skip" : badge.tone}
                  >
                    {duplicate
                      ? ko
                        ? "중복 후보"
                        : "Duplicate"
                      : badge.label}
                  </span>
                  {role === "orchestrator" && members.length === 1 && (
                    /*
                     * ★못 지우는 이유는 화면에 있어야 한다 (QA 실측 2026-09-08).
                     * 마지막 오케스트레이터 후보는 지울 수 없는 것이 맞다 — 하나는 남아야
                     * 한다. 그런데 그 이유가 비활성 단추의 title 에만 있었다. 비활성 단추는
                     * 포커스를 못 받아 툴팁도 스크린리더도 거기 닿지 않는다. QA 는 다섯 번
                     * 누르고도 아무 설명을 못 봤다 — 화면이 "고장"과 구별되지 않았다.
                     */
                    <span
                      className="dashboard-runtime-pool-note"
                      title={ko
                        ? "오케스트레이터 후보는 최소 하나가 있어야 합니다. 다른 후보를 먼저 추가한 뒤 이 행을 지우세요."
                        : "At least one orchestrator candidate must remain. Add another candidate first, then remove this row."}
                    >
                      {ko ? "마지막 후보라 지울 수 없음" : "Last candidate — cannot remove"}
                    </span>
                  )}
                  <span className="dashboard-runtime-pool-actions">
                    <button
                      type="button"
                      onClick={() => void removeMember(role, index)}
                      disabled={
                        busy || (role === "orchestrator" && members.length === 1)
                      }
                      aria-label={
                        ko
                          ? `${rowLabel} 제거`
                          : `Remove ${rowLabel.toLowerCase()}`
                      }
                      title={
                        role === "orchestrator" && members.length === 1
                          ? ko
                            ? "오케스트레이터 후보는 최소 1개가 필요합니다."
                            : "At least one orchestrator candidate is required."
                          : undefined
                      }
                    >
                      ×
                    </button>
                  </span>
                </li>
              );
              })}
            </ol>
          </>
        )}
        <button
          type="button"
          className="dashboard-runtime-pool-add"
          onClick={() => void addMember(role)}
          disabled={busy || runtimeOptions.length === 0}
        >
          {ko ? "+ 후보 행 추가" : "+ Add candidate row"}
        </button>
      </div>
    );
  }

  function renderRole(role: RuntimeRole) {
    const view = views[role];
    const active = view.runtime;
    // ★멀티모달만 번역돼 있었다 — 같은 묶음의 나머지 둘이 영어로 남아 한국어 화면에
    //   "Orchestrator"/"Worker" 가 그대로 떴다(한국어 화면 훑기 2026-09-08).
    //   어휘는 이 파일이 이미 쓰는 것과 맞춘다(아래 후보 행 라벨과 같은 말).
    const title =
      role === "orchestrator"
        ? ko ? "오케스트레이터" : "Orchestrator"
        : role === "multimodal"
          ? ko
            ? "멀티모달 생성 (이미지)"
            : "Multimodal generation (image)"
          : ko ? "워커" : "Worker";
    return (
      <section
        className="dashboard-runtime-role"
        data-role={role}
        data-tour-id={
          role === "worker" ? "dashboard.worker-model" : undefined
        }
        key={role}
      >
        <div className="dashboard-runtime-role-head">
          <div>
            <strong>{title}</strong>
            <span className="dashboard-runtime-role-kicker">
              {role === "orchestrator"
                ? ko
                  ? "1개 컨트롤러가 의사결정 · 위임 · 결과 통합 — 행은 모델 예비 순서"
                  : "One controller decides, delegates, and synthesizes — rows are model fallbacks"
                : role === "multimodal"
                  ? ko
                    ? "이미지 생성 CLI 우선순위 — 영상·API 공급자는 설정 > 멀티모달에서 관리"
                    : "Image-generation CLI priority — manage video and API providers in Settings > Multimodal"
                : ko
                  ? "N개 워커 실행이 공유하는 모델 우선순위 — 행 수는 워커 수가 아님"
                  : "Shared model priority for N worker executions — rows are not worker count"}
            </span>
          </div>
          <span
            className="dashboard-runtime-pool-badge"
            data-tone={active ? "active" : "idle"}
          >
            {active
              ? ko
                ? "연결됨"
                : "Connected"
              : ko
                ? "연결 대기"
                : "Waiting"}
          </span>
        </div>
        {renderPool(role)}
      </section>
    );
  }

  const anyActive = runtimes.some((runtime) => runtime.kind !== "ollama");
  return (
    <div
      className="dashboard-module dashboard-runtime-control"
      data-busy={busy ? "true" : "false"}
    >
      <div className="dashboard-module-head dashboard-runtime-module-head">
        <span>{ko ? "역할별 기본 모델" : "Role model defaults"}</span>
        <small>
          {ko
            ? "오케스트레이터 1 : 워커 N · 행은 역할별 모델 우선순위"
            : "1 Orchestrator : N Workers · rows are role model priorities"}
        </small>
        <button
          type="button"
          className="dashboard-runtime-auto"
          aria-label={ko ? "연결된 모델로 역할 우선순위 자동 설정" : "Automatically set role priorities from connected models"}
          onClick={() => void autoConfigureRoles()}
          disabled={busy || runtimes.length === 0}
          title={
            ko
              ? "현재 역할 모델을 1순위로 두고 연결된 런타임을 후순위에 배치합니다."
            : "Keeps current role models first and adds connected runtimes in order."
          }
        >
          {busy ? (ko ? "설정 중…" : "Setting…") : (ko ? "자동 설정" : "Auto set")}
        </button>
      </div>
      {loading ? (
        <div className="dashboard-module-empty">
          {ko ? "런타임 확인 중…" : "Checking runtimes…"}
        </div>
      ) : !anyActive ? (
        <div className="dashboard-module-empty">
          {ko ? "연결된 런타임이 없습니다." : "No runtime connected."}
        </div>
      ) : (
        <>
          <div className="dashboard-runtime-library">
            {renderRole("orchestrator")}
            {renderRole("worker")}
            {renderRole("multimodal")}
          </div>
          {message && (
            <div
              className="dashboard-runtime-message"
              data-tone={messageTone}
              role="status"
              aria-live="polite"
            >
              {message}
            </div>
          )}
        </>
      )}
    </div>
  );
}
