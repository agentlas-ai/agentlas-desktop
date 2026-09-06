// 대시보드 "엔진 사용량" 카드 — 모든 엔진을 카탈로그로 보여준다.
//   · 구독형(Claude·Codex): 연결 시 usage.snapshot()의 5시간/주간/일일 바.
//   · Antigravity: agy 연결 상태와 런타임이 제공한 모델 목록을 기준으로 표시한다.
//   · API키형(DeepSeek·GLM·Pi): 연결 시 "키 과금", 미연결 시 키 입력 팝업.
//   · Grok CLI: 실제 402가 확인되면 소진 상태와 공식 Usage 이동 버튼.
//   · 로컬(Ollama): "무제한".
// 미연결 엔진은 [연결] 버튼 — CLI는 자동설치+로그인창, API키는 인라인 입력 후 저장.
// 연결 액션은 대시보드에서 항상 보여야 한다. 사용자가 예전에 접은 상태 때문에
// "LLM 연결이 사라진" 것처럼 보이지 않도록 이 표면은 접지 않는다.
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ipc, ipcEvents } from "@/lib/ipc";
import { useVisibleInterval } from "@/lib/useVisibleInterval";
import { useT } from "@/lib/i18n";
import { navigate } from "@/lib/navigation";
import { loadViewData, readViewData, writeViewData } from "@/lib/view-data-cache";
import type {
  CliRuntimeVersionStatus,
  EnvVarMeta,
  ProviderUsage,
  RuntimeStatus,
  UsageRetryProviderId,
  UsageSnapshot,
  UsageWindow,
} from "@/lib/types";

// 사용량 %는 몇 분 단위로만 변하고, Main의 usage snapshot/어댑터 캐시가
// 실제 공급자 호출을 막는다. 여기서는 Main 소유 `agy update`가 끝난 뒤
// 카드가 오래된 "auto-update failed" 상태를 붙잡지 않도록 15초마다 같은
// 캐시된 snapshot을 재확인한다(수동 새로고침만 force 조회).
const POLL_MS = 15_000;
const WARN_PCT = 80;
type EngineAuth = "cli" | "apikey" | "local";
interface EngineDef {
  id: string; // usage provider id와 일치(구독형)
  label: string;
  auth: EngineAuth;
  /** 우리가 설치/로그인을 대신 실행할 수 있는 CLI만 이 칸을 갖는다(IPC 계약과 동일 집합). */
  cliKind?: "claude-code" | "codex" | "antigravity" | "kimi" | "grok";
  /** 감지 전용 kind — 설치는 manualSetup으로 안내한다(cursor처럼 설치 API가 없는 경우). */
  detectKind?: "cursor";
  /** kind "acp"로 감지되는 내장 에이전트(전용 kind가 없다) — acpAgentId로 매칭한다. */
  acpAgentId?: string;
  /**
   * 우리가 대신 설치할 수 없는 CLI의 정확한 설치/인증 명령. 설치 경로가 없는데
   * "연결" 버튼만 두면 눌러도 아무 일이 없다 — 그럴 땐 명령을 그대로 보여준다.
   */
  manualSetup?: string;
  retryProviderId?: UsageRetryProviderId;
  keyEnv?: string;
  logoSrc: string;
  logoAlt: string;
}

const ENGINES: EngineDef[] = [
  { id: "claude-code", label: "Claude Code", auth: "cli", cliKind: "claude-code", retryProviderId: "claude-code", logoSrc: "/brand/llm/claude.svg", logoAlt: "Claude" },
  { id: "codex", label: "Codex", auth: "cli", cliKind: "codex", retryProviderId: "codex", logoSrc: "/brand/llm/openai.svg", logoAlt: "OpenAI" },
  { id: "antigravity", label: "Antigravity", auth: "cli", cliKind: "antigravity", logoSrc: "/brand/llm/googlegemini.svg", logoAlt: "Antigravity" },
  { id: "deepseek", label: "DeepSeek", auth: "apikey", keyEnv: "DEEPSEEK_API_KEY", logoSrc: "/brand/llm/deepseek.svg", logoAlt: "DeepSeek" },
  { id: "grok", label: "Grok", auth: "cli", cliKind: "grok", retryProviderId: "grok", keyEnv: "XAI_API_KEY", logoSrc: "/brand/llm/x.svg", logoAlt: "xAI" },
  { id: "glm", label: "GLM", auth: "apikey", keyEnv: "ZHIPU_API_KEY", logoSrc: "/brand/llm/zhipu.png", logoAlt: "Zhipu GLM" },
  { id: "kimi", label: "Kimi Code", auth: "cli", cliKind: "kimi", logoSrc: "/brand/llm/kimi.svg", logoAlt: "Kimi Code" },
  // 실행되는 런타임과 이 목록은 반드시 같아야 한다(오너 결정 2026-08-18). cursor와
  // Copilot CLI는 실제로 실행되는데 여기 없어서 대시보드에서 연결할 길이 없었다.
  { id: "cursor", label: "Cursor", auth: "cli", detectKind: "cursor", manualSetup: "curl https://cursor.com/install -fsS | bash", logoSrc: "/brand/llm/cursor.svg", logoAlt: "Cursor" },
  { id: "github-copilot-cli", label: "GitHub Copilot", auth: "cli", acpAgentId: "github-copilot-cli", manualSetup: "gh auth login", logoSrc: "/brand/llm/githubcopilot.svg", logoAlt: "GitHub Copilot" },
  { id: "ollama", label: "Ollama", auth: "local", logoSrc: "/brand/llm/ollama.svg", logoAlt: "Ollama" },
];

function windowLabel(w: UsageWindow, ko: boolean): string {
  const named = (label: string) => w.limitName ? `${w.limitName} · ${label}` : label;
  if (w.kind === "monthly") return ko ? "추가 크레딧" : "Extra credits";
  if (w.id.includes("-local-")) return ko ? (w.kind === "5h" ? "최근 5시간(로컬)" : "최근 7일(로컬)") : w.kind === "5h" ? "Last 5h (local)" : "Last 7d (local)";
  if (w.kind === "5h") return named(ko ? "5시간" : "5-hour");
  if (w.kind === "daily") return w.label || (ko ? "일일" : "Daily");
  if (w.model === "opus") return ko ? "Opus 7일" : "Opus 7d";
  if (w.model === "sonnet") return ko ? "Sonnet 7일" : "Sonnet 7d";
  if (w.kind === "7d") return named(ko ? "주간(7일)" : "Weekly (7d)");
  return w.label || (ko ? "사용량 한도" : "Usage limit");
}

function formatReset(resetAt: number | null | undefined, ko: boolean): string {
  if (!resetAt) return "";
  const diff = resetAt - Date.now();
  const pre = ko ? "리셋 " : "resets in ";
  if (diff <= 0) return ko ? "리셋 임박" : "resetting";
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return `${pre}${mins}${ko ? "분" : "m"}`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) {
    const m = mins % 60;
    return `${pre}${hrs}${ko ? "시간" : "h"}${m ? ` ${m}${ko ? "분" : "m"}` : ""}`;
  }
  return `${pre}${Math.round(hrs / 24)}${ko ? "일" : "d"}`;
}

// "12.4 / 50" 대신 통화코드가 오면 실제 통화로 — 청구액은 단위 없이 쓰면 안 된다.
function formatCredits(used: number, limit: number, unit?: string | null): string {
  const code = typeof unit === "string" && /^[A-Za-z]{3}$/.test(unit) ? unit.toUpperCase() : null;
  if (code) {
    try {
      const fmt = new Intl.NumberFormat(undefined, { style: "currency", currency: code, maximumFractionDigits: 2 });
      return `${fmt.format(used)} / ${fmt.format(limit)}`;
    } catch {
      // 알 수 없는 코드 — 아래 일반 표기로 폴백
    }
  }
  const n = (v: number) => String(Math.round(v * 100) / 100);
  return `${n(used)} / ${n(limit)} ${unit || "credits"}`;
}

function formatTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(n);
}

function UsageBar({ w, ko }: { w: UsageWindow; ko: boolean }) {
  // 로컬 추정 창(unit="tokens", 서버 % 없음) — %바 대신 토큰 절대량을 보여준다.
  const isLocalTokens = w.unit === "tokens" && w.used != null;
  const pct = Math.round(w.usedPercent);
  if (isLocalTokens && pct === 0) {
    return (
      <div className="dashboard-usage-bar" data-local="true">
        <span>{windowLabel(w, ko)}</span>
        <div><div style={{ width: "0%" }} /></div>
        <span title={ko ? "로컬 로그 기준 실사용 토큰(서버 리밋 조회 대기)" : "tokens from local logs (server limit pending)"}>
          {formatTokens(w.used ?? 0)} {ko ? "토큰" : "tok"}
        </span>
        <span />
      </div>
    );
  }
  const warn = pct >= WARN_PCT;
  const fill = warn ? "var(--red-deep, var(--danger))" : "var(--accent)";
  // 월 크레딧(유료 초과분)엔 resets_at이 없어 마지막 칸이 늘 비어 있었다 —
  // %만 남으면 "얼마가 청구되는지"가 사라지므로, 어댑터가 계산해 둔
  // used/limit/통화를 그 칸에 그대로 보여준다.
  const money = w.kind === "monthly" && w.used != null && w.limit != null
    ? formatCredits(w.used, w.limit, w.unit)
    : null;
  return (
    <div className="dashboard-usage-bar">
      <span>{windowLabel(w, ko)}</span>
      <div>
        <div style={{ width: `${pct}%`, background: fill }} />
      </div>
      <span data-warn={warn ? "true" : "false"}>{pct}%</span>
      <span title={money ?? undefined}>{money ?? formatReset(w.resetAt, ko)}</span>
    </div>
  );
}

function ModelRoleUsage({ value, ko }: {
  value: UsageSnapshot["modelRoleUsage"];
  ko: boolean;
}) {
  if (!value) return null;
  // A cached snapshot may have been written by a pre-model-breakdown build.
  // Keep that old card renderable while the next Main snapshot backfills the
  // new exact model/effort rows.
  const modelBuckets = value.byModel ?? [];
  const workerPct = value.workerSharePercent;
  const orchestratorPct = value.totalObservedTokens > 0 ? 100 - workerPct : 0;
  const measurementLabel = value.measurement === "output-only"
    ? ko ? "관측 출력 토큰" : "observed output tokens"
    : ko ? "관측 전체 토큰" : "observed total tokens";
  return (
    <section className="dashboard-role-usage" aria-label={ko ? "모델 역할별 사용량" : "Model usage by role"}>
      <div className="dashboard-role-usage-head">
        <span>{ko ? "모델 역할 사용량 · 7일" : "Model role usage · 7d"}</span>
        <strong>{value.totalObservedTokens > 0
          ? ko ? `워커 ${workerPct}%` : `${workerPct}% worker`
          : ko ? "관측 데이터 없음" : "No observed usage"}</strong>
      </div>
      <div
        className="dashboard-role-usage-track"
        role="img"
        aria-label={
          value.totalObservedTokens > 0
            ? ko
              ? `오케스트레이터 ${orchestratorPct}%, 워커 ${workerPct}%`
              : `${orchestratorPct}% orchestrator, ${workerPct}% worker`
            : ko ? "관측된 모델 사용량 없음" : "No observed model usage"
        }
      >
        <span data-role="orchestrator" style={{ width: `${orchestratorPct}%` }} />
        <span data-role="worker" style={{ width: `${workerPct}%` }} />
      </div>
      <div className="dashboard-role-usage-legend">
        <span><i data-role="orchestrator" />Orch {formatTokens(value.orchestrator.observedTokens)} · {value.orchestrator.invocationCount}</span>
        <span><i data-role="worker" />Worker {formatTokens(value.worker.observedTokens)} · {value.worker.invocationCount}</span>
        <small>{measurementLabel} · {ko ? "공급자 쿼터는 계정 단위" : "provider quota is account-level"}</small>
      </div>
      {modelBuckets.length > 0 && (
        <div className="dashboard-role-usage-models" aria-label={ko ? "모델·작업량별 관측 사용량" : "Observed usage by model and effort"}>
          {modelBuckets.map((entry) => {
            const role = entry.role === "orchestrator" ? "Orch" : "Worker";
            const model = entry.model ?? (ko ? "모델 미상" : "unknown model");
            const effort = entry.effort ?? (ko ? "기본/미상" : "default/unknown");
            return (
              <span
                key={`${entry.role}:${entry.provider}:${entry.model ?? ""}:${entry.effort ?? ""}`}
                data-model-role-usage-row
                title={`${entry.provider} · ${model} · ${effort}`}
              >
                <b>{role}</b> · {entry.provider} · {model} · {effort} · {formatTokens(entry.observedTokens)} · {entry.invocationCount}
              </span>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function EngineUsage() {
  const { locale } = useT();
  const ko = locale === "ko";
  const [snap, setSnap] = useState<UsageSnapshot | null>(() => (
    readViewData<UsageSnapshot>("dashboard.usage")?.value ?? null
  ));
  const [runtimes, setRuntimes] = useState<RuntimeStatus[]>(() => (
    readViewData<RuntimeStatus[]>("dashboard.runtimes")?.value ?? []
  ));
  const [envKeys, setEnvKeys] = useState<Set<string>>(() => new Set(
    (readViewData<EnvVarMeta[]>("dashboard.env")?.value ?? []).filter((entry) => entry.hasValue).map((entry) => entry.key),
  ));
  const [busy, setBusy] = useState<string | null>(null);
  const [busyStage, setBusyStage] = useState<"install" | "login" | null>(null);
  const [usageLoadError, setUsageLoadError] = useState(false);
  const [notice, setNotice] = useState<{ id: string; text: string; command?: string } | null>(null);
  const [keyFor, setKeyFor] = useState<string | null>(null);
  const [keyVal, setKeyVal] = useState("");
  // 접이식 그룹(구독형·CLI / API 키 / 로컬). 기본 펼침.
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const usageRequestGen = useRef(0);

  const loadUsage = useCallback(async (force = false) => {
    const requestId = ++usageRequestGen.current;
    const api = ipc();
    if (!api) {
      if (usageRequestGen.current === requestId) setUsageLoadError(true);
      return;
    }
    try {
      const next = await loadViewData(
        "dashboard.usage",
        () => api.usage.snapshot(force ? { force: true } : undefined),
        { maxAgeMs: 10_000, force },
      );
      if (usageRequestGen.current !== requestId) return;
      setSnap(next);
      setUsageLoadError(false);
    } catch {
      // 공급자별 오류는 snapshot 안에 정규화된다. 여기까지 throw면 IPC 자체가 실패한 것이라
      // 조용히 빈 카드로 남기지 않고, 사용자가 즉시 다시 시도할 수 있게 한다.
      if (usageRequestGen.current === requestId) setUsageLoadError(true);
    }
  }, []);

  const loadConnections = useCallback(async () => {
    const api = ipc();
    if (!api) return;
    try {
      const [rt, env] = await Promise.all([
        loadViewData("dashboard.runtimes", () => api.runtime.detect(), { maxAgeMs: 300_000 }),
        loadViewData("dashboard.env", () => api.env.list(), { maxAgeMs: 15_000 }),
      ]);
      setRuntimes(rt);
      setEnvKeys(new Set(env.filter((e: EnvVarMeta) => e.hasValue).map((e) => e.key)));
    } catch {
      // ignore
    }
  }, []);

  const retryProviderUsage = useCallback(async (providerId: UsageRetryProviderId) => {
    const requestId = ++usageRequestGen.current;
    const api = ipc();
    if (!api) {
      if (usageRequestGen.current === requestId) setUsageLoadError(true);
      return;
    }
    try {
      const result = await api.usage.retry(providerId);
      if (usageRequestGen.current !== requestId) return;
      writeViewData("dashboard.usage", result.snapshot);
      setSnap(result.snapshot);
      setUsageLoadError(false);
      void loadConnections();
    } catch {
      if (usageRequestGen.current === requestId) setUsageLoadError(true);
    }
  }, [loadConnections]);

  // 초기 1회 load(usage+connections)는 유지, 주기 폴링(60s)은 loadUsage만 탭 보일 때 — useVisibleInterval이 hidden 시 정지.
  useEffect(() => {
    void loadUsage();
    void loadConnections();
  }, [loadUsage, loadConnections]);

  useEffect(() => {
    const events = ipcEvents();
    if (!events?.onStoreChanged) return;
    return events.onStoreChanged((change) => {
      if (change.entity === "runtime") void loadConnections();
    });
  }, [loadConnections]);
  useVisibleInterval(() => void loadUsage(), POLL_MS);

  // 재로그인은 터미널에서 끝난다 — 완료 시점을 앱이 폴링으로 감지해 자동 반영(15초 × 12 = 3분).
  const pollGen = useRef(0);
  useEffect(() => () => {
    pollGen.current++; // 언마운트 시 진행 중 폴링 중단
    usageRequestGen.current++; // 늦게 끝난 snapshot이 unmount 뒤 상태를 덮지 않게 한다.
  }, []);
  const watchRecovery = useCallback(
    async (providerId: string) => {
      const api = ipc();
      if (!api) return;
      const gen = ++pollGen.current;
      // 재로그인 완료 감지 폴링 — 예전엔 5초×36(3분간 usage 엔드포인트 폭격)이라 이 조회 자체가
      // 429를 유발했다. 로그인 브라우저 왕복은 보통 20초+ 걸리므로 15초 간격으로 충분하고,
      // 총 커버 시간(약 3분)은 유지하되 조회 횟수를 1/3로 줄인다.
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 15_000));
        if (pollGen.current !== gen) return;
        try {
          const requestId = ++usageRequestGen.current;
          const s = await api.usage.snapshot({ force: true });
          if (pollGen.current !== gen) return;
          if (usageRequestGen.current !== requestId) continue;
          writeViewData("dashboard.usage", s);
          setSnap(s);
          setUsageLoadError(false);
          const p = s.providers.find((x) => x.provider === providerId);
          // 429(일시 제한)는 '아직 로그인 안 됨'이 아니다 — 계속 폴링하면 제한만 길어지니 멈춘다.
          if (p && (p.status !== "error" || p.error === "rate_limited")) {
            void loadConnections();
            return;
          }
        } catch {
          // 다음 틱 재시도
        }
      }
    },
    [loadConnections],
  );

  // Kimi has no usage adapter to use as a login receipt. Its runtime detector
  // exposes it only after the official CLI has a usable default model, so poll
  // that exact condition while the device-code terminal is open.
  const watchKimiConnection = useCallback(async () => {
    const api = ipc();
    if (!api) return;
    const gen = ++pollGen.current;
    for (let i = 0; i < 60; i++) {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      if (pollGen.current !== gen) return;
      try {
        const detected = await api.runtime.detect(true);
        if (pollGen.current !== gen) return;
        writeViewData("dashboard.runtimes", detected);
        setRuntimes(detected);
        if (detected.some((runtime) => runtime.kind === "kimi")) {
          setNotice({
            id: "kimi",
            text: ko ? "Kimi Code 연결을 확인했어요." : "Kimi Code is connected.",
          });
          return;
        }
      } catch {
        // Device-code login may still be in progress.
      }
    }
    if (pollGen.current === gen) {
      setNotice({
        id: "kimi",
        text: ko
          ? "로그인이 아직 끝나지 않았어요. 터미널에서 로그인을 마친 뒤 다시 연결을 눌러주세요."
          : "Login is not finished yet. Complete it in the terminal, then choose Connect again.",
      });
    }
  }, [ko]);

  function usageFor(id: string): ProviderUsage | undefined {
    return snap?.providers.find((p) => p.provider === id);
  }
  function runtimeVersionFor(e: EngineDef): CliRuntimeVersionStatus | undefined {
    if (!e.cliKind) return undefined;
    return snap?.runtimeVersions?.find((version) => version.kind === e.cliKind);
  }
  function runtimeVersionText(version: CliRuntimeVersionStatus | undefined): string {
    if (!version || version.state === "not-installed") return "";
    const installed = version.installedVersion ? `v${version.installedVersion}` : (ko ? "버전 불명" : "unknown version");
    const target = version.latestVersion && version.latestVersion !== version.installedVersion
      ? ` → v${version.latestVersion}`
      : "";
    const state = {
      checking: ko ? "버전 확인 중" : "checking version",
      current: ko ? "최신" : "current",
      "update-available": ko ? "자동 업데이트 대기" : "auto-update pending",
      updating: ko ? "자동 업데이트 중" : "auto-updating",
      updated: ko ? "자동 업데이트됨" : "auto-updated",
      "deferred-active-runs": ko ? "작업 종료 후 업데이트" : "updates after active work",
      "check-failed": ko ? "최신 버전 확인 실패" : "version check failed",
      "update-failed": ko ? "자동 업데이트 실패" : "auto-update failed",
      unverifiable: ko ? "버전 검증 불가" : "version unverifiable",
      "not-installed": "",
    }[version.state];
    return `${installed}${target} · ${state}`;
  }
  function isConnected(e: EngineDef): boolean {
    // 사용량/오류 영수증은 runtime 설치 증거가 아니다. 오래된 receipt가 Connect를 숨기면 안 된다.
    if (e.auth === "cli") {
      return runtimes.some((r) => (e.cliKind && r.kind === e.cliKind)
        || (e.detectKind && r.kind === e.detectKind)
        || (e.acpAgentId && r.kind === "acp" && r.acpAgentId === e.acpAgentId));
    }
    if (e.auth === "local") return runtimes.some((r) => r.kind === "ollama");
    return !!e.keyEnv && envKeys.has(e.keyEnv);
  }

  async function connectCli(e: EngineDef) {
    const api = ipc();
    if (!api || busy) return;
    if (e.manualSetup) {
      // 설치 경로가 없는 CLI — 무반응 버튼 대신 실행할 명령을 그대로 보여준다.
      setNotice({
        id: e.id,
        text: ko
          ? `${e.label}는 아래 명령으로 설치·인증한 뒤 자동으로 인식됩니다.`
          : `Install and sign in to ${e.label} with the command below; it is detected automatically.`,
        command: e.manualSetup,
      });
      return;
    }
    if (!e.cliKind) return;
    setBusy(e.id);
    setNotice(null);
    let opened = false;
    try {
      // Antigravity는 앱이 npm으로 설치하지 않는다. 설치된 agy만 검증하고
      // 로그인/업데이트는 Antigravity 자체 경로로 연다.
      if (e.cliKind !== "antigravity") {
        setBusyStage("install");
        const inst = await api.runtime.installCli(e.cliKind);
        if (!inst?.ok) {
          setNotice({
            id: e.id,
            text: ko ? `CLI 설치에 실패했습니다: ${inst?.message ?? ""}` : `CLI install failed: ${inst?.message ?? ""}`,
            command: inst?.command,
          });
          return;
        }
        if (inst.message?.startsWith("already installed")) {
          try {
            await api.runtime.updateCli?.(e.cliKind);
          } catch {
            // best-effort
          }
        }
      }
      // 2) 로그인 — 절대경로 실행(셸 PATH 무관). 실패도 표면화.
      setBusyStage("login");
      const login = await api.runtime.openCliLogin(e.cliKind);
      if (!login?.ok) {
        setNotice({
          id: e.id,
          text: ko ? `로그인 창을 열지 못했습니다: ${login?.message ?? ""}` : `Could not open login: ${login?.message ?? ""}`,
          command: login?.command,
        });
        return;
      }
      opened = true;
      await loadConnections();
      await loadUsage(true);
    } finally {
      setBusy(null);
      setBusyStage(null);
    }
    // 터미널 로그인 완료를 감지해 자동 갱신 — usage 어댑터가 있는 엔진만(그 외엔 성공 신호가 없어 헛폴링).
    if (opened && ["claude-code", "codex"].includes(e.id)) void watchRecovery(e.id);
    if (opened && e.cliKind === "kimi") void watchKimiConnection();
  }

  function busyLabel(): string {
    if (busyStage === "install") return ko ? "설치 중…" : "Installing…";
    return ko ? "연결 중…" : "Connecting…";
  }

  // 기본 엔진 선택 — 연결/사용량과 "기본으로 쓸 엔진" 상태를 분리해 표시한다.
  function runtimeFor(e: EngineDef): RuntimeStatus | undefined {
    if (e.auth === "cli") {
      return runtimes.find((r) => (e.cliKind && r.kind === e.cliKind)
        || (e.detectKind && r.kind === e.detectKind)
        || (e.acpAgentId && r.kind === "acp" && r.acpAgentId === e.acpAgentId));
    }
    if (e.auth === "local") return runtimes.find((r) => r.kind === "ollama");
    return undefined; // API키형(BYOK)은 모델 선택이 필요해 세팅의 BYOK 패널이 담당
  }
  async function saveKey(e: EngineDef) {
    const api = ipc();
    if (!api || !e.keyEnv || !keyVal.trim() || busy) return;
    setBusy(e.id);
    try {
      await api.env.set(e.keyEnv, keyVal.trim());
      setKeyFor(null);
      setKeyVal("");
      await loadConnections();
    } finally {
      setBusy(null);
    }
  }

  function isRateLimited(u: ProviderUsage | undefined): boolean {
    return u?.status === "error" && u.error === "rate_limited";
  }

  function isTerminalProviderError(u: ProviderUsage | undefined): boolean {
    return u?.status === "error" && ["quota_exhausted", "unsupported_client"].includes(u.error ?? "");
  }

  function openProviderHelp(e: EngineDef): void {
    const url = e.id === "grok" ? "https://grok.com" : "https://antigravity.google";
    void ipc()?.fs.openPath(url).catch(() => undefined);
  }

  function statusText(e: EngineDef, u: ProviderUsage | undefined): string {
    if (e.auth === "apikey") return ko ? "키 과금" : "key-billed";
    if (e.auth === "local") return ko ? "로컬 · 무제한" : "local · unlimited";
    if (u?.status === "error") {
      if (u.error === "quota_exhausted") {
        return ko ? "한도 소진(402) · Usage 확인" : "quota exhausted (402) · open usage";
      }
      if (u.error === "credentials_corrupt") {
        return ko ? "로그인 파일 손상 · 재로그인 필요" : "login file corrupt · re-login required";
      }
      if (u.error === "keychain_blocked") {
        // macOS 키체인 접근이 거부/차단됨 — 로그인 문제가 아니라 앱→키체인 권한 문제.
        return ko ? "키체인 접근 차단 — 허용 필요" : "keychain access blocked — allow access";
      }
      if (u.error === "auth_expired") {
        return ko ? "로그인 만료 — 재로그인 필요" : "login expired — re-login";
      }
      if (isRateLimited(u)) {
        // 429 = 연결·로그인 문제가 아님. 재로그인을 유도하면 오진이라 라벨부터 구분한다.
        return ko ? "일시 제한(429) — 자동 재시도 중" : "rate-limited (429) — retrying";
      }
      return ko ? "조회 실패" : "fetch failed";
    }
    if (u?.status === "no_quota") return ko ? "연결됨 · 사용량 곧" : "connected · usage soon";
    // 서버 리밋 조회가 잠시 막혀 로컬 로그로 표시 중(status=ok, error 마커) — 정직하게 알린다.
    if (u?.error === "local_estimate") return ko ? "연결됨 · 로컬 추정" : "connected · local estimate";
    if (e.id === "grok" && snap && !u) {
      return ko ? "연결됨 · 사용량은 Grok Settings에서 확인" : "connected · usage in Grok Settings";
    }
    return ko ? "연결됨" : "connected";
  }

  const renderEngineCard = (e: EngineDef) => {
    const u = usageFor(e.id);
    const connected = isConnected(e);
    const rt = runtimeFor(e);
    const runtimeVersionLabel = runtimeVersionText(runtimeVersionFor(e));
    const hasBars = connected && (u?.windows.length ?? 0) > 0;
    const terminalError = connected && isTerminalProviderError(u);
    const retryableError = connected && u?.status === "error" && !isRateLimited(u);
    const showConnectedChip = connected && !terminalError && !retryableError;
    // The default-engine status and the "use as default" action belong at the
    // top-right of the card (compact), not in the action foot.
    const activeRoles = connected
      ? rt?.activeRoles ?? (rt?.active ? ["orchestrator"] : [])
      : [];
    const statusLine = (connected
      ? statusText(e, u)
      : e.auth === "cli" ? (ko ? "구독 · 미연결" : "subscription · not connected")
      : e.auth === "apikey" ? (ko ? "API 키 · 미연결" : "API key · not connected")
      : ko ? "미설치" : "not installed")
      + (connected && runtimeVersionLabel ? ` · ${runtimeVersionLabel}` : "");
    const actions = terminalError ? (
      <button onClick={() => openProviderHelp(e)} className="titlebar-nodrag" title={e.id === "grok" ? (ko ? "Grok Settings에서 사용량 확인" : "Open Grok usage settings") : (ko ? "Antigravity 안내 열기" : "Open Antigravity")}>
        {e.id === "grok" ? (ko ? "Usage 열기" : "Open usage") : (ko ? "Antigravity" : "Antigravity")}
      </button>
    ) : retryableError ? (
      <>
        <button onClick={() => { if (e.retryProviderId) void retryProviderUsage(e.retryProviderId); }} disabled={busy === e.id} className="titlebar-nodrag" title={ko ? "사용량 조회 다시 시도" : "Retry usage fetch"}>
          {ko ? "다시 시도" : "Retry"}
        </button>
        {e.auth === "cli" && (
          <button onClick={() => void connectCli(e)} disabled={busy === e.id} className="titlebar-nodrag" title={ko ? "CLI 재로그인" : "Re-login CLI"}>
            {busy === e.id ? busyLabel() : ko ? "재로그인" : "Re-login"}
          </button>
        )}
      </>
    ) : !connected ? (
      <button onClick={() => (e.id === "ollama" ? navigate("/settings#ollama") : e.auth === "apikey" ? setKeyFor(keyFor === e.id ? null : e.id) : void connectCli(e))} disabled={busy === e.id} className="titlebar-nodrag">
        {busy === e.id ? busyLabel() : ko ? "연결" : "Connect"}
      </button>
    ) : null;
    return (
      <div key={e.id} className="dashboard-engine-card" data-connected={connected ? "true" : "false"}>
        <div className="dashboard-engine-card-head">
          <span className="dashboard-engine-logo" aria-hidden="true"><img src={e.logoSrc} alt="" /></span>
          <span className="sr-only">{e.logoAlt}</span>
          <span className="dashboard-engine-card-name">{e.label}</span>
          <span className="dashboard-engine-head-right" style={{ marginLeft: "auto" }}>
            {activeRoles.length > 0 ? (
              <>
                {activeRoles.map((role) => (
                  <span
                    className="dashboard-engine-default"
                    key={role}
                    title={
                      role === "orchestrator"
                        ? ko
                          ? "오케스트레이터 기본 엔진"
                          : "Orchestrator default engine"
                        : ko
                          ? "워커 기본 엔진"
                          : "Worker default engine"
                    }
                  >
                    {role === "orchestrator" ? "Orch" : "Worker"}
                  </span>
                ))}
              </>
            ) : showConnectedChip ? (
              // 오너 결정(2026-07-28): 연결 카드는 '연결' CTA만 남긴다. 역할 풀
              // 편집(추가·순서·제거)은 역할 카드의 풀 편집기가 단일 창구다 —
              // 전역 기본값·Use default 계열 버튼은 여기서 완전히 제거.
              <span className="dashboard-engine-connected">{ko ? "연결됨" : "Connected"}</span>
            ) : null}
          </span>
        </div>
        <div
          className="dashboard-engine-card-status"
          data-terminal-state={terminalError ? "true" : undefined}
          style={connected && u?.status === "error" ? { color: "var(--dash-red)" } : undefined}
          title={statusLine}
        >
          {statusLine}
        </div>
        {hasBars && (
          <div className="dashboard-engine-card-body">
            {/* 어댑터가 만든 창은 전부 그린다. 예전 slice(0, 3) 상한은 창이 5개인
                Claude Max에서 유료 초과분(extra_usage)과 Sonnet 7일을 조용히
                잘라내, 실제로 청구되는 금액을 앱에서 볼 방법이 없게 만들었다.
                카드는 flex column이라 창 수만큼 자연히 늘어난다. */}
            {u!.windows.map((w) => <UsageBar key={w.id} w={w} ko={ko} />)}
          </div>
        )}
        {(actions || (keyFor === e.id && !connected)) && (
          <div className="dashboard-engine-card-foot">
            {actions ? <div className="dashboard-engine-actions" style={{ padding: 0 }}>{actions}</div> : <span />}
          </div>
        )}
        {keyFor === e.id && !connected && (
          <div className="dashboard-key-editor">
            <input type="password" autoFocus value={keyVal} onChange={(ev) => setKeyVal(ev.target.value)} onKeyDown={(ev) => ev.key === "Enter" && void saveKey(e)} placeholder={e.keyEnv} className="titlebar-nodrag" />
            <button onClick={() => void saveKey(e)} disabled={busy === e.id || !keyVal.trim()} className="titlebar-nodrag">{ko ? "저장" : "Save"}</button>
          </div>
        )}
        {notice?.id === e.id && (
          <div role="alert" style={{ fontSize: 11, lineHeight: 1.5, color: "var(--dash-red)", background: "var(--paper)", border: "1px solid var(--paper-edge)", borderRadius: 8, padding: "6px 9px", overflowWrap: "anywhere" }}>
            {notice.text}
            {notice.command && (<> {ko ? "터미널에서 직접 실행:" : "Run manually:"} <code>{notice.command}</code></>)}
          </div>
        )}
      </div>
    );
  };

  const engineGroups = [
    { key: "cli", label: ko ? "구독형 · CLI" : "Subscription · CLI", engines: ENGINES.filter((e) => e.auth === "cli") },
    { key: "apikey", label: ko ? "API 키" : "API key", engines: ENGINES.filter((e) => e.auth === "apikey") },
    { key: "local", label: ko ? "로컬" : "Local", engines: ENGINES.filter((e) => e.auth === "local") },
  ].filter((g) => g.engines.length > 0);

  return (
    <div className="dashboard-engine-usage">
      <div className="dashboard-module-head" data-collapsed="false">
        <span>{ko ? "LLM 연결 · 사용량" : "LLM connections · usage"}</span>
        <button onClick={() => void loadUsage(true)} className="titlebar-nodrag dashboard-refresh-button" title={ko ? "새로고침" : "Refresh"}>↻</button>
      </div>

      {usageLoadError && (
        <div className="dashboard-usage-load-error" role="alert">
          <span>{ko ? "사용량 상태를 읽지 못함" : "Could not load usage status"}</span>
          <span aria-hidden="true">·</span>
          <button type="button" className="titlebar-nodrag" onClick={() => void loadUsage(true)}>{ko ? "다시 시도" : "Retry"}</button>
        </div>
      )}

      <ModelRoleUsage value={snap?.modelRoleUsage} ko={ko} />

      <div className="dashboard-engine-groups">
        {engineGroups.map((group) => {
          const collapsed = !!collapsedGroups[group.key];
          const connectedCount = group.engines.filter((e) => isConnected(e)).length;
          return (
            <section key={group.key} className="dashboard-engine-group" data-collapsed={collapsed ? "true" : "false"}>
              <button
                type="button"
                className="dashboard-engine-group-head titlebar-nodrag"
                aria-expanded={!collapsed}
                onClick={() => setCollapsedGroups((prev) => ({ ...prev, [group.key]: !collapsed }))}
              >
                <span className="dashboard-engine-group-chevron" data-collapsed={collapsed ? "true" : "false"} aria-hidden="true">▾</span>
                <span className="dashboard-engine-group-label">{group.label}</span>
                <span className="dashboard-engine-group-count">{connectedCount}/{group.engines.length}</span>
              </button>
              {!collapsed && (
                <div className="dashboard-engine-grid">
                  {group.engines.map((e) => renderEngineCard(e))}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
