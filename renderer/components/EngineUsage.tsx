// 대시보드 "엔진 사용량" 카드 — 모든 엔진을 카탈로그로 보여준다.
//   · 구독형(Claude·Codex·Gemini): 연결 시 usage.snapshot()의 5시간/주간/일일 바.
//   · API키형(DeepSeek·Grok·GLM·Pi): 연결 시 "키 과금", 미연결 시 키 입력 팝업.
//   · 로컬(Ollama): "무제한".
// 미연결 엔진은 [연결] 버튼 — CLI는 자동설치+로그인창, API키는 인라인 입력 후 저장.
// 카드 헤더로 접기/펼치기(상태는 localStorage).
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

const POLL_MS = 60_000;
const WARN_PCT = 80;
const COLLAPSE_KEY = "agentlas.dash.usageCollapsed";

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

function UsageBar({ w, ko }: { w: UsageWindow; ko: boolean }) {
  const pct = Math.round(w.usedPercent);
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
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === "1");
    } catch {
      // ignore
    }
  }, []);

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
      for (let i = 0; i < 36; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        if (pollGen.current !== gen) return;
        try {
          const s = await api.usage.snapshot({ force: true });
          if (pollGen.current !== gen) return;
          setSnap(s);
          const p = s.providers.find((x) => x.provider === providerId);
          if (p && p.status !== "error") {
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

  function toggleCollapsed() {
    setCollapsed((c) => {
      const next = !c;
      try {
        window.localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        // ignore
      }
      return next;
    });
  }

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
    if (opened) void watchRecovery(e.id); // 터미널 로그인 완료를 감지해 자동 갱신
  }

  function busyLabel(): string {
    if (busyStage === "install") return ko ? "설치 중…" : "Installing…";
    return ko ? "연결 중…" : "Connecting…";
  }

  // 기본(활성) 엔진 선택 — 세팅의 detected 목록에서 대시보드로 이관(엔진 관리 일원화).
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

  function statusText(e: EngineDef, u: ProviderUsage | undefined): string {
    if (e.auth === "apikey") return ko ? "키 과금" : "key-billed";
    if (e.auth === "local") return ko ? "로컬 · 무제한" : "local · unlimited";
    if (u?.status === "error") {
      return /auth_expired|HTTP 40[13]/i.test(u.error ?? "")
        ? ko ? "로그인 만료 — 재로그인 필요" : "login expired — re-login"
        : ko ? "조회 실패" : "fetch failed";
    }
    if (u?.status === "no_quota") return ko ? "연결됨 · 사용량 곧" : "connected · usage soon";
    return ko ? "연결됨" : "connected";
  }

  return (
    <div className="dashboard-engine-usage">
      <div className="dashboard-module-head" data-collapsed={collapsed ? "true" : "false"}>
        <button
          onClick={toggleCollapsed}
          className="titlebar-nodrag"
          aria-label={ko ? "접기/펼치기" : "Toggle"}
          data-dashboard-chevron={collapsed ? "closed" : "open"}
        >
          ▶
        </button>
        <span>{ko ? "엔진 사용량" : "Engine usage"}</span>
        <button onClick={() => void loadUsage(true)} className="titlebar-nodrag dashboard-refresh-button" title={ko ? "새로고침" : "Refresh"}>↻</button>
      </div>

      {!collapsed &&
        ENGINES.map((e) => {
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
                {connected && u?.status === "error" ? (
                  // 조회 실패 — 막다른 골목 금지: 재시도 + (CLI) 재로그인 액션을 준다.
                  <span style={{ display: "inline-flex", gap: 6, flexShrink: 0 }}>
                    <button
                      onClick={() => {
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
                    {rt?.active ? (
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 800,
                          color: "#fff",
                          background: "var(--accent)",
                          borderRadius: 999,
                          padding: "2px 8px",
                          whiteSpace: "nowrap",
                        }}
                        title={ko ? "기본 엔진" : "Default engine"}
                      >
                        {ko ? "활성" : "active"}
                      </span>
                    ) : rt ? (
                      <button
                        onClick={() => void activateEngine(e, rt)}
                        disabled={busy === e.id}
                        className="titlebar-nodrag"
                        title={ko ? "이 엔진을 기본 엔진으로" : "Make this the default engine"}
                      >
                        {ko ? "활성화" : "Activate"}
                      </button>
                    ) : null}
                    <span className="dashboard-engine-check" aria-label={ko ? "연결됨" : "connected"}>✓</span>
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
