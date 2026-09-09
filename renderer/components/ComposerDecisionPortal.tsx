"use client";

import { useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";

const slots = new Set<HTMLElement>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => [...slots].filter((slot) => slot.isConnected).at(-1) ?? null;

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
