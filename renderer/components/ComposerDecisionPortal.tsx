"use client";

import { useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { focusedSpaceChatId, subscribeSpaceLayout } from "@/lib/space-store";

const slots = new Set<HTMLElement>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  const offLayout = subscribeSpaceLayout(listener); // the focused Space pane decides which composer a card lands in
  return () => { listeners.delete(listener); offLayout(); };
};
/**
 * The newest connected slot - except in Space, where several composers are on screen: the slot inside the focused
 * pane (`[data-space-chat]` = its chat id) wins, so a card lands next to the conversation the person is typing in.
 */
const snapshot = () => {
  const live = [...slots].filter((slot) => slot.isConnected);
  const focus = live.length > 1 ? focusedSpaceChatId() : null;
  if (focus) {
    const inFocus = live.filter((slot) => slot.closest("[data-space-chat]")?.getAttribute("data-space-chat") === focus).at(-1);
    if (inFocus) return inFocus;
  }
  return live.at(-1) ?? null;
};

/** Registration follows composer mount/unmount, without observing every streamed DOM mutation. */
export function ComposerDecisionSlot({ surface, className }: { surface: "one" | "work"; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    slots.add(element); notify();
    return () => { slots.delete(element); notify(); };
  }, []);
  return <div ref={ref} className={className} data-composer-decisions={surface} data-one-composer-decisions={surface === "one" ? "true" : undefined} />;
}

/** Keep requests actionable when switching between One, Work, and conversations. */
export function ComposerDecisionPortal({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const slot = useSyncExternalStore(subscribe, snapshot, () => null);
  return enabled && slot ? createPortal(children, slot) : <>{children}</>;
}
