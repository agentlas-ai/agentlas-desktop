import { useEffect, useState } from "react";
import { homeBridge } from "./home-tree";

/*
 * Is this group room run under the lead model (the personal agent is not in it: decision)? The room carries that mark in Main
 * (`home:lines` reports it as `lead`); a room is never judged by its title or its text. Only a positive answer is remembered:
 * a room made before the lead model has no mark until it is taken over (when it is opened or gets its next message), so a "no"
 * is asked again the next time the room is shown. A window whose preload lacks the channel answers false (the old look).
 */
const known = new Set<string>();

export function useLeadRoomMark(chatId: string | null): boolean {
  const [leadId, setLeadId] = useState<string | null>(null);
  useEffect(() => {
    if (!chatId || known.has(chatId)) return;
    const read = homeBridge()?.lines;
    if (!read) return;
    let cancelled = false;
    void read([chatId]).then((lines) => {
      if (lines.some((line) => line.id === chatId && line.lead)) known.add(chatId);
      if (!cancelled) setLeadId(known.has(chatId) ? chatId : null);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [chatId]);
  return Boolean(chatId) && (known.has(chatId as string) || leadId === chatId);
}
