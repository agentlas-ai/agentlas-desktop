// Dashboard "Connections and usage" card (Agentlas 2.0 F-D2): one row per connection, the shape of mockups/dashboard-final.
//   - the seven subscription CLIs (claude-code, codex, antigravity, grok, kimi, cursor, github-copilot-cli): a dot, the name, the most used window as a bar with
//     "42% · resets in 3h", or the state in words (Sign in again / Not set up / a usage error), and the one action (Sign in / Set up / Try again).
//     A CLI that gives no usage numbers gets no bar: nothing is drawn that was not read.
//   - Local models: one row (a loaded model, a detected local runtime, or Off / Set up).
//   - API keys: the connected ones as rows ("Key billed"); the others behind "Show API keys".
//   - AI credits (the same read as the sidebar balance) and the "Use automatically" switch (credits after a subscription limit).
// Reads: usage on a signal (runtime change, a run settling, the window coming back), never an idle timer; credits and the local model on the same signals.
"use client";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { usageLine } from "@/lib/usage-copy";
import { ipc, ipcEvents } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import { navigate } from "@/lib/navigation";
import { loadViewData, readViewData, writeViewData } from "@/lib/view-data-cache";
import { IconAlertTriangle, IconCircleDollar, IconCpu, IconKey, IconRefresh } from "@/components/Icon";
import { COPY, pick } from "@/components/dashboard/dashboard-copy";
import s from "@/components/dashboard/Dashboard.module.css";
import type { LocalModelHubSnapshot } from "@shared/local-model-hub";
import { RUNTIME_CHIPS, RuntimeConnectPopup, connectCopy, useRuntimeAuth, type RuntimeChipSpec } from "@/components/connect/RuntimeConnect";
import { manualSetupFor, manualSetupShellLabel, manualSetupText, setupOsFromNavigator, type ManualSetupRuntime } from "@shared/runtime-manual-setup";
import { isPaidOverageUsageWindow, isSupportedProviderUsageWindow } from "@shared/runtime-quota";
import type { ByokBackend } from "@shared/models";
import type {
  CliRuntimeVersionStatus,
  EnvVarMeta,
  HubCreditBalance,
  ProviderUsage,
  RuntimeStatus,
  UsageRetryProviderId,
  UsageSnapshot,
  UsageWindow,
} from "@/lib/types";

// Usage is read on a signal, never on an idle timer: every usage:snapshot makes Main probe the installed CLIs
// (its detect cache is 10 s), so a 15 s poll started CLI processes for as long as the Dashboard was open.
// A read older than this is refreshed when the window comes back (this was the old poll interval).
const USAGE_STALE_MS = 15_000;
// While a CLI shows "checking", "update-available" or "updating", Main's background cycle is still running and ends
// without a push unless the update succeeded. Only then the card looks again, this often and at most this many times.
const UPDATE_FOLLOW_UP_MS = 15_000;
const UPDATE_FOLLOW_UP_MAX = 20;
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
  /** Hand setup for this OS (shared/runtime-manual-setup.ts), keyed by runtime. */
  manualSetup?: ManualSetupRuntime;
  retryProviderId?: UsageRetryProviderId;
  keyEnv?: string;
  apiBackend?: ByokBackend;
  logoSrc: string;
  logoAlt: string;
}

const ENGINES: EngineDef[] = [
  { id: "claude-code", label: "Claude Code", auth: "cli", cliKind: "claude-code", retryProviderId: "claude-code", logoSrc: "/brand/llm/claude.svg", logoAlt: "Claude" },
  { id: "codex", label: "Codex", auth: "cli", cliKind: "codex", retryProviderId: "codex", logoSrc: "/brand/llm/openai.svg", logoAlt: "OpenAI" },
  { id: "antigravity", label: "Antigravity", auth: "cli", cliKind: "antigravity", logoSrc: "/brand/llm/googlegemini.svg", logoAlt: "Antigravity" },
  { id: "anthropic-api", label: "(API) Claude", auth: "apikey", apiBackend: "anthropic", keyEnv: "ANTHROPIC_API_KEY", logoSrc: "/brand/llm/claude.svg", logoAlt: "Claude" },
  { id: "openai-api", label: "(API) OpenAI", auth: "apikey", apiBackend: "openai", keyEnv: "OPENAI_API_KEY", logoSrc: "/brand/llm/openai.svg", logoAlt: "OpenAI" },
  { id: "google-api", label: "(API) Gemini", auth: "apikey", apiBackend: "google", keyEnv: "GOOGLE_API_KEY", logoSrc: "/brand/llm/googlegemini.svg", logoAlt: "Google" },
  { id: "deepseek", label: "(API) DeepSeek", auth: "apikey", apiBackend: "deepseek", keyEnv: "DEEPSEEK_API_KEY", logoSrc: "/brand/llm/deepseek.svg", logoAlt: "DeepSeek" },
  { id: "grok", label: "Grok", auth: "cli", cliKind: "grok", retryProviderId: "grok", keyEnv: "XAI_API_KEY", logoSrc: "/brand/llm/x.svg", logoAlt: "xAI" },
  { id: "glm", label: "(API) GLM", auth: "apikey", apiBackend: "glm", keyEnv: "ZHIPU_API_KEY", logoSrc: "/brand/llm/zhipu.png", logoAlt: "Zhipu GLM" },
  { id: "kimi-api", label: "(API) Kimi", auth: "apikey", apiBackend: "kimi", keyEnv: "MOONSHOT_API_KEY", logoSrc: "/brand/llm/kimi.svg", logoAlt: "Kimi" },
  { id: "minimax-api", label: "(API) MiniMax", auth: "apikey", apiBackend: "minimax", keyEnv: "MINIMAX_API_KEY", logoSrc: "/brand/llm/minimax.svg", logoAlt: "MiniMax" },
  { id: "xai-api", label: "(API) xAI", auth: "apikey", apiBackend: "xai", keyEnv: "XAI_API_KEY", logoSrc: "/brand/llm/x.svg", logoAlt: "xAI" },
  { id: "openrouter-api", label: "(API) OpenRouter", auth: "apikey", apiBackend: "openrouter", keyEnv: "OPENROUTER_API_KEY", logoSrc: "/brand/agentlas-mark.png", logoAlt: "OpenRouter" },
  { id: "upstage-api", label: "(API) Upstage", auth: "apikey", apiBackend: "upstage", keyEnv: "UPSTAGE_API_KEY", logoSrc: "/brand/agentlas-mark.png", logoAlt: "Upstage" },
  { id: "custom-api", label: "(API) Custom", auth: "apikey", apiBackend: "custom", keyEnv: "CUSTOM_API_KEY", logoSrc: "/brand/agentlas-mark.png", logoAlt: "Custom API" },
  { id: "kimi", label: "Kimi Code", auth: "cli", cliKind: "kimi", logoSrc: "/brand/llm/kimi.svg", logoAlt: "Kimi Code" },
  // 실행되는 런타임과 이 목록은 반드시 같아야 한다(오너 결정 2026-08-18). cursor와
  // Copilot CLI는 실제로 실행되는데 여기 없어서 대시보드에서 연결할 길이 없었다.
  { id: "cursor", label: "Cursor", auth: "cli", detectKind: "cursor", manualSetup: "cursor", logoSrc: "/brand/llm/cursor.svg", logoAlt: "Cursor" },
  { id: "github-copilot-cli", label: "GitHub Copilot", auth: "cli", acpAgentId: "github-copilot-cli", manualSetup: "github-copilot-cli", logoSrc: "/brand/llm/githubcopilot.svg", logoAlt: "GitHub Copilot" },
  { id: "agentlas-local", label: "Agentlas Local", auth: "local", logoSrc: "/brand/agentlas-mark.png", logoAlt: "Agentlas" },
];

function windowLabel(w: UsageWindow, ko: boolean): string {
  const named = (label: string) => (w.limitName || w.model) ? `${w.limitName || w.model} · ${label}` : label;
  if (w.quotaRole === "paid-overage" || w.id === "extra_usage") return ko ? "크레딧 사용" : "Credit usage";
  if (w.kind === "monthly") return ko ? "월간" : "Monthly";
  if (w.id.includes("-local-")) return ko ? (w.kind === "5h" ? "최근 5시간(로컬)" : "최근 7일(로컬)") : w.kind === "5h" ? "Last 5h (local)" : "Last 7d (local)";
  if (w.kind === "5h") return named(ko ? "5시간" : "5-hour");
  if (w.kind === "daily") return w.label || (ko ? "일일" : "Daily");
  if (w.model === "opus") return ko ? "Opus 7일" : "Opus 7d";
    if (w.model === "sonnet") return ko ? "Sonnet 7일" : "Sonnet 7d";
  if (w.model === "haiku") return ko ? "Haiku 7일" : "Haiku 7d";
  if (w.kind === "7d") return named(ko ? "주간(7일)" : "Weekly (7d)");
  return w.label || (ko ? "사용량 한도" : "Usage limit");
}

function formatReset(resetAt: number | null | undefined, ko: boolean): string {
  if (!resetAt) return "";
  const diff = resetAt - Date.now();
  // Owner 2026-10-13: "2% · 3m", "2% · 7d" — the unit letter is enough, no "resets in" words.
  // The Korean picture (desktop-impl-gaps-1-ko B) spells the unit: "3시간 뒤 초기화".
  if (diff <= 0) return ko ? "0분" : "0m";
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return ko ? `${mins}분` : `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return ko ? `${hrs}시간` : `${hrs}h`;
  return ko ? `${Math.round(hrs / 24)}일` : `${Math.round(hrs / 24)}d`;
}

function formatTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(n);
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
  const [connectSpec, setConnectSpec] = useState<RuntimeChipSpec | null>(null);
  const { probes: runtimeAuth, refresh: refreshAuth } = useRuntimeAuth();
  const [usageLoadError, setUsageLoadError] = useState(false);
  const [creditPreferencePending, setCreditPreferencePending] = useState(false);
  const [creditPreferenceError, setCreditPreferenceError] = useState(false);
  const [notice, setNotice] = useState<{ id: string; text: string; command?: string; commandLabel?: string; note?: string } | null>(null);
  const [keyFor, setKeyFor] = useState<string | null>(null);
  const [keyVal, setKeyVal] = useState("");
  const usageRequestGen = useRef(0);
  const usageReadAt = useRef(0);
  const updateFollowUps = useRef(0);

  const loadUsage = useCallback(async (force = false) => {
    usageReadAt.current = Date.now();
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

  const [connectionsLoadError, setConnectionsLoadError] = useState(false);

  const loadConnections = useCallback(async (force = false) => {
    const api = ipc();
    if (!api) return;
    try {
      const [rt, env] = await Promise.all([
        loadViewData("dashboard.runtimes", () => api.runtime.detect(force), { maxAgeMs: 300_000, force }),
        loadViewData("dashboard.env", () => api.env.list(), { maxAgeMs: 15_000, force }),
      ]);
      setRuntimes(rt);
      setEnvKeys(new Set(env.filter((e: EnvVarMeta) => e.hasValue).map((e) => e.key)));
      setConnectionsLoadError(false);
    } catch {
      /*
       * ★조용히 삼키면 연결 목록이 통째로 사라진 채 아무 말이 없다
       *   (읽기 실패 실측 2026-09-08: 대시보드에서 "1/7 · 지휘" 가 소리 없이 없어졌다).
       *   연결이 없는 것과 못 읽은 것은 사용자에게 완전히 다른 사실이다.
       */
      setConnectionsLoadError(true);
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

  // One read of usage and connections on mount. After that, signals only (below).
  useEffect(() => {
    void loadConnections();
    void loadUsage();
  }, [loadConnections, loadUsage]);

  // Signal: Main reports a runtime change (sign-in or sign-out, install, a finished CLI update).
  useEffect(() => {
    const events = ipcEvents();
    if (!events?.onStoreChanged) return;
    return events.onStoreChanged((change) => {
      if (change.entity === "runtime") {
        void loadConnections(true);
        void refreshAuth();
        void loadUsage();
      }
    });
  }, [loadConnections, refreshAuth, loadUsage]);

  // Signals: a run finished (it spent quota, and a CLI update that waited for runs can start), and the window
  // coming back after the figures are older than the old poll interval.
  useEffect(() => {
    let active: ReadonlySet<string> | null = null;
    const offActive = ipcEvents()?.onActiveChats?.((chatIds) => {
      const next = new Set(chatIds);
      const settled = active !== null && [...active].some((chatId) => !next.has(chatId));
      active = next;
      if (settled) void loadUsage();
    });
    const whenStale = () => {
      if (document.visibilityState !== "hidden" && Date.now() - usageReadAt.current >= USAGE_STALE_MS) void loadUsage();
    };
    window.addEventListener("focus", whenStale);
    document.addEventListener("visibilitychange", whenStale);
    return () => {
      offActive?.();
      window.removeEventListener("focus", whenStale);
      document.removeEventListener("visibilitychange", whenStale);
    };
  }, [loadUsage]);

  // Bounded follow-up, only while a CLI version check or update is in progress. A settled card schedules nothing.
  useEffect(() => {
    const inProgress = snap?.runtimeVersions?.some((version) => (
      version.state === "checking" || version.state === "update-available" || version.state === "updating"
    ));
    if (!inProgress) { updateFollowUps.current = 0; return; }
    if (updateFollowUps.current >= UPDATE_FOLLOW_UP_MAX) return;
    const timer = window.setTimeout(() => {
      // Hidden: the visibility signal above reads when the window comes back.
      if (document.visibilityState === "hidden") return;
      updateFollowUps.current += 1;
      void loadUsage();
    }, UPDATE_FOLLOW_UP_MS);
    return () => window.clearTimeout(timer);
  }, [snap, loadUsage]);
  // A quota window's reset is a known time: one read just after the earliest one, so a focused Dashboard does not keep
  // showing "limit reached" past the reset. A reset already in the past schedules nothing.
  useEffect(() => {
    const now = Date.now();
    const resets = (snap?.providers ?? []).flatMap((provider) => provider.windows ?? [])
      .map((usageWindow) => usageWindow.resetAt ?? 0).filter((at) => at > now);
    if (resets.length === 0) return;
    const wait = Math.min(Math.max(USAGE_STALE_MS, Math.min(...resets) - now + 5_000), 2_147_000_000);
    const timer = window.setTimeout(() => {
      // Hidden: the visibility signal above reads when the window comes back.
      if (document.visibilityState !== "hidden") void loadUsage();
    }, wait);
    return () => window.clearTimeout(timer);
  }, [snap, loadUsage]);
  useEffect(() => () => {
    usageRequestGen.current++; // 늦게 끝난 snapshot이 unmount 뒤 상태를 덮지 않게 한다.
  }, []);

  function usageFor(id: string): ProviderUsage | undefined {
    return snap?.providers.find((p) => p.provider === id);
  }

  async function toggleSubscriptionCredits() {
    const api = ipc();
    if (!api?.usage.setSubscriptionCreditUse || creditPreferencePending || !snap) return;
    setCreditPreferencePending(true);
    setCreditPreferenceError(false);
    ++usageRequestGen.current;
    try {
      const saved = await api.usage.setSubscriptionCreditUse(snap.subscriptionCreditUse !== true);
      ++usageRequestGen.current;
      setSnap(previous => {
        if (!previous) return previous;
        const next = { ...previous, subscriptionCreditUse: saved, providers: previous.providers.map(provider =>
          ["claude-code", "codex"].includes(provider.provider) ? { ...provider, allowPaidUsage: saved } : provider) };
        writeViewData("dashboard.usage", next);
        return next;
      });
    } catch { setCreditPreferenceError(true); }
    finally { setCreditPreferencePending(false); }
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
      const runtime = runtimeFor(e);
      if (!runtime) return false;
      const kind = e.cliKind ?? e.detectKind;
      // Installing an executable does not prove that its account is signed in.
      return kind ? runtimeAuth[kind]?.state === "signed-in" : true;
    }
    if (e.auth === "local") return runtimes.some((r) => r.kind === "agentlas-local");
    if (e.apiBackend) return runtimeFor(e)?.credentialAccess?.status === "available";
    return !!e.keyEnv && envKeys.has(e.keyEnv);
  }

  async function connectCli(e: EngineDef) {
    const api = ipc();
    if (!api || busy) return;
    if (e.manualSetup) {
      // 설치 경로가 없는 CLI — 무반응 버튼 대신 이 OS에서 실행할 명령을 그대로 보여준다.
      const setup = manualSetupFor(e.manualSetup, setupOsFromNavigator(typeof navigator === "undefined" ? undefined : navigator));
      setNotice({
        id: e.id,
        text: ko
          ? `${e.label}는 아래 명령으로 설치·인증한 뒤 자동으로 인식됩니다.`
          : `Install and sign in to ${e.label} with the command below; it is detected automatically.`,
        command: manualSetupText(setup),
        commandLabel: manualSetupShellLabel(setup, ko),
        ...(setup.note ? { note: ko ? setup.note.ko : setup.note.en } : {}),
      });
      return;
    }
    if (!e.cliKind) return;
    const spec = RUNTIME_CHIPS.find((chip) => chip.kind === e.cliKind);
    if (spec) {
      setNotice(null);
      setConnectSpec(spec);
    }
  }

  // 기본 엔진 선택 — 연결/사용량과 "기본으로 쓸 엔진" 상태를 분리해 표시한다.
  function runtimeFor(e: EngineDef): RuntimeStatus | undefined {
    if (e.auth === "cli") {
      return runtimes.find((r) => (e.cliKind && r.kind === e.cliKind)
        || (e.detectKind && r.kind === e.detectKind)
        || (e.acpAgentId && r.kind === "acp" && r.acpAgentId === e.acpAgentId));
    }
    if (e.auth === "local") return runtimes.find((r) => r.kind === "agentlas-local");
    return e.apiBackend ? runtimes.find(runtime => runtime.kind === "byok" && runtime.backend === e.apiBackend) : undefined;
  }
  async function saveKey(e: EngineDef) {
    const api = ipc();
    if (!api || !e.keyEnv || !keyVal.trim() || busy) return;
    setBusy(e.id);
    try {
      if (e.apiBackend) await api.secrets.saveApiKey(e.apiBackend, keyVal.trim());
      else await api.env.set(e.keyEnv, keyVal.trim());
      setKeyFor(null);
      setKeyVal("");
      await loadConnections(true);
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
    if (u?.stale) {
      const minutes = Math.max(0, Math.floor((Date.now() - u.fetchedAt) / 60_000));
      return ko ? `연결됨 · 마지막 확인 ${minutes}분 전` : `connected · checked ${minutes}m ago`;
    }
    if (e.id === "grok" && snap && !u) {
      return ko ? "연결됨 · 사용량은 Grok Settings에서 확인" : "connected · usage in Grok Settings";
    }
    return ko ? "연결됨" : "connected";
  }

  /** The one window that says the most: the most used subscription window. The others stay in the tooltip. */
  function mostUsed(windows: UsageWindow[]): UsageWindow | null {
    let best: UsageWindow | null = null;
    for (const w of windows) if (!best || w.usedPercent > best.usedPercent) best = w;
    return best;
  }
  function usageText(w: UsageWindow): string {
    const isLocalTokens = w.unit === "tokens" && w.used != null && Math.round(w.usedPercent) === 0;
    if (isLocalTokens) return `${formatTokens(w.used ?? 0)} ${ko ? "토큰" : "tok"}`;
    const pct = `${Math.max(0, Math.min(100, Math.round(w.usedPercent)))}%`;
    const reset = formatReset(w.resetAt, ko);
    return reset ? `${pct} · ${ko ? `${reset} 뒤 초기화` : `resets in ${reset}`}` : pct;
  }

  const [apiOpen, setApiOpen] = useState(false);
  const [localSnap, setLocalSnap] = useState<LocalModelHubSnapshot | null>(null);
  const [credits, setCredits] = useState<HubCreditBalance | null>(() => readViewData<HubCreditBalance>("shell.credit-balance")?.value ?? null);
  const [creditsFailed, setCreditsFailed] = useState(false);

  const loadCredits = useCallback(async (force = false) => {
    const api = ipc();
    if (!api?.billing) return;
    try {
      // The same read and the same cache key as the sidebar's balance: one answer for both.
      const next = await loadViewData("shell.credit-balance", () => (force ? api.billing.getCredits({ force: true }) : api.billing.getCredits()), { maxAgeMs: 60_000, force });
      setCredits((prev) => (prev && next.authenticated && typeof next.remainingCredits !== "number" ? prev : next));
      setCreditsFailed(false);
    } catch { setCreditsFailed(true); }
  }, []);
  const loadLocal = useCallback(async () => {
    try { const value = await ipc()?.localModelHub?.snapshot(); if (value) setLocalSnap(value); }
    catch { /* a failed read is not "no model": the row keeps what it had */ }
  }, []);
  // Credits and the local model follow the same signals as usage (run settled, runtime change, window back, mount).
  useEffect(() => {
    void loadCredits(); void loadLocal();
    const onAuth = () => void loadCredits(true);
    window.addEventListener("agentlas:auth-changed", onAuth);
    const off = ipcEvents()?.onStoreChanged?.((change) => { if (change.entity === "runtime") { void loadLocal(); void loadCredits(); } });
    const whenBack = () => { if (document.visibilityState !== "hidden") { void loadLocal(); void loadCredits(); } };
    window.addEventListener("focus", whenBack);
    return () => { window.removeEventListener("agentlas:auth-changed", onAuth); off?.(); window.removeEventListener("focus", whenBack); };
  }, [loadCredits, loadLocal]);

  const cliEngines = ENGINES.filter((e) => e.auth === "cli");
  const apiEngines = ENGINES.filter((e) => e.auth === "apikey");
  const rowLabel = (e: EngineDef) => (e.auth === "apikey" ? `${e.label.replace(/^\(API\)\s*/, "")} API` : e.label);

  const renderRow = (e: EngineDef) => {
    const u = usageFor(e.id);
    const visibleWindows = u?.windows.filter((window) => isSupportedProviderUsageWindow(window, e.id)) ?? [];
    const subscriptionWindows = visibleWindows.filter((window) => !isPaidOverageUsageWindow(window, e.id));
    const connected = isConnected(e);
    const rt = runtimeFor(e);
    const isApi = e.auth === "apikey";
    const terminalError = connected && !isApi && isTerminalProviderError(u);
    const retryableError = connected && !isApi && u?.status === "error" && !isRateLimited(u);
    const problem = connected && !isApi && (terminalError || u?.status === "error" || u?.error === "keychain_blocked");
    const authKind = e.cliKind ?? e.detectKind;
    const authState = authKind ? runtimeAuth[authKind]?.state : undefined;
    // Sign in again: the CLI is there but not signed in, or Main saw a login failure on it that has not been followed by a success (RuntimeStatus.signInRequired).
    const installedNotSignedIn = !isApi && !!rt && (!connected || !!rt.signInRequired);
    const best = connected && !problem && !isApi && !installedNotSignedIn ? mostUsed(subscriptionWindows) : null;
    const tipParts = [
      runtimeVersionText(runtimeVersionFor(e)),
      ...subscriptionWindows.map((w) => `${windowLabel(w, ko)} ${Math.round(w.usedPercent)}%${w.resetAt ? ` · ${formatReset(w.resetAt, ko)}` : ""}`),
      u ? `${ko ? "마지막 확인" : "Last checked"} ${new Date(u.fetchedAt).toLocaleString(ko ? "ko-KR" : "en-US")}` : "",
    ].filter(Boolean);
    const dotTone = problem || installedNotSignedIn ? "warn" : connected ? "ok" : "idle";
    const setUpAction = () => (e.apiBackend === "custom" ? navigate("/settings") : e.auth === "apikey" ? setKeyFor(keyFor === e.id ? null : e.id) : void connectCli(e));
    let mid: ReactNode;
    if (connected && isApi) mid = <span className={s.cstate}>{pick(ko, COPY.keyBilled)}</span>;
    else if (problem) mid = <span className={s.cstate} data-tone={u?.status === "error" ? "error" : "warn"} title={tipParts.join(" · ")}>{statusText(e, u)}</span>;
    else if (installedNotSignedIn) mid = <span className={s.cstate} data-tone="warn"><IconAlertTriangle size={14} />{pick(ko, authState === "unknown" && !rt?.signInRequired ? COPY.statusUnknown : COPY.signInAgain)}</span>;
    else if (best) {
      const pct = Math.max(0, Math.min(100, Math.round(best.usedPercent)));
      mid = <div className={s.cmid} title={tipParts.join("\n")}>
        <div className={s.bar} role="progressbar" aria-label={`${windowLabel(best, ko)} ${ko ? "사용량" : "usage"}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} data-hot={pct >= WARN_PCT ? "true" : "false"}><i style={{ width: `${pct}%` }} /></div>
        <span className={s.num} data-warn={pct >= WARN_PCT ? "true" : "false"}>{usageText(best)}</span>
      </div>;
    } else if (connected) mid = <span className={s.cstate} title={tipParts.join(" · ")}>{statusText(e, u)}</span>;
    else if (installedNotSignedIn) mid = <span className={s.cstate} data-tone="warn"><IconAlertTriangle size={14} />{pick(ko, authState === "unknown" ? COPY.statusUnknown : COPY.signInAgain)}</span>;
    else mid = <span className={s.cstate}>{pick(ko, COPY.notSetUp)}</span>;
    const act = terminalError ? (
      <button type="button" className={s.cact} onClick={() => openProviderHelp(e)}>{e.id === "grok" ? pick(ko, COPY.openUsage) : "Antigravity"}</button>
    ) : retryableError ? (
      <span className={s.cacts}>
        <button type="button" className={s.cact} disabled={busy === e.id} onClick={() => { if (e.retryProviderId) void retryProviderUsage(e.retryProviderId); }}>{pick(ko, COPY.retry)}</button>
        {e.auth === "cli" && <button type="button" className={s.cact} disabled={busy === e.id} onClick={() => void connectCli(e)}>{busy === e.id ? pick(ko, COPY.connecting) : pick(ko, COPY.signIn)}</button>}
      </span>
    ) : !connected || installedNotSignedIn ? (
      <button type="button" className={s.cact} disabled={busy === e.id} onClick={setUpAction}>
        {busy === e.id ? pick(ko, COPY.connecting) : installedNotSignedIn ? pick(ko, COPY.signIn) : pick(ko, COPY.setUp)}
      </button>
    ) : <span />;
    return (
      <div key={e.id} className={s.crow} data-provider={e.id} data-connected={connected ? "true" : "false"} data-state={dotTone}>
        <i className={s.statusDot} data-tone={dotTone === "ok" ? "ok" : dotTone === "warn" ? "warn" : "idle"} aria-hidden="true" />
        <img src={e.logoSrc} alt="" />
        <span className={s.cname}>{rowLabel(e)}</span>
        {mid}
        {act}
        {keyFor === e.id && !connected && (
          <div className={s.keyEdit}>
            <input type="password" autoFocus value={keyVal} onChange={(ev) => setKeyVal(ev.target.value)} onKeyDown={(ev) => ev.key === "Enter" && void saveKey(e)} placeholder={e.keyEnv} aria-label={`${rowLabel(e)} API key`} />
            <button type="button" className={s.btn} onClick={() => void saveKey(e)} disabled={busy === e.id || !keyVal.trim()}>{pick(ko, COPY.save)}</button>
          </div>
        )}
        {notice?.id === e.id && (
          <div role="alert" className={s.cnote}>
            {notice.text}
            {notice.command && (<> {notice.commandLabel ?? (ko ? "터미널에서 직접 실행:" : "Run manually:")} <code>{notice.command}</code></>)}
            {notice.note && <><br />{notice.note}</>}
          </div>
        )}
      </div>
    );
  };

  // The local row: a loaded model, a detected local runtime, or nothing. It says only what was read.
  const localKinds = new Set(["agentlas-local", "ollama", "lmstudio", "mlx"]);
  const localRuntimes = runtimes.filter((runtime) => localKinds.has(runtime.kind));
  const installedCount = localSnap?.modelInstallations.length ?? 0;
  const resident = localSnap?.resident ?? null;
  const residentName = resident ? localSnap?.modelInstallations.find((item) => item.installationId === resident.installationId)?.fileName.replace(/\.gguf$/i, "") ?? "" : "";
  const otherLocal = localRuntimes.filter((runtime) => runtime.kind !== "agentlas-local").map((runtime) => (runtime.kind === "lmstudio" ? "LM Studio" : runtime.kind === "mlx" ? "MLX" : "Ollama"));
  const localOn = Boolean(resident) || otherLocal.length > 0;
  const localState = resident ? `${pick(ko, COPY.on)}${residentName ? ` · ${residentName}` : ""}` : otherLocal.length > 0 ? `${pick(ko, COPY.ready)} · ${otherLocal.join(", ")}` : pick(ko, COPY.off);
  const renderLocalRow = () => (
    <div key="local" className={s.crow} data-provider="local-models" data-connected={localOn ? "true" : "false"}>
      <i className={s.statusDot} data-tone={localOn ? "ok" : "idle"} aria-hidden="true" />
      <IconCpu size={16} />
      <span className={s.cname}>{pick(ko, COPY.localModels)}</span>
      <span className={s.cstate} title={localSnap?.unavailableReason ? String(localSnap.unavailableReason) : undefined}>{localState}</span>
      <button type="button" className={s.cact} onClick={() => navigate("/local-models")}>{installedCount === 0 && otherLocal.length === 0 ? pick(ko, COPY.setUp) : pick(ko, COPY.manage)}</button>
    </div>
  );

  if (snap?.collection?.status === "suppressed") {
    return <section className={s.card} role="status" data-tour-id="dashboard.llm"><p className={s.emptyBody}>{pick(ko, COPY.devNoCollect)}</p></section>;
  }

  const creditsKnown = credits?.authenticated === true && typeof credits.remainingCredits === "number";
  const unconnectedApi = apiEngines.filter((e) => !isConnected(e));
  const connectedApi = apiEngines.filter((e) => isConnected(e));
  // A key "needs a look" when its runtime says the stored key could not be read back (keychain unavailable / read failed): it is in the count, never silently "not set".
  const apiKeysNeedLook = unconnectedApi.filter((e) => runtimeFor(e)?.credentialAccess?.status === "unavailable").length;
  return (
    <section className={s.card} data-tour-id="dashboard.llm" aria-labelledby="dashboard-connections-title">
      {connectSpec && <RuntimeConnectPopup
        spec={connectSpec}
        copy={connectCopy(ko)}
        onClose={() => setConnectSpec(null)}
        onDone={() => {
          setConnectSpec(null);
          void refreshAuth(connectSpec.kind);
          void loadConnections(true);
          void loadUsage(true);
        }}
      />}
      <div className={s.cardHead}>
        <h2 className={s.h} id="dashboard-connections-title">{pick(ko, COPY.connections)}</h2>
        <button type="button" className={s.iconBtn} aria-label={pick(ko, COPY.refresh)} title={pick(ko, COPY.refresh)}
          onClick={() => { void loadUsage(true); void loadConnections(true); void refreshAuth(); void loadLocal(); void loadCredits(true); }}>
          <IconRefresh size={15} />
        </button>
      </div>
      {connectionsLoadError && <p className={s.inlineError} role="alert">{pick(ko, COPY.connectionsFailed)}<button type="button" className={s.btn} onClick={() => void loadConnections(true)}>{pick(ko, COPY.retry)}</button></p>}
      {usageLoadError && <p className={s.inlineError} role="alert">{pick(ko, COPY.usageFailed)}<button type="button" className={s.btn} onClick={() => void loadUsage(true)}>{pick(ko, COPY.retry)}</button></p>}
      <div className={s.conn}>
        {cliEngines.map((e) => renderRow(e))}
        {renderLocalRow()}
        {connectedApi.map((e) => renderRow(e))}
        {unconnectedApi.length > 0 && (
          // F-D2b E: one row, "N API keys", with "N need a look" only when a key has a problem (a key the keychain would not give back).
          <div className={s.crow} data-provider="api-keys" data-testid="api-keys-row" data-problem={apiKeysNeedLook > 0 ? "true" : "false"}>
            <i aria-hidden="true" />
            <IconKey size={16} />
            <span className={s.cname}>{ko ? `API 키 ${unconnectedApi.length}개` : `${unconnectedApi.length} API key${unconnectedApi.length === 1 ? "" : "s"}`}</span>
            {apiKeysNeedLook > 0
              ? <span className={s.cstate} data-tone="warn"><IconAlertTriangle size={14} />{ko ? `${apiKeysNeedLook}개 확인 필요` : `${apiKeysNeedLook} need${apiKeysNeedLook === 1 ? "s" : ""} a look`}</span>
              : <span />}
            <button type="button" className={s.cact} aria-expanded={apiOpen} onClick={() => setApiOpen((open) => !open)}>
              {apiOpen ? pick(ko, COPY.hide) : pick(ko, COPY.view)}
            </button>
          </div>
        )}
        {apiOpen && unconnectedApi.map((e) => renderRow(e))}
      </div>
      {creditPreferenceError && <p className={s.inlineError} role="alert">{pick(ko, COPY.creditsSaveFailed)}</p>}
      <div className={s.toggleRow} data-testid="credits-row">
        <IconCircleDollar size={16} />
        {creditsKnown
          ? <span><b>{(credits?.remainingCredits ?? 0).toLocaleString()}</b> {pick(ko, COPY.aiCredits)}{credits?.usage ? ` · ${usageLine(credits.usage, ko)}` : ""}</span>
          : creditsFailed
            ? <span>{pick(ko, COPY.creditsUnread)} <button type="button" className={s.cact} onClick={() => void loadCredits(true)}>{pick(ko, COPY.retry)}</button></span>
            : credits && !credits.authenticated
              ? <span>{pick(ko, COPY.creditsSignedOut)}</span>
              : <span>{pick(ko, COPY.aiCredits)}</span>}
        <span className={s.tglLabel}>{pick(ko, COPY.useAutomatically)}</span>
        <button type="button" role="switch" className={s.tgl} aria-checked={snap?.subscriptionCreditUse === true}
          aria-label={pick(ko, COPY.useAutomatically)} title={pick(ko, COPY.creditsHint)}
          disabled={!snap || creditPreferencePending || !ipc()?.usage.setSubscriptionCreditUse}
          onClick={() => void toggleSubscriptionCredits()} />
      </div>
    </section>
  );
}
