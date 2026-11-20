"use client";
/*
 * Main's read model of a conversation's sends that are not a transcript row yet (electron/chat/owner-input-queue.ts), as every window reads it: read when the conversation
 * changes (a store signal) and on one safety net - never on a clock of its own. Every surface that draws a person's send under its intent id reads it here.
 */
import { useEffect, useState } from "react";
import { ipc } from "@/lib/ipc";
import { watchChat } from "@/lib/chat-signal";
import type { TranscriptOwnerInput } from "@/lib/chat-transcript-model";

export function useOwnerInputs(chatId: string | null | undefined): TranscriptOwnerInput[] {
  const [state, setState] = useState<{ chatId: string | null; items: TranscriptOwnerInput[] }>({ chatId: null, items: [] });
  useEffect(() => {
    if (!chatId) return;
    const api = ipc();
    if (!api?.chat?.ownerInputs) return;
    let cancelled = false, loading = false;
    const read = () => {
      if (cancelled || loading) return;
      loading = true;
      void api.chat.ownerInputs(chatId).then((items) => {
        if (cancelled) return;
        const next = items.map((item): TranscriptOwnerInput => ({ key: item.key, state: item.state, text: item.text, intentId: item.intentId, reason: item.reason, runId: item.runId, createdAt: item.createdAt }));
        setState((current) => (current.chatId === chatId && JSON.stringify(current.items) === JSON.stringify(next) ? current : { chatId, items: next }));
      }).catch(() => undefined).finally(() => { loading = false; });
    };
    read();
    const off = watchChat(chatId, read);
    return () => { cancelled = true; off(); };
  }, [chatId]);
  return state.chatId === chatId ? state.items : [];
}
