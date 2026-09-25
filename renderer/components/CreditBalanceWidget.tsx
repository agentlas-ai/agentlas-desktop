// 사이드바 하단 AI 사용 크레딧 잔액. 공개 Hub 에이전트 호출과 무관하다.
// 과거 렌트 수익 및 잔액 전송 UI는 마켓플레이스 정산 영구 폐쇄로 제거했다.
// 세션은 main이 보관하며 렌더러는 IPC로 잔액만 조회한다.
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ipc } from "@/lib/ipc";
import { useVisibleInterval } from "@/lib/useVisibleInterval";
import { useT } from "@/lib/i18n";
import { useDismissibleLayer } from "@/lib/use-dismissible-layer";
import { loadViewData, readViewData } from "@/lib/view-data-cache";
import { openPricing } from "./UpgradeCta";
import type { HubCreditBalance } from "@/lib/types";

const POLL_MS = 60_000;
/** 구독 잔액이 이 값 미만이면 구독 플랜 CTA 노출. */
const LOW_BALANCE_THRESHOLD = 50;

export function CreditBalanceWidget({ collapsed = false }: { collapsed?: boolean }) {
  const { locale } = useT();
  const ko = locale === "ko";
  const [bal, setBal] = useState<HubCreditBalance | null>(() => (
    readViewData<HubCreditBalance>("shell.credit-balance")?.value ?? null
  ));
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const refresh = useCallback(async (force = false) => {
    const api = ipc();
    if (!api?.billing) return;
    try {
      const next = await loadViewData(
        "shell.credit-balance",
        () => api.billing.getCredits(),
        { maxAgeMs: POLL_MS, force },
      );
      // 조회 실패는 "잔액 0"이 아니라 "잔액 모름"이다. billing.ts는 5xx/타임아웃에
      // {authenticated:true, error} 만 돌려주므로(숫자 없음) 그대로 담으면 마지막 정상
      // 잔액이 지워져 5,000 크레딧 사용자가 "0 크레딧 + 구독 CTA"를 보게 된다.
      // 로그인 상태이면서 숫자가 없는 응답은 폐기하고 직전 값을 유지한다.
      // (error 유무가 아니라 "숫자가 있느냐"로 판정 — 200인데 필드가 빠진 스키마 드리프트도 같은 구멍이다.)
      setBal((prev) =>
        prev && next.authenticated && typeof next.remainingCredits !== "number" ? prev : next,
      );
    } catch {
      // 다음 폴링 재시도
    }
  }, []);

  // 초기 1회 refresh는 유지. 주기 폴링(60s)은 useVisibleInterval이 담당 —
  // 기존 visibilitychange가 interval을 멈추지 않던 버그(숨김 중에도 계속 폴링)를 훅이 해결한다.
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useVisibleInterval(() => void refresh(true), POLL_MS);

  // 로그인/로그아웃 직후(AccountChip 브로드캐스트) 즉시 동기화 — 60초 폴링을 기다리며
  // "로그아웃했는데 크레딧이 그대로" 같은 불일치가 보이지 않게 한다.
  useEffect(() => {
    const onAuthChanged = () => {
      const api = ipc();
      if (!api?.billing) return;
      // 로그아웃 직후 stale 잔액이 남지 않도록 먼저 지우고 다시 조회한다.
      setBal(null);
      void refresh(true);
    };
    window.addEventListener("agentlas:auth-changed", onAuthChanged);
    return () => window.removeEventListener("agentlas:auth-changed", onAuthChanged);
  }, [refresh]);

  // 퀘스트 보상 수령 직후(QuestBoard 브로드캐스트) 즉시 동기화 — 60초 폴링을
  // 기다리는 동안 "+50 지급 완료"라는데 잔액이 그대로인 불신을 없앤다.
  useEffect(() => {
    const onCreditsRefresh = () => void refresh(true);
    window.addEventListener("agentlas:credits-refresh", onCreditsRefresh);
    return () => window.removeEventListener("agentlas:credits-refresh", onCreditsRefresh);
  }, [refresh]);

  useDismissibleLayer({
    open,
    roots: [rootRef],
    restoreFocusRef: triggerRef,
    onDismiss: () => setOpen(false),
  });

  // 미로그인이거나 아직 로딩 전이면 숨김. 첫 조회부터 실패해 유지할 직전 값조차 없는
  // 경우(=숫자 없음)도 숨김 — 모름을 0으로 메꾸면 "0 크레딧 · 구독하세요" 오탐이 난다.
  if (!bal || !bal.authenticated || typeof bal.remainingCredits !== "number") return null;

  const remaining = bal.remainingCredits;
  // Energy = remaining over this period's allowance (plan + top-ups); a missing allowance shows a full bar, never an empty one.
  const limit = typeof bal.limitCredits === "number" && bal.limitCredits > 0 ? bal.limitCredits
    : typeof bal.planCreditLimit === "number" && bal.planCreditLimit > 0 ? bal.planCreditLimit : 0;
  const energy = limit ? Math.min(1, Math.max(0, remaining / limit)) : remaining > 0 ? 1 : 0;
  const energyColor = energy > 0.3 ? "linear-gradient(90deg, #34C77B, #1FA463)" : energy > 0.1 ? "linear-gradient(90deg, #F5B544, #E0921A)" : "linear-gradient(90deg, #F2706A, #D9443B)";
  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={ko ? "AI 사용 크레딧 잔액" : "AI usage credit balance"}
        aria-expanded={open}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          padding: collapsed ? "8px 4px" : "8px 10px",
          background: open ? "var(--fill-1)" : "transparent",
          border: "none",
          borderRadius: 10,
          cursor: "pointer",
          textAlign: "left",
          fontSize: 12,
          color: "var(--ink)",
          justifyContent: collapsed ? "center" : "flex-start",
        }}
      >
        {/* Owner 2026-09-25: the remaining balance as a small horizontal energy bar, the number smaller than the bar. */}
        <span style={{ display: "flex", flexDirection: "column", gap: 4, width: "100%", minWidth: 0 }}>
          {!collapsed && (
            <span style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 6, fontSize: 10.5, lineHeight: 1 }}>
              <span style={{ color: "var(--muted-deep)" }}>{ko ? "AI 크레딧" : "AI credits"}</span>
              <span style={{ color: "var(--muted-deep)", fontVariantNumeric: "tabular-nums" }}>{remaining.toLocaleString()}</span>
            </span>
          )}
          <span
            role="meter"
            aria-label={ko ? "AI 크레딧 잔여" : "AI credits remaining"}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(energy * 100)}
            aria-valuetext={`${remaining.toLocaleString()}${limit ? ` / ${limit.toLocaleString()}` : ""}`}
            style={{ display: "block", width: collapsed ? 24 : "100%", height: 4, margin: collapsed ? "0 auto" : 0, borderRadius: 999, background: "var(--fill-2, rgba(0,0,0,0.08))", overflow: "hidden" }}
          >
            <span style={{ display: "block", width: `${Math.max(energy > 0 ? 3 : 0, Math.round(energy * 100))}%`, height: "100%", borderRadius: 999, background: energyColor, transition: "width 400ms ease" }} />
          </span>
        </span>
      </button>

      {/* 잔액 부족 CTA — 웹 결제 페이지(agentlas.cloud/pricing)를 외부 브라우저로 연다. */}
      {!collapsed && remaining < LOW_BALANCE_THRESHOLD && (
        <button
          type="button"
          onClick={openPricing}
          title={ko ? "구독 플랜 보기" : "View subscription plans"}
          style={{
            display: "block",
            width: "100%",
            marginTop: 2,
            padding: "4px 8px",
            borderRadius: 8,
            border: "1px dashed var(--paper-edge)",
            background: "transparent",
            color: "var(--amber-deep, var(--accent))",
            fontSize: 11,
            fontWeight: 650,
            textAlign: "left",
            cursor: "pointer",
          }}
        >
          {ko ? "AI 사용 잔액이 적어요 · 구독 플랜 보기 →" : "Low AI usage balance · View plans →"}
        </button>
      )}

      {open && (
        <div
          role="dialog"
          style={{
            position: "absolute",
            bottom: "calc(100% + 8px)",
            left: 0,
            zIndex: 60,
            width: 260,
            padding: 14,
            borderRadius: 12,
            background: "var(--paper)",
            border: "1px solid var(--paper-edge)",
            boxShadow: "0 14px 36px rgba(0,0,0,0.18)",
            fontSize: 12,
            color: "var(--ink)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
            <span style={{ color: "var(--muted-deep)" }}>{ko ? "AI 사용 잔액" : "AI usage balance"}</span>
            <strong style={{ fontVariantNumeric: "tabular-nums" }}>{remaining.toLocaleString()}{limit ? <span style={{ color: "var(--muted-deep)", fontWeight: 500 }}> / {limit.toLocaleString()}</span> : null}</strong>
          </div>
          <p style={{ margin: "8px 0 0", color: "var(--muted-deep)", lineHeight: 1.45 }}>
            {ko ? "공개 Hub 에이전트는 무료로 공유·호출됩니다." : "Public Hub agents are free to share and invoke."}
          </p>
        </div>
      )}
    </div>
  );
}
