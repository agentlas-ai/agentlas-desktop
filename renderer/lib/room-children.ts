"use client";

import { useEffect, useState } from "react";
import { ipc } from "@/lib/ipc";
import { useRunningChats } from "@/lib/running-chats";

/*
 * A group room's members each work in a child session of the room (`Chat.parentChatId`). A question or an approval those
 * sessions raise is addressed to the CHILD's chat id, but the person is looking at the ROOM: this module answers "which room does
 * this chat belong to" so a pane can draw the child's card and the focused-pane rules can match it to the room.
 *
 * Read once per running chat, remembered for the life of the window, capped (400 entries, then forgotten and re-read).
 */
interface ChildEntry { parent: string | null; agentId: string }
export const childOfRoom = new Map<string, ChildEntry>();
const CAP = 400;

/** The room a chat belongs to: its parent room when it is a member's child session that is known, else itself. */
export function roomOfChat(chatId: string | null | undefined): string | null {
  if (!chatId) return null;
  return childOfRoom.get(chatId)?.parent ?? chatId;
}

export function noteRoomChildren(entries: ReadonlyArray<readonly [string, ChildEntry]>): void {
  if (childOfRoom.size > CAP) childOfRoom.clear();
  for (const [id, entry] of entries) childOfRoom.set(id, entry);
}

/**
 * The running chats whose parent is `roomChatId` (the members working in this room right now). Live state only: nothing after a
 * restart, nothing for a room with no running member. `enabled:false` reads nothing.
 */
export function useRoomChildren(roomChatId: string, enabled = true): string[] {
  const running = useRunningChats();
  const [, bump] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const api = ipc();
    if (!api) return;
    let cancelled = false;
    const unknown = [...running].filter((id) => id !== roomChatId && !childOfRoom.has(id));
    if (unknown.length === 0) return;
    void Promise.all(unknown.slice(0, 20).map((id) => api.chats.get(id)
      .then((chat) => { childOfRoom.set(id, { parent: chat?.parentChatId ?? null, agentId: chat?.agentId ?? "" }); })
      .catch(() => { childOfRoom.set(id, { parent: null, agentId: "" }); })))
      .then(() => { if (!cancelled) bump((value) => value + 1); });
    if (childOfRoom.size > CAP) childOfRoom.clear();
    return () => { cancelled = true; };
  }, [running, roomChatId, enabled]);
  if (!enabled) return [];
  return [...running].filter((id) => childOfRoom.get(id)?.parent === roomChatId);
}
