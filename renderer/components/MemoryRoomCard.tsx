"use client";

/*
 * The card "oldest memory deleted" in the conversation the new line was said in (pictures desktop-plural-3 BH · BI · BL; the words are in shared/memory-room-card.ts and nowhere else). Drawn from the card row only.
 * The only thing to press is the × at the top right: it closes the card and it does not come back (the closing is kept for this screen under the row's id; there is no "remember again" button - saying the words again does that).
 */
import { useEffect, useState } from "react";
import { IconClose } from "@/components/Icon";
import { useT } from "@/lib/i18n";
import { memoryRoomWords, type MemoryRoomCardValue } from "@shared/memory-room-card";
import s from "./MemoryRoomCard.module.css";

const CLOSED_KEY = "agentlas.memory-room.closed.v1";
const readClosed = (): string[] => { try { const v = JSON.parse(window.localStorage.getItem(CLOSED_KEY) ?? "[]") as unknown; return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; } catch { return []; } };
/** At most this many closed card ids are kept (the oldest is dropped): a closed card is a row of an old conversation, and the list must not grow for ever. */
const KEEP_CLOSED = 200;

export function MemoryRoomCard({ rowId, value, locale }: { rowId: string; value: MemoryRoomCardValue; locale?: "ko" | "en" }) {
  const i18n = useT();
  const ko = (locale ?? i18n.locale) === "ko";
  const [closed, setClosed] = useState(false);
  useEffect(() => { setClosed(readClosed().includes(rowId)); }, [rowId]);
  if (closed) return null;
  const words = memoryRoomWords(value, ko);
  const close = (): void => {
    setClosed(true);
    try { window.localStorage.setItem(CLOSED_KEY, JSON.stringify([...readClosed().filter((id) => id !== rowId), rowId].slice(-KEEP_CLOSED))); } catch { /* the card stays closed for this screen */ }
  };
  return (
    <aside className={s.card} data-testid="memory-room-card" data-scope={value.scope}>
      <header className={s.head}>
        <svg className={s.icon} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 7h16v4H4z" /><path d="M6 11v8h12v-8" /><path d="M10 14.5h4" /></svg>
        <strong className={s.title}>{words.title}</strong>
        <button type="button" className={s.close} onClick={close} aria-label={ko ? "닫기" : "Close"} title={ko ? "닫기" : "Close"}><IconClose size={14} /></button>
      </header>
      <p className={s.line} title={words.line}>{words.line}</p>
      <p className={s.reason}>{words.reason}</p>
    </aside>
  );
}
