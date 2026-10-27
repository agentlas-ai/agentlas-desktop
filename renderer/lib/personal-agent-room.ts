"use client";

import { useEffect, useState } from "react";
import { ipc, ipcEvents } from "@/lib/ipc";
import { ipcErrorCode } from "@shared/ipc-error-code";

/*
 * A room the personal agent opened and runs (Main: electron/one/personal-agent-rooms.ts; owner 2026-10-27 "개인 에이전트가
 * 띄운 Work 는 … 사용자가 챗을 치지 못하고 … 개인 에이전트로 봐야 한다"). Main marks it on the Chat and on its Task
 * (`supervisedByPersonalAgent`); the screens only read that marker, never a title or a guess.
 *   - It stays out of the Work lists (sidebar, dashboard, project lists).
 *   - Its composer is a notice with a way to the personal agent; approval and question cards still answer in the room.
 *   - "내가 직접 이어가기" (room ⋯ menu, with a confirmation) makes it an ordinary Work room.
 */

export const PERSONAL_AGENT_HREF = "/one?personal=1";
/** Main's refusal code for an owner message into such a room (IPC and phone bridge). */
export const PERSONAL_AGENT_ROOM_READ_ONLY = "supervised_room_read_only";

export function isPersonalAgentRoom(value: { supervisedByPersonalAgent?: boolean } | null | undefined): boolean {
  return value?.supervisedByPersonalAgent === true;
}

export function isPersonalAgentRoomRefusal(error: unknown): boolean {
  return ipcErrorCode(error) === PERSONAL_AGENT_ROOM_READ_ONLY;
}

export function personalAgentRoomCopy(locale: "ko" | "en") {
  const ko = locale === "ko";
  return {
    title: ko ? "개인 에이전트가 맡긴 작업이에요" : "Your personal agent is running this task",
    body: ko ? "이 방에는 직접 쓰지 않아요. 지시나 질문은 개인 에이전트에게 말해 주세요." : "You don't write in this room. Tell your personal agent what you need.",
    openPersonalAgent: ko ? "개인 에이전트에게 말하기" : "Talk to your personal agent",
    menu: ko ? "방 메뉴" : "Room menu",
    takeOver: ko ? "내가 직접 이어가기" : "Continue it myself",
    confirmTitle: ko ? "이 작업을 직접 이어갈까요?" : "Continue this task yourself?",
    confirmBody: ko
      ? "개인 에이전트가 이 방을 더 이상 맡지 않아요. 방은 보통 Work 방이 되어 Work 목록에 보이고, 여기서 직접 대화할 수 있어요. 개인 에이전트는 이 방에 지시를 보내지 않아요."
      : "Your personal agent stops running this room. It becomes an ordinary Work room in your Work list, and you can talk here directly. Your personal agent will no longer send directions into it.",
    confirm: ko ? "직접 이어가기" : "Continue myself",
    cancel: ko ? "취소" : "Cancel",
    failed: ko ? "직접 이어가기를 확인하지 못했어요. 다시 시도해 주세요." : "Taking the room over was not confirmed. Please try again.",
    refused: ko ? "이 방은 개인 에이전트가 맡고 있어요. 개인 에이전트에게 말해 주세요." : "Your personal agent is running this room. Tell your personal agent instead.",
  };
}

/** "내가 직접 이어가기". Resolves with Main's receipt; throws when Main did not confirm it. */
export async function releasePersonalAgentRoom(chatId: string): Promise<{ chatId: string; released: true; releasedAt: string; alreadyReleased: boolean }> {
  const api = ipc();
  if (!api?.oneSupervisor?.releaseRoom) throw new Error("personal_agent_room_release_unavailable");
  const receipt = await api.oneSupervisor.releaseRoom({ chatId });
  if (!receipt || receipt.chatId !== chatId || receipt.released !== true) throw new Error("personal_agent_room_release_unconfirmed");
  return receipt;
}

/**
 * Whether the chat is a personal agent's room, for screens that hold only a chat id (the One session view). Re-read on a
 * change to that chat, so a release shows at once. Unknown (no bridge, read failed) is false: Main still refuses.
 */
export function usePersonalAgentRoom(chatId: string | null | undefined): boolean {
  const [state, setState] = useState<{ chatId: string; supervised: boolean } | null>(null);
  useEffect(() => {
    if (!chatId) return;
    const api = ipc();
    if (!api?.chats?.get) return;
    let alive = true;
    const read = () => {
      void api.chats.get(chatId).then((chat) => {
        if (alive) setState({ chatId, supervised: isPersonalAgentRoom(chat) });
      }).catch(() => { /* keep the last answer */ });
    };
    read();
    const off = ipcEvents()?.onStoreChanged?.((change: { entity: string; id?: string }) => {
      if (change.entity === "chat" && (!change.id || change.id === chatId)) read();
    });
    return () => { alive = false; off?.(); };
  }, [chatId]);
  return Boolean(chatId && state?.chatId === chatId && state.supervised);
}
