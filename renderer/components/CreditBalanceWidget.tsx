// 사이드바 하단 AI 사용량(사용한 %). 공개 Hub 에이전트 호출과 무관하다.
// 과거 렌트 수익 및 잔액 전송 UI는 마켓플레이스 정산 영구 폐쇄로 제거했다.
// 세션은 main이 보관하며 렌더러는 IPC로 잔액만 조회한다.
"use client";
import popupMenu from "./PanelPopover.module.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { ipc, ipcEvents } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import { useDismissibleLayer } from "@/lib/use-dismissible-layer";
import { invalidateIpcCache } from "@/lib/ipc-cache";
import { loadViewData, readViewData } from "@/lib/view-data-cache";
import { openPricing } from "./UpgradeCta";
import { UsageResetInvitePanel } from "./UsageResetInvitePanel";
import { UsageMeter } from "./usage/UsageMeter";
import { usageExhaustedLine, usageExtraLine, usageHubFootnote, usagePeriodLine, usedPercentOf } from "@/lib/usage-copy";
import type { HubCreditBalance, HubUsage } from "@/lib/types";

// A balance older than this is refreshed when the window comes back (this was the old poll interval).
const STALE_MS = 60_000;
// After a run finishes the server needs a moment to settle its charge, and runs that end together share one read.
// Runs that keep finishing (a busy team) still read at most once per STALE_MS, as the old poll did.
const RUN_SETTLE_DELAY_MS = 3_000;
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

  const readAt = useRef(0);
  const refresh = useCallback(async (force = false) => {
    const api = ipc();
    if (!api?.billing) return;
    readAt.current = Date.now();
    try {
      const next = await loadViewData(
        "shell.credit-balance",
        // A forced read reaches Main as `force` (past its 2 s shared read) and skips the IPC read cache (ipc-cache.ts `isForcedRead`).
        () => (force ? api.billing.getCredits({ force: true }) : api.billing.getCredits()),
        { maxAgeMs: STALE_MS, force },
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
      // The next signal reads again.
    } finally {
      // Age counts from when the answer arrived, so a later "older than STALE_MS" read is past the IPC cache too.
      readAt.current = Date.now();
    }
  }, []);

  // No polling: GET /api/billing/credits runs once on mount and then on a signal. Sign-in/out and a claimed reward
  // are the two events below; here, a run finishing (it may have spent credits) and the window coming back after
  // the balance is older than the old poll interval (a plan bought in the browser is seen on return).
  useEffect(() => {
    void refresh();
    let active: ReadonlySet<string> | null = null;
    let settleTimer: number | null = null;
    const offActive = ipcEvents()?.onActiveChats?.((chatIds) => {
      const next = new Set(chatIds);
      const settled = active !== null && [...active].some((chatId) => !next.has(chatId));
      active = next;
      if (!settled || settleTimer !== null) return;
      const wait = Math.max(RUN_SETTLE_DELAY_MS, readAt.current + STALE_MS - Date.now());
      settleTimer = window.setTimeout(() => { settleTimer = null; void refresh(true); }, wait);
    });
    const whenStale = () => {
      if (document.visibilityState !== "hidden" && Date.now() - readAt.current >= STALE_MS) void refresh(true);
    };
    window.addEventListener("focus", whenStale);
    document.addEventListener("visibilitychange", whenStale);
    return () => {
      offActive?.();
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      window.removeEventListener("focus", whenStale);
      document.removeEventListener("visibilitychange", whenStale);
    };
  }, [refresh]);

  // 로그인/로그아웃 직후(AccountChip 브로드캐스트) 즉시 동기화 —
  // "로그아웃했는데 크레딧이 그대로" 같은 불일치가 보이지 않게 한다.
  useEffect(() => {
    const onAuthChanged = () => {
      const api = ipc();
      if (!api?.billing) return;
      // 로그아웃 직후 stale 잔액이 남지 않도록 먼저 지우고 다시 조회한다. refresh(true) 는 화면 캐시만 건너뛰므로
      // IPC 읽기 캐시(60초)도 여기서 비운다 — 앞 계정의 값이 60초 넘게 남던 결함(#3).
      setBal(null);
      invalidateIpcCache("billing");
      void refresh(true);
    };
    window.addEventListener("agentlas:auth-changed", onAuthChanged);
    return () => window.removeEventListener("agentlas:auth-changed", onAuthChanged);
  }, [refresh]);

  // A reset answers with the new usage: draw it now, then read the balance again (the credit numbers moved too).
  const onUsage = useCallback((usage: HubUsage) => {
    setBal((prev) => (prev ? { ...prev, usage } : prev));
    invalidateIpcCache("billing");
    void refresh(true);
  }, [refresh]);

  useDismissibleLayer({
    open,
    roots: [rootRef],
    restoreFocusRef: triggerRef,
    dismissOnFocusLeave: true,
    onDismiss: () => setOpen(false),
  });

  // 미로그인이거나 아직 로딩 전이면 숨김. 첫 조회부터 실패해 유지할 직전 값조차 없는
  // 경우(=숫자 없음)도 숨김 — 모름을 0으로 메꾸면 "0 크레딧 · 구독하세요" 오탐이 난다.
  if (!bal || !bal.authenticated || typeof bal.remainingCredits !== "number") return null;

  const remaining = bal.remainingCredits;
  // AI usage is one measure, in percent USED, everywhere ("usage unified in %"). The raw credit count and the "remaining / allowance" pair are not shown:
  // beside "Usage 0%" a "33,531 / 40,743" read as "not fully reset", and the bar used to fill by what was LEFT while the percent counted what was USED.
  const limit = typeof bal.limitCredits === "number" && bal.limitCredits > 0 ? bal.limitCredits
    : typeof bal.planCreditLimit === "number" && bal.planCreditLimit > 0 ? bal.planCreditLimit : 0;
  const used = usedPercentOf(bal.usage, remaining, limit);
  const windowLine = bal.usage ? usagePeriodLine(bal.usage, ko) : "";
  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={ko ? "AI 사용량" : "AI usage"}
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
        {/* The usage as one percent and one bar that fills with what was USED; the reset time under it. No credit count. The one meter. */}
        <UsageMeter variant="sidebar" ko={ko} percent={used} detail={windowLine} collapsed={collapsed} />
      </button>

      {/* 잔액 부족 CTA — 웹 결제 페이지(agentlas.cloud/pricing)를 외부 브라우저로 연다. */}
      {!collapsed && remaining < LOW_BALANCE_THRESHOLD && (
        <button
          type="button"
          onClick={() => openPricing("ai-credits")}
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
          {ko ? "AI 사용량이 거의 찼어요 · 구독 플랜 보기 →" : "AI usage almost used up · View plans →"}
        </button>
      )}

      {open && (
        <div
          className={popupMenu.panelPopover} role="dialog" aria-label={ko ? "AI 사용량" : "AI usage"}
          style={{
            position: "absolute",
            bottom: "calc(100% + 8px)",
            left: 0,
            zIndex: 60,
            width: 300,
            padding: 14,
            borderRadius: "var(--popup-radius)",
            background: "var(--popup-card-bg)",
            border: "1px solid var(--paper-edge)",
            boxShadow: "var(--popup-shadow)",
            fontSize: 12,
            color: "var(--ink)",
          }}
        >
          <UsageMeter variant="popup" ko={ko} percent={used}>
            {bal.usage && (
              <div style={{ margin: "8px 0 0", lineHeight: 1.45 }}>
                {windowLine && <div>{windowLine}</div>}
                {usageExhaustedLine(bal.usage, ko) && <div style={{ color: "var(--amber-deep, var(--accent))" }}>{usageExhaustedLine(bal.usage, ko)}</div>}
                {usageExtraLine(bal.usage, ko) && <div style={{ color: "var(--muted-deep)" }}>{usageExtraLine(bal.usage, ko)}</div>}
              </div>
            )}
          </UsageMeter>
          <p data-testid="usage-hub-note" style={{ margin: "8px 0 0", color: "var(--muted-deep)", lineHeight: 1.45, fontSize: 11.5 }}>{usageHubFootnote(ko)}</p>
          {bal.usage?.resetTickets && <UsageResetInvitePanel usage={bal.usage} ko={ko} onUsage={onUsage} />}
        </div>
      )}
    </div>
  );
}
