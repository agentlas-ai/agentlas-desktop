"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ipc } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import type {
  AuthSession,
  HephaestusCommandResult,
  HephaestusStatus,
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
}

interface ReadinessSnapshot {
  version: string;
  checkedAt: number;
  overall: Exclude<ReadinessStatus, "checking" | "optional">;
  items: ReadinessItem[];
}

const BLOCKING_UPDATER_STATES = new Set<UpdaterState["status"]>([
  "incompatible",
  "recovery-required",
]);
const HUB_READINESS_TIMEOUT_MS = 6_000;

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
    gemini: "Gemini",
    grok: "Grok",
    byok: "BYOK API",
    ollama: "Ollama",
    lmstudio: "LM Studio",
    mlx: "MLX",
  };
  const model = active.model?.trim();
  const version = active.version && active.version !== "unknown" ? active.version : "";
  const detail = model || version || active.source;
  return [labels[active.kind] ?? active.kind, detail].filter(Boolean).join(" · ");
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
  if (items.some((item) => item.status === "attention")) return "attention";
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
  const [snapshot, setSnapshot] = useState<ReadinessSnapshot | null>(null);
  const [checking, setChecking] = useState(true);

  const inspect = useCallback(async (deep: boolean) => {
    const api = ipc();
    if (!api) {
      setChecking(false);
      return;
    }
    const currentRequest = ++requestId.current;
    setChecking(true);

    const [versionResult, sessionResult, runtimeResult, engineResult, hubResult, installedResult, pluginResult, updaterResult] = await Promise.allSettled([
      api.app.getVersion(),
      api.auth.getSession(),
      api.runtime.detect(deep),
      api.hephaestus.status(locale),
      within(api.marketplace.status(deep), HUB_READINESS_TIMEOUT_MS),
      api.mcpTools.listInstalled(),
      api.mcpTools.status(),
      deep ? api.updater.check() : api.updater.getState(),
    ]);
    const engine = fulfilled(engineResult) as HephaestusStatus | null;
    let doctor: HephaestusCommandResult | null = null;
    if (deep && engine?.available) {
      doctor = await api.hephaestus.doctor().catch(() => null);
    }
    if (currentRequest !== requestId.current) return;

    const runtimes = (fulfilled(runtimeResult) ?? []) as RuntimeStatus[];
    const session = fulfilled(sessionResult) as AuthSession | null;
    const hub = fulfilled(hubResult) as MarketplaceSourceStatus | null;
    const installed = (fulfilled(installedResult) ?? []) as InstalledMcpServer[];
    const pluginStates = (fulfilled(pluginResult) ?? []) as McpServerStatus[];
    const enabledPlugins = installed.filter((plugin) => plugin.enabled);
    const connectedPlugins = pluginStates.filter((plugin) => plugin.connected).length;
    const pluginProblems = pluginStates.filter((plugin) => !plugin.connected);

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
        detail: engine?.available
          ? (deep
            ? (doctor?.ok
              ? (ko ? `자가진단 통과${engine.version ? ` · v${engine.version}` : ""}` : `Self-check passed${engine.version ? ` · v${engine.version}` : ""}`)
              : (ko ? "엔진은 있지만 자가진단을 통과하지 못했습니다." : "The engine exists but did not pass its self-check."))
            : (ko ? `Agentlas OS 엔진 사용 가능${engine.version ? ` · v${engine.version}` : ""}` : `Agentlas OS engine available${engine.version ? ` · v${engine.version}` : ""}`))
          : (engine?.reason || (ko ? "Agentlas OS 엔진을 찾지 못했습니다." : "Agentlas OS engine was not found.")),
        status: engine?.available && (!deep || doctor?.ok) ? "ready" : "blocked",
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
          : pluginProblems.length === 0
            ? (ko ? `${connectedPlugins}개 활성 연결 확인` : `${connectedPlugins} active connection${connectedPlugins === 1 ? "" : "s"} verified`)
            : (ko ? `${pluginProblems.length}개 연결에 자격증명 또는 서버 확인이 필요합니다.` : `${pluginProblems.length} connection${pluginProblems.length === 1 ? "" : "s"} need credentials or a server check.`),
        status: enabledPlugins.length === 0 ? "optional" : pluginProblems.length === 0 ? "ready" : "attention",
      },
      updaterItem(fulfilled(updaterResult) as UpdaterState | null, ko),
    ];

    setSnapshot({
      version: fulfilled(versionResult) || "",
      checkedAt: Date.now(),
      overall: overallStatus(items),
      items,
    });
    setChecking(false);
  }, [ko, locale]);

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
      <div className="dashboard-readiness-grid">
        {(snapshot?.items ?? []).map((item) => (
          <div key={item.id} className="dashboard-readiness-item" data-readiness-id={item.id} data-readiness-status={item.status}>
            <div>
              <strong>{item.label}</strong>
              <span>{item.detail}</span>
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
