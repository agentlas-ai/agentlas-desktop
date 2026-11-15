"use client";

import { useCallback } from "react";
import { openChatInSpace } from "@/lib/space-store";
import { OneEmbeddedShell, forgetOneComposerDrafts } from "./OneShell";

export { forgetOneComposerDrafts };

/**
 * A conversation in a pane of Home's Space (Agentlas 2.0 H1, decision). It IS the One screen's conversation view - the same
 * bubbles, "Worked for" lines, composer and model / effort / permission chips - drawn without the rail. Nothing about the look
 * is made here; the pane only says where "open another conversation" and "close" go.
 */
export function OneConversationPane({ chatId, paneId, focused, onClose, startPrompt = null }: {
  chatId: string;
  paneId: string;
  focused: boolean;
  onClose: (chatId: string) => void;
  /** The first message the New chat start screen held for this Agent Chat: sent once when the room is ready. */
  startPrompt?: string | null;
}) {
  // "Open another conversation" (a new session, a teammate's session) replaces this pane's tab; the old one stays in the left list.
  const onOpenChat = useCallback((next: string) => openChatInSpace({ chatId: next, kind: "room" }, "replace-pane", paneId), [paneId]);
  // A conversation that starts a Task stays here (the pane is a conversation, not a Work screen): nothing moves.
  const onOpenTask = useCallback(() => undefined, []);
  const close = useCallback(() => onClose(chatId), [onClose, chatId]);
  return <OneEmbeddedShell embed={{ chatId, focused, onOpenChat, onOpenTask, onClose: close, startPrompt }} />;
}
