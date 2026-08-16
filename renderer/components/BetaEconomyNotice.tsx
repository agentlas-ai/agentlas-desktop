"use client";

// The Real Economy beta notice — Desktop.
//
// SAME FACTS AS THE WEB DIALOG, ON PURPOSE
//   Earnings are not paid out yet, calls may be unstable, and a contest closes
//   on a date. Someone who reads it in the browser and then opens Desktop must
//   not get a different deadline or a different promise. The constant and the
//   dismissal rule below are deliberately identical to
//   AgentsAtlas/app/src/components/views/BetaEconomyNotice.tsx.
//
// WHY IT IS NOT SHARED CODE
//   The two products do not share a bundle. Copying twenty lines is the honest
//   cost; a package would be a bigger commitment than the notice is worth, and
//   both sides carry a gate asserting the same facts so they cannot drift
//   silently.
//
// WHY A WEEK AND NOT FOREVER
//   The prize is decided by a deadline. A permanent dismissal hides that
//   deadline from the person it is for.

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useT } from "@/lib/i18n";

/** When the beta closes. Must equal the web constant. */
export const BETA_ENDS_AT = "2026-09-30T23:59:59+09:00";

const STORAGE_KEY = "agentlas.beta-economy-notice.snoozed-until";
const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Whether to show it. Every failure mode resolves toward SHOWING — a
 * disclosure suppressed by a corrupt value is a disclosure nobody made.
 */
export function shouldShowNotice(storedValue: string | null, now: number, endsAt: number): boolean {
  if (now > endsAt) return false;
  if (!storedValue) return true;
  const until = Number(storedValue);
  if (!Number.isFinite(until)) return true;
  if (until - now > SNOOZE_MS) return true;
  return now >= until;
}

export function BetaEconomyNotice() {
  const { locale } = useT();
  const ko = locale === "ko";
  const [open, setOpen] = useState(false);
  const primaryRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const endsAt = new Date(BETA_ENDS_AT).getTime();
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(STORAGE_KEY);
    } catch {
      stored = null;
    }
    if (shouldShowNotice(stored, Date.now(), endsAt)) setOpen(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    primaryRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;

  const snooze = () => {
    try {
      window.localStorage.setItem(STORAGE_KEY, String(Date.now() + SNOOZE_MS));
    } catch {
      // Closing still works; it simply returns next launch.
    }
    setOpen(false);
  };

  const deadline = new Date(BETA_ENDS_AT);
  const deadlineLabel = ko
    ? `${deadline.getMonth() + 1}월 ${deadline.getDate()}일`
    : deadline.toLocaleDateString("en-US", { month: "long", day: "numeric" });

  return (
    <div
      className="titlebar-nodrag"
      role="presentation"
      onClick={() => setOpen(false)}
      style={backdrop}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={ko ? "허브 네트워크 베타 안내" : "Hub Network beta notice"}
        onClick={(event) => event.stopPropagation()}
        style={card}
      >
        <span style={kicker}>{ko ? "허브 네트워크" : "HUB NETWORK"}</span>
        <h2 style={title}>{ko ? "Real Economy를 시작합니다" : "Real Economy starts now"}</h2>

        <p style={body}>
          {ko
            ? "베타 테스트입니다. 정식 오픈 전까지 수익 정산은 지급되지 않으며, 서버와 네트워크 호출이 불안정할 수 있습니다."
            : "This is a beta. Earnings will not be paid out until the full launch, and servers and network calls may be unstable."}
        </p>

        <div style={prize}>
          <strong style={{ fontSize: 13.5 }}>
            {ko ? `베타 기간: ${deadlineLabel}까지` : `Beta runs through ${deadlineLabel}`}
          </strong>
          <p style={{ ...body, margin: "6px 0 0", fontSize: 12.5 }}>
            {ko
              ? "기간 동안 에이전트 호출 수가 가장 많은 제작자 세 분께 USDC를 드립니다."
              : "The three creators whose agents are called the most in that time receive USDC."}
          </p>
          <div style={ranks}>
            {([["1st", "$100"], ["2nd", "$50"], ["3rd", "$10"]] as const).map(([rank, amount]) => (
              <div key={rank} style={rankBox}>
                <span style={{ fontSize: 10.5, color: "var(--muted-deep)" }}>{rank}</span>
                <strong style={{ fontSize: 18 }}>{amount}</strong>
              </div>
            ))}
          </div>
        </div>

        <p style={{ ...body, fontSize: 13 }}>
          {ko ? "많은 참여 부탁드립니다." : "We would love to have you take part."}
        </p>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 18 }}>
          <button type="button" ref={primaryRef} onClick={() => setOpen(false)} style={primary}>
            {ko ? "확인" : "Got it"}
          </button>
          <button type="button" onClick={snooze} style={secondary}>
            {ko ? "1주일간 보지 않기" : "Don't show for a week"}
          </button>
        </div>
      </div>
    </div>
  );
}

const backdrop: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 400,
  display: "grid",
  placeItems: "center",
  padding: 20,
  background: "rgba(11, 11, 15, 0.5)",
};

const card: CSSProperties = {
  width: "min(440px, calc(100vw - 40px))",
  maxHeight: "calc(100vh - 40px)",
  overflowY: "auto",
  padding: "22px 22px 18px",
  border: "1px solid var(--paper-edge)",
  borderRadius: 12,
  background: "var(--paper)",
  boxShadow: "0 24px 60px rgba(11, 11, 15, 0.24)",
};

const kicker: CSSProperties = {
  display: "block",
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  color: "var(--muted-deep)",
};

const title: CSSProperties = {
  margin: "7px 0 0",
  fontFamily: "var(--font-head)",
  fontSize: 21,
  fontWeight: 800,
  lineHeight: 1.18,
};

const body: CSSProperties = {
  margin: "11px 0 0",
  color: "var(--muted-deep)",
  fontSize: 13.5,
  lineHeight: 1.6,
  wordBreak: "keep-all",
};

const prize: CSSProperties = {
  marginTop: 14,
  padding: "12px 14px 14px",
  border: "1px solid var(--paper-edge)",
  borderRadius: 10,
  background: "var(--surface-2, rgba(0,0,0,.02))",
};

const ranks: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
  gap: 8,
  marginTop: 11,
};

const rankBox: CSSProperties = {
  display: "grid",
  gap: 2,
  justifyItems: "center",
  padding: "8px 4px",
  border: "1px solid var(--paper-edge)",
  borderRadius: 8,
  background: "var(--paper)",
};

const primary: CSSProperties = {
  height: 32,
  padding: "0 16px",
  borderRadius: 9,
  border: "1px solid transparent",
  background: "var(--accent, #111)",
  color: "#fff",
  font: "inherit",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};

const secondary: CSSProperties = {
  height: 32,
  padding: "0 13px",
  borderRadius: 9,
  border: "1px solid var(--paper-edge)",
  background: "transparent",
  color: "var(--muted-deep)",
  font: "inherit",
  fontSize: 12.5,
  cursor: "pointer",
};
