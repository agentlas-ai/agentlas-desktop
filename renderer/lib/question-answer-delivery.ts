// What happens to an answer the owner chose on a Work question card when it cannot go out at once
// (owner 2026-10-25: "안되는 경우가 없어야지 — 어쩔 수 없을 때는 나중에 전송"). An answer is never refused and
// dropped: it is saved in Main first (confirm.commitAnswer), then delivered to the turn that asked, and when that
// turn can no longer take it, as a new message of the owner. One rule for every caller in TaskCockpit.tsx.

/** Main's continuation refusals that clear by themselves: a turn is running, the app is closing/starting, the bridge dropped. */
const TRANSIENT_CONTINUATION_REFUSALS = new Set([
  "chat-busy",
  "admission-closed",
  "decision_continuation_transport_unavailable",
]);

/** How many times a saved answer retries its own continuation before it goes out as a new message instead. */
export const SAVED_ANSWER_MAX_RETRIES = 20;

export type SavedAnswerNextStep =
  /** Keep the saved answer and start its continuation again the next time the chat is idle. */
  | "retry-when-idle"
  /** The asking turn cannot take it any more (a newer question or message replaced it): send it as a new owner message. */
  | "deliver-as-new-turn"
  /** The owner stopped this Goal after answering: the saved answer must not restart it on its own, so it waits in the composer. */
  | "return-to-composer";

/**
 * The next step for a saved answer whose continuation did not start.
 * `reasonCode` is Main's typed refusal (QuestionContinuationReceipt.reasonCode) or undefined when the send never reached Main
 * (the view was busy or changing chats): that is transient too. A transient refusal retries up to SAVED_ANSWER_MAX_RETRIES,
 * then the answer goes out as a new message, so no state of the harness can hold it for ever.
 */
export function savedAnswerNextStep(input: { reasonCode?: string | null; transportRetryable?: boolean; attempts: number }): SavedAnswerNextStep {
  const reason = input.reasonCode ?? undefined;
  if (reason === "start-rejected") return "return-to-composer";
  const transient = input.transportRetryable === true || reason === undefined || TRANSIENT_CONTINUATION_REFUSALS.has(reason);
  if (transient && input.attempts < SAVED_ANSWER_MAX_RETRIES) return "retry-when-idle";
  return "deliver-as-new-turn";
}
