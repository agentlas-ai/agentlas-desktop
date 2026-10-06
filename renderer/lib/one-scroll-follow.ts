/** Coalesce layout-follow work and recheck ownership/reader intent when it runs. */
export function createOneScrollFollow(
  requestFrame: (callback: FrameRequestCallback) => number,
  cancelFrame: (id: number) => void,
) {
  let pending: number | null = null;
  const cancel = () => {
    if (pending !== null) cancelFrame(pending);
    pending = null;
  };
  return {
    cancel,
    schedule(isCurrent: () => boolean, move: () => void) {
      cancel();
      pending = requestFrame(() => {
        pending = null;
        if (isCurrent()) move();
      });
    },
  };
}

/** An active-list omission cannot settle a run or release its custody. */
export function oneRunReceiptIsTerminal(
  receipt: { runId: string; chatId?: string | null; status: string } | null | undefined,
  runId: string,
  chatId: string,
): boolean {
  return Boolean(receipt && receipt.runId === runId && receipt.chatId === chatId
    && ["completed", "failed", "cancelled", "interrupted"].includes(receipt.status));
}
