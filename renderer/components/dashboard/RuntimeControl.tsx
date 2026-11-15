"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { effortLabel, effortOptions } from "@/lib/effort-label";
import { ipc, ipcEvents } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import { invalidateViewData, loadViewData, readViewData, writeViewData } from "@/lib/view-data-cache";
import type {
  RuntimeRole,
  RuntimeRolePoolState,
  RuntimeSelection,
  RuntimeStatus,
} from "@/lib/types";
import {
  RuntimeModelPicker,
  runtimeEffectiveModelId,
  runtimeModelFallbackLabel,
  type RuntimeModelPickerOption,
} from "./RuntimeModelPicker";
import { runtimeUsesEngineModelSetting } from "@shared/models";
import { runtimeIdentityKey, runtimeMatchesSelection as sharedRuntimeMatchesSelection, selectionForRuntime } from "@shared/runtime-selection";
import { describeRoleWriteFailure } from "@/lib/runtime-role-failure";
import type { LocalModelHubSnapshot, LocalModelInstallationReceipt } from "@shared/local-model-hub";
import { Select } from "@/components/Select";
import { IconClose, IconImage, IconNetwork, IconPlus, IconUsers, IconWand } from "@/components/Icon";
import { COPY, pick } from "./dashboard-copy";
import s from "./Dashboard.module.css";
import { RUNTIME_CHIPS, RuntimeConnectPopup, connectCopy, type RuntimeChipSpec } from "@/components/connect/RuntimeConnect";
import { discoverySignInRequired } from "@shared/model-discovery";

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
  "agentlas-local": "Agentlas Local · On-device",
  agentlas: "Agentlas",
};

const BACKEND_LABEL: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  ollama: "Ollama",
  lmstudio: "LM Studio",
  mlx: "MLX",
  "agentlas-local": "Agentlas Local · On-device",
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

function runtimeKey(runtime: Pick<RuntimeStatus, "kind" | "backend" | "source" | "acpAgentId">): string {
  return runtimeIdentityKey(runtime);
}

function runtimeMatchesSelection(
  runtime: RuntimeStatus,
  selection: RuntimeSelection,
): boolean {
  return sharedRuntimeMatchesSelection(runtime, selection);
}

function selectionKey(selection: RuntimeSelection): string {
  return [
    selection.kind,
    selection.backend ?? "",
    selection.source ?? "",
    selection.acpAgentId ?? "",
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

type DiscoveryNote = { key: string; text: string; signIn?: boolean; connect?: RuntimeChipSpec };

/**
 * One line per runtime whose model listing failed. "Not signed in" is its own state (discoverySignInRequired:
 * ACP's typed refusal or the CLI's own signed-out answer) and says so, with the Connect action that runs the CLI's
 * sign-in. A signed-out grok used to read "could not read the model list. Check the connection …" (Windows 2026-10-24).
 */
export function modelDiscoveryNotes(runtimes: RuntimeStatus[], ko: boolean): DiscoveryNote[] {
  const notes: DiscoveryNote[] = [];
  const seen = new Set<string>();
  for (const runtime of runtimes) {
    if (runtime.credentialAccess?.status === "unavailable") continue;
    if (runtime.modelDiscovery?.status !== "failed") continue;
    const key = runtimeKey(runtime);
    if (seen.has(key)) continue;
    seen.add(key);
    const label = runtimeLabel(runtime);
    if (discoverySignInRequired(runtime.modelDiscovery.reason)) {
      const connect = RUNTIME_CHIPS.find((chip) => chip.kind === runtime.kind);
      notes.push({
        key,
        signIn: true,
        ...(connect ? { connect } : {}),
        text: connect
          ? (ko ? `${label}: 로그인이 필요해요.` : `${label}: sign in required.`)
          : (ko ? `${label}: 로그인이 필요해요. 이 에이전트의 로그인 명령으로 로그인한 뒤 다시 확인해 주세요.`
            : `${label}: sign in required. Sign in with this agent's own login command, then check again.`),
      });
      continue;
    }
    // Discovery reasons can contain RPC bodies and headers. Keep diagnostics
    // in the host; a cached or selected model does not make this probe succeed.
    const noCodexCache = runtime.kind === "codex" && runtime.modelDiscovery.reason === "no-cache";
    notes.push({
      key,
      text: noCodexCache
        ? ko
          ? `${label}: 최신 모델 목록을 확인하지 못했어요. 터미널에서 codex login을 마친 뒤 다시 확인해 주세요.`
          : `${label}: could not check the current model list. Finish codex login in a terminal, then check again.`
        : ko
          ? `${label}: 모델 목록을 불러오지 못했어요. 연결 상태와 모델 사용 권한을 확인해 주세요.`
          : `${label}: could not read the model list. Check the connection and model access permissions.`,
    });
  }
  return notes;
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
  const [localModelSnapshot, setLocalModelSnapshot] = useState<LocalModelHubSnapshot | null>(null);
  const [localModelBusy, setLocalModelBusy] = useState(false);
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
  const discoveryNotes = useMemo(() => modelDiscoveryNotes(runtimes, ko), [runtimes, ko]);
  const [connectSpec, setConnectSpec] = useState<RuntimeChipSpec | null>(null);
  const multimodalRuntimes = useMemo(
    // The local generate_image tool has executable adapters only for these
    // two CLIs. Input-vision support on a chat model is not image generation.
    // 로컬 모델은 비전 프로젝터(mmproj)가 붙어 이미지를 읽을 수 있을 때만 이 자리에 온다
    // (오너 2026-09-13: "로컬 멀티모달 모델 있으면 등록되야함").
    () => runtimes.filter(
      (runtime) => runtime.kind === "codex" || runtime.kind === "antigravity"
        || (runtime.kind === "agentlas-local"
          && Object.values(runtime.allocationModelProfiles ?? {}).some((profile) => profile.supportsMultimodal === true)),
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

  const loadLocalModelSnapshot = useCallback(async () => {
    const api = ipc();
    if (!api?.localModelHub) return null;
    try {
      const snapshot = await api.localModelHub.snapshot();
      setLocalModelSnapshot(snapshot);
      // The initial inventory can precede daemon readiness. Replace its
      // pending projection when this real snapshot settles, without polling.
      invalidateViewData("dashboard.runtimes");
      try {
        const detected = await loadViewData("dashboard.runtimes", () => api.runtime.detect(), { maxAgeMs: 300_000 });
        setRuntimes(detected);
      } catch {
        // A connection inventory failure does not invalidate this snapshot.
      }
      return snapshot;
    } catch {
      setLocalModelSnapshot(null);
      return null;
    }
  }, []);

  useEffect(() => { void loadLocalModelSnapshot(); }, [loadLocalModelSnapshot]);

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
          ? "모델 연결 상태를 새로 확인하지 못해 마지막 확인 결과를 보여 줘요. 새로고침으로 다시 시도해 주세요."
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
      void loadLocalModelSnapshot();
    });
  }, [load, loadLocalModelSnapshot, loadPool]);

  function localInstallationForSelection(
    snapshot: LocalModelHubSnapshot,
    selection: RuntimeSelection,
  ): LocalModelInstallationReceipt | null {
    if (selection.kind !== "agentlas-local") return null;
    const sourceInstallationId = selection.source?.split(":").at(-1);
    const exact = sourceInstallationId
      ? snapshot.modelInstallations.find((item) => item.installationId === sourceInstallationId)
      : null;
    if (exact && (!selection.model || exact.fileName === selection.model)) return exact;
    const matchingModel = snapshot.modelInstallations.filter((item) => item.fileName === selection.model);
    return matchingModel.length === 1 ? matchingModel[0] : null;
  }

  async function toggleLocalModel(selection: RuntimeSelection) {
    const api = ipc();
    if (!api?.localModelHub || localModelBusy) return;
    setLocalModelBusy(true);
    try {
      const before = await api.localModelHub.snapshot();
      const installation = localInstallationForSelection(before, selection);
      const selectedModelIsResident = Boolean(installation && before.resident?.installationId === installation.installationId);
      if (selectedModelIsResident && before.resident) {
        await api.localModelHub.unload({ processEpoch: before.resident.processEpoch, cancelActiveRuns: false });
        say(ko ? "로컬 모델을 껐어요. GPU와 메모리를 해제했어요." : "Local model turned off. GPU and memory were released.");
      } else {
        if (!installation) {
          throw new Error("local_model_selection_unavailable");
        }
        const receipt = await api.localModelHub.loadModel({ installationId: installation.installationId, contextTokens: 0, operationId: crypto.randomUUID() });
        if (receipt.state !== "resident") throw new Error(receipt.reasonCode ?? "model_load_failed");
        say(ko ? `${installation.fileName} 모델을 켰어요.` : `${installation.fileName} is on.`);
      }
      const [snapshot, detected, nextPool] = await Promise.all([
        api.localModelHub.snapshot(),
        api.runtime.detect(),
        api.runtime.listRoleMembers?.(),
      ]);
      setLocalModelSnapshot(snapshot);
      writeViewData("dashboard.runtimes", detected);
      setRuntimes(detected);
      if (nextPool) {
        writeViewData("dashboard.runtime-role-pool", nextPool);
        setPool(nextPool);
      }
    } catch (error) {
      const code = error instanceof Error ? error.message : String(error);
      say(
        code === "local_model_runs_active"
          ? (ko ? "로컬 모델이 작업 중이라 끄지 못했어요. 작업이 끝난 뒤 다시 꺼 주세요." : "The local model is working, so it stayed on. Turn it off after the run finishes.")
          : code === "local_model_selection_unavailable"
            ? (ko ? "이 후보와 일치하는 설치된 모델이 없어요. 로컬 모델 화면에서 다시 선택해 주세요." : "No installed model matches this candidate. Choose it again on the Local Models screen.")
              : (ko ? `로컬 모델을 전환하지 못했어요.` : `Could not switch the local model.`),
        "error",
      );
      await loadLocalModelSnapshot();
    } finally {
      setLocalModelBusy(false);
    }
  }

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
    return runtimesForRole(role).filter((runtime) => runtime.credentialAccess?.status !== "unavailable").map((runtime, index) => ({
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
      const models = modelsByRuntime[runtimeKey(runtime)] ?? (runtime.availableModels ?? []).map((id) => ({ id, label: id }));
      if (runtimeUsesEngineModelSetting(runtime.kind)) {
        options.push({
          key: modelOptionKey(runtime, undefined),
          label: "",
          runtime,
          isDefault: true,
          // 모델을 비워 둔 선택은 행으로 보이지 않는다. 그 선택이 현재 값일 때 트리거 이름과
          // 하이라이트가 실제로 돌 모델(resolvesTo)을 가리킨다.
          ...((): { resolvesTo?: string } => {
            const id = runtimeEffectiveModelId({ ...runtime, model: undefined }, models);
            return id ? { resolvesTo: id } : {};
          })(),
          // 이 선택이 실제로 무엇으로 풀렸는지 — 실행이 알려준 값, 없으면 CLI 설정 파일의
          // 모델이 카탈로그에서 풀린 값만 붙는다.
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
    const installedLocalSelection = currentSelection.kind === "agentlas-local"
      && localModelSnapshot?.modelInstallations.some((item) => item.fileName === currentSelection.model) === true;
    const currentKey = currentRuntime
      ? modelOptionKey(currentRuntime, currentSelection.model)
      : `unavailable\u0000${selectionKey(currentSelection)}`;
    if (!options.some((option) => option.key === currentKey)) {
      const unavailableRuntime: RuntimeStatus = currentRuntime ?? {
        kind: currentSelection.kind,
        backend: currentSelection.backend ?? "custom",
        source: currentSelection.source ?? "unavailable",
        ...(currentSelection.acpAgentId ? { acpAgentId: currentSelection.acpAgentId } : {}),
        ...(currentSelection.label ? { label: currentSelection.label } : {}),
        version: null,
        active: false,
      };
      options.unshift({
        key: currentKey,
        model: currentSelection.model,
        label: currentSelection.model ?? runtimeModelFallbackLabel(currentSelection.kind, locale),
        runtime: unavailableRuntime,
        unavailable: !installedLocalSelection,
      });
    }
    return options;
  }

  async function writePool(
    role: RuntimeRole,
    selections: RuntimeSelection[],
    success = ko ? "후보 목록을 저장했어요." : "Candidate pool saved.",
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
    // Resolve the selected executable identity from this role's available runtimes.
    const roleRuntimes = runtimesForRole(selection.role ?? "orchestrator");
    return roleRuntimes.find((runtime) => runtimeMatchesSelection(runtime, selection)) ?? null;
  }

  function selectionFromRuntime(
    runtime: RuntimeStatus,
    role: RuntimeRole,
  ): RuntimeSelection {
    // 공용 조립기 — ACP 좌석(acpAgentId·label)까지 싣는다(역할 표는 v120 부터 그 열을 가진다).
    return selectionForRuntime(runtime, { role, inherit: false });
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
          ? "연결된 모델과 현재 역할에 맞춰 우선순위를 자동 설정했어요."
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
      ko ? "우선순위를 변경했어요." : "Priority updated.",
    );
  }

  async function moveMember(role: RuntimeRole, index: number, delta: number) {
    await reorderMember(role, index, index + delta);
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
      ko ? "후보를 추가했어요." : "Candidate row added.",
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

  /** Why a line is not the one in use, in words (no colour: a muted line under the row). The default line says nothing. */
  function lineNote(role: RuntimeRole, position: number, duplicate: boolean): string | null {
    if (duplicate) return pick(ko, COPY.duplicate);
    const skip = pool?.picks[role]?.skipped.find((entry) => entry.position === position);
    if (!skip) return null;
    return pick(ko, skip.reason === "quota-exceeded" ? COPY.skippedQuota : skip.reason === "model-unavailable" ? COPY.skippedModel : COPY.skippedMissing);
  }

  // F-D2b A: a line is dragged by its handle (only a role with two or more lines has handles). The order is the priority and a drop saves at once
  // through reorderMember -> writePool -> runtime.setRoleMembers, the same write Alt+Up / Alt+Down makes.
  const [drag, setDrag] = useState<{ role: RuntimeRole; from: number } | null>(null);
  const [dropAt, setDropAt] = useState<{ role: RuntimeRole; index: number; edge: "before" | "after" } | null>(null);
  function endDrag() { setDrag(null); setDropAt(null); }
  function dropTarget(role: RuntimeRole, from: number, hover: { index: number; edge: "before" | "after" }): number {
    const slot = hover.edge === "before" ? hover.index : hover.index + 1;
    return slot > from ? slot - 1 : slot;
  }

  function renderLines(role: RuntimeRole) {
    const members = pool?.members[role] ?? [];
    const runtimeOptions = runtimeOptionsForRole(role);
    const roleName = pick(ko, role === "orchestrator" ? COPY.orchestrator : role === "multimodal" ? COPY.multimodal : COPY.worker);
    if (members.length === 0) {
      return (
        <>
          <button
            type="button"
            className={s.chooseBtn}
            data-testid={`models-choose-${role}`}
            // The pool unread (null) is unknown, not empty: a write now could replace lines this screen has not seen.
            disabled={busy || pool === null || runtimeOptions.length === 0}
            aria-label={`${roleName}: ${pick(ko, COPY.chooseModel)}`}
            onClick={() => void addMember(role)}
          >
            {pick(ko, COPY.chooseModel)}
          </button>
          {role === "multimodal" && runtimeOptions.length === 0 && <p className={s.mnote}>{pick(ko, COPY.noMultimodalCli)}</p>}
          {role === "worker" && <p className={s.mnote}>{pick(ko, COPY.workerEmpty)}</p>}
        </>
      );
    }
    return (
      <>
        {members.map((member, index) => {
          const selection = member.selection;
          const runtime = runtimeForSelection(selection);
          const installedLocalModel = selection.kind === "agentlas-local" && localModelSnapshot?.modelInstallations.some((item) => item.fileName === selection.model);
          const localInstallation = localModelSnapshot ? localInstallationForSelection(localModelSnapshot, selection) : null;
          const localModelOn = Boolean(localInstallation && localModelSnapshot?.resident?.installationId === localInstallation.installationId);
          const modelOptions = modelOptionsForRole(role, selection);
          const modelValue = runtime ? modelOptionKey(runtime, selection.model) : `unavailable\u0000${selectionKey(selection)}`;
          const efforts = effortsFor(runtime, selection.model);
          const effortValue = effortIsSupported(runtime, selection.model, selection.effort) ? selection.effort ?? "" : "";
          const duplicate = members.filter((candidate) => selectionKey(candidate.selection) === selectionKey(selection)).length > 1;
          const rowLabel = `${roleName} ${index + 1}`;
          const note = lineNote(role, member.position, duplicate);
          const isLocal = selection.kind === "agentlas-local";
          return (
            <div
              className={s.mline}
              data-runtime-pool-row
              data-runtime-pool-role={role}
              data-runtime-pool-index={index}
              key={`${member.position}:${selectionKey(selection)}`}
              data-pool-position={member.position}
              data-with-switch={isLocal ? "true" : undefined}
              data-handle={members.length > 1 ? "true" : undefined}
              data-dragging={drag?.role === role && drag.from === index ? "true" : undefined}
              data-drop={dropAt?.role === role && dropAt.index === index && drag && dropTarget(role, drag.from, dropAt) !== drag.from ? dropAt.edge : undefined}
              data-line-count={members.length}
              onDragOver={(event) => {
                if (!drag || drag.role !== role) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                const box = event.currentTarget.getBoundingClientRect();
                const edge = event.clientY < box.top + box.height / 2 ? "before" : "after";
                if (dropAt?.role !== role || dropAt.index !== index || dropAt.edge !== edge) setDropAt({ role, index, edge });
              }}
              onDrop={(event) => {
                if (!drag || drag.role !== role) return;
                event.preventDefault();
                const box = event.currentTarget.getBoundingClientRect();
                const edge = event.clientY < box.top + box.height / 2 ? "before" : "after";
                const from = drag.from;
                endDrag();
                void reorderMember(role, from, dropTarget(role, from, { index, edge }));
              }}
              // The order is the priority. The picture shows no number and no handle, so a line moves with Alt + the up / down arrow while focus is in it.
              onKeyDown={(event) => {
                if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
                event.preventDefault();
                void moveMember(role, index, event.key === "ArrowUp" ? -1 : 1);
              }}
              title={pick(ko, COPY.reorderHint)}
            >
              {members.length > 1 && (
                <span
                  className={s.grip}
                  data-testid="model-line-handle"
                  draggable={!busy}
                  aria-hidden="true"
                  title={pick(ko, COPY.reorderHint)}
                  onDragStart={(event) => {
                    if (busy) { event.preventDefault(); return; }
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", `${role}:${index}`);
                    const rowEl = event.currentTarget.closest<HTMLElement>("[data-runtime-pool-row]");
                    if (rowEl) event.dataTransfer.setDragImage(rowEl, 16, 20);
                    setDrag({ role, from: index });
                  }}
                  onDragEnd={endDrag}
                >
                  <svg width="12" height="16" viewBox="0 0 12 16" fill="currentColor"><circle cx="3.5" cy="3" r="1.3" /><circle cx="8.5" cy="3" r="1.3" /><circle cx="3.5" cy="8" r="1.3" /><circle cx="8.5" cy="8" r="1.3" /><circle cx="3.5" cy="13" r="1.3" /><circle cx="8.5" cy="13" r="1.3" /></svg>
                </span>
              )}
              <RuntimeModelPicker
                ariaLabel={`${rowLabel} ${pick(ko, COPY.model)}`}
                value={modelValue}
                options={modelOptions}
                locale={locale}
                disabled={busy}
                dashboardLook
                onSelect={(option) => void updateMemberModelSelection(role, index, option)}
              />
              <div className={s.eff} data-x={index > 0 ? "true" : "false"}>
                {efforts.length > 0 || selection.effort ? (
                  <Select
                    className={s.effortSelect}
                    aria-label={`${rowLabel} ${pick(ko, COPY.effort)}`}
                    value={effortValue}
                    aria-invalid={selection.effort && effortValue === "" ? "true" : undefined}
                    onChange={(event) => void updateMemberEffort(role, index, event.target.value)}
                    disabled={busy}
                  >
                    <option value="">{ko ? "기본" : "Default"}</option>
                    {efforts.map((effort) => <option key={effort.id} value={effort.id}>{effort.label}</option>)}
                  </Select>
                ) : (
                  <span className={s.effort}>{ko ? "기본" : "Default"}</span>
                )}
                {index > 0 && (
                  <button type="button" className={s.xBtn} onClick={() => void removeMember(role, index)} disabled={busy}
                    aria-label={`${pick(ko, COPY.remove)}: ${rowLabel}`} title={pick(ko, COPY.remove)}>
                    <IconClose size={14} />
                  </button>
                )}
              </div>
              {isLocal && (
                <button
                  type="button"
                  role="switch"
                  aria-checked={localModelOn}
                  aria-label={`${rowLabel} ${pick(ko, COPY.localSwitch)}`}
                  aria-busy={localModelBusy ? "true" : undefined}
                  className="dashboard-runtime-row-switch"
                  disabled={localModelBusy || !installedLocalModel || !localInstallation || Boolean(localModelSnapshot?.unavailableReason)}
                  onClick={() => void toggleLocalModel(selection)}
                  title={ko ? "이 로컬 모델의 GPU 사용을 켜거나 꺼요." : "Turns this local model's GPU resident process on or off."}
                >
                  <span className="dashboard-runtime-row-switch-track" aria-hidden="true"><span /></span>
                  <span>{localModelOn ? "ON" : "OFF"}</span>
                </button>
              )}
              {note && <p className={s.mnote}>{note}</p>}
            </div>
          );
        })}
        <button
          type="button"
          className={s.moreBtn}
          onClick={() => void addMember(role)}
          disabled={busy || pool === null || runtimeOptions.length === 0}
          // The same button on every role: the role name tells them apart.
          aria-label={`${roleName}: ${pick(ko, COPY.addFallback)}`}
          title={pick(ko, COPY.addFallback)}
        >
          <IconPlus size={14} />
        </button>
        {members.length > 1 && (
          <p className={s.orderHint} data-testid="model-order-hint">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 13V3M2.5 5.5L5 3l2.5 2.5M11 3v10M8.5 10.5L11 13l2.5-2.5" /></svg>
            {pick(ko, COPY.orderHint)}
          </p>
        )}
      </>
    );
  }

  function renderRole(role: RuntimeRole) {
    const view = views[role];
    const active = view.runtime;
    const checking = active?.localObservation?.state === "pending";
    const connected = Boolean(active) && !checking;
    const RoleIcon = role === "orchestrator" ? IconNetwork : role === "multimodal" ? IconImage : IconUsers;
    const roleName = pick(ko, role === "orchestrator" ? COPY.orchestrator : role === "multimodal" ? COPY.multimodal : COPY.worker);
    return (
      <section className={s.role} data-role={role} key={role}>
        <h3 className={s.roleHead}>
          <RoleIcon size={17} />
          {roleName}
          <i className={s.statusDot} data-tone={connected ? "ok" : "idle"} role="img"
            aria-label={checking ? pick(ko, COPY.checkingReadiness) : connected ? pick(ko, COPY.connected) : pick(ko, COPY.waiting)}
            title={checking ? pick(ko, COPY.checkingReadiness) : connected ? pick(ko, COPY.connected) : pick(ko, COPY.waiting)} />
        </h3>
        {renderLines(role)}
      </section>
    );
  }

  const anyActive = runtimes.some((runtime) => runtime.localObservation?.state !== "pending");
  const localPending = runtimes.some((runtime) => runtime.localObservation?.state === "pending");
  const localInstalled = (localModelSnapshot?.modelInstallations.length ?? 0) > 0;
  return (
    <section id="runtime-roles" className={s.card} data-tour-id="dashboard.worker-model" data-busy={busy ? "true" : "false"} aria-labelledby="dashboard-models-title">
      <div className={s.cardHead}>
        <h2 className={s.h} id="dashboard-models-title">{pick(ko, COPY.models)}</h2>
        <button
          type="button"
          className={s.iconBtn}
          aria-label={pick(ko, COPY.autoSet)}
          title={pick(ko, COPY.autoSet)}
          onClick={() => void autoConfigureRoles()}
          disabled={busy || runtimes.length === 0}
        >
          <IconWand size={16} />
        </button>
      </div>
      {loading ? (
        <p className={s.emptyBody}>{pick(ko, COPY.checkingRuntimes)}</p>
      ) : !anyActive && !localInstalled && !localPending ? (
        // A failed read of the connections is not "nothing is connected": it says so, with its retry.
        messageTone === "error" && message ? (
          <p className={s.note} data-tone="error" role="alert">
            {message}
            <button type="button" className={`${s.btn} ${s.inlineBtn}`} onClick={() => { invalidateViewData("dashboard.runtimes"); void load(); void loadPool(); }}>{pick(ko, COPY.retry)}</button>
          </p>
        ) : (
          <p className={s.emptyBody}>{pick(ko, COPY.noRuntime)}</p>
        )
      ) : (
        <>
          {localPending && (
            <p className={s.note} role="status" aria-live="polite">
              {ko ? "로컬 모델 준비 상태 확인 중" : "Checking local model readiness."}
            </p>
          )}
          {discoveryNotes.length > 0 && (
            <div className={s.note} role="status">
              <ul>
                {discoveryNotes.map((note) => (
                  <li key={note.key} data-sign-in-required={note.signIn ? "true" : undefined}>
                    {note.text}
                    {note.connect && (
                      <button type="button" className={s.btn}
                        aria-label={`${note.connect.name} — ${connectCopy(ko).connect}`}
                        onClick={() => setConnectSpec(note.connect ?? null)}>
                        {connectCopy(ko).connect}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {connectSpec && (
            <RuntimeConnectPopup
              spec={connectSpec}
              copy={connectCopy(ko)}
              onClose={() => setConnectSpec(null)}
              onDone={() => {
                setConnectSpec(null);
                // The sign-in cleared Main's detection caches; read the runtimes again, not the cached projection.
                invalidateViewData("dashboard.runtimes");
                const api = ipc();
                void api?.runtime.detect(true).then((detected) => setRuntimes(detected)).catch(() => undefined);
              }}
            />
          )}
          {renderRole("orchestrator")}
          {renderRole("worker")}
          {renderRole("multimodal")}
          {message && (
            <p className={s.note} data-tone={messageTone} role="status" aria-live="polite">
              {message}
            </p>
          )}
        </>
      )}
    </section>
  );
}
