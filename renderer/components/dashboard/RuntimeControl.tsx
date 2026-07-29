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
  const [modelsByRuntime, setModelsByRuntime] = useState<Record<string, ModelRow[]>>({});
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
    } catch (err) {
      setMessage(
        ko
          ? `풀을 저장하지 못했습니다. ${String(err)}`
          : `Could not save the pool. ${String(err)}`,
      );
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

  async function setWorkerInheritance(inherit: boolean) {
    if (inherit) {
      await writePool(
        "worker",
        [],
        ko
          ? "워커가 오케스트레이터 후보 풀을 따릅니다."
          : "Worker now follows the orchestrator pool.",
      );
      return;
    }
    if (poolSelections("worker").length > 0) return;
    const inheritedHead =
      poolSelections("orchestrator")[0] ??
      (runtimes[0] ? selectionFromRuntime(runtimes[0], "worker") : null);
    if (!inheritedHead) return;
    await writePool(
      "worker",
      [{ ...inheritedHead, role: "worker", inherit: false }],
      ko
        ? "워커 후보 행을 만들었습니다."
        : "Worker candidate row added.",
    );
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
                ? "비어 있음 — 후보 행을 추가하세요."
                : "Empty — add a candidate row."}
          </div>
        ) : (
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
                  key={`${member.position}:${selectionKey(selection)}`}
                  data-pool-position={member.position}
                >
                  <span className="dashboard-runtime-pool-order">{index + 1}</span>
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
                    {(efforts.length > 0 || selection.effort) && (
                      <label>
                        <span>{ko ? "작업량" : "Effort"}</span>
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
                      </label>
                    )}
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
                      onClick={() => void moveMember(role, index, -1)}
                      disabled={busy || index === 0}
                      aria-label={
                        ko
                          ? `${rowLabel} 위로 이동`
                          : `Move ${rowLabel.toLowerCase()} up`
                      }
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      onClick={() => void moveMember(role, index, 1)}
                      disabled={busy || index === members.length - 1}
                      aria-label={
                        ko
                          ? `${rowLabel} 아래로 이동`
                          : `Move ${rowLabel.toLowerCase()} down`
                      }
                    >
                      ↓
                    </button>
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
    const inherited =
      role === "worker" && (pool?.picks.worker?.inherited ?? view.inherited);
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
        data-tour-id={
          role === "worker" ? "dashboard.worker-model" : undefined
        }
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
        {renderPool(role)}
        <div className="dashboard-runtime-note">{note}</div>
      </section>
    );
  }

  const anyActive = runtimes.length > 0;
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
