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
import { openPricing } from "./UpgradeCta";
import type { HubCreditBalance } from "@/lib/types";

const POLL_MS = 60_000;
/** 구독 잔액이 이 값 미만이면 충전/구독 CTA 노출. */
const LOW_BALANCE_THRESHOLD = 50;

export function CreditBalanceWidget({ collapsed = false }: { collapsed?: boolean }) {
  const { locale } = useT();
  const ko = locale === "ko";
  const [bal, setBal] = useState<HubCreditBalance | null>(null);
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    const api = ipc();
    if (!api?.billing) return;
    try {
      setBal(await api.billing.getCredits());
    } catch {
      // 다음 폴링 재시도
    }
  }, []);

  // 초기 1회 refresh는 유지. 주기 폴링(60s)은 useVisibleInterval이 담당 —
  // 기존 visibilitychange가 interval을 멈추지 않던 버그(숨김 중에도 계속 폴링)를 훅이 해결한다.
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useVisibleInterval(() => void refresh(), POLL_MS);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // 미로그인이거나 아직 로딩 전이면 숨김.
  if (!bal || !bal.authenticated) return null;

  const remaining = bal.remainingCredits ?? 0;
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
      await refresh();
    } catch {
      setErr(ko ? "전송에 실패했습니다." : "Transfer failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
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
                color: canTransfer ? "#fff" : "var(--muted-deep)",
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
