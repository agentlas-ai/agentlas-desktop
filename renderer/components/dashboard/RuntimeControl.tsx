"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
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

const ROLES: RuntimeRole[] = ["orchestrator", "worker"];

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

function runtimeSubLabel(runtime: RuntimeStatus, ko: boolean): string {
  const model = runtime.model?.trim();
  const effort = runtime.effort?.trim();
  const version =
    runtime.version && runtime.version !== "unknown" ? runtime.version : "";
  return [
    version ? `v${version}` : runtime.source,
    model ||
      (runtime.kind === "byok" || LOCAL_MODEL_KINDS.has(runtime.kind)
        ? ""
        : ko
          ? "구독 기본"
          : "subscription default"),
    effort ? `effort ${effort}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
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
  const [modelsByRole, setModelsByRole] = useState<
    Record<RuntimeRole, ModelRow[]>
  >({ orchestrator: [], worker: [] });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [pool, setPool] = useState<RuntimeRolePoolState | null>(null);

  const loadPool = useCallback(async () => {
    const api = ipc();
    if (!api?.runtime.listRoleMembers) return;
    try {
      setPool(await api.runtime.listRoleMembers());
    } catch {
      /* 풀 미지원 빌드 — 단일 선택 UI만 표시 */
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
      setRuntimes([]);
      setMessage(
        ko ? "런타임을 불러오지 못했습니다." : "Could not load runtimes.",
      );
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
      ROLES.map(async (role) => {
        const active = views[role].runtime;
        if (!active) return [role, []] as const;
        try {
          const rows = await api.runtime.listModels({
            kind: active.kind,
            backend: active.backend,
            availableModels: active.availableModels,
          });
          return [role, rows] as const;
        } catch {
          return [role, []] as const;
        }
      }),
    ).then((entries) => {
      if (alive) {
        setModelsByRole(
          Object.fromEntries(entries) as Record<RuntimeRole, ModelRow[]>,
        );
      }
    });
    return () => {
      alive = false;
    };
  }, [
    views.orchestrator.runtime?.kind,
    views.orchestrator.runtime?.backend,
    views.orchestrator.runtime?.source,
    views.orchestrator.runtime?.availableModels?.join("|"),
    views.worker.runtime?.kind,
    views.worker.runtime?.backend,
    views.worker.runtime?.source,
    views.worker.runtime?.availableModels?.join("|"),
  ]);

  const runtimeOptions = useMemo(
    () =>
      runtimes.map((runtime, index) => ({
        runtime,
        index,
        label: runtimeLabel(runtime),
      })),
    [runtimes],
  );

  async function saveSelection(
    role: RuntimeRole,
    selection: RuntimeSelection,
    success: string,
  ) {
    const api = ipc();
    if (!api || busy) return;
    setBusy(true);
    try {
      const updated = await api.runtime.setActive({
        ...selection,
        role,
        inherit: role === "worker" ? selection.inherit : false,
      });
      setRuntimes(updated);
      setMessage(success);
      // 단일 설정은 풀 헤드 교체이므로 풀 표시도 함께 갱신한다.
      void loadPool();
    } catch (err) {
      setMessage(
        ko
          ? `변경하지 못했습니다. ${String(err)}`
          : `Could not change it. ${String(err)}`,
      );
    } finally {
      setBusy(false);
    }
  }

  async function activateRuntime(role: RuntimeRole, indexValue: string) {
    const next = runtimes[Number(indexValue)];
    if (!next) return;
    await saveSelection(
      role,
      {
        kind: next.kind,
        backend: next.backend,
        source: next.source,
        model: next.model ?? undefined,
        longContext:
          next.kind === "byok"
            ? next.longContextEnabled ?? false
            : undefined,
        effort:
          next.kind === "claude-code" ? next.effort ?? undefined : undefined,
        inherit: false,
      },
      role === "orchestrator"
        ? ko
          ? "오케스트레이터 엔진을 바꿨습니다."
          : "Orchestrator engine changed."
        : ko
          ? "워커 엔진을 바꿨습니다."
          : "Worker engine changed.",
    );
  }

  async function activateModel(role: RuntimeRole, model: string) {
    const active = views[role].runtime;
    if (!active) return;
    await saveSelection(
      role,
      {
        kind: active.kind,
        backend: active.backend,
        source: active.source,
        model: model || undefined,
        longContext:
          active.kind === "byok"
            ? active.longContextEnabled ?? false
            : undefined,
        effort: active.effort ?? undefined,
        inherit: false,
      },
      role === "orchestrator"
        ? ko
          ? "오케스트레이터 모델을 바꿨습니다."
          : "Orchestrator model changed."
        : ko
          ? "워커 모델을 바꿨습니다."
          : "Worker model changed.",
    );
  }

  async function activateEffort(role: RuntimeRole, effort: string) {
    const active = views[role].runtime;
    if (!active) return;
    await saveSelection(
      role,
      {
        kind: active.kind,
        backend: active.backend,
        source: active.source,
        model: active.model ?? undefined,
        longContext:
          active.kind === "byok"
            ? active.longContextEnabled ?? false
            : undefined,
        effort,
        inherit: false,
      },
      ko ? "작업 강도를 바꿨습니다." : "Effort changed.",
    );
  }

  async function setWorkerInheritance(inherit: boolean) {
    const orchestrator = views.orchestrator.runtime;
    const worker = views.worker.runtime ?? orchestrator;
    const source = inherit ? orchestrator : worker;
    if (!source) return;
    await saveSelection(
      "worker",
      {
        kind: source.kind,
        backend: source.backend,
        source: source.source,
        model: source.model ?? undefined,
        longContext: source.longContextEnabled,
        effort: source.effort ?? undefined,
        inherit,
      },
      inherit
        ? ko
          ? "워커가 오케스트레이터 모델을 사용합니다."
          : "Worker now inherits the orchestrator model."
        : ko
          ? "워커 모델을 직접 지정할 수 있습니다."
          : "Worker model can now be selected directly.",
    );
  }

  async function writePool(role: RuntimeRole, selections: RuntimeSelection[]) {
    const api = ipc();
    if (!api?.runtime.setRoleMembers || busy) return;
    setBusy(true);
    try {
      setPool(await api.runtime.setRoleMembers(role, selections));
      const detected = await api.runtime.detect();
      setRuntimes(detected);
      setMessage(ko ? "후보 풀을 저장했습니다." : "Candidate pool saved.");
    } catch (err) {
      setMessage(
        ko
          ? `풀을 저장하지 못했습니다. ${String(err)}`
          : `Could not save the pool. ${String(err)}`,
      );
    } finally {
      setBusy(false);
    }
  }

  function poolSelections(role: RuntimeRole): RuntimeSelection[] {
    return (pool?.members[role] ?? []).map((member) => member.selection);
  }

  async function moveMember(role: RuntimeRole, index: number, delta: number) {
    const selections = poolSelections(role);
    const target = index + delta;
    if (target < 0 || target >= selections.length) return;
    const next = [...selections];
    [next[index], next[target]] = [next[target], next[index]];
    await writePool(role, next);
  }

  async function removeMember(role: RuntimeRole, index: number) {
    const selections = poolSelections(role);
    const next = selections.filter((_, i) => i !== index);
    await writePool(role, next);
  }

  async function addCurrentAsMember(role: RuntimeRole) {
    const active = views[role].runtime;
    if (!active) return;
    const selections = poolSelections(role);
    const candidate: RuntimeSelection = {
      kind: active.kind,
      backend: active.backend,
      source: active.source,
      model: active.model ?? undefined,
      longContext: active.longContextEnabled,
      effort: active.effort ?? undefined,
      role,
      inherit: false,
    };
    const duplicate = selections.some(
      (selection) =>
        selection.kind === candidate.kind &&
        (selection.backend ?? null) === (candidate.backend ?? null) &&
        (selection.model ?? null) === (candidate.model ?? null),
    );
    if (duplicate) {
      setMessage(ko ? "이미 풀에 있는 후보입니다." : "Already in the pool.");
      return;
    }
    await writePool(
      role,
      selections.length === 0 ? [candidate] : [...selections, candidate],
    );
  }

  function memberBadge(role: RuntimeRole, position: number): {
    label: string;
    tone: "active" | "skip" | "idle";
  } {
    const pick = pool?.picks[role];
    if (pick?.position === position && !pick.inherited) {
      return { label: ko ? "사용 중" : "In use", tone: "active" };
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
    return { label: ko ? "대기" : "Standby", tone: "idle" };
  }

  function renderPool(role: RuntimeRole) {
    const members = pool?.members[role] ?? [];
    const inheritedPick = role === "worker" && (pool?.picks.worker?.inherited ?? false);
    return (
      <div className="dashboard-runtime-pool">
        <div className="dashboard-runtime-pool-head">
          <span>
            {role === "orchestrator"
              ? ko
                ? "오케스트레이터 후보 풀"
                : "Orchestrator pool"
              : ko
                ? "워커 후보 풀"
                : "Worker pool"}
          </span>
          <span className="dashboard-module-meta">
            {ko
              ? "순서가 우선순위 — 미설치·쿼터 초과는 자동으로 다음 후보"
              : "Order is priority — unavailable or quota-hit members are skipped"}
          </span>
        </div>
        {members.length === 0 ? (
          <div className="dashboard-runtime-pool-empty">
            {role === "worker"
              ? ko
                ? "비어 있음 — 오케스트레이터 풀을 따릅니다."
                : "Empty — follows the orchestrator pool."
              : ko
                ? "비어 있음 — 아래 선택을 추가하세요."
                : "Empty — add the selection below."}
          </div>
        ) : (
          <ol className="dashboard-runtime-pool-list">
            {members.map((member, index) => {
              const badge = memberBadge(role, member.position);
              const kindLabel = RUNTIME_LABEL[member.selection.kind] ?? member.selection.kind;
              return (
                <li key={`${member.selection.kind}:${member.selection.model ?? ""}:${member.position}`}>
                  <span className="dashboard-runtime-pool-order">{index + 1}</span>
                  <span className="dashboard-runtime-pool-name">
                    {kindLabel}
                    {member.selection.model ? ` · ${member.selection.model}` : ""}
                    {member.selection.effort ? ` · ${member.selection.effort}` : ""}
                  </span>
                  <span
                    className="dashboard-runtime-pool-badge"
                    data-tone={badge.tone}
                  >
                    {badge.label}
                  </span>
                  <span className="dashboard-runtime-pool-actions">
                    <button
                      type="button"
                      onClick={() => void moveMember(role, index, -1)}
                      disabled={busy || index === 0}
                      aria-label={ko ? "위로" : "Move up"}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      onClick={() => void moveMember(role, index, 1)}
                      disabled={busy || index === members.length - 1}
                      aria-label={ko ? "아래로" : "Move down"}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      onClick={() => void removeMember(role, index)}
                      disabled={
                        busy || (role === "orchestrator" && members.length === 1)
                      }
                      aria-label={ko ? "제거" : "Remove"}
                    >
                      ×
                    </button>
                  </span>
                </li>
              );
            })}
          </ol>
        )}
        <button
          type="button"
          className="dashboard-runtime-pool-add"
          onClick={() => void addCurrentAsMember(role)}
          disabled={busy || !views[role].runtime}
        >
          {ko ? "+ 현재 선택을 풀에 추가" : "+ Add current selection to pool"}
        </button>
      </div>
    );
  }

  function renderRole(role: RuntimeRole) {
    const view = views[role];
    const active = view.runtime;
    const inherited = view.inherited;
    const title =
      role === "orchestrator"
        ? "Orchestrator"
        : ko
          ? "Worker"
          : "Worker";
    const note =
      role === "orchestrator"
        ? ko
          ? "채팅, 팀 계획·합성, 검증 판단이 이 모델을 사용합니다."
          : "Chats, team planning, synthesis, and verification use this model."
        : ko
          ? "팀 워커, 백그라운드 작업, 빌려온 에이전트 실행이 사용합니다."
          : "Team workers, background jobs, and borrowed agents use this model.";
    return (
      <section
        className="dashboard-runtime-role"
        data-role={role}
        key={role}
      >
        <div className="dashboard-runtime-role-head">
          <strong>{title}</strong>
          {active && (
            <span className="dashboard-module-meta">
              {runtimeSubLabel(active, ko)}
            </span>
          )}
        </div>
        {role === "worker" && (
          <div className="dashboard-runtime-inherit">
            <label>
              <input
                type="radio"
                checked={inherited}
                onChange={() => void setWorkerInheritance(true)}
                disabled={busy}
              />
              {ko ? "오케스트레이터와 동일" : "Same as orchestrator"}
            </label>
            <label>
              <input
                type="radio"
                checked={!inherited}
                onChange={() => void setWorkerInheritance(false)}
                disabled={busy}
              />
              {ko ? "직접 지정" : "Choose directly"}
            </label>
          </div>
        )}
        {active && (
          <div className="dashboard-runtime-row">
            <label>
              <span>{ko ? "엔진" : "Engine"}</span>
              <select
                value={String(view.index)}
                onChange={(event) =>
                  void activateRuntime(role, event.target.value)
                }
                disabled={busy || inherited}
              >
                {runtimeOptions.map(({ runtime, index, label }) => (
                  <option
                    key={`${runtime.kind}:${runtime.backend}:${runtime.source}`}
                    value={index}
                  >
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>{ko ? "모델" : "Model"}</span>
              <select
                value={active.model ?? ""}
                onChange={(event) =>
                  void activateModel(role, event.target.value)
                }
                disabled={
                  busy ||
                  inherited ||
                  modelsByRole[role].length === 0
                }
              >
                {active.kind !== "byok" &&
                  !LOCAL_MODEL_KINDS.has(active.kind) && (
                    <option value="">
                      {ko ? "구독 기본" : "Subscription default"}
                    </option>
                  )}
                {modelsByRole[role].map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                    {model.tag
                      ? ` · ${cliModelTagLabel(model.tag, locale)}`
                      : ""}
                  </option>
                ))}
              </select>
            </label>
            {(active.efforts?.length ?? 0) > 0 && (
              <label>
                <span>{ko ? "작업량" : "Effort"}</span>
                <select
                  value={active.effort ?? ""}
                  onChange={(event) =>
                    void activateEffort(role, event.target.value)
                  }
                  disabled={busy || inherited}
                >
                  <option value="">{ko ? "기본" : "Default"}</option>
                  {active.efforts?.map((effort) => (
                    <option key={effort.id} value={effort.id}>
                      {effort.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        )}
        {renderPool(role)}
        <div className="dashboard-runtime-note">{note}</div>
      </section>
    );
  }

  const anyActive = views.orchestrator.runtime || views.worker.runtime;
  return (
    <div
      className="dashboard-module dashboard-runtime-control"
      data-busy={busy ? "true" : "false"}
    >
      <div className="dashboard-module-head">
        <span>{ko ? "역할별 기본 모델" : "Role model defaults"}</span>
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
          {ROLES.map(renderRole)}
          {message && (
            <div className="dashboard-runtime-message">{message}</div>
          )}
        </>
      )}
    </div>
  );
}
