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

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
import { ipc } from "@/lib/ipc";
import { readViewData } from "@/lib/view-data-cache";
import { openPricing } from "@/components/UpgradeCta";
import type { AgentLeaseQuote, AuthSession } from "@shared/types";
import { LoadingEstimate } from "@/components/LoadingEstimate";

const DAY_PRESETS = [1, 3, 7, 14, 30] as const;

type PendingLeaseRequest = {
  slug: string;
  accountScope: string;
  days: number;
  idempotencyKey: string;
  perDayCredits: number | null;
};

const PENDING_LEASE_PREFIX = "agentlas.agent-lease-purchase.v1:";

function leaseAccountScope(): string | null {
  const session = readViewData<AuthSession>("shell.auth-session")?.value;
  if (!session?.signedIn) return null;
  const fingerprint = session.accountFingerprint?.trim();
  if (fingerprint) return `account:${fingerprint}`;
  const workspaceId = session.workspaceId?.trim();
  return workspaceId ? `workspace:${workspaceId}` : null;
}

function pendingLeaseStorageKey(slug: string, accountScope = leaseAccountScope()): string | null {
  return accountScope
    ? `${PENDING_LEASE_PREFIX}${encodeURIComponent(accountScope)}:${encodeURIComponent(slug.trim())}`
    : null;
}

function isValidLeaseDays(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 30;
}

function isValidIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(value);
}

function parsePendingLease(raw: string | null, slug: string, accountScope: string): PendingLeaseRequest | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PendingLeaseRequest>;
    if (parsed.slug !== slug || parsed.accountScope !== accountScope || !isValidLeaseDays(parsed.days) || !isValidIdempotencyKey(parsed.idempotencyKey)) return null;
    return {
      slug,
      accountScope,
      days: parsed.days,
      idempotencyKey: parsed.idempotencyKey,
      perDayCredits: typeof parsed.perDayCredits === "number" && Number.isFinite(parsed.perDayCredits)
        ? parsed.perDayCredits
        : null,
    };
  } catch {
    return null;
  }
}

function readPendingLease(slug: string, accountScope = leaseAccountScope()): PendingLeaseRequest | null {
  if (typeof window === "undefined") return null;
  try {
    const storageKey = pendingLeaseStorageKey(slug, accountScope);
    if (!accountScope || !storageKey) return null;
    const raw = window.localStorage.getItem(storageKey);
    const parsed = parsePendingLease(raw, slug, accountScope);
    if (!parsed && raw) {
      window.localStorage.removeItem(storageKey);
    }
    return parsed;
  } catch {
    return null;
  }
}

type PendingLeaseWrite = { ok: true } | { ok: false; reason: "account_changed" | "storage_unavailable" };

function writePendingLease(request: PendingLeaseRequest): PendingLeaseWrite {
  if (typeof window === "undefined") return { ok: false, reason: "storage_unavailable" };
  const storageKey = pendingLeaseStorageKey(request.slug, request.accountScope);
  if (!storageKey || request.accountScope !== leaseAccountScope()) return { ok: false, reason: "account_changed" };
  try {
    const serialized = JSON.stringify(request);
    window.localStorage.setItem(storageKey, serialized);
    // A successful setItem call is not enough: private browsing, quota errors,
    // and hostile storage shims may acknowledge the write without persisting it.
    // Never send a billable POST until the exact, account-bound key reads back.
    const readBack = window.localStorage.getItem(storageKey);
    if (readBack !== serialized || !parsePendingLease(readBack, request.slug, request.accountScope)) {
      return { ok: false, reason: "storage_unavailable" };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "storage_unavailable" };
  }
}

function removePendingLease(slug: string, accountScope = leaseAccountScope()): void {
  if (typeof window === "undefined") return;
  const storageKey = pendingLeaseStorageKey(slug, accountScope);
  if (!storageKey) return;
  try { window.localStorage.removeItem(storageKey); } catch { /* noop */ }
}

function newLeaseIdempotencyKey(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid || `lease_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function normalizedInitialDays(value: number | undefined): number {
  return isValidLeaseDays(value) ? value : 7;
}

function quoteUnavailableMessage(quote: AgentLeaseQuote | null, ko: boolean): string {
  if (quote?.code === "signed_out") return ko ? "Agentlas 로그인이 필요합니다. 로그인 후 대여 조건을 다시 확인하세요." : "Sign in to Agentlas, then check the lease terms again.";
  if (quote?.code === "account_changed") return ko ? "계정이 바뀌어 이전 대여 조건을 적용하지 않았습니다. 현재 계정에서 다시 확인하세요." : "The account changed, so the previous lease terms were discarded. Check the current account again.";
  if (quote?.code === "lease_not_offered") return ko ? "이 에이전트는 장기대여를 제공하지 않습니다." : "This agent does not offer long-term leases.";
  return ko ? "대여 조건을 확인하지 못했습니다. 네트워크를 확인한 뒤 다시 시도하세요." : "The lease terms could not be checked. Check the network and try again.";
}

function pendingRetryMessage(ko: boolean, days: number): string {
  return ko
    ? `이전 ${days}일 대여 요청의 결과를 확인하지 못했습니다. 같은 요청으로 다시 확인하며 중복 청구하지 않습니다.`
    : `The previous ${days}-day lease request has an unknown result. Retry the same request so it cannot be charged twice.`;
}

function pendingStorageMessage(ko: boolean): string {
  return ko
    ? "대여 요청을 안전하게 저장하지 못했습니다. 저장소를 사용할 수 있을 때 다시 시도하세요. 청구는 진행되지 않았습니다."
    : "The lease request could not be saved securely. Enable persistent storage and try again. No charge was sent.";
}

export function AgentLeaseDialog({
  slug,
  agentName,
  locale,
  initialDays,
  skipPurchaseIfActive = false,
  onClose,
  onLeased,
}: {
  slug: string;
  agentName: string;
  locale: string;
  initialDays?: number;
  /** One's seat flow must reuse an active server lease instead of extending it. */
  skipPurchaseIfActive?: boolean;
  onClose: () => void;
  /** 구매 성공 — 부모가 대여 상태를 새로고침하고 닫는다. */
  onLeased: (leasedUntil: string) => void;
}) {
  const ko = locale === "ko";
  const [quote, setQuote] = useState<AgentLeaseQuote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(true);
  const [days, setDays] = useState(() => normalizedInitialDays(initialDays));
  const [daysText, setDaysText] = useState(() => String(normalizedInitialDays(initialDays)));
  const [pendingRequest, setPendingRequest] = useState<PendingLeaseRequest | null>(() => readPendingLease(slug));
  const [authVersion, setAuthVersion] = useState(0);
  const [purchasing, setPurchasing] = useState(false);
  const [portalReady, setPortalReady] = useState(false);
  const [failure, setFailure] = useState<{ kind: "insufficient"; needed: number | null; have: number | null } | { kind: "other"; message: string } | null>(null);
  const authEpochRef = useRef(0);
  const purchaseSequenceRef = useRef(0);
  const activePurchaseRef = useRef<number | null>(null);

  useEffect(() => {
    // This dialog is opened from inside OneOrgChart's picker. Portaling after
    // hydration keeps the first client render SSR-safe while making the fixed
    // scrim a true top-level hit target above the picker.
    setPortalReady(true);
  }, []);

  useEffect(() => {
    const restored = readPendingLease(slug);
    setPendingRequest(restored);
    const nextDays = restored?.days ?? normalizedInitialDays(initialDays);
    setDays(nextDays);
    setDaysText(String(nextDays));
    setFailure(null);
  }, [slug, initialDays]);

  useEffect(() => {
    const onAuthChanged = () => {
      authEpochRef.current += 1;
      // An in-flight request belongs to the previous account. It may finish on
      // the wire, but it must not clear the new account's state or call the old
      // account's onLeased handler.
      activePurchaseRef.current = null;
      setPurchasing(false);
      const restored = readPendingLease(slug);
      setPendingRequest(restored);
      const nextDays = restored?.days ?? normalizedInitialDays(initialDays);
      setDays(nextDays);
      setDaysText(String(nextDays));
      setFailure(null);
      setQuote(null);
      setQuoteLoading(true);
      setAuthVersion((version) => version + 1);
    };
    window.addEventListener("agentlas:auth-changed", onAuthChanged);
    return () => window.removeEventListener("agentlas:auth-changed", onAuthChanged);
  }, [slug, initialDays]);

  useEffect(() => {
    let cancelled = false;
    const requestAuthEpoch = authEpochRef.current;
    const requestAccountScope = leaseAccountScope();
    const currentRequest = () => (
      !cancelled
      && authEpochRef.current === requestAuthEpoch
      && leaseAccountScope() === requestAccountScope
    );
    setQuoteLoading(true);
    setQuote(null);
    const bridge = ipc();
    if (!bridge) {
      if (currentRequest()) {
        setQuote({ ok: false, active: false, leasedUntil: null, perDayCredits: null, leaseOffered: false, code: "network" });
        setQuoteLoading(false);
      }
      return () => { cancelled = true; };
    }
    void bridge.agentLeases.quote(slug)
      .then((result) => {
        if (!currentRequest()) return;
        setQuote(result);
        const pending = readPendingLease(slug, requestAccountScope);
        const expiresAt = result?.active && typeof result.leasedUntil === "string" ? Date.parse(result.leasedUntil) : NaN;
        if (skipPurchaseIfActive && pending && result?.ok && Number.isFinite(expiresAt) && expiresAt > Date.now()) {
          // A lost POST response may have committed successfully. The active server lease
          // is enough to continue; replaying the same key is unnecessary.
          removePendingLease(slug, requestAccountScope);
          setPendingRequest(null);
          onLeased(result.leasedUntil!);
        }
      })
      .catch(() => {
        if (currentRequest()) setQuote({ ok: false, active: false, leasedUntil: null, perDayCredits: null, leaseOffered: false, code: "network" });
      })
      .finally(() => { if (currentRequest()) setQuoteLoading(false); });
    return () => { cancelled = true; };
  }, [slug, skipPurchaseIfActive, authVersion]); // onLeased is a parent event sink; auth changes also refresh the quote.

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !purchasing) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, purchasing]);

  const currentAccountScope = leaseAccountScope();
  const visiblePendingRequest = currentAccountScope && pendingRequest?.accountScope === currentAccountScope
    ? pendingRequest
    : null;
  const validDays = Number.isInteger(days) && days >= 1 && days <= 30;
  const perDay = quote?.perDayCredits ?? visiblePendingRequest?.perDayCredits ?? null;
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
    if (visiblePendingRequest) return;
    setDays(next);
    setDaysText(String(next));
  }

  async function purchase() {
    if (!validDays || purchasing) return;
    const accountScope = leaseAccountScope();
    if (!accountScope) {
      setFailure({ kind: "other", message: ko ? "계정 식별자를 확인하지 못했습니다. 로그인 상태를 새로고침한 뒤 다시 시도하세요." : "The signed-in account could not be identified. Refresh the signed-in state and try again." });
      return;
    }
    const statePendingRequest = pendingRequest?.accountScope === accountScope ? pendingRequest : null;
    // A retry is only safe when the exact request is still durable. If state says
    // there is a pending charge but storage no longer contains it, do not mint a
    // replacement key that could double-charge the account.
    const persistedPendingRequest = readPendingLease(slug, accountScope);
    if (statePendingRequest && !persistedPendingRequest) {
      setFailure({ kind: "other", message: pendingStorageMessage(ko) });
      return;
    }
    const scopedPendingRequest = persistedPendingRequest;
    const request = scopedPendingRequest ?? {
      slug,
      accountScope,
      days,
      idempotencyKey: newLeaseIdempotencyKey(),
      perDayCredits: perDay,
    };
    if (request.slug !== slug || request.days !== days) return;

    const requestAuthEpoch = authEpochRef.current;
    const runId = ++purchaseSequenceRef.current;
    activePurchaseRef.current = runId;
    const isCurrentRequest = () => (
      activePurchaseRef.current === runId
      && authEpochRef.current === requestAuthEpoch
      && leaseAccountScope() === accountScope
    );
    setPurchasing(true);
    setFailure(null);
    let requestSent = false;
    try {
      const bridge = ipc();
      if (!bridge) throw new Error("network");
      if (skipPurchaseIfActive) {
        const latestQuote = await bridge.agentLeases.quote(slug);
        if (!isCurrentRequest()) return;
        const latestExpiry = latestQuote?.active && typeof latestQuote.leasedUntil === "string" ? Date.parse(latestQuote.leasedUntil) : NaN;
        if (latestQuote?.ok && Number.isFinite(latestExpiry) && latestExpiry > Date.now()) {
          removePendingLease(slug, accountScope);
          setPendingRequest(null);
          onLeased(latestQuote.leasedUntil!);
          return;
        }
        if (!latestQuote?.ok) {
          // A standing-seat add must never bill while the active-lease check is
          // unavailable. Keep an existing key for a later retry; a new confirmation
          // has not been sent when this branch is reached.
          setFailure({ kind: "other", message: quoteUnavailableMessage(latestQuote ?? null, ko) });
          return;
        }
        if (!latestQuote.leaseOffered) {
          removePendingLease(slug, accountScope);
          setPendingRequest(null);
          setQuote((current) => current ? { ...current, leaseOffered: false, code: "lease_not_offered" } : current);
          return;
        }
      }
      if (!scopedPendingRequest) {
        const persisted = writePendingLease(request);
        if (!persisted.ok) {
          if (isCurrentRequest()) {
            setFailure({
              kind: "other",
              message: persisted.reason === "account_changed"
                ? (ko ? "계정이 바뀌어 대여 요청을 중단했습니다. 현재 계정에서 다시 확인하세요." : "The account changed, so this lease request was stopped. Check the current account and try again.")
                : pendingStorageMessage(ko),
            });
          }
          return;
        }
        if (!isCurrentRequest()) return;
        setPendingRequest(request);
      } else if (!isCurrentRequest()) {
        return;
      }
      requestSent = true;
      const result = await bridge.agentLeases.purchase({ slug, days: request.days, idempotencyKey: request.idempotencyKey });
      if (!isCurrentRequest()) return;
      if (result?.ok) {
        removePendingLease(slug, accountScope);
        setPendingRequest(null);
        onLeased(result.leasedUntil);
        return;
      }
      if (result?.code === "insufficient_credits") {
        removePendingLease(slug, accountScope);
        setPendingRequest(null);
        setFailure({ kind: "insufficient", needed: result.needed ?? total, have: result.have ?? null });
      } else if (result?.code === "lease_not_offered") {
        removePendingLease(slug, accountScope);
        setPendingRequest(null);
        setQuote((current) => current ? { ...current, leaseOffered: false, code: "lease_not_offered" } : current);
      } else if (result?.code === "network" || result?.code === "http" || String(result?.code || "").startsWith("http_")) {
        setFailure({ kind: "other", message: pendingRetryMessage(ko, request.days) });
      } else {
        removePendingLease(slug, accountScope);
        setPendingRequest(null);
        setFailure({ kind: "other", message: result?.message || (ko ? "대여를 완료하지 못했습니다." : "The lease could not be completed.") });
      }
    } catch {
      // A thrown request has an unknown outcome. Keep the exact confirmation key so
      // reopening this dialog retries the same server idempotency record.
      if (isCurrentRequest()) {
        setFailure({ kind: "other", message: requestSent ? pendingRetryMessage(ko, request.days) : quoteUnavailableMessage(null, ko) });
      }
    } finally {
      if (activePurchaseRef.current === runId) {
        activePurchaseRef.current = null;
        setPurchasing(false);
      }
    }
  }

  const quoteUnavailable = !quoteLoading && (!quote?.ok || quote?.code === "signed_out" || quote?.code === "network" || quote?.code === "http" || quote?.code === "invalid_slug");
  const notOffered = !quoteLoading && Boolean(quote && (
    quote.code === "lease_not_offered"
    || (quote.ok && !quote.leaseOffered && !quote.code)
  ));
  const canRetryPending = visiblePendingRequest !== null;
  const canSubmitPurchase = validDays && (total !== null || canRetryPending) && !purchasing;

  const dialog = (
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
        ) : quoteUnavailable && !canRetryPending ? (
          <>
            <div role="alert" style={{ padding: "14px 12px", borderRadius: 10, border: "1px solid var(--paper-edge)", background: "var(--paper-2)", color: "var(--ink-soft)", fontSize: 13, lineHeight: 1.55 }}>
              {quoteUnavailableMessage(quote, ko)}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button type="button" onClick={onClose} style={secondaryButton}>
                {ko ? "닫기" : "Close"}
              </button>
            </div>
          </>
        ) : notOffered && !canRetryPending ? (
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
            {visiblePendingRequest && (
              <div role="status" style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid var(--paper-edge)", background: "var(--paper-2)", color: "var(--ink-soft)", fontSize: 12.5, lineHeight: 1.5 }}>
                {pendingRetryMessage(ko, visiblePendingRequest.days)}
              </div>
            )}
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
                  disabled={Boolean(visiblePendingRequest) || purchasing}
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
                    cursor: visiblePendingRequest || purchasing ? "default" : "pointer",
                    opacity: visiblePendingRequest || purchasing ? 0.55 : 1,
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
                    if (visiblePendingRequest) return;
                    setDaysText(event.target.value);
                    setDays(Number(event.target.value));
                  }}
                  disabled={Boolean(visiblePendingRequest) || purchasing}
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
                disabled={!canSubmitPurchase}
                onClick={() => void purchase()}
                data-testid="agent-lease-purchase"
                style={{
                  minHeight: 36,
                  padding: "0 18px",
                  borderRadius: 9,
                  border: 0,
                  background: "var(--accent)",
                  color: "var(--white)",
                  fontSize: 13,
                  fontWeight: 750,
                  cursor: !canSubmitPurchase ? "default" : "pointer",
                  opacity: !canSubmitPurchase ? 0.55 : 1,
                }}
              >
                {purchasing
                  ? (extending ? (ko ? "연장 중…" : "Extending…") : (ko ? "대여 중…" : "Leasing…"))
                  : (visiblePendingRequest
                    ? (ko ? "같은 요청 재시도" : "Retry same request")
                    : (extending ? (ko ? "연장" : "Extend") : (ko ? "대여" : "Lease")))}
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );

  return portalReady && typeof document !== "undefined"
    ? createPortal(dialog, document.body)
    : dialog;
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
