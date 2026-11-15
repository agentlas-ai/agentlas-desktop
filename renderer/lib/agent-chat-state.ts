"use client";

import { useEffect, useState } from "react";
import { ipc, ipcEvents } from "@/lib/ipc";

/*
 * Whether an Agent Chat room can still take the owner's message (Main: electron/one/agent-chat-state.ts; Agentlas 2.0
 * item 1). A one-to-one room whose agent was deleted stays readable but has nobody to answer; the room says so in one line and
 * offers "continue with another agent". Main refuses the send as well (assertOwnerMayWriteRoom), so this only decides what is shown.
 * Unknown (no bridge, a failed read) is "can write": Main still has the last word.
 */

export type AgentChatReadOnlyReason = "agent_deleted" | "room_dissolved" | "no_members" | null;

/** Main's refusal code for an owner message into such a room (IPC; the phone sees a plain failure). */
export const AGENT_CHAT_READ_ONLY = "agent_chat_read_only";

export function agentChatReadOnlyCopy(locale: "ko" | "en", reason: AgentChatReadOnlyReason = "agent_deleted") {
  const ko = locale === "ko";
  if (reason === "no_members") {
    // No picture draws this state: it is the deleted-agent line in the same grammar (listed as "no picture - made" in the F-D5b record).
    return {
      title: ko ? "이 그룹에는 남은 구성원이 없어요" : "No one is left in this group",
      body: ko ? "대화 기록은 그대로 볼 수 있어요. 이어서 이야기하려면 다른 에이전트와 새 대화를 시작해 주세요." : "You can still read the conversation. To keep going, start a new chat with other agents.",
      action: ko ? "다른 에이전트로 이어가기" : "Continue with other agents",
    };
  }
  return {
    title: ko ? "이 에이전트는 삭제됐어요" : "This agent was deleted",
    body: ko ? "대화 기록은 그대로 볼 수 있어요. 이어서 이야기하려면 다른 에이전트와 새 대화를 시작해 주세요." : "You can still read the conversation. To keep going, start a new chat with another agent.",
    action: ko ? "다른 에이전트로 이어가기" : "Continue with another agent",
  };
}

export function useAgentChatReadOnly(chatId: string | null | undefined): AgentChatReadOnlyReason {
  const [state, setState] = useState<{ chatId: string; reason: AgentChatReadOnlyReason } | null>(null);
  useEffect(() => {
    if (!chatId) return;
    const api = ipc();
    if (!api?.chats?.agentChatState) return;
    let alive = true;
    const read = () => {
      void api.chats.agentChatState!(chatId).then((answer) => {
        if (alive) setState({ chatId, reason: answer?.readOnly ? answer.reason : null });
      }).catch(() => { /* keep the last answer */ });
    };
    read();
    const off = ipcEvents()?.onStoreChanged?.((change: { entity: string; id?: string }) => {
      if ((change.entity === "chat" || change.entity === "agent" || change.entity === "one-org") && (!change.id || change.id === chatId || change.entity !== "chat")) read();
    });
    return () => { alive = false; off?.(); };
  }, [chatId]);
  return chatId && state?.chatId === chatId ? state.reason : null;
}
