"use client";

import { useEffect, useRef, useState } from "react";
import {
  alwaysApprovedChatIds,
  grantAlwaysApproval,
  revokeAlwaysApproval,
  subscribeAlwaysApproved,
} from "./always-approved-chats";

/** Display only Main-confirmed consent for the exact conversation. */
export function useChatAlwaysApproval(chatId: string | null | undefined) {
  const [ids, setIds] = useState<readonly string[]>(alwaysApprovedChatIds);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const operationRef = useRef(false);
  const activeChatRef = useRef(chatId);
  activeChatRef.current = chatId;
  useEffect(() => subscribeAlwaysApproved(setIds), []);
  useEffect(() => setFailed(false), [chatId]);

  async function toggle() {
    if (!chatId || operationRef.current) return;
    const targetChatId = chatId;
    const wasApproved = ids.includes(targetChatId);
    operationRef.current = true;
    setPending(true);
    setFailed(false);
    try {
      if (wasApproved) await revokeAlwaysApproval(targetChatId);
      else await grantAlwaysApproval(targetChatId);
    } catch {
      if (activeChatRef.current === targetChatId) setFailed(true);
    } finally {
      operationRef.current = false;
      setPending(false);
    }
  }

  return { enabled: Boolean(chatId && ids.includes(chatId)), available: Boolean(chatId), pending, failed, toggle };
}

export type ChatAlwaysApprovalControl = ReturnType<typeof useChatAlwaysApproval>;
