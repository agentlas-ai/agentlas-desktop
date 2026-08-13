/** Stable Main-owned refusal used by every UI that deletes a chat. */
export const CHAT_RUN_ACTIVE = "chat_run_active";

export function assertChatRemovalAllowed(chatId: string, activeChatIds: readonly string[]): void {
  if (!activeChatIds.includes(chatId)) return;
  const error = new Error(CHAT_RUN_ACTIVE) as Error & { code?: string };
  error.code = CHAT_RUN_ACTIVE;
  throw error;
}
