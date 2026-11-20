/*
 * The New chat start screen's state (Agentlas 2.0 F-D6). "New chat" (the list's top button, the "+" on a project row) opens a pane with a centered
 * composer and two drop-downs; no chat exists until the first message is sent. This is screen state only: memory, no storage, no table, no timer.
 * The start itself is what the person asked for just now - it is never restored after a restart (nothing was created, nothing is lost).
 *
 *   projectId: a project id -> that project (the row's "+")     null -> No project     "current" -> the project of the conversation on screen
 */
import { useSyncExternalStore } from "react";

export type NewChatStartRequest = { projectId: string | null | "current"; projectName?: string | null };
export type NewChatStartState = (NewChatStartRequest & { nonce: number }) | null;

let state: NewChatStartState = null;
let nonce = 0;
const listeners = new Set<() => void>();
const emit = () => { for (const listener of [...listeners]) listener(); };

export function openNewChatStart(request: NewChatStartRequest): void { nonce += 1; state = { ...request, nonce }; emit(); }
export function closeNewChatStart(): void { if (!state) return; state = null; emit(); }
export function getNewChatStart(): NewChatStartState { return state; }
export function useNewChatStart(): NewChatStartState {
  return useSyncExternalStore((onChange) => { listeners.add(onChange); return () => { listeners.delete(onChange); }; }, () => state, () => null);
}

/*
 * The first message of a Work session started from the start screen: handed to the new chat's surface once, by chat id. At most 4 are held
 * (a start whose pane was never drawn is dropped, oldest first); taking one removes it, so a reload never sends it again.
 */
const MAX_PENDING = 4;
const pendingFirst = new Map<string, string>();
export function holdFirstMessage(chatId: string, text: string): void {
  pendingFirst.delete(chatId);
  pendingFirst.set(chatId, text);
  while (pendingFirst.size > MAX_PENDING) { const oldest = pendingFirst.keys().next().value; if (oldest === undefined) break; pendingFirst.delete(oldest); }
}
export function takeFirstMessage(chatId: string): string | null {
  const text = pendingFirst.get(chatId);
  if (text === undefined) return null;
  pendingFirst.delete(chatId);
  return text;
}
export function pendingFirstMessageCountForTests(): number { return pendingFirst.size; }

/*
 * An Agent Chat room sends its held first message by its own send, from a view that can be drawn again (a failed read and a retry, a tab switch).
 * The chat that already sent it is remembered here (memory, 64 chats, oldest dropped) so a second drawing never sends it twice.
 */
const sentFirst = new Set<string>();
/** True the first time for a chat (the caller sends), false after. */
export function claimFirstMessageSend(chatId: string): boolean {
  if (sentFirst.has(chatId)) return false;
  sentFirst.add(chatId);
  while (sentFirst.size > 64) { const oldest = sentFirst.values().next().value; if (oldest === undefined) break; sentFirst.delete(oldest); }
  return true;
}
