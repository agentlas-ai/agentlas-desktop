"use client";
// 컨텍스트 상세(docs/2026-10-13-native-harness/20): 마지막 모델 요청에 실린 항목별 토큰을 harness context.inspect 로 읽는다.
// 열기만으로 모델 호출·로그인·압축·세션 종료를 하지 않는다. 항목마다 측정 방식(공급자 집계/추정/확인 불가)을 그대로 보인다.
// NH18: 과거 요청(시각·요청 id)과 현재 설정을 나눠 보이고, 집계 차이는 양쪽 방향, 창은 실행기가 보고한 값이 있으면 그것,
// 같은 대화의 새 요청이 생기면 다시 읽고, 항목을 펼치면 그 요청에 실제로 실린 원문(보존된 것만)을 읽는다.
import { useEffect, useRef, useState } from "react";
import { ipc } from "@/lib/ipc";
import type { Locale } from "@/lib/i18n";
import { OperatorTelemetry } from "./OperatorTelemetry";

type Category = "system_prompt" | "tools" | "messages" | "agentlas_instructions" | "attachments" | "current_input" | "tool_exchanges" | "framing";
type Measurement = "provider_reported" | "host_estimated" | "unavailable";
interface Occurrence { occurrenceId: string; category: Category; tokens: number | null; measurement: Measurement; bytes?: number;
  original: "retained" | "not_retained" | "elsewhere" | "provider_held" | "derived" }
interface Snapshot {
  status: "observed" | "no_request";
  requestId?: string;
  request?: { ts: string; mode?: string };
  capacity: { tokens: number | null; source?: "runtime-reported" | "model-catalog" | "unavailable" };
  input: { tokens: number | null; measurement: Measurement; cachedTokens?: number };
  rotationAtTokens: number | null;
  usedRatio: number | null;
  items: Array<{ category: Category; tokens: number | null; measurement: Measurement }>;
  occurrences?: Occurrence[];
  unattributedTokens: number | null;
  overAttributedTokens?: number | null;
  views?: {
    sessionCumulative: { requests: number; inputTokens: number; outputTokens: number; unmeasuredRequests: number };
    nextRequestEstimate: { basis: "current-settings"; moduleTokens: number; modules: number };
  };
  requests?: Array<{ requestId: string; ts: string; role: string; inputTokens: number | null; measurement: Measurement }>;
}
/** Same chat, a new request: re-read while the panel is open (a cheap indexed read, never a model call). */
const REFRESH_MS = 4_000;

const LABEL: Record<Category | "unattributed" | "overAttributed", { ko: string; en: string; color: string }> = {
  system_prompt: { ko: "시스템", en: "System", color: "var(--accent)" },
  tools: { ko: "도구", en: "Tools", color: "#7c6cf0" },
  agentlas_instructions: { ko: "실행 지침", en: "Instructions", color: "#e39a3b" },
  messages: { ko: "대화", en: "Messages", color: "#3aa57a" },
  tool_exchanges: { ko: "도구 결과", en: "Tool results", color: "#4a90d9" },
  attachments: { ko: "첨부", en: "Attachments", color: "#c45d8c" },
  current_input: { ko: "이번 입력", en: "Input", color: "#8a8f98" },
  framing: { ko: "형식", en: "Framing", color: "#b8bcc4" },
  unattributed: { ko: "실행기 내장", en: "Runtime built-in", color: "var(--paper-edge-strong)" },
  overAttributed: { ko: "추정 차이", en: "Estimate gap", color: "transparent" },
};
/**
 * A continued CLI session (ledger mode resume/reopen) keeps the earlier conversation and tool results inside the
 * provider, and Agentlas sends only the new input. Its residual is then mostly that held history, not runtime defaults.
 * Yotube 2026-10-17: 236k of a 241k codex request; a fresh codex thread starts at 15-24k.
 */
const HELD_SESSION_LABEL = { ko: "세션에 쌓인 기록·실행기 기본", en: "Session history + runtime base" };

const clock = (iso: string | undefined, locale: Locale): string => {
  if (!iso) return "";
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "" : at.toLocaleTimeString(locale === "ko" ? "ko-KR" : "en-US", { hour: "2-digit", minute: "2-digit" });
};

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  return String(value);
}

export function ContextBreakdown({ chatId, locale, fallbackLabel, fallbackNote }: { chatId: string | null; locale: Locale; fallbackLabel: string; fallbackNote?: string }) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [operatorOpen, setOperatorOpen] = useState(false);
  /** null = the newest request (follows new turns); a requestId = that exact past request. */
  const [pinnedRequest, setPinnedRequest] = useState<string | null>(null);
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [source, setSource] = useState<{ occurrenceId: string; text: string | null } | null>(null);
  const seen = useRef<string>("");
  useEffect(() => {
    let live = true;
    seen.current = "";
    if (!chatId) return;
    const read = () => {
      void ipc()?.harness?.call("context.inspect", { chatId, ...(pinnedRequest ? { requestId: pinnedRequest } : {}) }).then((result) => {
        if (!live || result?.status !== "ok") return;
        const next = result.data as Snapshot;
        // A Desktop that cannot read a past request answers with the newest one: never show it under the pinned label.
        if (pinnedRequest && next.requestId !== pinnedRequest) { setPinnedRequest(null); return; }
        const key = `${next.requestId ?? ""}:${next.input.tokens ?? ""}:${next.views?.sessionCumulative.requests ?? ""}`;
        if (key === seen.current) return;
        seen.current = key;
        setSnap(next);
      }).catch(() => undefined);
    };
    read();
    const timer = pinnedRequest ? null : setInterval(read, REFRESH_MS);
    return () => { live = false; if (timer) clearInterval(timer); };
  }, [chatId, pinnedRequest]);
  useEffect(() => { setOpenRow(null); setSource(null); }, [snap?.requestId]);
  const openOccurrence = (occurrence: Occurrence | undefined) => {
    if (!occurrence || !chatId) return;
    const toggled = openRow === occurrence.occurrenceId ? null : occurrence.occurrenceId;
    setOpenRow(toggled);
    setSource(null);
    if (!toggled || occurrence.original !== "retained") return;
    void ipc()?.harness?.call("context.sources.get", { chatId, occurrenceId: occurrence.occurrenceId }).then((result) => {
      const data = result?.status === "ok" ? result.data as { original?: string; text?: string } : null;
      setSource({ occurrenceId: occurrence.occurrenceId, text: data?.original === "retained" && typeof data.text === "string" ? data.text : null });
    }).catch(() => setSource({ occurrenceId: occurrence.occurrenceId, text: null }));
  };
  const ko = locale === "ko";
  const input = snap?.status === "observed" ? snap.input.tokens : null;
  const capacity = snap?.capacity.tokens ?? null;
  const approx = snap?.input.measurement === "host_estimated" ? "~" : "";
  const headline = input === null ? fallbackLabel : `${approx}${formatTokens(input)}${capacity ? ` / ${formatTokens(capacity)}` : ""}`;
  const percent = snap?.usedRatio != null ? `${Math.round(snap.usedRatio * 100)}%` : null;
  const rows: Array<{ key: Category | "unattributed" | "overAttributed"; tokens: number | null; sign?: "-" }> = snap?.status === "observed"
    ? [...snap.items.map((item) => ({ key: item.category, tokens: item.tokens })),
      ...(snap.unattributedTokens ? [{ key: "unattributed" as const, tokens: snap.unattributedTokens }] : []),
      ...(snap.overAttributedTokens ? [{ key: "overAttributed" as const, tokens: snap.overAttributedTokens, sign: "-" as const }] : [])]
    : [];
  const total = capacity ?? Math.max(1, rows.reduce((sum, row) => sum + (row.sign ? 0 : row.tokens ?? 0), 0));
  const at = clock(snap?.request?.ts, locale);
  const which = pinnedRequest ? (ko ? "이전 요청" : "Earlier request") : (ko ? "최근 요청" : "Last request");
  const note = input === null
    ? (fallbackNote ?? (ko ? "기록 추정" : "History estimate"))
    : `${which}${at ? ` ${at}` : ""} · ${snap!.input.measurement === "provider_reported" ? (ko ? "공급자 집계" : "provider") : (ko ? "추정" : "estimate")}`
      + (snap!.capacity.source === "runtime-reported" ? (ko ? " · 보고된 창" : " · reported window") : "");
  const heldSession = snap?.request?.mode === "resume" || snap?.request?.mode === "reopen";
  const occurrenceOf = (key: string) => snap?.occurrences?.find((item) => item.category === key);
  const session = snap?.views?.sessionCumulative;
  const nextEstimate = snap?.views?.nextRequestEstimate;
  return (
    <div data-context-breakdown="true" style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
        <strong style={{ fontSize: 22, lineHeight: 1.2, color: "var(--ink)" }}>{headline}</strong>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          {percent && <span style={{ fontSize: 12, fontWeight: 750, color: "var(--accent)" }}>{percent}</span>}
          {chatId && (
            <button type="button" aria-pressed={operatorOpen} aria-label={ko ? "운영 통계" : "Operator stats"} title={ko ? "운영 통계" : "Operator stats"}
              onClick={() => setOperatorOpen((open) => !open)}
              style={{ display: "inline-flex", padding: 4, border: 0, borderRadius: 4, cursor: "pointer", color: "var(--ink-soft)", background: operatorOpen ? "var(--fill-1)" : "transparent" }}>
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden fill="currentColor"><rect x="1" y="6" width="2.4" height="5" rx=".6" /><rect x="4.8" y="3" width="2.4" height="8" rx=".6" /><rect x="8.6" y="1" width="2.4" height="10" rx=".6" /></svg>
            </button>
          )}
        </span>
      </div>
      {operatorOpen && <OperatorTelemetry chatId={chatId} locale={locale} />}
      {note && <span style={{ color: "var(--muted-deep)", fontSize: 10.5 }}>
        {note}{snap?.input.cachedTokens ? ` · ${ko ? "캐시" : "cached"} ${formatTokens(snap.input.cachedTokens)}` : ""}
      </span>}
      {rows.length > 0 && (
        <>
          <div aria-hidden style={{ position: "relative", display: "flex", height: 6, borderRadius: 3, overflow: "hidden", background: "var(--fill-1)" }}>
            {rows.filter((row) => !row.sign && (row.tokens ?? 0) > 0).map((row) => (
              <span key={row.key} style={{ width: `${((row.tokens ?? 0) / total) * 100}%`, background: LABEL[row.key].color }} />
            ))}
            {capacity && snap?.rotationAtTokens ? (
              <span style={{ position: "absolute", top: 0, bottom: 0, left: `${(snap.rotationAtTokens / capacity) * 100}%`, width: 1, background: "var(--ink-soft)" }} />
            ) : null}
          </div>
          <div style={{ display: "grid", gap: 3 }}>
            {rows.map((row) => {
              const occurrence = occurrenceOf(row.key);
              const open = !!occurrence && openRow === occurrence.occurrenceId;
              return (
                <div key={row.key} style={{ display: "grid", gap: 4 }}>
                  <button type="button" disabled={!occurrence} aria-expanded={occurrence ? open : undefined}
                    onClick={() => openOccurrence(occurrence)}
                    style={{ display: "grid", gridTemplateColumns: "8px 1fr auto", alignItems: "center", gap: 6, fontSize: 10.5, padding: "2px 4px",
                      border: 0, borderRadius: 4, background: open ? "var(--fill-1)" : "transparent", cursor: occurrence ? "pointer" : "default", textAlign: "left", color: "inherit" }}>
                    <span aria-hidden style={{ width: 8, height: 8, borderRadius: 2, background: LABEL[row.key].color, border: row.sign ? "1px solid var(--paper-edge-strong)" : 0 }} />
                    <span style={{ color: "var(--ink-soft)" }}>{(() => {
                      const label = row.key === "unattributed" && heldSession ? HELD_SESSION_LABEL : LABEL[row.key];
                      return ko ? label.ko : label.en;
                    })()}</span>
                    <span style={{ color: row.tokens === null ? "var(--muted)" : "var(--ink)", fontVariantNumeric: "tabular-nums" }}>
                      {row.tokens === null ? "—" : `${row.sign ?? ""}${formatTokens(row.tokens)}`}
                    </span>
                  </button>
                  {open && occurrence && (
                    <div data-context-occurrence={occurrence.occurrenceId} style={{ display: "grid", gap: 4, padding: "6px 8px", borderRadius: 6, background: "var(--fill-1)", fontSize: 10.5, color: "var(--muted-deep)" }}>
                      <span>{occurrence.measurement === "provider_reported" ? (ko ? "공급자 집계" : "provider")
                        : occurrence.measurement === "host_estimated" ? (ko ? "추정" : "estimate") : (ko ? "확인 불가" : "unavailable")}
                        {occurrence.bytes !== undefined ? ` · ${formatTokens(occurrence.bytes)}B` : ""}
                        {` · ${occurrence.original === "retained" ? (ko ? "원문 보존" : "original kept")
                          : occurrence.original === "elsewhere" ? (ko ? "대화 기록에 있음" : "in the conversation record")
                            : occurrence.original === "provider_held" ? (ko ? "공급자 세션 안" : "inside the provider session")
                              : occurrence.original === "derived" ? (ko ? "계산값" : "derived")
                              : (ko ? "원문 없음" : "original not kept")}`}</span>
                      {source?.occurrenceId === occurrence.occurrenceId && source.text !== null && (
                        <pre style={{ margin: 0, maxHeight: 220, overflow: "auto", padding: "6px 8px", borderRadius: 4, background: "var(--paper)", color: "var(--ink)",
                          whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 10.5 }}>{source.text}</pre>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
      {(session || nextEstimate) && (
        <div style={{ display: "grid", gap: 2, color: "var(--muted-deep)", fontSize: 10.5 }}>
          {session && session.requests > 0 && <span>
            {ko ? "누적" : "Session"} {session.requests} · {ko ? "입력" : "in"} {formatTokens(session.inputTokens)} · {ko ? "출력" : "out"} {formatTokens(session.outputTokens)}
            {session.unmeasuredRequests ? ` · ${ko ? "미측정" : "unmeasured"} ${session.unmeasuredRequests}` : ""}
          </span>}
          {nextEstimate && nextEstimate.modules > 0 && <span>{ko ? "현재 설정 지침" : "Current settings"} ~{formatTokens(nextEstimate.moduleTokens)}</span>}
        </div>
      )}
      {snap?.requests && snap.requests.length > 1 && (
        <select aria-label={ko ? "요청" : "Request"} value={pinnedRequest ?? ""} onChange={(event) => setPinnedRequest(event.target.value || null)}
          style={{ fontSize: 10.5, padding: "2px 4px", borderRadius: 4, border: "1px solid var(--paper-edge)", background: "var(--paper)", color: "var(--ink-soft)" }}>
          <option value="">{ko ? "최근 요청" : "Last request"}</option>
          {snap.requests.map((request) => (
            <option key={request.requestId} value={request.requestId}>
              {clock(request.ts, locale)} · {request.role}{request.inputTokens !== null ? ` · ${formatTokens(request.inputTokens)}` : ""}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
