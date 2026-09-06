"use client";

// 장기대여 다이얼로그 — 일 단위 선불 대여(오너 결정 2026-08-18, 24시간 자동 리스 폐지).
// 대여는 계정 귀속이다 — 기간 중에는 어느 프로젝트에서든 호출이 무료다.
//
// 흐름: 열리면 GET agent-leases?slug 로 견적을 받는다.
//   · leaseOffered=false → 제공하지 않는다는 안내와 닫기만.
//   · 활성 대여가 있으면 이 다이얼로그는 연장(EXTEND)이다 — 현재 만료일과
//     일수를 더한 새 만료일을 보여준다(서버가 같은 날 재구매를 연장으로 받는다).
//   · 제공 시 일 단가·기간 선택(1/3/7/14/30 프리셋 + 1..30 직접 입력)·합계를 보여주고
//     [대여/연장] 확정 → POST. 402 insufficient_credits 는 부족액(필요 N · 잔액 M)과
//     "플랜 보기"로 안내한다(기존 페이월 문구와 같은 결).
// 서버가 청구의 최종 심판이다 — 이 화면의 합계는 견적이며 표기 단가로만 계산한다.

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { ipc } from "@/lib/ipc";
import { openPricing } from "@/components/UpgradeCta";
import type { AgentLeaseQuote } from "@shared/types";
import { LoadingEstimate } from "@/components/LoadingEstimate";

const DAY_PRESETS = [1, 3, 7, 14, 30] as const;

export function AgentLeaseDialog({
  slug,
  agentName,
  locale,
  onClose,
  onLeased,
}: {
  slug: string;
  agentName: string;
  locale: string;
  onClose: () => void;
  /** 구매 성공 — 부모가 대여 상태를 새로고침하고 닫는다. */
  onLeased: (leasedUntil: string) => void;
}) {
  const ko = locale === "ko";
  const [quote, setQuote] = useState<AgentLeaseQuote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(true);
  const [days, setDays] = useState(7);
  const [daysText, setDaysText] = useState("7");
  const [purchasing, setPurchasing] = useState(false);
  const [failure, setFailure] = useState<{ kind: "insufficient"; needed: number | null; have: number | null } | { kind: "other"; message: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setQuoteLoading(true);
    void ipc()?.agentLeases.quote(slug)
      .then((result) => { if (!cancelled) setQuote(result); })
      .catch(() => { if (!cancelled) setQuote({ ok: false, active: false, leasedUntil: null, perDayCredits: null, leaseOffered: false }); })
      .finally(() => { if (!cancelled) setQuoteLoading(false); });
    return () => { cancelled = true; };
  }, [slug]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !purchasing) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, purchasing]);

  const validDays = Number.isInteger(days) && days >= 1 && days <= 30;
  const perDay = quote?.perDayCredits ?? null;
  const total = useMemo(
    () => (validDays && typeof perDay === "number" ? perDay * days : null),
    [validDays, perDay, days],
  );
  // 활성 대여가 있으면 이 다이얼로그는 연장이다 — 서버가 같은 날 재구매를
  // 연장으로 받으므로(2026-08-18 계약) 새 만료일 = 현재 만료일 + 일수.
  const currentLeaseEnd =
    quote?.active && typeof quote.leasedUntil === "string" && Number.isFinite(Date.parse(quote.leasedUntil))
      ? new Date(quote.leasedUntil)
      : null;
  const extending = currentLeaseEnd !== null;
  const newLeaseEnd = extending && validDays
    ? new Date(currentLeaseEnd.getTime() + days * 86_400_000)
    : null;
  const formatLeaseEnd = (date: Date) =>
    new Intl.DateTimeFormat(ko ? "ko-KR" : "en-US", { month: ko ? "long" : "short", day: "numeric" }).format(date);

  function pickDays(next: number) {
    setDays(next);
    setDaysText(String(next));
  }

  async function purchase() {
    if (!validDays || purchasing) return;
    setPurchasing(true);
    setFailure(null);
    try {
      const result = await ipc()?.agentLeases.purchase({ slug, days });
      if (result?.ok) {
        onLeased(result.leasedUntil);
        return;
      }
      if (result?.code === "insufficient_credits") {
        setFailure({ kind: "insufficient", needed: result.needed ?? total, have: result.have ?? null });
      } else if (result?.code === "lease_not_offered") {
        setQuote((current) => current ? { ...current, leaseOffered: false } : current);
      } else {
        setFailure({ kind: "other", message: result?.message || (ko ? "대여를 완료하지 못했습니다." : "The lease could not be completed.") });
      }
    } catch (error) {
      setFailure({ kind: "other", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setPurchasing(false);
    }
  }

  const notOffered = !quoteLoading && (!quote?.ok || !quote.leaseOffered);

  return (
    <div
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !purchasing) onClose();
      }}
      style={{ position: "fixed", inset: 0, zIndex: 1220, display: "grid", placeItems: "center", padding: 24, background: "rgba(21, 22, 18, .34)", backdropFilter: "blur(3px)" }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-lease-title"
        style={{ width: "var(--popup-3-width)", border: "1px solid var(--paper-edge)", borderRadius: 16, background: "var(--paper)", boxShadow: "0 24px 80px rgba(20, 22, 18, .22)", padding: 20, display: "flex", flexDirection: "column", gap: 14 }}
      >
        <header>
          <h2 id="agent-lease-title" style={{ margin: 0, fontSize: 17, fontFamily: "var(--font-head)" }}>
            {extending ? (ko ? "대여 연장" : "Extend lease") : (ko ? "장기대여" : "Long-term lease")}
          </h2>
          <p style={{ margin: "5px 0 0", color: "var(--muted-deep)", fontSize: 12, lineHeight: 1.5 }}>
            {agentName}
          </p>
        </header>

        {quoteLoading ? (
          <div role="status" style={{ padding: "18px 0", textAlign: "center", color: "var(--muted-deep)", fontSize: 12.5, display: "grid", gap: 6, justifyItems: "center" }}>
            <span>{ko ? "대여 조건을 확인하는 중…" : "Checking lease terms…"}</span>
            <LoadingEstimate locale={ko ? "ko" : "en"} operationKey="desktop-agent-lease-quote" expectedSeconds={[2, 15]} />
          </div>
        ) : notOffered ? (
          <>
            <div role="status" style={{ padding: "14px 12px", borderRadius: 10, border: "1px solid var(--paper-edge)", background: "var(--paper-2)", color: "var(--ink-soft)", fontSize: 13, lineHeight: 1.55 }}>
              {ko ? "이 에이전트는 장기대여를 제공하지 않습니다." : "This agent does not offer long-term leases."}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button type="button" onClick={onClose} style={secondaryButton}>
                {ko ? "닫기" : "Close"}
              </button>
            </div>
          </>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <strong style={{ fontSize: 14 }}>
                {ko ? `하루 ${perDay ?? "?"} 크레딧` : `${perDay ?? "?"} credits per day`}
              </strong>
            </div>

            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {DAY_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => pickDays(preset)}
                  aria-pressed={days === preset}
                  style={{
                    minWidth: 48,
                    minHeight: 32,
                    padding: "0 10px",
                    borderRadius: 8,
                    border: days === preset ? "1px solid var(--accent)" : "1px solid var(--paper-edge)",
                    background: days === preset ? "color-mix(in srgb, var(--accent) 8%, var(--paper))" : "var(--paper)",
                    color: days === preset ? "var(--accent)" : "var(--ink)",
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  {ko ? `${preset}일` : `${preset}d`}
                </button>
              ))}
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--muted-deep)" }}>
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={30}
                  step={1}
                  value={daysText}
                  onChange={(event) => {
                    setDaysText(event.target.value);
                    setDays(Number(event.target.value));
                  }}
                  aria-label={ko ? "대여 일수 (1~30)" : "Lease days (1-30)"}
                  aria-invalid={!validDays}
                  style={{
                    width: 64,
                    height: 32,
                    padding: "0 8px",
                    borderRadius: 8,
                    border: `1px solid ${validDays ? "var(--paper-edge)" : "var(--red-deep)"}`,
                    background: "var(--paper)",
                    color: "var(--ink)",
                    fontFamily: "var(--font-mono)",
                    fontSize: 12.5,
                  }}
                />
                {ko ? "일 (1~30)" : "days (1-30)"}
              </label>
            </div>

            <div style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid var(--paper-edge)", background: "var(--paper-2)", display: "flex", flexDirection: "column", gap: 5 }}>
              {extending && (
                <>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5 }}>
                    <span style={{ color: "var(--muted-deep)" }}>{ko ? "현재 만료" : "Current end"}</span>
                    <span style={{ fontFamily: "var(--font-mono)" }}>{formatLeaseEnd(currentLeaseEnd)}</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5 }}>
                    <span style={{ color: "var(--muted-deep)" }}>{ko ? "연장 후 만료" : "New end"}</span>
                    <span style={{ fontFamily: "var(--font-mono)" }}>{newLeaseEnd ? formatLeaseEnd(newLeaseEnd) : "—"}</span>
                  </div>
                </>
              )}
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                <span style={{ color: "var(--muted-deep)" }}>{ko ? "합계" : "Total"}</span>
                <strong style={{ fontFamily: "var(--font-mono)" }}>
                  {total !== null
                    ? (ko ? `${total.toLocaleString()} 크레딧` : `${total.toLocaleString()} credits`)
                    : "—"}
                </strong>
              </div>
              <span style={{ fontSize: 11.5, color: "var(--muted-deep)", lineHeight: 1.5 }}>
                {ko
                  ? "대여 기간 동안 이 에이전트 호출은 어느 프로젝트에서든 추가 크레딧이 들지 않습니다."
                  : "While leased, calls to this agent cost no extra credits in any project."}
              </span>
            </div>

            {failure && (
              <div role="alert" style={{ padding: "10px 12px", borderRadius: 10, background: "var(--red-soft)", color: "var(--red-deep)", fontSize: 12.5, lineHeight: 1.5, display: "flex", flexDirection: "column", gap: 6 }}>
                {failure.kind === "insufficient" ? (
                  <>
                    <span>
                      {ko
                        ? `크레딧이 부족해요 — 필요 ${failure.needed ?? "?"}cr · 잔액 ${failure.have ?? "?"}cr`
                        : `Not enough credits — ${failure.needed ?? "?"}cr needed · ${failure.have ?? "?"}cr balance`}
                    </span>
                    <button type="button" onClick={openPricing} style={{ alignSelf: "flex-start", textDecoration: "underline", textUnderlineOffset: 3, color: "inherit", fontSize: 12.5, fontWeight: 700, background: "transparent", border: 0, padding: 0, cursor: "pointer" }}>
                      {ko ? "플랜 보기" : "See plans"}
                    </button>
                  </>
                ) : (
                  <span>{failure.message}</span>
                )}
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button type="button" disabled={purchasing} onClick={onClose} style={secondaryButton}>
                {ko ? "닫기" : "Close"}
              </button>
              <button
                type="button"
                disabled={!validDays || total === null || purchasing}
                onClick={() => void purchase()}
                style={{
                  minHeight: 36,
                  padding: "0 18px",
                  borderRadius: 9,
                  border: 0,
                  background: "var(--accent)",
                  color: "var(--white)",
                  fontSize: 13,
                  fontWeight: 750,
                  cursor: !validDays || total === null || purchasing ? "default" : "pointer",
                  opacity: !validDays || total === null || purchasing ? 0.55 : 1,
                }}
              >
                {purchasing
                  ? (extending ? (ko ? "연장 중…" : "Extending…") : (ko ? "대여 중…" : "Leasing…"))
                  : (extending ? (ko ? "연장" : "Extend") : (ko ? "대여" : "Lease"))}
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

const secondaryButton: CSSProperties = {
  minHeight: 36,
  padding: "0 14px",
  borderRadius: 9,
  border: "1px solid var(--paper-edge)",
  background: "var(--paper)",
  color: "var(--muted-deep)",
  fontSize: 12.5,
  fontWeight: 650,
  cursor: "pointer",
};
