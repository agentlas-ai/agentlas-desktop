// 대시보드 "엔진 사용량" 카드 — 모든 엔진을 카탈로그로 보여준다.
//   · 구독형(Claude·Codex·Gemini): 연결 시 usage.snapshot()의 5시간/주간/일일 바.
//   · API키형(DeepSeek·Grok·GLM·Pi): 연결 시 "키 과금", 미연결 시 키 입력 팝업.
//   · 로컬(Ollama): "무제한".
// 미연결 엔진은 [연결] 버튼 — CLI는 자동설치+로그인창, API키는 인라인 입력 후 저장.
// 카드 헤더로 접기/펼치기(상태는 localStorage).
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ipc } from "@/lib/ipc";
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
  cliKind?: "claude-code" | "codex" | "gemini";
  keyEnv?: string;
  glyph: string;
}

const ENGINES: EngineDef[] = [
  { id: "claude-code", label: "Claude Code", auth: "cli", cliKind: "claude-code", glyph: "C" },
  { id: "codex", label: "Codex", auth: "cli", cliKind: "codex", glyph: "G" },
  { id: "gemini", label: "Gemini", auth: "cli", cliKind: "gemini", glyph: "✦" },
  { id: "deepseek", label: "DeepSeek", auth: "apikey", keyEnv: "DEEPSEEK_API_KEY", glyph: "D" },
  { id: "grok", label: "Grok", auth: "apikey", keyEnv: "XAI_API_KEY", glyph: "x" },
  { id: "glm", label: "GLM", auth: "apikey", keyEnv: "ZHIPU_API_KEY", glyph: "Z" },
  { id: "pi", label: "Pi", auth: "apikey", keyEnv: "PI_API_KEY", glyph: "π" },
  { id: "ollama", label: "Ollama", auth: "local", glyph: "O" },
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
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ fontSize: 10.5, color: "var(--muted-deep)", width: 76, flexShrink: 0 }}>{windowLabel(w, ko)}</span>
      <div style={{ flex: 1, height: 6, borderRadius: 99, background: "var(--fill-1)", overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${pct}%`, background: fill, borderRadius: 99 }} />
      </div>
      <span style={{ fontSize: 10.5, fontFamily: "var(--font-mono)", width: 32, textAlign: "right", flexShrink: 0, color: warn ? "var(--red-deep, #c0392b)" : "var(--muted-deep)" }}>{pct}%</span>
      <span style={{ fontSize: 10, fontFamily: "var(--font-mono)", width: 92, textAlign: "right", flexShrink: 0, color: "var(--muted-deep)" }}>{formatReset(w.resetAt, ko)}</span>
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
  const [keyFor, setKeyFor] = useState<string | null>(null);
  const [keyVal, setKeyVal] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

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

  useEffect(() => {
    void loadUsage();
    void loadConnections();
    timer.current = setInterval(() => void loadUsage(), POLL_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [loadUsage, loadConnections]);

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
    try {
      await api.runtime.installCli(e.cliKind); // 자동설치(이미 있으면 no-op)
      await api.runtime.openCliLogin(e.cliKind); // 로그인창/터미널
      await loadConnections();
      await loadUsage(true);
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
    if (u?.status === "error") return ko ? "조회 실패" : "fetch failed";
    if (u?.status === "no_quota") return ko ? "연결됨 · 사용량 곧" : "connected · usage soon";
    return ko ? "연결됨" : "connected";
  }

  return (
    <div style={{ background: "var(--paper-2)", border: "1px solid var(--paper-edge)", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "9px 13px", background: "var(--fill-1)", borderBottom: collapsed ? "none" : "1px solid var(--paper-edge)" }}>
        <button
          onClick={toggleCollapsed}
          className="titlebar-nodrag"
          aria-label={ko ? "접기/펼치기" : "Toggle"}
          style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--muted-deep)", fontSize: 10, width: 14, transform: collapsed ? "none" : "rotate(90deg)", transition: "transform .15s", padding: 0 }}
        >
          ▶
        </button>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink)", flex: 1 }}>{ko ? "엔진 사용량" : "Engine usage"}</span>
        <button onClick={() => void loadUsage(true)} className="titlebar-nodrag" title={ko ? "새로고침" : "Refresh"} style={{ background: "transparent", border: "none", color: "var(--muted-deep)", cursor: "pointer", fontSize: 11, padding: "2px 6px" }}>↻</button>
      </div>

      {!collapsed &&
        ENGINES.map((e) => {
          const u = usageFor(e.id);
          const connected = isConnected(e);
          const hasBars = connected && (u?.windows.length ?? 0) > 0;
          return (
            <div key={e.id} style={{ display: "flex", flexDirection: "column", gap: 7, padding: "10px 13px", borderTop: "1px solid var(--paper-edge)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                <span style={{ width: 25, height: 25, borderRadius: 7, background: connected ? "var(--accent-soft, var(--fill-1))" : "var(--fill-1)", color: connected ? "var(--accent)" : "var(--muted-deep)", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 600, flexShrink: 0 }}>{e.glyph}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink)" }}>{e.label}</div>
                  <div style={{ fontSize: 10.5, color: "var(--muted-deep)", fontFamily: "var(--font-mono)" }}>
                    {connected ? statusText(e, u) : e.auth === "cli" ? (ko ? "구독 · 미연결" : "subscription · not connected") : e.auth === "apikey" ? (ko ? "API 키 · 미연결" : "API key · not connected") : ko ? "미설치" : "not installed"}
                  </div>
                </div>
                {connected ? (
                  <span style={{ fontSize: 14, color: "var(--green-deep, var(--accent))" }} aria-label={ko ? "연결됨" : "connected"}>✓</span>
                ) : (
                  <button
                    onClick={() => (e.auth === "apikey" ? setKeyFor(keyFor === e.id ? null : e.id) : void connectCli(e))}
                    disabled={busy === e.id}
                    className="titlebar-nodrag"
                    style={{ fontSize: 11.5, padding: "4px 12px", borderRadius: 8, border: "1px solid var(--accent)", color: "var(--accent)", background: "transparent", cursor: busy === e.id ? "default" : "pointer", flexShrink: 0, fontWeight: 500 }}
                  >
                    {busy === e.id ? (ko ? "연결 중…" : "Connecting…") : ko ? "연결" : "Connect"}
                  </button>
                )}
              </div>

              {hasBars && u!.windows.map((w) => <UsageBar key={w.id} w={w} ko={ko} />)}

              {keyFor === e.id && !connected && (
                <div style={{ display: "flex", gap: 7, marginTop: 2 }}>
                  <input
                    type="password"
                    autoFocus
                    value={keyVal}
                    onChange={(ev) => setKeyVal(ev.target.value)}
                    onKeyDown={(ev) => ev.key === "Enter" && void saveKey(e)}
                    placeholder={e.keyEnv}
                    className="titlebar-nodrag"
                    style={{ flex: 1, height: 30, padding: "0 9px", fontSize: 12, fontFamily: "var(--font-mono)", background: "var(--paper-2)", border: "1px solid var(--paper-edge)", borderRadius: 8, color: "var(--ink)" }}
                  />
                  <button onClick={() => void saveKey(e)} disabled={busy === e.id || !keyVal.trim()} className="titlebar-nodrag" style={{ fontSize: 11.5, padding: "0 13px", borderRadius: 8, border: "none", background: "var(--accent)", color: "#fff", cursor: keyVal.trim() ? "pointer" : "default", fontWeight: 500 }}>
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
