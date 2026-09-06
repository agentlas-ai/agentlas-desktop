// 사이드바 하단 크레딧 칩 — Agentlas Hub 2계좌(구독/렌트수익).
//   · 구독 계좌(A): 사용 가능 잔액(월 초기화 + 톱업 + 전송분).
//   · 렌트수익 계좌(B): 내 업로드를 남이 빌려 쓸 때 쌓이는 적립금. 이동 가능.
//   · 클릭 → 팝오버에서 두 잔액 표시 + 렌트수익 → 구독 일방 전송.
// 세션은 main이 보관; 본 위젯은 ipc().billing 으로 Hub API를 호출한다(렌더러 직접 fetch 아님).
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
/** 구독 잔액이 이 값 미만이면 충전/구독 CTA 노출. */
const LOW_BALANCE_THRESHOLD = 50;

export function CreditBalanceWidget({ collapsed = false }: { collapsed?: boolean }) {
  const { locale } = useT();
  const ko = locale === "ko";
  const [bal, setBal] = useState<HubCreditBalance | null>(() => (
    readViewData<HubCreditBalance>("shell.credit-balance")?.value ?? null
  ));
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
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
      // 잔액이 지워져 5,000 크레딧 사용자가 "0 크레딧 + 충전 CTA"를 보게 된다.
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
  // 경우(=숫자 없음)도 숨김 — 모름을 0으로 메꾸면 "0 크레딧 · 충전하세요" 오탐이 난다.
  if (!bal || !bal.authenticated || typeof bal.remainingCredits !== "number") return null;

  const remaining = bal.remainingCredits;
  const earnings = bal.earningsCredits ?? 0;

  const requested = Math.floor(Number(amount));
  const canTransfer = Number.isFinite(requested) && requested > 0 && requested <= earnings && !busy;

  const onTransfer = async () => {
    const api = ipc();
    if (!api?.billing || !canTransfer) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await api.billing.transferEarnings(requested);
      if (!res.ok) {
        setErr(
          res.error === "insufficient_earnings"
            ? ko ? "수익 잔액이 부족합니다." : "Not enough rent-revenue credits."
            : ko ? "전송에 실패했습니다." : "Transfer failed.",
        );
        return;
      }
      setAmount("");
      await refresh(true);
    } catch {
      setErr(ko ? "전송에 실패했습니다." : "Transfer failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={ko ? "크레딧 잔액" : "Credit balance"}
        aria-expanded={open}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          padding: collapsed ? "6px 4px" : "6px 8px",
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
        <span
          aria-hidden="true"
          style={{ width: 7, height: 7, borderRadius: 999, background: "var(--green-deep)", flexShrink: 0 }}
        />
        {!collapsed && (
          <>
            <span style={{ fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
              {remaining.toLocaleString()}
            </span>
            <span style={{ color: "var(--muted-deep)", flex: 1, minWidth: 0 }}>
              {ko ? "크레딧" : "credits"}
            </span>
            {earnings > 0 && (
              <span style={{ color: "var(--green-deep)", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                {ko ? `+${earnings.toLocaleString()}` : `+${earnings.toLocaleString()}`}
              </span>
            )}
          </>
        )}
      </button>

      {/* 잔액 부족 CTA — 웹 결제 페이지(agentlas.cloud/pricing)를 외부 브라우저로 연다. */}
      {!collapsed && remaining < LOW_BALANCE_THRESHOLD && (
        <button
          type="button"
          onClick={openPricing}
          title={ko ? "충전/구독 페이지 열기" : "Open top-up / subscription page"}
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
          {ko ? "크레딧이 얼마 없어요 · 충전/구독 →" : "Low credits · Top up / Subscribe →"}
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
            <span style={{ color: "var(--muted-deep)" }}>{ko ? "구독 잔액 (사용 가능)" : "Subscription (spendable)"}</span>
            <strong style={{ fontVariantNumeric: "tabular-nums" }}>{remaining.toLocaleString()}</strong>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
            <span style={{ color: "var(--muted-deep)" }}>{ko ? "렌트 수익 (이동 가능)" : "Rent revenue (movable)"}</span>
            <strong style={{ color: "var(--green-deep)", fontVariantNumeric: "tabular-nums" }}>{earnings.toLocaleString()}</strong>
          </div>

          <div style={{ height: 1, background: "var(--paper-edge)", margin: "0 -14px 10px" }} />

          <p style={{ margin: "0 0 8px", color: "var(--muted-deep)", lineHeight: 1.45 }}>
            {ko
              ? "렌트 수익은 구독 잔액으로 옮긴 뒤에만 사용할 수 있습니다. (역방향 이동 불가)"
              : "Rent revenue is spendable only after you move it to your subscription balance. (One-way.)"}
          </p>

          <div style={{ display: "flex", gap: 6 }}>
            <input
              type="number"
              min={1}
              max={earnings}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder={ko ? "이동할 크레딧" : "Credits to move"}
              disabled={earnings <= 0}
              style={{
                flex: 1,
                minWidth: 0,
                padding: "6px 8px",
                borderRadius: 8,
                border: "1px solid var(--paper-edge)",
                background: "var(--fill-1)",
                color: "var(--ink)",
                fontSize: 12,
              }}
            />
            <button
              type="button"
              onClick={() => void onTransfer()}
              disabled={!canTransfer}
              style={{
                padding: "6px 12px",
                borderRadius: 8,
                border: "none",
                background: canTransfer ? "var(--green-deep)" : "var(--paper-edge)",
                color: canTransfer ? "var(--white)" : "var(--muted-deep)",
                fontSize: 12,
                fontWeight: 700,
                cursor: canTransfer ? "pointer" : "not-allowed",
                whiteSpace: "nowrap",
              }}
            >
              {busy ? (ko ? "이동 중…" : "Moving…") : ko ? "전송" : "Move"}
            </button>
          </div>

          {err && <div style={{ color: "var(--red-deep)", marginTop: 8 }}>{err}</div>}
        </div>
      )}
    </div>
  );
}
