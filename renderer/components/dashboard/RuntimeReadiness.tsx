"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ipc } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import { navigate } from "@/lib/navigation";
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
}

interface ReadinessSnapshot {
  version: string;
  checkedAt: number;
  overall: Exclude<ReadinessStatus, "checking" | "optional">;
  items: ReadinessItem[];
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

function activeRuntimeLabel(runtimes: RuntimeStatus[], ko: boolean): string {
  const active = runtimes.find((runtime) => runtime.active) ?? runtimes[0];
  if (!active) return ko ? "연결된 로컬 LLM 런타임이 없습니다." : "No local LLM runtime is connected.";
  const labels: Record<string, string> = {
    "claude-code": "Claude Code",
    codex: "Codex",
    antigravity: "Antigravity",
    grok: "Grok",
    byok: "BYOK API",
    ollama: "Ollama",
    lmstudio: "LM Studio",
    mlx: "MLX",
    agentlas: "Agentlas",
  };
  const model = active.model?.trim();
  const version = active.version && active.version !== "unknown" ? active.version : "";
  const detail = model || version || active.source;
  return [active.label ?? labels[active.kind] ?? active.kind, detail].filter(Boolean).join(" · ");
}

function updaterItem(state: UpdaterState | null, ko: boolean): ReadinessItem {
  if (!state) {
    return {
      id: "update",
      label: ko ? "업데이트" : "Update",
      detail: ko ? "업데이트 상태를 읽지 못했습니다. 설정에서 다시 확인하세요." : "Update state could not be read. Recheck it in Settings.",
      status: "attention",
    };
  }
  if (BLOCKING_UPDATER_STATES.has(state.status)) {
    return {
      id: "update",
      label: ko ? "업데이트" : "Update",
      detail: state.error || (ko ? "호환성 또는 복구 확인이 필요합니다." : "Compatibility or recovery needs attention."),
      status: "blocked",
    };
  }
  if (state.status === "error" || state.status === "manual-required") {
    return {
      id: "update",
      label: ko ? "업데이트" : "Update",
      detail: state.error || (ko ? "자동 적용을 중단했습니다. 현재 앱은 그대로 유지됩니다." : "Automatic apply stopped. The current app remains intact."),
      status: "attention",
    };
  }
  if (state.status === "available" || state.status === "downloading" || state.status === "downloaded") {
    return {
      id: "update",
      label: ko ? "업데이트" : "Update",
      detail: state.version
        ? (ko ? `v${state.version} 업데이트가 준비 중입니다.` : `Update v${state.version} is being prepared.`)
        : (ko ? "새 업데이트가 준비 중입니다." : "A new update is being prepared."),
      status: "attention",
    };
  }
  if (state.status === "idle" && !state.lastCheckedAt) {
    return {
      id: "update",
      label: ko ? "업데이트" : "Update",
      detail: ko ? "공식 업데이트 확인을 기다리고 있습니다." : "Waiting for the official update check.",
      status: "checking",
    };
  }
  return {
    id: "update",
    label: ko ? "업데이트" : "Update",
    detail: state.status === "checking"
      ? (ko ? "공식 업데이트 채널을 확인하고 있습니다." : "Checking the official update channel.")
      : (ko ? "현재 설치 상태에 차단 문제가 없습니다." : "The current installation has no blocking update issue."),
    status: state.status === "checking" ? "checking" : "ready",
  };
}

function overallStatus(items: ReadinessItem[]): ReadinessSnapshot["overall"] {
  if (items.some((item) => item.status === "blocked")) return "blocked";
  if (items.some((item) => item.status === "attention" || item.status === "checking")) return "attention";
  return "ready";
}

function statusText(status: ReadinessStatus, ko: boolean): string {
  const labels: Record<ReadinessStatus, [string, string]> = {
    checking: ["확인 중", "Checking"],
    ready: ["준비됨", "Ready"],
    attention: ["확인 필요", "Check"],
    blocked: ["차단됨", "Blocked"],
    optional: ["선택", "Optional"],
  };
  return labels[status][ko ? 0 : 1];
}

export function RuntimeReadiness() {
  const { locale } = useT();
  const ko = locale === "ko";
  const requestId = useRef(0);
  const [snapshot, setSnapshot] = useState<ReadinessSnapshot | null>(() => readinessCache.get(locale) ?? null);
  const [checking, setChecking] = useState(() => !readinessCache.has(locale));
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

    const [versionResult, sessionResult, runtimeResult, engineResult, engineJournalResult, hubResult, installedResult, pluginResult, updaterResult] = await Promise.allSettled([
      api.app.getVersion(),
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
      || (ko ? "호스트 앱" : "host apps");
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
      {
        id: "runtime",
        label: ko ? "로컬 LLM 런타임" : "Local LLM runtime",
        detail: activeRuntimeLabel(runtimes, ko),
        status: runtimes.length > 0 ? "ready" : "blocked",
      },
      {
        id: "account",
        label: ko ? "Agentlas 계정" : "Agentlas account",
        detail: session?.signedIn
          ? (session.email || session.name || (ko ? "Agent Cloud와 Hub를 사용할 수 있습니다." : "Agent Cloud and Hub are available."))
          : (ko ? "로컬 실행은 가능하지만 Cloud 저장과 Hub 호출은 제한됩니다." : "Local runs work, but Cloud saves and Hub calls are limited."),
        status: session?.signedIn ? "ready" : "attention",
      },
      {
        id: "agentlas-os",
        label: "Agentlas OS",
        detail: !engineRecovery?.verified || !engine
          ? (engineRecovery?.presentation?.summary ?? "")
          : deep && !doctor?.ok
            ? (ko ? "엔진은 있지만 자가진단을 통과하지 못했습니다." : "The engine exists but did not pass its self-check.")
            : engineUpdate.reloadRequired
              ? engineUpdate.state === "applied"
                ? (ko
                  ? `런타임 업데이트됨${engine.version ? ` · v${engine.version}` : ""}, ${pendingHostLabel} 재시작 대기`
                  : `Runtime updated${engine.version ? ` · v${engine.version}` : ""}; waiting for ${pendingHostLabel} to restart.`)
                : engineUpdate.state === "current"
                  ? (ko
                    ? `런타임은 최신입니다${engine.version ? ` · v${engine.version}` : ""}, ${pendingHostLabel} 재시작 대기`
                    : `Runtime is current${engine.version ? ` · v${engine.version}` : ""}; waiting for ${pendingHostLabel} to restart.`)
                  : (ko
                    ? `런타임 상태 확인 필요${engine.version ? ` · v${engine.version}` : ""}, ${pendingHostLabel} 재시작 대기`
                    : `Runtime status needs verification${engine.version ? ` · v${engine.version}` : ""}; waiting for ${pendingHostLabel} to restart.`)
            : engineUpdateUnknown
              ? (ko
                ? `엔진 사용 가능${engine.version ? ` · v${engine.version}` : ""} · 업데이트 결과를 판단하지 못했습니다.`
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
                    ? `앱에 고정된 엔진입니다${engine.version ? ` · v${engine.version}` : ""}`
                    : `Engine pinned to this app${engine.version ? ` · v${engine.version}` : ""}`)
                : (ko
                  ? `엔진 사용 가능${engine.version ? ` · v${engine.version}` : ""} · 업데이트 확인이 진행 중입니다.`
                  : `Engine available${engine.version ? ` · v${engine.version}` : ""} · update verification is in progress.`)
              // Settings warns about a manually pinned engine; this row used to
              // call the same state "ready". One situation must not get two
              // answers depending on which screen you opened.
              : engine.source === "override"
                ? (ko
                  ? `직접 지정한 경로의 엔진입니다${engine.version ? ` · v${engine.version}` : ""} — 자동으로 업데이트되지 않습니다.`
                  : `Using an engine at a path you set yourself${engine.version ? ` · v${engine.version}` : ""} — it will not update automatically.`)
              : deep
                ? (ko ? `자가진단 통과${engine.version ? ` · v${engine.version}` : ""}` : `Self-check passed${engine.version ? ` · v${engine.version}` : ""}`)
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
            ? (ko ? "Hub 카탈로그 일부만 확인됐습니다. 다시 확인해 주세요." : "Only part of the Hub catalog was verified. Recheck the connection.")
            : hub.usingFallback
            ? (ko ? "캐시된 목록을 사용 중입니다. 호출 전 연결을 다시 확인합니다." : "Using a cached catalog. Connectivity is rechecked before invocation.")
            : (ko ? "실시간 Hub 카탈로그에 연결됐습니다." : "Connected to the live Hub catalog."))
          : (ko ? "Hub가 오프라인입니다. 로컬 자산은 계속 실행할 수 있습니다." : "Hub is offline. Local assets can still run."),
        status: hub?.online && !hub.usingFallback && !hub.lastError ? "ready" : "attention",
      },
      {
        id: "plugins",
        label: ko ? "플러그인 · MCP" : "Plugins · MCP",
        detail: enabledPlugins.length === 0
          ? (ko ? "활성 플러그인이 없습니다. 필요한 작업에서만 추가하세요." : "No active plugins. Add them only when a task needs one.")
          : !pluginStatusObserved
            ? (ko ? "연결 상태를 아직 확인하지 못했습니다." : "Connection state has not been observed yet.")
          : pluginProblems.length === 0
            ? (deferredPlugins.length > 0
              ? (ko
                ? `${connectedPlugins}개 연결 확인 · ${deferredPlugins.length}개는 필요할 때만 브라우저를 엽니다.`
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
      version: fulfilled(versionResult) || "",
      checkedAt: Date.now(),
      overall: overallStatus(items),
      items,
    };
    readinessCache.set(locale, nextSnapshot);
    setSnapshot(nextSnapshot);
    setChecking(false);
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
          ? (ko ? "선택한 복구를 실행했고 Agentlas OS를 다시 확인했습니다." : "Ran the selected recovery and verified Agentlas OS again.")
          : (ko ? "이미 Agentlas OS가 준비되어 있어 추가 변경은 하지 않았습니다." : "Agentlas OS was already ready, so no additional change was made.")
        : receipt.presentation?.summary || (ko
          ? "선택한 복구를 실행했지만 Agentlas OS는 아직 확인이 필요합니다."
          : "The selected recovery ran, but Agentlas OS still needs attention.");
      setRecoveryNotice(terminalMessage);
      if (!await inspect(true)) {
        setRecoveryNotice(`${terminalMessage} ${ko
          ? "화면 상태만 새로고침하지 못했습니다. 같은 복구를 반복하지 말고 다시 확인해 주세요."
          : "Only the screen state failed to refresh. Do not repeat the recovery; run checks again."}`);
      }
    } catch {
      const refreshed = await inspect(true).catch(() => false);
      setRecoveryNotice(refreshed
        ? (ko
          ? "복구 응답의 정확한 결과를 확인하지 못해 현재 상태만 다시 읽었습니다. Agentlas OS 행을 확인하기 전에는 같은 복구를 반복하지 마세요."
          : "The exact recovery outcome could not be verified, so only the current state was re-read. Do not repeat the recovery until you check the Agentlas OS row.")
        : (ko
          ? "복구 요청 뒤 실제 상태를 확인하지 못했습니다. 같은 버튼을 반복하지 말고 전체 확인을 다시 실행해 주세요."
          : "The actual state could not be checked after the recovery request. Do not repeat the action; run all checks again."));
    } finally {
      setRecoveryActionBusy(null);
    }
  }, [inspect, ko, locale, recoveryActionBusy]);

  useEffect(() => {
    void inspect(false);
    return () => {
      requestId.current += 1;
    };
  }, [inspect]);

  const overall = checking && !snapshot ? "checking" : snapshot?.overall ?? "attention";
  const overallCopy = overall === "ready"
    ? (ko ? "이 PC에서 실행 준비됨" : "Ready to run on this computer")
    : overall === "blocked"
      ? (ko ? "실행 전 조치 필요" : "Action required before running")
      : overall === "checking"
        ? (ko ? "현재 환경 확인 중" : "Checking this environment")
        : (ko ? "로컬 실행 가능 · 일부 확인 필요" : "Local runs available · some checks needed");

  return (
    <section className="dashboard-module dashboard-readiness" aria-labelledby="dashboard-runtime-readiness-title">
      <div className="dashboard-module-head">
        <span id="dashboard-runtime-readiness-title">{ko ? "이 PC의 실행 준비 상태" : "Run readiness on this computer"}</span>
        <span className="dashboard-module-meta">{snapshot?.version ? `v${snapshot.version}` : "Desktop"}</span>
        <button
          type="button"
          data-dashboard-action="true"
          onClick={() => void inspect(true)}
          disabled={checking}
          aria-label={ko ? "런타임 전체 다시 확인" : "Run all readiness checks again"}
        >
          {checking ? (ko ? "확인 중" : "Checking") : (ko ? "전체 확인" : "Run checks")}
        </button>
      </div>
      <div className="dashboard-readiness-summary" data-readiness-overall={overall} role="status" aria-live="polite">
        <strong>{overallCopy}</strong>
        <span>{ko ? "실제 계정·런타임·엔진·Hub·플러그인·업데이트 상태입니다." : "Live account, runtime, engine, Hub, plugin, and update state."}</span>
      </div>
      {recoveryNotice ? <div className="dashboard-module-empty" role="status">{recoveryNotice}</div> : null}
      <div className="dashboard-readiness-grid">
        {(snapshot?.items ?? []).map((item) => (
          <div key={item.id} className="dashboard-readiness-item" data-readiness-id={item.id} data-readiness-status={item.status}>
            <div>
              <strong>{item.label}</strong>
              {item.detail && <span>{item.detail}</span>}
              {item.id === "plugins" && item.status === "attention" && (
                <button
                  type="button"
                  data-dashboard-action="true"
                  onClick={() => navigate("/settings")}
                >
                  {ko ? "설정 열기" : "Open settings"}
                </button>
              )}
              {item.actions?.map((action) => (
                <button
                  type="button"
                  key={action.actionId}
                  data-dashboard-action="true"
                  disabled={recoveryActionBusy !== null}
                  onClick={() => void runRecoveryAction(action)}
                >
                  {recoveryActionBusy === action.actionId ? (ko ? "확인 중…" : "Checking…") : action.label}
                </button>
              ))}
            </div>
            <span className="dashboard-readiness-state">{statusText(item.status, ko)}</span>
          </div>
        ))}
        {!snapshot && <div className="dashboard-module-empty">{ko ? "현재 상태를 확인하고 있습니다…" : "Checking the current state…"}</div>}
      </div>
      {snapshot && (
        <div className="dashboard-readiness-footnote">
          {ko
            ? "문제가 있어도 정상인 로컬 자산과 파일은 변경하지 않습니다. 전체 확인은 자가진단과 공식 업데이트 조회만 수행합니다."
            : "Checks do not modify healthy local assets or files. Run checks only adds an engine self-check and official update lookup."}
        </div>
      )}
    </section>
  );
}
