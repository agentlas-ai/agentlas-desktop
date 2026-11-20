"use client";

import { useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { focusedSpaceChatId, subscribeSpaceLayout } from "@/lib/space-store";
import { pickDecisionSlot } from "@/lib/composer-decision-target";
import { roomOfChat } from "@/lib/room-children";
import { decisionSlotMaxHeight, findDecisionSlotColumn, measureDecisionSlotRoom } from "@/lib/ask-card-room";

const slots = new Set<HTMLElement>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  const offLayout = subscribeSpaceLayout(listener); // a pane opening or closing changes which conversations have a slot
  return () => { listeners.delete(listener); offLayout(); };
};

/** The conversation a slot belongs to: the one its composer declares, else the Space pane it sits in (`[data-space-chat]`); null = tied to none. */
const chatOfSlot = (slot: HTMLElement): string | null =>
  slot.getAttribute("data-decision-chat") || slot.closest("[data-space-chat]")?.getAttribute("data-space-chat") || null;

/**
 * The slot a card is drawn in (lib/composer-decision-target.ts): its owner conversation's own composer, so with several conversations on screen each
 * pane shows its own card and no other pane's. A card that names no conversation, or whose conversation has no composer here, has no slot:
 * it is drawn where it was written (the app-wide sheet), never above another conversation's input.
 */
const pick = (owner: string | null | undefined): HTMLElement | null => {
  const live = [...slots].filter((slot) => slot.isConnected).map((element) => ({ element, chat: chatOfSlot(element), draft: element.getAttribute("data-decision-draft") === "true" }));
  return pickDecisionSlot(live, owner, { roomOf: (chatId) => roomOfChat(chatId) })?.element ?? null;
};

/**
 * Whatever card sits in a decision box may not push the composer out of its pane: the box is capped by the room its column has
 * (lib/ask-card-room decisionSlotMaxHeight) and scrolls inside. Read only when the column or its children change size, never on a timer.
 */
function useDecisionCap(ref: { current: HTMLElement | null }): void {
  useLayoutEffect(() => {
    const slot = ref.current;
    if (!slot || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const apply = () => {
      frame = 0;
      const column = findDecisionSlotColumn(slot);
      if (!column) { slot.style.removeProperty("max-height"); slot.style.removeProperty("overflow-y"); return; }
      const room = measureDecisionSlotRoom(slot, column);
      const cap = decisionSlotMaxHeight(room.columnHeight, room.otherWithoutSlotHeight);
      if (slot.style.maxHeight !== `${cap}px`) slot.style.maxHeight = `${cap}px`;
      if (slot.style.overflowY !== "auto") slot.style.overflowY = "auto";
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(apply); };
    apply();
    const observer = new ResizeObserver(schedule);
    const column = findDecisionSlotColumn(slot);
    if (column) {
      observer.observe(column.element);
      for (const child of Array.from(column.element.children)) observer.observe(child);
    }
    return () => { observer.disconnect(); if (frame) cancelAnimationFrame(frame); };
  }, [ref]);
}

/** A box for a decision card that does not sit in a composer's slot (the Work conversation's tool approval): the same cap, so it cannot push the composer out either. */
export function CappedDecisionBox({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useDecisionCap(ref);
  return <div ref={ref} data-decision-cap="true">{children}</div>;
}

/** Registration follows composer mount/unmount, without observing every streamed DOM mutation. `chatId` is the conversation this composer belongs to. */
export function ComposerDecisionSlot({ surface, className, chatId, draft }: { surface: "one" | "work"; className?: string; chatId?: string | null; draft?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    slots.add(element); notify();
    return () => { slots.delete(element); notify(); };
  }, []);
  // The composer may be handed another conversation in place; the cards waiting for a slot choose again.
  useLayoutEffect(() => { notify(); }, [chatId]);
  useDecisionCap(ref);
  return <div ref={ref} className={className} data-composer-decisions={surface} data-decision-chat={chatId || undefined} data-decision-draft={draft && !chatId ? "true" : undefined} data-one-composer-decisions={surface === "one" ? "true" : undefined} />;
}

/**
 * Keep requests actionable when switching between One, Work, and conversations. `chatId` is the conversation that asked: the card goes into that
 * conversation's own composer slot. Without it (a card that names no conversation) no slot: it is drawn where it was written.
 */
export function ComposerDecisionPortal({ enabled, chatId, children }: { enabled: boolean; chatId?: string | null; children: ReactNode }) {
  const slot = useSyncExternalStore(subscribe, () => pick(chatId), () => null);
  return enabled && slot ? createPortal(children, slot) : <>{children}</>;
}

/**
 * With several panes on screen a key press belongs to one of them: the pane that holds the focus, else Space's focused pane. A card listening on the
 * whole document asks this first, so Esc or a digit meant for one conversation's question does not also answer another's. Outside Space (one pane,
 * One's page) the card always answers.
 */
export function decisionKeysBelongHere(card: HTMLElement | null, target: EventTarget | null): boolean {
  const mine = card?.closest("[data-space-chat]") ?? null;
  if (!mine) return true;
  const paneOf = (node: unknown): Element | null => (node instanceof Element ? node.closest("[data-space-chat]") : null);
  const holder = paneOf(target) ?? paneOf(document.activeElement);
  if (holder) return holder === mine;
  return mine.getAttribute("data-space-chat") === focusedSpaceChatId();
}
