// R3-3 (Agentlas 2.0 desktop R): a permission request that closes without the phone's answer leaves ONE quiet line in the conversation.
//
// Before: the phone drew "Timed out - treated as declined" only when its previous snapshot held the request as pending
// (mobile app_controller.dart _noticeUnansweredApprovals), and the computer named a timed-out id for only 2 minutes
// (runtime/tool-approval.ts listRecentlyExpiredToolApprovalIds). A phone that was off when the card closed - or that was reinstalled - showed nothing.
//
// Now: every close path of a request this host holds (time ran out, the run was cancelled, the app restarted, the person declined on the computer)
// writes `approval-closed:<requestId>` as a 'view' row of the request's own chat (store/chats.ts recordApprovalClosedRow). The phone's existing history
// readers draw a stored system row as a quiet notice line in a Work chat; in a One chat a system row is hidden unless it carries the seat marker
// (shared/one-seat-events.ts, which the phone already opens), so a One-origin chat gets the marker. A 'view' row is never read by the runtime
// (store/chats.ts listChatMessages), so the model's input does not change. No new table, no timer, no model call.
//
// Pure of Electron: the daemon loads it (the daemon holds approvals too and writes its own rows; the id is the request's, so Main and the daemon never write twice).
import { chatOriginSurface, recordApprovalClosedRow } from "../store/chats";
import { seatEventText } from "../../shared/one-seat-events";
import { currentUiLocale } from "../ui-locale";

/*
 * DD (decision, the coordinator's ruling): an answer "allow" given on the computer leaves NO line. What was allowed shows in the conversation by its own
 * result, so a line "Allowed on the computer" under every allowed call was noise. What is refused, timed out, cancelled or lost to a restart still leaves its one
 * line (a fact the phone could not know). There is no `answered_allow` any more: a caller that wanted it does not compile.
 */
export type ApprovalClosureReason = "timed_out" | "cancelled" | "restarted" | "answered_deny";

/** The closed sentences (Korean / English). `timed_out` is word for word the sentence the phone draws for the same fact. */
const LINES: Readonly<Record<ApprovalClosureReason, readonly [string, string]>> = {
  timed_out: ["시간이 지나 거절로 처리됐어요", "Timed out — treated as declined"],
  cancelled: ["실행이 멈춰 요청이 닫혔어요", "The run stopped, so the request was closed"],
  restarted: ["앱이 다시 시작돼 요청이 닫혔어요", "The app restarted, so the request was closed"],
  answered_deny: ["컴퓨터에서 거절했어요", "Declined on the computer"],
};

export function approvalClosureLine(reason: ApprovalClosureReason, ko: boolean): string {
  return LINES[reason][ko ? 0 : 1];
}

export interface ApprovalClosure {
  requestId: string;
  chatId: string | undefined;
  reason: ApprovalClosureReason;
  /** ISO time the request closed. */
  at?: string;
  /** Write only when a phone is paired with this computer (the computer's own answer is not news to anyone else otherwise). */
  requirePairedPhone?: boolean;
}

function phonePaired(): boolean {
  try {
    // Lazy: the bridge module is heavy and the daemon may not carry a bridge at all.
    const bridge = require("../mobile-bridge/runtime") as typeof import("../mobile-bridge/runtime");
    return bridge.listMobileBridgeDevices().length > 0;
  } catch { return false; }
}

/**
 * Writes the line once. Never throws (the settlement of a request must not wait on a record) and never writes twice for one request.
 * Returns "written", "exists" (the same request already has its line), or "skipped" (no chat, no phone to tell, unwritable).
 */
export function recordApprovalClosure(closure: ApprovalClosure): "written" | "exists" | "skipped" {
  try {
    if (!closure.chatId || !closure.requestId) return "skipped";
    if (closure.requirePairedPhone && !phonePaired()) return "skipped";
    const ko = currentUiLocale() === "ko";
    const line = approvalClosureLine(closure.reason, ko);
    const text = chatOriginSurface(closure.chatId) === "one" ? seatEventText(line) : line;
    const at = closure.at && Number.isFinite(Date.parse(closure.at)) ? new Date(closure.at).toISOString() : new Date().toISOString();
    const result = recordApprovalClosedRow({ requestId: closure.requestId, chatId: closure.chatId, text, createdAt: at });
    return result === "refused" ? "skipped" : result;
  } catch { return "skipped"; }
}
