import type { ChatHostNotice, HostStatusKind } from "./types";
import { normalizeOneDispatchPresentation } from "./one-dispatch-presentation";

const HOST_STATUS_KINDS: readonly HostStatusKind[] = [
  "effect-checking", "effect-continuing", "wait-registered", "wait-not-scheduled", "cycle-verified", "goal-resuming",
  "effect-retrying", "goal-paused", "goal-closed", "runtime-kept", "needs-owner", "app-failed", "recovered",
];
/** Host status lines that need nothing from the owner: housekeeping, drawn on no surface (isHousekeepingHostNotice). */
const QUIET_HOST_STATUSES: ReadonlySet<HostStatusKind> = new Set([
  "effect-checking", "effect-continuing", "wait-registered", "wait-not-scheduled", "cycle-verified", "goal-resuming",
  // Retry/pause lines the app resolves on its own: nothing for the owner to do, so never an ordinary chat bubble.
  "effect-retrying", "goal-paused",
  // A failed run whose request a later run took over (Main's history read sets it from the ledger): history, not news.
  "recovered",
]);

export function isQuietHostStatus(notice: ChatHostNotice | undefined): notice is Extract<ChatHostNotice, { purpose: "host-status" }> {
  return notice?.purpose === "host-status" && QUIET_HOST_STATUSES.has(notice.status);
}

/**
 * Housekeeping (native-harness 04 §2, notyet NH26): the host's own check / continue / wait / cycle / resume / retry /
 * pause lines, its continuation requests, and One waking to review handed-off work. Decided by the typed notice the
 * host wrote, never by wording. No surface draws these rows — Work, One, the split pane and the phone — not as a bubble,
 * not as a quiet line, not folded into a work block. They stay in the ledger. Results, questions, consent and
 * milestones stay visible: needs-owner, goal-closed, runtime-kept, teammate dispatch links/results, teammate joined,
 * the brief handed to a teammate, automation and AGI reports.
 */
export function isHousekeepingHostNotice(notice: ChatHostNotice | undefined): boolean {
  if (!notice) return false;
  if (notice.purpose === "host-status") return QUIET_HOST_STATUSES.has(notice.status);
  // An AGI owner ask whose incident has closed (Main's history read marks it): the ask is no longer current.
  if (notice.purpose === "automation-report") return notice.withdrawn === true;
  return notice.purpose === "goal-continuation" || notice.purpose === "update-resume"
    || notice.purpose === "one-delegation-review" || notice.purpose === "one-checkin";
}

/** Short label for a host status line ("확인 중", "반영 안 됨 → 이어감", "예약 안 함"). */
export function hostStatusLabel(notice: Extract<ChatHostNotice, { purpose: "host-status" }>, locale: "ko" | "en"): string {
  const ko = locale === "ko";
  switch (notice.status) {
    case "effect-checking": return ko ? "확인 중" : "Checking";
    case "effect-continuing":
      return notice.verdict === "done" ? (ko ? "이미 반영됨 → 이어감" : "Already done → continuing")
        : notice.verdict === "not_done" ? (ko ? "반영 안 됨 → 이어감" : "Not done → continuing")
        : (ko ? "확인 → 이어감" : "Checked → continuing");
    case "wait-registered": return ko ? "대기 예약" : "Wait scheduled";
    case "wait-not-scheduled": return ko ? "예약 안 함" : "Not scheduled";
    case "cycle-verified": return ko ? "회차 확인" : "Cycle verified";
    case "goal-resuming": return ko ? "멈춘 목표 이어감" : "Resuming the goal";
    case "goal-paused": return ko ? "잠시 멈춤 → 자동 재개" : "Paused → resumes on its own";
    case "goal-closed": return ko ? "목표 마침" : "Goal closed";
    case "runtime-kept": return ko ? "시작한 모델로 이어감" : "Kept the starting model";
    case "effect-retrying": return ko ? "확인 못 함 → 다시 확인" : "Could not check → will retry";
    case "needs-owner": return ko ? "확인 필요" : "Needs you";
    case "app-failed": return ko ? "앱 문제" : "App problem";
    case "recovered": return ko ? "다음 실행이 이어받음" : "Taken over by the next run";
    default: return "";
  }
}

/**
 * Host status lines are the one purpose kept on **assistant** rows: the host writes them as the
 * conversation's voice (the model reads them in later turns), and the marker lets every surface drop
 * the housekeeping ones (isHousekeepingHostNotice). Every other purpose stays system-only.
 */
export function normalizeChatHostNotice(role: string, value: unknown): ChatHostNotice | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const validId = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id);
  if (item.purpose === "host-status") {
    if (role !== "assistant" && role !== "system") return undefined;
    if (Object.keys(item).some((key) => !["purpose", "runId", "status", "verdict"].includes(key))
      || !validId(item.runId) || !HOST_STATUS_KINDS.includes(item.status as HostStatusKind)
      || (item.verdict !== undefined && item.verdict !== "done" && item.verdict !== "not_done")) return undefined;
    return { purpose: "host-status", runId: item.runId, status: item.status as HostStatusKind,
      ...(item.verdict === "done" || item.verdict === "not_done" ? { verdict: item.verdict } : {}) };
  }
  if (role !== "system") return undefined;
  if (item.purpose === "automation-report") {
    if (Object.keys(item).some(key => !["purpose", "runId", "automationId", "withdrawn"].includes(key)) || !validId(item.runId) || !validId(item.automationId)
      || (item.withdrawn !== undefined && item.withdrawn !== true)) return undefined;
    return { purpose: "automation-report", runId: item.runId, automationId: item.automationId, ...(item.withdrawn === true ? { withdrawn: true as const } : {}) };
  }
  if (item.purpose === "one-dispatch-link" || item.purpose === "one-dispatch-result") {
    const name = typeof item.memberName === "string" ? item.memberName.replace(/\s+/g, " ").trim() : "";
    if (Object.keys(item).some(key => !["purpose", "runId", "chatId", "memberName", "dispatch"].includes(key))
      || !validId(item.runId) || !validId(item.chatId) || !name || name.length > 80) return undefined;
    const dispatch = normalizeOneDispatchPresentation(item.dispatch);
    return { purpose: item.purpose, runId: item.runId, chatId: item.chatId, memberName: name, ...(dispatch ? { dispatch } : {}) };
  }
  if (item.purpose === "one-team-member-joined") {
    const name = typeof item.memberName === "string" ? item.memberName.replace(/\s+/g, " ").trim() : "";
    if (Object.keys(item).some(key => !["purpose", "memberName", "created"].includes(key))
      || !name || name.length > 80 || typeof item.created !== "boolean") return undefined;
    return { purpose: "one-team-member-joined", memberName: name, created: item.created };
  }
  if (item.purpose === "one-dispatch-brief") {
    if (Object.keys(item).some(key => key !== "purpose" && key !== "runId") || !validId(item.runId)) return undefined;
    return { purpose: "one-dispatch-brief", runId: item.runId };
  }
  if (item.purpose === "update-resume") {
    if (Object.keys(item).some(key => key !== "purpose" && key !== "runId") || !validId(item.runId)) return undefined;
    return { purpose: "update-resume", runId: item.runId };
  }
  if (item.purpose === "one-delegation-review") {
    if (Object.keys(item).some(key => key !== "purpose" && key !== "runId") || !validId(item.runId)) return undefined;
    return { purpose: "one-delegation-review", runId: item.runId };
  }
  if (Object.keys(item).some((key) => key !== "purpose" && key !== "runId")
    || item.purpose !== "goal-continuation" || typeof item.runId !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(item.runId)) return undefined;
  return { purpose: "goal-continuation", runId: item.runId };
}

export function parseChatHostNotice(role: string, json: unknown): ChatHostNotice | undefined {
  if (typeof json !== "string" || json.length > 512) return undefined;
  try { return normalizeChatHostNotice(role, JSON.parse(json)); } catch { return undefined; }
}

/** automation-report rows written by the AGI unblocker (electron/agi/wiring.ts). One quiet line, never a report card. */
export const AGI_ACTION_NOTICE_AUTOMATION_ID = "agi-unblocker";
/** Alive orchestrator notices (electron/alive-organisms/action-notice.ts) — also AGI's own voice. */
export const ALIVE_ACTION_NOTICE_AUTOMATION_ID_SHARED = "alive-orchestrator";

/**
 * An AGI/Alive action row is the host's own status, not a scheduled report. Soak 1.2.50 owner screenshot: it drew
 * as a "예약 보고" card with a bare "AGI" name line above "AGI: 다음 실행은 다른 모델로 이어가요". Returns the one
 * sentence to show, or null when the row is not an AGI action notice. Older rows carry an "AGI" name paragraph.
 */
export function agiActionNoticeLine(notice: { purpose?: string; automationId?: string } | null | undefined, text: string): string | null {
  if (notice?.purpose !== "automation-report") return null;
  if (notice.automationId !== AGI_ACTION_NOTICE_AUTOMATION_ID && notice.automationId !== ALIVE_ACTION_NOTICE_AUTOMATION_ID_SHARED) return null;
  const body = String(text ?? "").replace(/^\s*AGI\s*\n\s*\n/, "").trim();
  return body.replace(/^AGI\s*[:：]\s*/, "").replace(/^AGI(가|는)\s*/, "").trim() || null;
}
