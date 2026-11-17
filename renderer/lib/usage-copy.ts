// Usage window / reset ticket / invite wording (Korean + English). Pure functions: the widget and the dashboard
// card print the same sentence. `usage` absent never reaches here (callers draw the old credit number instead).
import type { HubUsage } from "@/lib/types";

const SOON_MS = 24 * 60 * 60 * 1000;

/** Window end in the viewer's own time zone: a weekday + time for a week, a date for month/trial. */
export function formatUsageReset(usage: Pick<HubUsage, "kind" | "windowEnd">, ko: boolean): string {
  const at = new Date(usage.windowEnd);
  if (!Number.isFinite(at.getTime())) return "";
  const locale = ko ? "ko-KR" : "en-US";
  return usage.kind === "week"
    ? `${at.toLocaleDateString(locale, { weekday: "long" })} ${at.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" })}`
    : at.toLocaleString(locale, { month: "short", day: "numeric" });
}

/** "usage 42% · resets Monday 9:00 AM" — month/trial say so instead of "week". */
export function usageLine(usage: HubUsage, ko: boolean): string {
  const pct = `${usage.usedPercent}%`;
  const when = formatUsageReset(usage, ko);
  if (usage.kind === "week") {
    return ko ? `사용량 ${pct}${when ? ` · ${when}에 초기화` : ""}` : `Usage ${pct}${when ? ` · resets ${when}` : ""}`;
  }
  if (usage.kind === "trial") {
    return ko ? `체험 사용량 ${pct}${when ? ` · ${when}까지` : ""}` : `Trial usage ${pct}${when ? ` · until ${when}` : ""}`;
  }
  return ko ? `이번 달 사용량 ${pct}${when ? ` · ${when}에 초기화` : ""}` : `This month's usage ${pct}${when ? ` · resets ${when}` : ""}`;
}

export function usageExhaustedLine(usage: HubUsage, ko: boolean): string | null {
  if (!usage.exhausted) return null;
  const week = usage.kind === "week";
  return ko ? (week ? "이번 주 사용량을 다 썼어요" : usage.kind === "trial" ? "체험 사용량을 다 썼어요" : "이번 달 사용량을 다 썼어요")
    : (week ? "You used up this week's allowance" : usage.kind === "trial" ? "You used up the trial allowance" : "You used up this month's allowance");
}

export function usageExtraLine(usage: HubUsage, ko: boolean): string | null {
  return usage.extraUsage ? (ko ? "추가 사용량 있음" : "Extra usage available") : null;
}

/** True when the window ends in less than 24 h: the client asks "use anyway?" first (the server does not). */
export function usageResetsSoon(usage: Pick<HubUsage, "windowEnd">, now = Date.now()): boolean {
  const end = Date.parse(usage.windowEnd);
  return Number.isFinite(end) && end - now < SOON_MS;
}

export function ticketBlockedText(code: string, ko: boolean): string {
  switch (code) {
    case "trial_active": return ko ? "체험 중에는 쓸 수 없어요" : "Not available during the trial";
    case "already_reset_this_window": return ko ? "이번 기간에는 이미 리셋했어요" : "Already reset in this window";
    case "nothing_to_reset": return ko ? "아직 리셋할 사용량이 없어요" : "There is no usage to reset yet";
    case "no_ticket": return ko ? "리셋권이 없어요" : "No reset ticket";
    case "ticket_expired": return ko ? "리셋권 기한이 지났어요" : "The ticket has expired";
    case "rate_limited": return ko ? "잠시 뒤 다시 시도해 주세요" : "Try again in a moment";
    case "signed_out": return ko ? "다시 로그인해 주세요" : "Sign in again";
    case "network": return ko ? "연결하지 못했어요. 다시 눌러 주세요" : "Could not connect. Press again";
    default: return ko ? "지금은 쓸 수 없어요" : "Not available right now";
  }
}

export function inviteClaimText(code: string, ko: boolean): string {
  switch (code) {
    case "invalid_code": return ko ? "코드를 확인해 주세요" : "Check the code";
    case "account_too_old": return ko ? "가입 7일 안에만 입력할 수 있어요" : "Codes can be entered within 7 days of sign-up";
    case "already_claimed": return ko ? "이미 입력했어요" : "Already entered";
    case "signed_out": return ko ? "다시 로그인해 주세요" : "Sign in again";
    case "network": return ko ? "연결하지 못했어요. 다시 눌러 주세요" : "Could not connect. Press again";
    default: return ko ? "지금은 쓸 수 없어요" : "Not available right now";
  }
}
