"use client";

/**
 * The one reader of "what waits for the owner" for the owner window (the line above the composer and the dot on the personal agent's face in the menu). It reads `oneHome.status()` (numbers and closed words only:
 * `mirror.waiting`, `screenControl.active`, `waitingReview`) when the first screen that wants it opens, when the window is focused again and once after the owner's own press. There is no timer, and any number of
 * screens share ONE read at a time. Nothing here can hold a word of an item: the owner window is never given one.
 * Draws nothing (null) for a bridge with no `oneHome`, a closed server switch (`available: false`) and an older Main that does not carry the numbers.
 */
import { useEffect, useState } from "react";
import { ipc } from "@/lib/ipc";
import type { WaitingLineInput } from "@/lib/waiting-review";

export type WaitingSnapshot = Pick<WaitingLineInput, "waiting" | "screenActive" | "failed" | "result">;
let snapshot: WaitingSnapshot | null = null;
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;
let bound = false;

export function readWaitingNow(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    const api = ipc()?.oneHome;
    let next: WaitingSnapshot | null = null;
    if (api?.status) {
      try {
        const st = await api.status();
        const n = typeof st?.mirror?.waiting === "number" && Number.isFinite(st.mirror.waiting) ? Math.max(0, Math.floor(st.mirror.waiting)) : 0;
        next = st?.available ? { waiting: n, screenActive: st.screenControl?.active === true, failed: st.waitingReview?.failed ?? null, result: st.waitingReview?.result ?? null } : null;
      } catch { next = null; }
    }
    snapshot = next;
    for (const f of [...listeners]) f();
  })().finally(() => { inflight = null; });
  return inflight;
}
const onFocus = (): void => { void readWaitingNow(); };
function bind(): void { if (bound || typeof window === "undefined") return; bound = true; window.addEventListener("focus", onFocus); }
function unbind(): void { if (!bound || listeners.size > 0 || typeof window === "undefined") return; bound = false; window.removeEventListener("focus", onFocus); }

export function useWaitingSnapshot(): { snapshot: WaitingSnapshot | null; reload: () => Promise<void> } {
  const [, tick] = useState(0);
  useEffect(() => {
    const f = () => tick((n) => n + 1);
    listeners.add(f); bind(); void readWaitingNow();
    return () => { listeners.delete(f); unbind(); };
  }, []);
  return { snapshot, reload: readWaitingNow };
}
