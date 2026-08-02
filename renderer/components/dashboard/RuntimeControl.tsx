"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ipc } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import type {
  RuntimeRole,
  RuntimeRolePoolState,
  RuntimeSelection,
  RuntimeStatus,
} from "@/lib/types";
import { cliModelTagLabel } from "@shared/models";

type ModelRow = { id: string; label: string; tag?: string };
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
  gemini: "Gemini",
  kimi: "Kimi Code",
  grok: "Grok",
  cursor: "Cursor Agent",
  byok: "BYOK API",
  ollama: "Ollama",
  lmstudio: "LM Studio",
  mlx: "MLX",
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
};

/** Local OpenAI-compatible runtimes expose models but have no subscription default. */
const LOCAL_MODEL_KINDS = new Set(["ollama", "lmstudio", "mlx"]);

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
  if (
    runtime.kind === "gemini" &&
    /(^|[/\\])agy(?:\.(?:exe|cmd))?$/.test(runtime.source ?? "")
  ) {
    return "Antigravity";
  }
  return RUNTIME_LABEL[runtime.kind] ?? runtime.kind;
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
  const [runtimes, setRuntimes] = useState<RuntimeStatus[]>([]);
  const [modelsByRuntime, setModelsByRuntime] = useState<Record<string, ModelRow[]>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [pool, setPool] = useState<RuntimeRolePoolState | null>(null);
  const [dragState, setDragState] = useState<{
    role: RuntimeRole;
    from: number;
    over: number;
  } | null>(null);
  const pointerDragRef = useRef<{ role: RuntimeRole; from: number; startX: number; startY: number } | null>(null);

  const loadPool = useCallback(async () => {
    const api = ipc();
    if (!api?.runtime.listRoleMembers) return;
    try {
      setPool(await api.runtime.listRoleMembers());
    } catch {
      /* 풀 미지원 빌드 — 읽기 전용 빈 상태 유지 */
    }
  }, []);

  useEffect(() => {
    void loadPool();
  }, [loadPool]);

  const views = useMemo(
    () => ({
      orchestrator: roleView(runtimes, "orchestrator"),
      worker: roleView(runtimes, "worker"),
    }),
    [runtimes],
  );

  const load = useCallback(async () => {
    const api = ipc();
    if (!api) {
      setLoading(false);
      return;
    }
    try {
      const detected = await api.runtime.detect();
      setRuntimes(detected);
      setMessage("");
    } catch {
      // Keep the last verified projection. Operational evidence stays in Main
      // for One recovery and never becomes dashboard copy.
      setMessage("");
    } finally {
      setLoading(false);
    }
  }, [ko]);

  useEffect(() => {
    void load();
  }, [load]);

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

  const runtimeOptions = useMemo(
    () =>
      runtimes.map((runtime, index) => ({
        runtime,
        index,
        label: runtimeLabel(runtime),
      })),
    [runtimes],
  );

  async function writePool(
    role: RuntimeRole,
    selections: RuntimeSelection[],
    success = ko ? "후보 풀을 저장했습니다." : "Candidate pool saved.",
  ): Promise<boolean> {
    const api = ipc();
    if (!api?.runtime.setRoleMembers || busy) return false;
    setBusy(true);
    try {
      setPool(await api.runtime.setRoleMembers(role, selections));
      const detected = await api.runtime.detect();
      setRuntimes(detected);
      setMessage(success);
      return true;
    } catch {
      setMessage("");
      return false;
    } finally {
      setBusy(false);
    }
  }

  function poolSelections(role: RuntimeRole): RuntimeSelection[] {
    return (pool?.members[role] ?? []).map((member) => member.selection);
  }

  function runtimeForSelection(selection: RuntimeSelection): RuntimeStatus | null {
    return (
      runtimes.find((runtime) => runtimeMatchesSelection(runtime, selection)) ??
      runtimes.find(
        (runtime) =>
          runtime.kind === selection.kind &&
          (!selection.backend || runtime.backend === selection.backend),
      ) ??
      null
    );
  }

  function runtimeIndexForSelection(selection: RuntimeSelection): number {
    const runtime = runtimeForSelection(selection);
    return runtime ? runtimes.indexOf(runtime) : -1;
  }

  function modelRowsForSelection(selection: RuntimeSelection): ModelRow[] {
    const runtime = runtimeForSelection(selection);
    const rows = runtime ? modelsByRuntime[runtimeKey(runtime)] ?? [] : [];
    if (!selection.model || rows.some((row) => row.id === selection.model)) return rows;
    return [{ id: selection.model, label: selection.model }, ...rows];
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

  async function updateMemberRuntime(
    role: RuntimeRole,
    index: number,
    runtimeIndex: number,
  ) {
    const runtime = runtimes[runtimeIndex];
    if (!runtime) return;
    await updateMember(role, index, selectionFromRuntime(runtime, role));
  }

  async function updateMemberModel(
    role: RuntimeRole,
    index: number,
    model: string,
  ) {
    const current = poolSelections(role)[index];
    if (!current) return;
    await updateMember(role, index, {
      ...current,
      model: model || undefined,
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
      return [selectionFromRuntime(runtime, role)];
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
      setPool(await api.runtime.setRoleMembers("worker", worker));
      setRuntimes(await api.runtime.detect());
      setMessage(
        ko
          ? "연결된 런타임과 현재 역할을 기준으로 우선순위를 자동 설정했습니다."
          : "Priority tables were configured from connected runtimes and current roles.",
      );
    } catch {
      setMessage("");
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
    if (runtimes.length === 0) return;
    const selections = poolSelections(role);
    const used = new Set(selections.map(selectionKey));
    const firstUnusedRuntime = runtimes.find(
      (runtime) =>
        !selections.some((selection) =>
          runtimeMatchesSelection(runtime, selection),
        ),
    );
    const available = runtimes.flatMap((runtime) => {
      const base = selectionFromRuntime(runtime, role);
      const modelRows = modelsByRuntime[runtimeKey(runtime)] ?? [];
      const candidates = [base];
      for (const model of modelRows) {
        candidates.push({ ...base, model: model.id });
      }
      if (runtime.kind !== "byok" && !LOCAL_MODEL_KINDS.has(runtime.kind)) {
        candidates.unshift({ ...base, model: undefined });
      }
      return candidates;
    });
    const candidate =
      (firstUnusedRuntime
        ? selectionFromRuntime(firstUnusedRuntime, role)
        : available.find((selection) => !used.has(selectionKey(selection)))) ??
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
            .querySelector<HTMLSelectElement>(
              `[data-role="${role}"] [data-pool-position="${selections.length + 1}"] select`,
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
      return { label: ko ? "기본 선택" : "Selected default", tone: "active" };
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
    return (
      <div className="dashboard-runtime-pool">
        {members.length === 0 ? (
          <div className="dashboard-runtime-pool-empty">
            {role === "worker"
              ? ko
                ? "비어 있음 — 오케스트레이터 풀을 따릅니다."
                : "Empty — follows the orchestrator pool."
              : ko
                ? "비어 있음 — 후보 행을 추가하세요."
                : "Empty — add a candidate row."}
          </div>
        ) : (
          <>
            <div className="dashboard-runtime-pool-columns" aria-hidden="true">
              <span>{ko ? "순위" : "Priority"}</span>
              <span>{ko ? "엔진" : "Engine"}</span>
              <span>{ko ? "모델" : "Model"}</span>
              <span>{ko ? "작업량" : "Effort"}</span>
              <span>{ko ? "선택" : "Selection"}</span>
              <span>{ko ? "관리" : "Manage"}</span>
            </div>
            <ol className="dashboard-runtime-pool-list">
              {members.map((member, index) => {
              const badge = memberBadge(role, member.position);
              const selection = member.selection;
              const runtimeIndex = runtimeIndexForSelection(selection);
              const runtime = runtimeForSelection(selection);
              const models = modelRowsForSelection(selection);
              const efforts = runtime?.efforts ?? [];
              const duplicate =
                members.filter(
                  (candidate) =>
                    selectionKey(candidate.selection) === selectionKey(selection),
                ).length > 1;
              const roleLabel = role === "orchestrator"
                ? ko ? "오케스트레이터" : "Orchestrator"
                : ko ? "워커" : "Worker";
              const rowLabel = `${roleLabel} ${ko ? "후보" : "candidate"} ${index + 1}`;
              return (
                <li
                  data-runtime-pool-row
                  data-runtime-pool-role={role}
                  data-runtime-pool-index={index}
                  key={`${member.position}:${selectionKey(selection)}`}
                  data-pool-position={member.position}
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
                      <span>{ko ? "엔진" : "Engine"}</span>
                      <select
                        aria-label={`${rowLabel} ${ko ? "엔진" : "engine"}`}
                        value={String(runtimeIndex)}
                        onChange={(event) =>
                          void updateMemberRuntime(
                            role,
                            index,
                            Number(event.target.value),
                          )
                        }
                        disabled={busy}
                      >
                        {runtimeIndex < 0 && (
                          <option value="-1" disabled>
                            {RUNTIME_LABEL[selection.kind] ?? selection.kind}
                            {ko ? " · 연결 안 됨" : " · unavailable"}
                          </option>
                        )}
                        {runtimeOptions.map(({ runtime: option, index: optionIndex, label }) => (
                          <option
                            key={runtimeKey(option)}
                            value={optionIndex}
                          >
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>{ko ? "모델" : "Model"}</span>
                      <select
                        aria-label={`${rowLabel} ${ko ? "모델" : "model"}`}
                        value={selection.model ?? ""}
                        onChange={(event) =>
                          void updateMemberModel(role, index, event.target.value)
                        }
                        disabled={
                          busy ||
                          (!runtime && models.length === 0) ||
                          (models.length === 0 &&
                            (selection.kind === "byok" ||
                              LOCAL_MODEL_KINDS.has(selection.kind)))
                        }
                      >
                        {selection.kind !== "byok" &&
                          !LOCAL_MODEL_KINDS.has(selection.kind) && (
                            <option value="">
                              {ko ? "구독 기본" : "Subscription default"}
                            </option>
                          )}
                        {models.map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.label}
                            {model.tag
                              ? ` · ${cliModelTagLabel(model.tag, locale)}`
                              : ""}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>{ko ? "작업량" : "Effort"}</span>
                      {efforts.length > 0 || selection.effort ? (
                        <select
                          aria-label={`${rowLabel} ${ko ? "작업량" : "effort"}`}
                          value={selection.effort ?? ""}
                          onChange={(event) =>
                            void updateMemberEffort(role, index, event.target.value)
                          }
                          disabled={busy}
                        >
                          <option value="">{ko ? "기본" : "Default"}</option>
                          {selection.effort &&
                            !efforts.some((effort) => effort.id === selection.effort) && (
                              <option value={selection.effort}>{selection.effort}</option>
                            )}
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
          disabled={busy || runtimes.length === 0}
        >
          {ko ? "+ 후보 행 추가" : "+ Add candidate row"}
        </button>
      </div>
    );
  }

  function renderRole(role: RuntimeRole) {
    const view = views[role];
    const active = view.runtime;
    const title =
      role === "orchestrator"
        ? "Orchestrator"
        : ko
          ? "Worker"
          : "Worker";
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
                : ko
                  ? "N개 Worker 실행이 공유하는 모델 우선순위 — 행 수는 Worker 수가 아님"
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

  const anyActive = runtimes.length > 0;
  return (
    <div
      className="dashboard-module dashboard-runtime-control"
      data-busy={busy ? "true" : "false"}
    >
      <div className="dashboard-module-head dashboard-runtime-module-head">
        <span>{ko ? "역할별 기본 모델" : "Role model defaults"}</span>
        <small>
          {ko
            ? "1 Orchestrator : N Workers · 행은 역할별 모델 우선순위"
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
          </div>
          {message && (
            <div className="dashboard-runtime-message">{message}</div>
          )}
        </>
      )}
    </div>
  );
}
