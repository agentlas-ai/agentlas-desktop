"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ipc } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import { navigate } from "@/lib/navigation";
import s from "./Dashboard.module.css";
import { IconCloud, IconCpu, IconDownload, IconKey, IconPuzzle, IconToolchain } from "@/components/Icon";
import { classifyHephaestusUpdateJournal, hephaestusPendingHostLabels } from "@shared/hephaestus-update-contract";
import type {
  AuthSession,
  HephaestusCommandResult,
  HephaestusRecoveryResult,
  HephaestusUpdateJournal,
  InstalledMcpServer,
  MarketplaceSourceStatus,
  McpServerStatus,
  RuntimeStatus,
  UpdaterState,
} from "@/lib/types";

type ReadinessStatus = "checking" | "ready" | "attention" | "blocked" | "optional";

interface ReadinessItem {
  id: "runtime" | "account" | "agentlas-os" | "hub" | "plugins" | "update";
  label: string;
  detail: string;
  status: ReadinessStatus;
  actions?: Array<{ actionId: string; label: string }>;
  /** The update row's own button (everything else is a recovery action or "Open settings"). */
  todo?: "reopen" | "download";
}

interface ReadinessSnapshot {
  checkedAt: number;
  items: ReadinessItem[];
}

/**
 * F-D2b C: which item is drawn WHERE. The card holds only what the owner has to do and that nothing else on this screen already shows.
 *   runtime  -> "Connections and usage" (a signed-out CLI says "Sign in again", none connected says "Set up") and the Models card
 *   account  -> the account chip in the left menu (sign in lives there)
 *   hub      -> the Agent Hub card (its own offline label)
 *   agentlas-os, plugins, update -> this card
 * An item owned by another place never makes a row here, so one problem is told once.
 */
export const READINESS_OWNER: Record<ReadinessItem["id"], "card" | "connections" | "account-chip" | "agent-hub"> = {
  runtime: "connections",
  account: "account-chip",
  "agentlas-os": "card",
  hub: "agent-hub",
  plugins: "card",
  update: "card",
};
export function readinessRows(items: readonly ReadinessItem[]): ReadinessItem[] {
  return items.filter((item) => READINESS_OWNER[item.id] === "card" && (item.status === "attention" || item.status === "blocked"));
}

const READINESS_CACHE_MAX_AGE_MS = 60_000;
const readinessCache = new Map<"ko" | "en", ReadinessSnapshot>();

const BLOCKING_UPDATER_STATES = new Set<UpdaterState["status"]>([
  "incompatible",
]);
const HUB_READINESS_TIMEOUT_MS = 6_000;
// These are Desktop-owned capabilities, not user-installed integrations.
// Their readiness belongs to the OS/browser/computer-use surfaces and must not
// be misreported as credential problems in the user's plugin inventory.
const SYSTEM_MCP_CATALOG_IDS = new Set([
  "hephaestus-network",
  "agentlas-browser",
  "playwright",
  "cua-driver",
  "agentlas-time",
]);

function fulfilled<T>(result: PromiseSettledResult<T>): T | null {
  return result.status === "fulfilled" ? result.value : null;
}

function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`readiness check timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

const RUNTIME_KIND_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  antigravity: "Antigravity",
  grok: "Grok",
  kimi: "Kimi Code",
  cursor: "Cursor Agent",
  byok: "BYOK API",
  ollama: "Ollama",
  lmstudio: "LM Studio",
  mlx: "MLX",
  "agentlas-local": "Agentlas Local · On-device",
  acp: "ACP",
  agentlas: "Agentlas",
};

/** A pending local runtime is not ready for execution yet. */
function executableRuntimes(runtimes: RuntimeStatus[]): RuntimeStatus[] {
  return runtimes.filter((runtime) => runtime.localObservation?.state !== "pending");
}

function activeRuntimeLabel(runtimes: RuntimeStatus[], ko: boolean): string {
  const active = runtimes.find((runtime) => runtime.active) ?? runtimes[0];
  if (!active) return ko ? "연결된 로컬 모델이 없어요." : "No local LLM runtime is connected.";
  const labels = RUNTIME_KIND_LABELS;
  const model = active.model?.trim();
  const version = active.version && active.version !== "unknown" ? active.version : "";
  const detail = model || version || active.source;
  return [active.label ?? labels[active.kind] ?? active.kind, detail].filter(Boolean).join(" · ");
}

/**
 * "런타임이 목록에 있다"는 "쓸 수 있다"가 아니다.
 *
 * 이 항목은 runtimes.length > 0 이면 초록불이었다. 감지는 CLI 파일이 있고 버전이 나오는지만
 * 보므로, 계정이 만료된 런타임도 화면에는 "연결됨"으로 떴다. 사용자는 초록불을 보면서 실행마다
 * 인증 실패를 겪었고, 푸는 길은 터미널을 직접 열어 로그인하는 것뿐이었다.
 *
 * 실행이 실제로 낸 인증 실패는 이제 런타임 상태에 실려 온다. 그 사실이 있으면 초록불이 아니라
 * 할 일을 말한다.
 */
function runtimeItem(allRuntimes: RuntimeStatus[], ko: boolean): ReadinessItem {
  const runtimes = executableRuntimes(allRuntimes);
  const signedOut = runtimes.filter((runtime) => runtime.signInRequired);
  const pendingLocal = allRuntimes.find((runtime) => runtime.localObservation?.state === "pending");
  if (pendingLocal && (pendingLocal.active || runtimes.length === 0)) {
    return {
      id: "runtime",
      label: ko ? "로컬 모델" : "Local LLM runtime",
      detail: ko ? "로컬 모델 준비 상태 확인 중" : "Checking local model readiness.",
      status: "attention",
    };
  }
  if (runtimes.length === 0) {
    return {
      id: "runtime",
      label: ko ? "로컬 모델" : "Local LLM runtime",
      detail: activeRuntimeLabel(runtimes, ko),
      status: "blocked",
    };
  }
  if (signedOut.length > 0) {
    const names = signedOut.map((runtime) => runtime.label ?? RUNTIME_KIND_LABELS[runtime.kind] ?? runtime.kind).join(" · ");
    return {
      id: "runtime",
      label: ko ? "로컬 모델" : "Local LLM runtime",
      detail: ko
        ? `${names} 로그인이 만료됐어요. 설정 › 모델과 엔진에서 로그인해 주세요.`
        : `${names} needs signing in again. Sign in from Settings › Runtimes.`,
      status: "attention",
    };
  }
  return {
    id: "runtime",
    label: ko ? "로컬 모델" : "Local LLM runtime",
    detail: activeRuntimeLabel(runtimes, ko),
    status: "ready",
  };
}

function updaterItem(state: UpdaterState | null, ko: boolean): ReadinessItem {
  if (!state) {
    return {
      id: "update",
      label: ko ? "업데이트" : "Update",
      detail: ko ? "업데이트 상태를 불러오지 못했어요. 설정에서 다시 확인해 주세요." : "Update state could not be read. Recheck it in Settings.",
      status: "attention",
    };
  }
  if (BLOCKING_UPDATER_STATES.has(state.status)) {
    return {
      id: "update",
      label: ko ? "업데이트" : "Update",
      detail: state.error || (ko ? "호환성 또는 복구 확인이 필요해요." : "Compatibility or recovery needs attention."),
      status: "blocked",
    };
  }
  if (state.status === "error" || state.status === "manual-required") {
    return {
      id: "update",
      label: ko ? "업데이트" : "Update",
      detail: state.error || (ko ? "자동 적용을 중단했어요. 현재 앱은 그대로 유지돼요." : "Automatic apply stopped. The current app remains intact."),
      status: "attention",
      todo: state.status === "manual-required" ? "download" : undefined,
    };
  }
  if (state.status === "downloaded") {
    return {
      id: "update",
      label: ko ? "업데이트" : "Update",
      detail: state.version
        ? (ko ? `새 버전 ${state.version}이 준비됐어요 · 다시 열면 적용돼요` : `Version ${state.version} is ready · applies when you reopen`)
        : (ko ? "새 버전이 준비됐어요 · 다시 열면 적용돼요" : "A new version is ready · applies when you reopen"),
      status: "attention",
      todo: "reopen",
    };
  }
  if (state.status === "available" || state.status === "downloading") {
    // Being fetched by itself: nothing for the owner to do yet (the update banner shows the progress).
    return {
      id: "update",
      label: ko ? "업데이트" : "Update",
      detail: state.version
        ? (ko ? `v${state.version} 업데이트 준비 중` : `Update v${state.version} is being prepared.`)
        : (ko ? "새 업데이트 준비 중" : "A new update is being prepared."),
      status: "checking",
    };
  }
  if (state.status === "idle" && !state.lastCheckedAt) {
    return {
      id: "update",
      label: ko ? "업데이트" : "Update",
      detail: ko ? "공식 업데이트 확인 대기 중" : "Waiting for the official update check.",
      status: "checking",
    };
  }
  return {
    id: "update",
    label: ko ? "업데이트" : "Update",
    detail: state.status === "checking"
      ? (ko ? "공식 업데이트 채널 확인 중" : "Checking the official update channel.")
      : (ko ? "현재 설치 상태에 차단 문제가 없어요." : "The current installation has no blocking update issue."),
    status: state.status === "checking" ? "checking" : "ready",
  };
}

export function RuntimeReadiness() {
  const { locale } = useT();
  const ko = locale === "ko";
  const requestId = useRef(0);
  const [snapshot, setSnapshot] = useState<ReadinessSnapshot | null>(() => readinessCache.get(locale) ?? null);
  const [checking, setChecking] = useState(() => !readinessCache.has(locale));
  // The card draws a "checking" state only for a check the owner asked for (Check again); the quiet first read draws nothing.
  const [deepChecking, setDeepChecking] = useState(false);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateNote, setUpdateNote] = useState<string | null>(null);
  const [recoveryActionBusy, setRecoveryActionBusy] = useState<string | null>(null);
  const [recoveryNotice, setRecoveryNotice] = useState<string | null>(null);

  const inspect = useCallback(async (deep: boolean) => {
    const api = ipc();
    if (!api) {
      setChecking(false);
      return false;
    }
    const cached = readinessCache.get(locale);
    if (!deep && cached && Date.now() - cached.checkedAt <= READINESS_CACHE_MAX_AGE_MS) {
      setSnapshot(cached);
      setChecking(false);
      return true;
    }
    const currentRequest = ++requestId.current;
    setChecking(true);
    setDeepChecking(deep);

    const [sessionResult, runtimeResult, engineResult, engineJournalResult, hubResult, installedResult, pluginResult, updaterResult] = await Promise.allSettled([
      api.auth.getSession(),
      api.runtime.detect(deep),
      api.hephaestus.recover({ locale }),
      api.hephaestus.updateJournal(),
      within(api.marketplace.status(deep), HUB_READINESS_TIMEOUT_MS),
      api.mcpTools.listInstalled(),
      api.mcpTools.status(),
      deep ? api.updater.check() : api.updater.getState(),
    ]);
    const engineRecovery = fulfilled(engineResult) as HephaestusRecoveryResult | null;
    const engine = engineRecovery?.status ?? null;
    const engineJournal = fulfilled(engineJournalResult) as HephaestusUpdateJournal | null;
    const engineUpdate = classifyHephaestusUpdateJournal(engineJournal);
    const engineUpdateUnknown = Boolean(
      engineJournal && (engineUpdate.state === "unknown" || engineUpdate.state === "unobserved"),
    );
    const pendingHostLabel = hephaestusPendingHostLabels(engineJournal).join("/")
      || (ko ? "연결된 앱" : "host apps");
    let doctor: HephaestusCommandResult | null = null;
    if (deep && engine?.available) {
      doctor = await api.hephaestus.doctor().catch(() => null);
    }
    if (currentRequest !== requestId.current) return false;

    const runtimes = (fulfilled(runtimeResult) ?? []) as RuntimeStatus[];
    const session = fulfilled(sessionResult) as AuthSession | null;
    const hub = fulfilled(hubResult) as MarketplaceSourceStatus | null;
    const installed = (fulfilled(installedResult) ?? []) as InstalledMcpServer[];
    const pluginStates = (fulfilled(pluginResult) ?? []) as McpServerStatus[];
    const pluginStatusObserved = pluginResult.status === "fulfilled";
    const userPlugins = installed.filter((plugin) => !plugin.catalogId || !SYSTEM_MCP_CATALOG_IDS.has(plugin.catalogId));
    const userPluginIds = new Set(userPlugins.map((plugin) => plugin.id));
    const enabledPlugins = userPlugins.filter((plugin) => plugin.enabled);
    const userPluginStates = pluginStates.filter((plugin) => userPluginIds.has(plugin.id));
    const connectedPlugins = userPluginStates.filter((plugin) => plugin.connected).length;
    const deferredPlugins = userPluginStates.filter((plugin) => plugin.deferred === "interactive");
    const pluginProblems = userPluginStates.filter((plugin) => !plugin.connected && plugin.deferred !== "interactive");
    const pluginNames = new Map(userPlugins.map((plugin) => [plugin.id, plugin.name || plugin.nameEn || plugin.id]));
    const disconnectedNames = pluginProblems
      .map((plugin) => pluginNames.get(plugin.id) ?? plugin.id)
      .slice(0, 3)
      .join(" · ");

    const items: ReadinessItem[] = [
      runtimeItem(runtimes, ko),
      {
        id: "account",
        label: ko ? "Agentlas 계정" : "Agentlas account",
        detail: session?.signedIn
          ? (session.email || session.name || (ko ? "Agent Cloud와 Hub를 사용할 수 있어요." : "Agent Cloud and Hub are available."))
          : (ko ? "로컬 실행은 가능하지만 Cloud 저장과 Hub 호출은 제한돼요." : "Local runs work, but Cloud saves and Hub calls are limited."),
        status: session?.signedIn ? "ready" : "attention",
      },
      {
        id: "agentlas-os",
        label: "Agentlas OS",
        detail: !engineRecovery?.verified || !engine
          ? (engineRecovery?.presentation?.summary ?? "")
          : deep && !doctor?.ok
            ? (ko ? "엔진은 있지만 점검을 통과하지 못했어요." : "The engine exists but did not pass its self-check.")
            : engineJournal?.status === "failed"
              ? (ko ? "엔진 업데이트에 실패했어요. 다시 시도해 주세요." : "The engine update failed. Please try again.")
            : engineUpdate.reloadRequired
              ? engineUpdate.state === "applied"
                ? (ko
                  ? `엔진 업데이트됨${engine.version ? ` · v${engine.version}` : ""}, ${pendingHostLabel} 재시작 대기`
                  : `Runtime updated${engine.version ? ` · v${engine.version}` : ""}; waiting for ${pendingHostLabel} to restart.`)
                : engineUpdate.state === "current"
                  ? (ko
                    ? `엔진은 최신이에요${engine.version ? ` · v${engine.version}` : ""}, ${pendingHostLabel} 재시작 대기`
                    : `Runtime is current${engine.version ? ` · v${engine.version}` : ""}; waiting for ${pendingHostLabel} to restart.`)
                  : (ko
                    ? `엔진 상태 확인 필요${engine.version ? ` · v${engine.version}` : ""}, ${pendingHostLabel} 재시작 대기`
                    : `Runtime status needs verification${engine.version ? ` · v${engine.version}` : ""}; waiting for ${pendingHostLabel} to restart.`)
            : engineUpdateUnknown
              ? (ko
                ? `엔진 사용 가능${engine.version ? ` · v${engine.version}` : ""} · 업데이트 결과를 확인하지 못했어요.`
                : `Engine available${engine.version ? ` · v${engine.version}` : ""} · the update result could not be interpreted.`)
            : engine.source === "bundled"
              ? engineUpdate.state === "current" || engineUpdate.state === "applied"
                ? (ko
                  ? `현재 엔진 확인 완료${engine.version ? ` · v${engine.version}` : ""}`
                  : `Current engine verified${engine.version ? ` · v${engine.version}` : ""}`)
                // No journal at all is not a check in flight. A bundled engine is
                // pinned to the app — Settings calls it "앱에 들어 있는 고정본" —
                // so there is nothing to verify and nothing will ever arrive to
                // resolve it. Reporting "진행 중" left this row Checking forever
                // while Settings said the same engine was current, so one engine
                // got two answers depending on which screen you opened.
                : !engineJournal
                  ? (ko
                    ? `앱에 고정된 엔진이에요${engine.version ? ` · v${engine.version}` : ""}`
                    : `Engine pinned to this app${engine.version ? ` · v${engine.version}` : ""}`)
                : (ko
                  ? `엔진 사용 가능${engine.version ? ` · v${engine.version}` : ""} · 업데이트 확인 중`
                  : `Engine available${engine.version ? ` · v${engine.version}` : ""} · update verification is in progress.`)
              // Settings warns about a manually pinned engine; this row used to
              // call the same state "ready". One situation must not get two
              // answers depending on which screen you opened.
              : engine.source === "override"
                ? (ko
                  ? `직접 지정한 경로의 엔진이에요${engine.version ? ` · v${engine.version}` : ""} — 자동으로 업데이트되지 않아요.`
                  : `Using an engine at a path you set yourself${engine.version ? ` · v${engine.version}` : ""} — it will not update automatically.`)
              : deep
                ? (ko ? `점검 통과${engine.version ? ` · v${engine.version}` : ""}` : `Self-check passed${engine.version ? ` · v${engine.version}` : ""}`)
                : (ko ? `Agentlas OS 엔진 사용 가능${engine.version ? ` · v${engine.version}` : ""}` : `Agentlas OS engine available${engine.version ? ` · v${engine.version}` : ""}`),
        status: !engineRecovery?.verified || !engine
          ? (engineRecovery?.presentation ? "attention" : "checking")
          : engine.source === "override"
            ? "attention"
            : engineUpdate.reloadRequired || engineUpdateUnknown
              ? "attention"
            : "ready",
        actions: engineRecovery?.presentation?.options,
      },
      {
        id: "hub",
        label: "Hub",
        detail: hub?.online
          ? (hub.lastError
            ? (ko ? "Hub 카탈로그 일부만 확인했어요. 다시 확인해 주세요." : "Only part of the Hub catalog was verified. Recheck the connection.")
            : hub.usingFallback
            ? (ko ? "저장된 목록을 사용 중이에요. 호출 전에 연결을 다시 확인해요." : "Using a cached catalog. Connectivity is rechecked before invocation.")
            : (ko ? "실시간 Hub 카탈로그에 연결됐어요." : "Connected to the live Hub catalog."))
          : (ko ? "Hub가 오프라인이에요. 로컬 자산은 계속 실행할 수 있어요." : "Hub is offline. Local assets can still run."),
        status: hub?.online && !hub.usingFallback && !hub.lastError ? "ready" : "attention",
      },
      {
        id: "plugins",
        label: ko ? "플러그인 · MCP" : "Plugins · MCP",
        detail: enabledPlugins.length === 0
          ? (ko ? "활성 플러그인이 없어요. 필요한 작업에서만 추가해 주세요." : "No active plugins. Add them only when a task needs one.")
          : !pluginStatusObserved
            ? (ko ? "연결 상태를 아직 확인하지 못했어요." : "Connection state has not been observed yet.")
          : pluginProblems.length === 0
            ? (deferredPlugins.length > 0
              ? (ko
                ? `${connectedPlugins}개 연결 확인 · ${deferredPlugins.length}개는 필요할 때만 브라우저를 열어요.`
                : `${connectedPlugins} connection${connectedPlugins === 1 ? "" : "s"} verified · ${deferredPlugins.length} opens only when needed.`)
              : (ko ? `${connectedPlugins}개 활성 연결 확인` : `${connectedPlugins} active connection${connectedPlugins === 1 ? "" : "s"} verified`))
            : (ko
              ? `연결되지 않은 항목 ${pluginProblems.length}개 · ${disconnectedNames}`
              : `${pluginProblems.length} not connected · ${disconnectedNames}`),
        status: enabledPlugins.length === 0
          ? "optional"
          : !pluginStatusObserved
            ? "checking"
            : pluginProblems.length === 0 ? "ready" : "attention",
      },
      updaterItem(fulfilled(updaterResult) as UpdaterState | null, ko),
    ];

    const nextSnapshot: ReadinessSnapshot = {
      checkedAt: Date.now(),
      items,
    };
    readinessCache.set(locale, nextSnapshot);
    setSnapshot(nextSnapshot);
    setChecking(false);
    setDeepChecking(false);
    return true;
  }, [ko, locale]);

  const runRecoveryAction = useCallback(async (action: { actionId: string; label: string }) => {
    const api = ipc();
    if (!api || recoveryActionBusy) return;
    setRecoveryActionBusy(action.actionId);
    setRecoveryNotice(null);
    try {
      const receipt = await api.hephaestus.recover({ locale, actionId: action.actionId });
      if (receipt.actionId !== action.actionId || (!receipt.attempted && !receipt.verified)) {
        throw new Error("hephaestus_recovery_receipt_mismatch");
      }
      const terminalMessage = receipt.verified
        ? receipt.attempted
          ? (ko ? "선택한 복구를 실행하고 Agentlas OS를 다시 확인했어요." : "Ran the selected recovery and verified Agentlas OS again.")
          : (ko ? "이미 Agentlas OS가 준비돼 있어 변경하지 않았어요." : "Agentlas OS was already ready, so no additional change was made.")
        : receipt.presentation?.summary || (ko
          ? "선택한 복구를 실행했지만 Agentlas OS는 아직 확인이 필요해요."
          : "The selected recovery ran, but Agentlas OS still needs attention.");
      setRecoveryNotice(terminalMessage);
      if (!await inspect(true)) {
        setRecoveryNotice(`${terminalMessage} ${ko
          ? "복구 후 화면 상태만 불러오지 못했어요. 다시 확인해 주세요."
          : "Only the screen state failed to refresh. Do not repeat the recovery; run checks again."}`);
      }
    } catch {
      const refreshed = await inspect(true).catch(() => false);
      setRecoveryNotice(refreshed
        ? (ko
          ? "복구 결과를 정확히 확인하지 못해 현재 상태만 다시 읽었어요. Agentlas OS 항목을 확인하기 전에는 같은 복구를 반복하지 말아 주세요."
          : "The exact recovery outcome could not be verified, so only the current state was re-read. Do not repeat the recovery until you check the Agentlas OS row.")
        : (ko
          ? "복구 뒤 실제 상태를 확인하지 못했어요. 같은 버튼을 반복하지 말고 전체 확인을 다시 실행해 주세요."
          : "The actual state could not be checked after the recovery request. Do not repeat the action; run all checks again."));
    } finally {
      setRecoveryActionBusy(null);
    }
  }, [inspect, ko, locale, recoveryActionBusy]);

  const reopenToUpdate = useCallback(async () => {
    const api = ipc();
    if (!api || updateBusy) return;
    setUpdateBusy(true);
    setUpdateNote(null);
    try {
      const result = await api.updater.install();
      if (!result.accepted && result.blockedBy === "active-runs") {
        setUpdateNote(ko ? "진행 중인 작업이 있어요. 끝난 뒤 다시 눌러 주세요." : "Work is still running. Press again when it is done.");
      }
    } catch {
      setUpdateNote(ko ? "다시 열지 못했어요. 다시 확인을 눌러 주세요." : "Could not reopen. Press Check again.");
    } finally {
      setUpdateBusy(false);
    }
  }, [ko, updateBusy]);

  useEffect(() => {
    void inspect(false);
    return () => {
      requestId.current += 1;
    };
  }, [inspect]);

  const rows = snapshot ? readinessRows(snapshot.items) : [];
  // Nothing to do (or the first quiet read is still going): no card at all. The card shows after "Check again" is pressed, and turns into rows or nothing.
  if (deepChecking) {
    return (
      <section className={s.card} aria-labelledby="dashboard-readiness-title" data-tour-id="dashboard.readiness" data-readiness="checking">
        <div className={s.cardHead}>
          <WrenchGlyph />
          <h2 className={s.h} id="dashboard-readiness-title">{ko ? "이 데스크탑 상태 확인 중" : "Checking this computer"}</h2>
        </div>
        <p className={s.readyBody} role="status" aria-live="polite">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" className={s.spin}><path d="M8 1.8a6.2 6.2 0 1 0 6.2 6.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          {ko ? "확인 중…" : "Checking…"}
        </p>
      </section>
    );
  }
  if (rows.length === 0 && !recoveryNotice) return null;

  let darkTaken = false;
  return (
    <section className={s.card} aria-labelledby="dashboard-readiness-title" data-tour-id="dashboard.readiness" data-readiness="todo">
      <div className={s.cardHead}>
        <WrenchGlyph />
        <h2 className={s.h} id="dashboard-readiness-title">
          {ko ? `이 데스크탑에서 할 작업 ${rows.length}개` : `${rows.length} thing${rows.length === 1 ? "" : "s"} to do on this computer`}
        </h2>
        <button type="button" className={s.bandBtn} onClick={() => void inspect(true)} disabled={checking}>{ko ? "다시 확인" : "Check again"}</button>
      </div>
      {recoveryNotice ? <p className={s.note} role="status">{recoveryNotice}</p> : null}
      {rows.map((item) => {
        const buttons: Array<{ key: string; label: string; onClick: () => void; disabled?: boolean }> = [];
        for (const action of item.actions ?? []) {
          buttons.push({ key: action.actionId, label: recoveryActionBusy === action.actionId ? (ko ? "확인 중…" : "Checking…") : action.label, onClick: () => void runRecoveryAction(action), disabled: recoveryActionBusy !== null });
        }
        if (item.id === "plugins") buttons.push({ key: "settings", label: ko ? "설정 열기" : "Open settings", onClick: () => navigate("/settings") });
        if (item.todo === "reopen") buttons.push({ key: "reopen", label: ko ? "다시 열기" : "Reopen", onClick: () => void reopenToUpdate(), disabled: updateBusy });
        if (item.todo === "download") buttons.push({ key: "download", label: ko ? "내려받기" : "Download", onClick: () => void ipc()?.updater.openManualDownload() });
        return (
          <div key={item.id} className={s.todoRow} data-readiness-id={item.id} data-readiness-status={item.status}>
            <span className={s.todoIcon} aria-hidden="true">{readinessIcon(item.id)}</span>
            <div className={s.todoCopy}>
              <b>{item.label}</b>
              {item.detail && <span>{item.id === "update" && updateNote ? updateNote : item.detail}</span>}
            </div>
            {buttons.map((button) => {
              const dark = !darkTaken;
              darkTaken = true;
              return (
                <button key={button.key} type="button" className={dark ? s.darkBtn : s.bandBtn} data-dark={dark ? "true" : undefined} disabled={button.disabled} onClick={button.onClick}>{button.label}</button>
              );
            })}
          </div>
        );
      })}
    </section>
  );
}

/** Picture C: every row starts with an 18px line icon of what it is about. */
function readinessIcon(id: string) {
  if (id === "update") return <IconDownload size={18} />;
  if (id === "plugins") return <IconPuzzle size={18} />;
  if (id === "account") return <IconKey size={18} />;
  if (id === "hub") return <IconCloud size={18} />;
  if (id === "agentlas-os") return <IconToolchain size={18} />;
  return <IconCpu size={18} />;
}

function WrenchGlyph() {
  return <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10.2 2.2a3.3 3.3 0 0 0-3 4.4L2.4 11.4a1.4 1.4 0 0 0 2 2l4.8-4.8a3.3 3.3 0 0 0 4.4-3l-2 2-1.8-.4-.4-1.8 2-2a3.3 3.3 0 0 0-1.2-.2Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>;
}
