import { receiptOfRow } from "./receipt-card-model";

/*
 * The words of the "clear this conversation's history" confirmation: what will be cleared, in a few words, and how many schedules this conversation made
 * (they stay: only the messages go). The count comes from the conversation's own schedule receipts that still point at a live, enabled schedule.
 * The dialog is the app's one confirm (lib/popup.tsx confirmPopup); this file only says the words.
 */

type Row = { id?: string; role?: string; text?: string | null };
type Schedule = { id: string; enabled?: boolean | number | null };

/** How many messages the clear removes: the person's and the agent's, not the host's receipt rows. */
export function clearableMessageCount(rows: readonly Row[]): number {
  return rows.filter((row) => (row.role === "user" || row.role === "agent") && !receiptOfRow({ ...row, role: "system" })).length;
}

/** The enabled schedules this conversation's receipts point at (distinct, still existing). */
export function schedulesOfConversation(rows: readonly Row[], schedules: readonly Schedule[]): number {
  const ids = new Set<string>();
  for (const row of rows) {
    const value = receiptOfRow(row);
    const ref = value?.kind === "schedule" && value.outcome === "done" && value.verb !== "delete" ? (value.ref as { automationId?: unknown }) : null;
    if (ref && typeof ref.automationId === "string") ids.add(ref.automationId);
  }
  return schedules.filter((one) => ids.has(one.id) && one.enabled !== false && one.enabled !== 0).length;
}

export function clearHistoryConfirmWords(input: { locale: "ko" | "en"; messages: number; schedules: number }): { title: string; message: string; confirmLabel: string; cancelLabel: string } {
  const ko = input.locale === "ko";
  const schedules = input.schedules > 0 ? (ko ? `\n이 대화의 예약 ${input.schedules}개는 그대로 남아요.` : `\nThis conversation's ${input.schedules} schedule${input.schedules === 1 ? "" : "s"} stay.`) : "";
  return ko
    ? { title: "대화 기록을 지울까요?", message: `메시지 ${input.messages}개가 지워져요. 되돌릴 수 없어요.${schedules}`, confirmLabel: "기록 지우기", cancelLabel: "취소" }
    : { title: "Clear this history?", message: `${input.messages} message${input.messages === 1 ? "" : "s"} will be cleared. This cannot be undone.${schedules}`, confirmLabel: "Clear history", cancelLabel: "Cancel" };
}
