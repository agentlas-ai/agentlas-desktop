/**
 * One calm line for an owner message the app could not learn the fate of (the run that took it was lost without a stated cause) and will not send
 * again: the queue's one resend is spent, or the input is a one-use attachment/team ref the queue does not re-send. No code and no instruction:
 * the owner decides what to do with the message they can see (nothing the owner sent ends with no line). Shared by the send
 * queue (renderer-send-queue.ts onEnded) and the queued-input custody (queued-owner-input-custody.ts, which deletes the bytes of such an input).
 */
export function queuedSendUnansweredNotice(locale: "ko" | "en"): string {
  return locale === "ko"
    ? "이 메시지에는 아직 답이 없어요. 앱이 모델이 받았는지 확인하지 못했어요."
    : "This message has not been answered: the app could not confirm that the model received it.";
}
