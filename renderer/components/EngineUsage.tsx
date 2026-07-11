// 대시보드 "엔진 사용량" 카드 — 모든 엔진을 카탈로그로 보여준다.
//   · 구독형(Claude·Codex·Gemini): 연결 시 usage.snapshot()의 5시간/주간/일일 바.
//   · API키형(DeepSeek·Grok·GLM·Pi): 연결 시 "키 과금", 미연결 시 키 입력 팝업.
//   · 로컬(Ollama): "무제한".
// 미연결 엔진은 [연결] 버튼 — CLI는 자동설치+로그인창, API키는 인라인 입력 후 저장.
// 연결 액션은 대시보드에서 항상 보여야 한다. 사용자가 예전에 접은 상태 때문에
// "LLM 연결이 사라진" 것처럼 보이지 않도록 이 표면은 접지 않는다.
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ipc } from "@/lib/ipc";
import { useVisibleInterval } from "@/lib/useVisibleInterval";
import { useT } from "@/lib/i18n";
import type {
  EnvVarMeta,
  ProviderUsage,
  RuntimeStatus,
  UsageSnapshot,
  UsageWindow,
} from "@/lib/types";

// 사용량 %는 몇 분 단위로만 변하고, 이 조회 엔드포인트는 rate limit이 짜다 —
// 평상시 폴링은 넉넉히 잡아 429를 예방한다(수동 새로고침 버튼은 즉시 조회 유지).
const POLL_MS = 180_000;
const WARN_PCT = 80;
type EngineAuth = "cli" | "apikey" | "local";
interface EngineDef {
  id: string; // usage provider id와 일치(구독형)
  label: string;
  auth: EngineAuth;
  cliKind?: "claude-code" | "codex" | "gemini" | "grok";
  keyEnv?: string;
  logoSrc: string;
  logoAlt: string;
}

const ENGINES: EngineDef[] = [
  { id: "claude-code", label: "Claude Code", auth: "cli", cliKind: "claude-code", logoSrc: "/brand/llm/claude.svg", logoAlt: "Claude" },
  { id: "codex", label: "Codex", auth: "cli", cliKind: "codex", logoSrc: "/brand/llm/openai.svg", logoAlt: "OpenAI" },
  { id: "gemini", label: "Gemini", auth: "cli", cliKind: "gemini", logoSrc: "/brand/llm/googlegemini.svg", logoAlt: "Google Gemini" },
  { id: "deepseek", label: "DeepSeek", auth: "apikey", keyEnv: "DEEPSEEK_API_KEY", logoSrc: "/brand/llm/deepseek.svg", logoAlt: "DeepSeek" },
  { id: "grok", label: "Grok", auth: "cli", cliKind: "grok", keyEnv: "XAI_API_KEY", logoSrc: "/brand/llm/x.svg", logoAlt: "xAI" },
  { id: "glm", label: "GLM", auth: "apikey", keyEnv: "ZHIPU_API_KEY", logoSrc: "/brand/llm/zhipu.png", logoAlt: "Zhipu GLM" },
  { id: "pi", label: "Pi", auth: "apikey", keyEnv: "PI_API_KEY", logoSrc: "/brand/llm/pi.png", logoAlt: "Pi" },
  { id: "ollama", label: "Ollama", auth: "local", logoSrc: "/brand/llm/ollama.svg", logoAlt: "Ollama" },
];

function windowLabel(w: UsageWindow, ko: boolean): string {
  if (w.kind === "monthly") return ko ? "추가 크레딧" : "Extra credits";
  if (w.id.includes("-local-")) return ko ? (w.kind === "5h" ? "최근 5시간(로컬)" : "최근 7일(로컬)") : w.kind === "5h" ? "Last 5h (local)" : "Last 7d (local)";
  if (w.kind === "5h") return ko ? "5시간" : "5-hour";
  if (w.kind === "daily") return w.label || (ko ? "일일" : "Daily");
  if (w.model === "opus") return ko ? "Opus 7일" : "Opus 7d";
  if (w.model === "sonnet") return ko ? "Sonnet 7일" : "Sonnet 7d";
  return ko ? "주간(7일)" : "Weekly (7d)";
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
  const fill = warn ? "var(--red-deep, #c0392b)" : "var(--accent)";
  return (
    <div className="dashboard-usage-bar">
      <span>{windowLabel(w, ko)}</span>
      <div>
        <div style={{ width: `${pct}%`, background: fill }} />
      </div>
      <span data-warn={warn ? "true" : "false"}>{pct}%</span>
      <span>{formatReset(w.resetAt, ko)}</span>
    </div>
  );
}

export function EngineUsage() {
  const { locale } = useT();
  const ko = locale === "ko";
  const [snap, setSnap] = useState<UsageSnapshot | null>(null);
  const [runtimes, setRuntimes] = useState<RuntimeStatus[]>([]);
  const [envKeys, setEnvKeys] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [busyStage, setBusyStage] = useState<"install" | "login" | null>(null);
  const [notice, setNotice] = useState<{ id: string; text: string; command?: string } | null>(null);
  const [keyFor, setKeyFor] = useState<string | null>(null);
  const [keyVal, setKeyVal] = useState("");

  const loadUsage = useCallback(async (force = false) => {
    const api = ipc();
    if (!api) return;
    try {
      setSnap(await api.usage.snapshot(force ? { force: true } : undefined));
    } catch {
      // 다음 폴링 재시도
    }
  }, []);

  const loadConnections = useCallback(async () => {
    const api = ipc();
    if (!api) return;
    try {
      const [rt, env] = await Promise.all([api.runtime.detect(), api.env.list()]);
      setRuntimes(rt);
      setEnvKeys(new Set(env.filter((e: EnvVarMeta) => e.hasValue).map((e) => e.key)));
    } catch {
      // ignore
    }
  }, []);

  // 초기 1회 load(usage+connections)는 유지, 주기 폴링(60s)은 loadUsage만 탭 보일 때 — useVisibleInterval이 hidden 시 정지.
  useEffect(() => {
    void loadUsage();
    void loadConnections();
  }, [loadUsage, loadConnections]);
  useVisibleInterval(() => void loadUsage(), POLL_MS);

  // 재로그인은 터미널에서 끝난다 — 완료 시점을 앱이 폴링으로 감지해 자동 반영(5초 × 36 = 3분).
  const pollGen = useRef(0);
  useEffect(() => () => {
    pollGen.current++; // 언마운트 시 진행 중 폴링 중단
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
          const s = await api.usage.snapshot({ force: true });
          if (pollGen.current !== gen) return;
          setSnap(s);
          const p = s.providers.find((x) => x.provider === providerId);
          // 429(일시 제한)는 '아직 로그인 안 됨'이 아니다 — 계속 폴링하면 제한만 길어지니 멈춘다.
          if (p && (p.status !== "error" || /HTTP 429/.test(p.error ?? ""))) {
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

  function usageFor(id: string): ProviderUsage | undefined {
    return snap?.providers.find((p) => p.provider === id);
  }
  function isConnected(e: EngineDef): boolean {
    if (e.auth === "cli") return !!usageFor(e.id) || runtimes.some((r) => r.kind === e.cliKind);
    if (e.auth === "local") return runtimes.some((r) => r.kind === "ollama");
    return !!e.keyEnv && envKeys.has(e.keyEnv);
  }

  async function connectCli(e: EngineDef) {
    const api = ipc();
    if (!api || !e.cliKind || busy) return;
    setBusy(e.id);
    setNotice(null);
    let opened = false;
    try {
      // 1) 설치 — 없으면 깔고, 실패하면 터미널을 열지 않고 이유+수동 명령을 보여준다.
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
        // 기존 설치본만 최신으로(버전 불일치 자동 해소) — 방금 설치한 건 이미 최신. 실패해도 로그인은 진행.
        try {
          await api.runtime.updateCli?.(e.cliKind);
        } catch {
          // best-effort
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
    if (opened && ["claude-code", "codex", "gemini"].includes(e.id)) void watchRecovery(e.id);
  }

  function busyLabel(): string {
    if (busyStage === "install") return ko ? "설치 중…" : "Installing…";
    return ko ? "연결 중…" : "Connecting…";
  }

  // 기본 엔진 선택 — 연결/사용량과 "기본으로 쓸 엔진" 상태를 분리해 표시한다.
  function runtimeFor(e: EngineDef): RuntimeStatus | undefined {
    if (e.auth === "cli") return runtimes.find((r) => r.kind === e.cliKind);
    if (e.auth === "local") return runtimes.find((r) => r.kind === "ollama");
    return undefined; // API키형(BYOK)은 모델 선택이 필요해 세팅의 BYOK 패널이 담당
  }
  async function activateEngine(e: EngineDef, rt: RuntimeStatus) {
    const api = ipc();
    if (!api || busy) return;
    setBusy(e.id);
    try {
      const updated = await api.runtime.setActive({
        kind: rt.kind,
        backend: rt.backend,
        source: rt.source,
        model: rt.model ?? undefined,
      });
      setRuntimes(updated);
    } catch {
      // 실패 시 이전 활성 유지
    } finally {
      setBusy(null);
    }
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
    return u?.status === "error" && /HTTP 429/.test(u.error ?? "");
  }

  function statusText(e: EngineDef, u: ProviderUsage | undefined): string {
    if (e.auth === "apikey") return ko ? "키 과금" : "key-billed";
    if (e.auth === "local") return ko ? "로컬 · 무제한" : "local · unlimited";
    // gemini 슬롯이 Antigravity(agy)로만 연결된 경우: agy는 ~/.gemini/oauth_creds.json을 만들지 않아
    // usage 어댑터가 구조적으로 조회할 수 없다 — "연결됨"과 구분되는 정직한 라벨로 알린다.
    // (스냅샷 로딩 전 깜빡임 방지를 위해 snap 수신 후에만.)
    if (e.id === "gemini" && snap && !u) {
      return ko ? "연결됨 · 사용량 미제공(Antigravity)" : "connected · usage n/a (Antigravity)";
    }
    if (u?.status === "error") {
      if (u.error === "keychain_blocked") {
        // macOS 키체인 접근이 거부/차단됨 — 로그인 문제가 아니라 앱→키체인 권한 문제.
        return ko ? "키체인 접근 차단 — 허용 필요" : "keychain access blocked — allow access";
      }
      if (/auth_expired|HTTP 40[13]/i.test(u.error ?? "")) {
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
    return ko ? "연결됨" : "connected";
  }

  return (
    <div className="dashboard-engine-usage">
      <div className="dashboard-module-head" data-collapsed="false">
        <span>{ko ? "LLM 연결 · 사용량" : "LLM connections · usage"}</span>
        <button onClick={() => void loadUsage(true)} className="titlebar-nodrag dashboard-refresh-button" title={ko ? "새로고침" : "Refresh"}>↻</button>
      </div>

      {ENGINES.map((e) => {
          const u = usageFor(e.id);
          const connected = isConnected(e);
          const rt = runtimeFor(e);
          const hasBars = connected && (u?.windows.length ?? 0) > 0;
          return (
            <div key={e.id} className="dashboard-engine-row" data-connected={connected ? "true" : "false"}>
              <div className="dashboard-engine-topline">
                <span className="dashboard-engine-logo" aria-hidden="true">
                  <img src={e.logoSrc} alt="" />
                </span>
                <span className="sr-only">{e.logoAlt}</span>
                <div className="dashboard-engine-copy">
                  <div>{e.label}</div>
                  <div
                    style={connected && u?.status === "error" ? { color: "var(--red-deep, #c0392b)" } : undefined}
                    title={u?.status === "error" ? u.error ?? undefined : undefined}
                  >
                    {connected ? statusText(e, u) : e.auth === "cli" ? (ko ? "구독 · 미연결" : "subscription · not connected") : e.auth === "apikey" ? (ko ? "API 키 · 미연결" : "API key · not connected") : ko ? "미설치" : "not installed"}
                  </div>
                </div>
                {connected && u?.status === "error" && !isRateLimited(u) ? (
                  // 조회 실패 — 막다른 골목 금지: 재시도 + (CLI) 재로그인 액션을 준다.
                  // (429는 제외 — 로그인 문제가 아니고, 누를수록 제한이 길어진다. 백오프가 자동 재시도.)
                  <span style={{ display: "inline-flex", gap: 6, flexShrink: 0 }}>
                    <button
                      onClick={() => {
                        // 명시 무효화 후 조회 — 낡은 lastResult/백오프가 재시도를 가리지 않게.
                        void ipc()?.usage.invalidate?.(e.id)?.catch(() => undefined);
                        void loadConnections();
                        void loadUsage(true);
                      }}
                      disabled={busy === e.id}
                      className="titlebar-nodrag"
                      title={ko ? "사용량 조회 다시 시도" : "Retry usage fetch"}
                    >
                      {ko ? "다시 시도" : "Retry"}
                    </button>
                    {e.auth === "cli" && (
                      <button
                        onClick={() => void connectCli(e)}
                        disabled={busy === e.id}
                        className="titlebar-nodrag"
                        title={ko ? "CLI 재로그인" : "Re-login CLI"}
                      >
                        {busy === e.id ? busyLabel() : ko ? "재로그인" : "Re-login"}
                      </button>
                    )}
                  </span>
                ) : connected ? (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                    <span className="dashboard-engine-connected">
                      {ko ? "연결됨" : "Connected"}
                    </span>
                    {rt?.active ? (
                      <span className="dashboard-engine-default" title={ko ? "기본 실행 엔진" : "Default run engine"}>
                        {ko ? "기본" : "Default"}
                      </span>
                    ) : rt ? (
                      <button
                        onClick={() => void activateEngine(e, rt)}
                        disabled={busy === e.id}
                        className="titlebar-nodrag"
                        title={ko ? "이 엔진을 기본 실행 엔진으로" : "Make this the default run engine"}
                      >
                        {ko ? "기본으로" : "Use default"}
                      </button>
                    ) : null}
                  </span>
                ) : (
                  <button
                    onClick={() => (e.auth === "apikey" ? setKeyFor(keyFor === e.id ? null : e.id) : void connectCli(e))}
                    disabled={busy === e.id}
                    className="titlebar-nodrag"
                  >
                    {busy === e.id ? busyLabel() : ko ? "연결" : "Connect"}
                  </button>
                )}
              </div>

              {notice?.id === e.id && (
                <div
                  role="alert"
                  style={{
                    fontSize: 11,
                    lineHeight: 1.5,
                    color: "var(--red-deep, #c0392b)",
                    background: "var(--paper)",
                    border: "1px solid var(--paper-edge)",
                    borderRadius: 8,
                    padding: "6px 9px",
                    marginTop: 6,
                    overflowWrap: "anywhere",
                  }}
                >
                  {notice.text}
                  {notice.command && (
                    <>
                      {" "}
                      {ko ? "터미널에서 직접 실행:" : "Run manually:"} <code>{notice.command}</code>
                    </>
                  )}
                </div>
              )}

              {hasBars && u!.windows.map((w) => <UsageBar key={w.id} w={w} ko={ko} />)}

              {keyFor === e.id && !connected && (
                <div className="dashboard-key-editor">
                  <input
                    type="password"
                    autoFocus
                    value={keyVal}
                    onChange={(ev) => setKeyVal(ev.target.value)}
                    onKeyDown={(ev) => ev.key === "Enter" && void saveKey(e)}
                    placeholder={e.keyEnv}
                    className="titlebar-nodrag"
                  />
                  <button onClick={() => void saveKey(e)} disabled={busy === e.id || !keyVal.trim()} className="titlebar-nodrag">
                    {ko ? "저장" : "Save"}
                  </button>
                </div>
              )}
            </div>
          );
        })}
    </div>
  );
}
