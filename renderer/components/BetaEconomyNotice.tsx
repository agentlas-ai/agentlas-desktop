"use client";

// The Agentlas Build Competition notice — Desktop.
//
// SAME FACTS AS THE WEB DIALOG, ON PURPOSE
//   Earnings are not paid out yet, calls may be unstable, and a contest closes
//   on a date. Someone who reads it in the browser and then opens Desktop must
//   not get a different deadline, a different prize, or different rules. The
//   constant and the dismissal rule below are deliberately identical to
//   AgentsAtlas/app/src/components/views/BetaEconomyNotice.tsx.
//
// WHY IT IS NOT SHARED CODE
//   The two products do not share a bundle. Copying the content is the honest
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

/** Dispatch this to open the dialog on demand, bypassing the snooze. */
export const OPEN_BUILD_NOTICE_EVENT = "agentlas:open-build-notice";

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

/**
 * @param suspended 처음 실행 세팅이 화면을 갖고 있는 동안 true. **감추는 게 아니라 미룬다** —
 *   열림 상태와 스누즈 계산은 그대로 돌고, 세팅이 끝나면 그때 뜬다. 실측(2026-08-20 dev QA)
 *   에서 첫 실행 대시보드에 온보딩과 이 안내가 겹쳐 떴다. 안내가 스누즈되지 않고 미뤄지는
 *   것이 중요하다 — 여기 적힌 마감일은 안 본 사람에게는 없는 것과 같기 때문이다.
 */
export function BetaEconomyNotice({
  suspended = false,
  onVisibilityChange,
}: {
  suspended?: boolean;
  /** 이 안내가 화면을 갖고 있는 동안 뒤에 있는 소개가 함께 뜨지 않도록 셸에 알린다. */
  onVisibilityChange?: (visible: boolean) => void;
} = {}) {
  const { locale } = useT();
  const ko = locale === "ko";
  const [open, setOpen] = useState(false);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const visible = open && !suspended;

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
    const onExternalOpen = () => setOpen(true);
    window.addEventListener(OPEN_BUILD_NOTICE_EVENT, onExternalOpen);
    return () => window.removeEventListener(OPEN_BUILD_NOTICE_EVENT, onExternalOpen);
  }, []);

  useEffect(() => {
    onVisibilityChange?.(visible);
  }, [visible, onVisibilityChange]);

  useEffect(() => {
    if (!visible) return;
    primaryRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible]);

  if (!visible) return null;

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
        <h2 style={title}>Agentlas Build Competition</h2>
        <p style={subtitle}>{ko ? "총 상금 260 USDC" : "Total 260 USDC Prize"}</p>

        <p style={body}>
          {ko
            ? "베타 테스트입니다. 정식 오픈 전까지 수익 정산은 지급되지 않으며, 서버와 네트워크 호출이 불안정할 수 있습니다."
            : "This is a beta. Earnings will not be paid out until the full launch, and servers and network calls may be unstable."}
        </p>

        <div style={flowRulesGrid}>
          <ol style={flow} aria-label={ko ? "참여 순서" : "How it works"}>
            {[
              ko ? "에이전트 만들기" : "Agent Build",
              ko ? "Agent Hub 업로드 (마켓플레이스)" : "Agent Hub Upload (Marketplace)",
              ko ? "누군가 에이전트를 호출" : "Someone calls your Agent",
              ko ? `${deadlineLabel} 이후 USDC 지급` : `You get USDC after ${deadlineLabel}`,
            ].map((step, index, steps) => (
              <li key={step} style={flowStep}>
                <span style={flowStepBox}>{step}</span>
                {index < steps.length - 1 && (
                  <span style={flowArrow} aria-hidden="true">
                    ↓
                  </span>
                )}
              </li>
            ))}
          </ol>

          <div style={rules}>
            <strong style={rulesTitle}>{ko ? "참가 규정" : "Rules"}</strong>
            <ol style={rulesList}>
              {(ko
                ? [
                    "기존 마켓플레이스에서 포크한 에이전트는 참여할 수 없습니다.",
                    "배포한 에이전트 개수가 여러 개일 경우, 가장 호출 수가 많은 에이전트 하나로 평가합니다.",
                    "보편적 통념상 반사회적, 마약, 총기 및 각국 법률에 저촉되는 내용의 에이전트는 수상에서 제외됩니다.",
                    "본인이 만든 에이전트를 본인이 부를 경우 이벤트 호출에 포함되지 않습니다.",
                    "이벤트 내용과 일정은 주최측 사정에 따라 변경될 수 있습니다.",
                  ]
                : [
                    "Agents forked from the existing marketplace cannot take part.",
                    "If a creator has deployed more than one agent, only the one with the most calls is scored.",
                    "Agents whose content is widely considered antisocial, involves drugs or firearms, or violates any country's laws are excluded from winning.",
                    "Calling an agent you made yourself does not count toward the event's call total.",
                    "Event details and schedule may change at the organizer's discretion.",
                  ]
              ).map((rule, index) => (
                <li key={index} style={rulesItem}>
                  {rule}
                </li>
              ))}
            </ol>
          </div>
        </div>

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
  width: "var(--popup-3-width)",
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

const subtitle: CSSProperties = {
  margin: "4px 0 0",
  fontSize: 13,
  fontWeight: 700,
  color: "var(--accent, var(--black))",
};

const flowRulesGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 0.9fr) minmax(0, 1.1fr)",
  gap: 14,
  marginTop: 14,
  padding: "12px 14px 14px",
  border: "1px solid var(--paper-edge)",
  borderRadius: 10,
  background: "var(--surface-2, rgba(0,0,0,.02))",
};

const flow: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "stretch",
  // The rules column is almost always the taller one — this spreads the four
  // steps across that same height instead of leaving dead space below the
  // last arrow.
  justifyContent: "space-between",
  height: "100%",
  margin: 0,
  padding: 0,
  listStyle: "none",
};

const flowStep: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 3,
};

const flowStepBox: CSSProperties = {
  display: "grid",
  placeItems: "center",
  width: "100%",
  minHeight: 36,
  padding: "5px 8px",
  border: "1px solid var(--muted-deep)",
  borderRadius: 8,
  background: "var(--paper)",
  fontSize: 10.5,
  fontWeight: 700,
  lineHeight: 1.25,
  textAlign: "center",
  wordBreak: "keep-all",
};

const flowArrow: CSSProperties = {
  color: "var(--muted-deep)",
  fontSize: 12,
  lineHeight: 1,
};

const rules: CSSProperties = {
  fontSize: 11,
};

const rulesTitle: CSSProperties = {
  display: "block",
  fontSize: 11.5,
  fontWeight: 700,
};

const rulesList: CSSProperties = {
  margin: "7px 0 0",
  paddingLeft: 15,
  color: "var(--muted-deep)",
  lineHeight: 1.5,
};

const rulesItem: CSSProperties = {
  marginTop: 5,
};

const primary: CSSProperties = {
  height: 32,
  padding: "0 16px",
  borderRadius: 9,
  border: "1px solid transparent",
  background: "var(--accent, var(--black))",
  color: "var(--white)",
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
