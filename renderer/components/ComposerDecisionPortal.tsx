"use client";

import { useLayoutEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Put transient decisions in the visible composer's stack without changing their lifecycle. */
export function ComposerDecisionPortal({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!enabled) { setSlot(null); return; }
    setSlot(document.querySelector<HTMLElement>("[data-one-composer-decisions]"));
  }, [enabled]);
  return enabled && slot ? createPortal(children, slot) : <>{children}</>;
}
