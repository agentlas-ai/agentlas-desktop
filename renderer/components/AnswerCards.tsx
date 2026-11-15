"use client";

import { createContext, useCallback, useContext, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { isUpgrade, upgradeSteps, upgradeTable } from "@shared/canvas/from-markdown";
import { isResultCardInstance } from "@shared/finance-native-ui";
import { useT } from "@/lib/i18n";
import { FinancePresentBody } from "./finance/FinancePresentCard";
import type { UiInstanceView } from "@shared/ui-instances";
import styles from "./AnswerCards.module.css";

/**
 * What the chat does with the SHAPE of an answer the model has already written (shared/canvas/from-markdown.ts): a table of numbers can be switched to a
 * chart, drawn by the same card renderer as every other card (desktop, phone panel and Science panel read the same HTML). The model is not asked and the
 * text is not changed; the switch only changes how this screen draws it. Off unless a chat answer turns it on (a file preview, a skill page or a
 * notice keeps drawing its tables as they are), and off for a turn that already has a result card of its own (one card, not two).
 */
const AnswerCardsContext = createContext(false);

export function AnswerCardsProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  return <AnswerCardsContext.Provider value={enabled}>{children}</AnswerCardsContext.Provider>;
}

/** On for an answer that has no result card of its own; `instances` are the cards the conversation holds for this reply. */
export const answerCardsEnabledFor = (instances: readonly { presentation: { viewId: string; fallbackText?: string } }[] | undefined): boolean =>
  !(instances ?? []).some(isResultCardInstance);

/**
 * The cards a conversation holds, read once per conversation however many answers ask (one `uiList` and one change subscription per chat, shared; the chat
 * bubbles already read it twice each, so this adds no per-bubble read). `loaded` is false until the first answer arrives: nothing is switched on before it,
 * so a switch never appears and then disappears when a result card turns out to exist.
 */
type CardsSnapshot = { rows: readonly UiInstanceView[]; loaded: boolean };
const NOT_LOADED: CardsSnapshot = { rows: [], loaded: false }, ALWAYS_LOADED: CardsSnapshot = { rows: [], loaded: true };
type CardsHarness = { uiList(chatId: string): Promise<UiInstanceView[]>; onUiChanged(handler: (event: { chatId: string }) => void): () => void };
const cardsHarness = (): CardsHarness | null => (typeof window !== "undefined" ? ((window as unknown as { agentlas?: { harness?: CardsHarness } }).agentlas?.harness ?? null) : null);
type CardsEntry = { snapshot: CardsSnapshot; listeners: Set<() => void>; stop: () => void };
const cardEntries = new Map<string, CardsEntry>();

export function acquireChatCards(chatId: string, listener: () => void): () => void {
  let entry = cardEntries.get(chatId);
  if (!entry) {
    const api = cardsHarness();
    const made: CardsEntry = { snapshot: api ? NOT_LOADED : ALWAYS_LOADED, listeners: new Set(), stop: () => undefined };
    entry = made;
    cardEntries.set(chatId, made);
    if (api) {
      let alive = true;
      const load = () => {
        api.uiList(chatId).then(rows => {
          if (!alive) return;
          made.snapshot = { rows: rows.filter(row => row.chatId === chatId), loaded: true };
          made.listeners.forEach(notify => notify());
        }).catch(() => undefined); // not read: nothing is switched on for this chat (fails closed)
      };
      load();
      const off = api.onUiChanged(event => { if (event.chatId === chatId) load(); });
      made.stop = () => { alive = false; off(); };
    }
  }
  entry.listeners.add(listener);
  return () => {
    const current = cardEntries.get(chatId);
    if (!current) return;
    current.listeners.delete(listener);
    if (current.listeners.size === 0) { current.stop(); cardEntries.delete(chatId); }
  };
}
export const chatCardsSnapshot = (chatId: string): CardsSnapshot => cardEntries.get(chatId)?.snapshot ?? NOT_LOADED;

function useChatCards(chatId?: string): CardsSnapshot {
  const subscribe = useCallback((listener: () => void) => (chatId ? acquireChatCards(chatId, listener) : () => undefined), [chatId]);
  const read = useCallback(() => (chatId ? chatCardsSnapshot(chatId) : ALWAYS_LOADED), [chatId]);
  return useSyncExternalStore(subscribe, read, () => NOT_LOADED);
}

/** Whether tables and lists of an answer of these turns may offer a card: the cards are read, none of them is a result card of one of these turns, and the answer is not switched off. */
export const answerCardsOn = (cards: CardsSnapshot, turnIds: readonly string[], disabled = false): boolean =>
  !disabled && cards.loaded && !cards.rows.some(row => row.state !== "closed" && turnIds.includes(row.turnId) && isResultCardInstance(row));

/** The same, for a surface that renders the conversation's answers: answers of these turns draw their tables as they are while the cards are not read, and when the turn shows a result card of its own. */
export function AnswerCardsForTurns({ chatId, turnIds, disabled, children }: { chatId?: string; turnIds: readonly string[]; disabled?: boolean; children: ReactNode }) {
  const cards = useChatCards(chatId);
  return <AnswerCardsProvider enabled={answerCardsOn(cards, turnIds, disabled)}>{children}</AnswerCardsProvider>;
}

/**
 * The last block of an answer that is still arriving: it may gain a row, a total, a column, so a table or a list there is drawn as it is until the text stops
 * (the switch would appear, vanish and come back as each row lands, and the table under it would be built again each time). The element is always the same
 * one, so nothing under it is rebuilt when the hold ends.
 */
export function AnswerCardsHold({ hold, children }: { hold: boolean; children: ReactNode }) {
  const parent = useContext(AnswerCardsContext);
  return <AnswerCardsContext.Provider value={parent && !hold}>{children}</AnswerCardsContext.Provider>;
}

type TableBlockData = { header: string[]; align?: unknown[]; rows: string[][] };

/**
 * A table the answer wrote: drawn as it is, with a "table | chart" switch above it when its columns are numbers. The table is what opens, on every surface
 * and at every moment (a table still being written, one that is finished), so the same answer looks the same everywhere and nothing jumps when it ends.
 */
export function TableWithChart({ block, children }: { block: TableBlockData; children: ReactNode }) {
  const enabled = useContext(AnswerCardsContext);
  const { locale } = useT();
  const upgrade = useMemo(() => (enabled ? upgradeTable({ header: block.header, rows: block.rows }) : null), [enabled, block.header, block.rows]);
  const [pick, setPick] = useState<"table" | "chart" | null>(null);
  if (!upgrade || !isUpgrade(upgrade) || upgrade.kind !== "chart") return <>{children}</>;
  const view = pick ?? "table";
  const ko = locale === "ko";
  return (
    <div className={styles.wrap} data-answer-card={upgrade.blocks[0].type}>
      <div className={styles.switch} role="group" aria-label={ko ? "표와 차트 전환" : "Switch between table and chart"}>
        <button type="button" className={styles.option} aria-pressed={view === "table"} onClick={() => setPick("table")}>{ko ? "표" : "Table"}</button>
        <button type="button" className={styles.option} aria-pressed={view === "chart"} onClick={() => setPick("chart")}>{ko ? "차트" : "Chart"}</button>
      </div>
      {view === "chart"
        ? <div className={styles.bare}><FinancePresentBody view={{ kind: "canvas", title: "·", chips: [], sources: [], blocks: upgrade.blocks }} locale={ko ? "ko" : "en"} /></div>
        : children}
    </div>
  );
}

type ListBlockData = { type: "ul" | "ol"; items: { text: string; children?: unknown }[]; start?: number };

/**
 * A numbered list the answer wrote: drawn as it is, with a small chip under it that draws it as steps (and back). Only a short plain list gets the chip. A
 * list of tips has the same shape as a process, so the owner chooses; nothing here turns a list into steps by itself.
 */
export function ListWithSteps({ block, children }: { block: ListBlockData; children: ReactNode }) {
  const enabled = useContext(AnswerCardsContext);
  const { locale } = useT();
  const upgrade = useMemo(() => (enabled && block.type === "ol" ? upgradeSteps({ ordered: true, items: block.items, start: block.start }) : null), [enabled, block.type, block.items, block.start]);
  const [open, setOpen] = useState(false);
  if (!upgrade || !isUpgrade(upgrade)) return <>{children}</>;
  const ko = locale === "ko";
  return (
    <div className={styles.wrap} data-answer-card="process_steps">
      {open ? <div className={styles.bare}><FinancePresentBody view={{ kind: "canvas", title: "·", chips: [], sources: [], blocks: upgrade.blocks }} locale={ko ? "ko" : "en"} /></div> : children}
      <button type="button" className={styles.chip} aria-pressed={open} onClick={() => setOpen(value => !value)}>
        {open ? (ko ? "목록으로 보기" : "Show as list") : (ko ? "단계 카드로 보기" : "Show as steps")}
      </button>
    </div>
  );
}
