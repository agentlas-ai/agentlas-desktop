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

/**
 * The one number the app shows for AI usage: the percent USED. The server's window percent when it sent one; otherwise (an older server, the switch off) derived from the
 * credit balance and its allowance; null when neither is known - the caller then has nothing honest to show as a percent. Never the raw credit count (owner: usage is one
 * measure, in %, in every place).
 */
export function usedPercentOf(usage: Pick<HubUsage, "usedPercent"> | undefined | null, remaining: number | undefined, limit: number | undefined): number | null {
  const clamp = (value: number) => Math.min(100, Math.max(0, Math.round(value)));
  if (usage && Number.isFinite(usage.usedPercent)) return clamp(usage.usedPercent);
  if (typeof remaining === "number" && typeof limit === "number" && limit > 0) return clamp((1 - remaining / limit) * 100);
  return null;
}

/** The window half of usageLine alone: "resets Monday 9:00 AM" (week/month), "until Dec 1" (trial). Empty when the window end is unknown. */
export function usageWindowLine(usage: Pick<HubUsage, "kind" | "windowEnd">, ko: boolean): string {
  const when = formatUsageReset(usage, ko);
  if (!when) return "";
  if (usage.kind === "trial") return ko ? `${when}까지` : `until ${when}`;
  return ko ? `${when}에 초기화` : `resets ${when}`;
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
  return ko ? (week ? "이번 주 사용량 소진" : usage.kind === "trial" ? "체험 사용량 소진" : "이번 달 사용량 소진")
    : (week ? "This week's usage is used up" : usage.kind === "trial" ? "Trial usage is used up" : "This month's usage is used up");
}

export function usageExtraLine(usage: HubUsage, ko: boolean): string | null {
  return usage.extraUsage
    ? (ko ? "충전 크레딧으로 계속 쓸 수 있어요" : "Top-up credits keep it going")
    : null;
}

/** The window this percent belongs to, in words: "This week · resets Monday 9:00 AM" / "This month · ..." / "Trial · until ...". */
export function usagePeriodLine(usage: Pick<HubUsage, "kind" | "windowEnd">, ko: boolean): string {
  const when = formatUsageReset(usage, ko);
  if (usage.kind === "trial") return ko ? `체험 중${when ? ` · ${when}까지` : ""}` : `Trial${when ? ` · until ${when}` : ""}`;
  const period = usage.kind === "week" ? (ko ? "이번 주" : "This week") : (ko ? "이번 달" : "This month");
  return `${period}${when ? (ko ? ` · ${when}에 초기화` : ` · resets ${when}`) : ""}`;
}

/** Public Hub calls and sharing are free, so they are not part of this number - the one question the old "Public Hub" line was about. */
export function usageHubFootnote(ko: boolean): string {
  return ko ? "공개 Hub 호출·공유는 사용량에 들어가지 않아요." : "Public Hub calls and sharing are not counted.";
}

/** Reset tickets: what one is, what it does, how to get one. Pure so the popup and the tests read the same words. */
export function ticketHeadLine(available: number, ko: boolean): string {
  return ko ? `리셋권 ${available}장` : `Reset tickets: ${available}`;
}
export function ticketHelpLine(available: number, ko: boolean): string {
  return available > 0
    ? (ko ? "쓰면 이번 사용량이 0%로 돌아가요. 충전한 크레딧은 그대로예요." : "Using one sets your usage back to 0%. Top-up credits are not touched.")
    : (ko ? "리셋권이 없어요. 친구를 초대하면 받을 수 있어요." : "You have no reset tickets. Invite a friend to get one.");
}
export function ticketExpiryLine(nextExpiresAt: string | null | undefined, ko: boolean): string | null {
  if (!nextExpiresAt) return null;
  const at = new Date(nextExpiresAt);
  if (!Number.isFinite(at.getTime())) return null;
  const date = at.toLocaleDateString(ko ? "ko-KR" : "en-US", { month: "short", day: "numeric" });
  return ko ? `가장 빠른 만료 ${date}` : `Next one expires ${date}`;
}
/** Why the percent is low right now: a ticket was already used in this window. */
export function ticketUsedLine(usedThisWindow: boolean, ko: boolean): string | null {
  return usedThisWindow ? (ko ? "이번 기간에 리셋권을 이미 썼어요." : "You already used a reset ticket in this window.") : null;
}

/** Invite: what the person gets, how many have joined, and the one limit that would otherwise only show up as an error. */
export function inviteRewardLine(ko: boolean): string {
  return ko ? "친구가 가입하고 첫 대화를 하면 리셋권을 한 장 받아요. 한 달에 최대 3장까지예요." : "When a friend signs up and has a first conversation, you get one reset ticket (up to 3 a month).";
}
export function inviteJoinedLine(joined: number, ko: boolean): string {
  return ko ? `가입한 친구 ${joined}명` : `${joined} ${joined === 1 ? "friend has" : "friends have"} joined`;
}
export function inviteClaimHintLine(ko: boolean): string {
  return ko ? "친구에게 받은 코드는 가입 후 7일 안에만 넣을 수 있어요." : "A friend's code can only be entered within 7 days of signing up.";
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

// ── the one usage meter's words and numbers ────────────────────────────────────────────────────────────────────────
// Every place that shows AI usage draws it with components/usage/UsageMeter.tsx, and every sentence about it comes from here: the percent USED (decision,
// never a credit count), the "no percent known" words, the "this one is used up" suffix, the "tries again around ..." line. A screen that wants usage words
// asks this file; it does not write its own.

/** The percent from which the meter turns amber / red. One pair of numbers for the sidebar, the dashboard row and the banner. */
export const USAGE_WARN_PERCENT = 70;
export const USAGE_HOT_PERCENT = 90;
export type UsageTone = "unknown" | "ok" | "warn" | "hot";

export interface UsageMeterModel {
  /** The percent USED, whole and clamped; null when nothing honest can be said as a percent. */
  percent: number | null;
  tone: UsageTone;
  /** "42%", or the words "Usage unavailable" (never a credit count). */
  text: string;
  /** Bar fill in percent of the track: a used bar never rounds to invisible (0 stays 0, 1..2 shows 3). */
  fill: number;
  /** Screen-reader sentence ("42% used"), undefined when unknown. */
  valueText: string | undefined;
}

export function usageHeadLabel(ko: boolean): string { return ko ? "AI 사용량" : "AI usage"; }
export function usageUnavailableText(ko: boolean): string { return ko ? "사용량을 불러오지 못했어요" : "Usage unavailable"; }

export function usageToneOf(percent: number | null): UsageTone {
  if (percent === null) return "unknown";
  return percent >= USAGE_HOT_PERCENT ? "hot" : percent >= USAGE_WARN_PERCENT ? "warn" : "ok";
}

/** The meter's numbers from ONE percent. Any raw value is clamped here, so no caller can draw 140% or -3%. */
export function usageMeterModel(percent: number | null | undefined, ko: boolean): UsageMeterModel {
  const value = typeof percent === "number" && Number.isFinite(percent) ? Math.min(100, Math.max(0, Math.round(percent))) : null;
  return {
    percent: value,
    tone: usageToneOf(value),
    text: value === null ? usageUnavailableText(ko) : `${value}%`,
    fill: value === null ? 0 : Math.max(value > 0 ? 3 : 0, value),
    valueText: value === null ? undefined : ko ? `${value}% 사용` : `${value}% used`,
  };
}

/** What follows a runtime's name in a picker when its usage is used up (an <option> holds text only, so this is a sentence, not the component). */
export function usageExhaustedSuffix(ko: boolean): string { return ko ? " · 사용량 소진" : " · usage exhausted"; }

/** A member that hit a usage limit: when the router tries it again (local clock), or just that it will. */
export function usageLimitRetryLine(names: readonly string[], clock: string | null, ko: boolean): string {
  const who = names.join(", ");
  return clock
    ? (ko ? `${who} 한도 도달 · ${clock}쯤 재시도` : `${who} at limit · retry ~${clock}`)
    : (ko ? `${who} 한도 도달 · 곧 재시도` : `${who} at limit · retry soon`);
}

/** Why a line of the runtime pool was passed over because its usage is used up. */
export function usageSkippedLine(ko: boolean): string { return ko ? "건너뜀: 한도 소진" : "Skipped: quota used up"; }
