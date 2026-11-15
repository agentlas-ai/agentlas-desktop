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

/**
 * The same, for the conversation the window SHOWS. A group room runs nothing itself: the run a send to it was promised answers in a
 * member's child session of the room (`Chat.parentChatId`), so that run's receipt names the child, never the room. Without this the two
 * recovery reads (the active-list gap and the busy-time check) could never settle a room's run whose end event was missed, and the room
 * kept "working" and its stop button until the window was reloaded (mac-daily-1 defect 6). Only a terminal receipt of this exact run
 * whose chat is the room itself or a direct child of it counts.
 */
export async function oneRunReceiptIsTerminalForThread(
  api: { chats: { get(id: string): Promise<{ parentChatId?: string | null } | null | undefined> } },
  receipt: { runId: string; chatId?: string | null; status: string } | null | undefined,
  runId: string,
  threadChatId: string,
): Promise<boolean> {
  if (oneRunReceiptIsTerminal(receipt, runId, threadChatId)) return true;
  if (!receipt || receipt.runId !== runId || !receipt.chatId || receipt.chatId === threadChatId) return false;
  if (!["completed", "failed", "cancelled", "interrupted"].includes(receipt.status)) return false;
  try { return (await api.chats.get(receipt.chatId))?.parentChatId === threadChatId; } catch { return false; }
}
