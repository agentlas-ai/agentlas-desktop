"use client";
// Personal One only: the switch, the "show instantly" setting and the one CadenceRegistry the screen reads.
// The cut and the pacing live in shared/chat-cadence.ts and renderer/lib/chat-cadence-rows.ts; this file is the React edge.
import { useEffect, useReducer, useRef, useState } from "react";
import { CadenceRegistry, systemCadenceClock } from "./chat-cadence-rows";

/** localStorage: "on" | "off". Anything else follows BUBBLE_CADENCE_DEFAULT_ON. */
export const BUBBLE_CADENCE_KEY = "agentlas.one.bubbleCadence";
/** localStorage: "1" shows every bubble the moment it closes (no gaps, no motion). */
export const BUBBLE_INSTANT_KEY = "agentlas.one.bubbleInstant";
/** The rollout switch: on, after the real screen was checked bubble by bubble (appearance, motion, dots, history anchor, reduced motion, cards, stop). "off" in localStorage turns it back off. */
export const BUBBLE_CADENCE_DEFAULT_ON = true;

export function cadenceFlag(stored: string | null | undefined, fallback: boolean = BUBBLE_CADENCE_DEFAULT_ON): boolean {
  return stored === "on" ? true : stored === "off" ? false : fallback;
}

function readStorage(key: string): string | null {
  try { return typeof window === "undefined" ? null : window.localStorage.getItem(key); } catch { return null; }
}

function systemReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export interface ChatCadenceController {
  enabled: boolean;
  instant: boolean;
  reducedMotion: boolean;
  registry: CadenceRegistry;
  /** Changes whenever a bubble comes out or a session settles: the rows must be derived again. */
  version: number;
  setInstant(value: boolean): void;
  /** The owner's own switch: off draws every reply as one plain message, as before bubbles. Stored, so it survives a restart. */
  setEnabled(value: boolean): void;
}

export function useChatCadence(): ChatCadenceController {
  const [enabled, setEnabledState] = useState(() => cadenceFlag(readStorage(BUBBLE_CADENCE_KEY)));
  const [instant, setInstantState] = useState(() => readStorage(BUBBLE_INSTANT_KEY) === "1");
  const [reducedMotion, setReducedMotion] = useState(systemReducedMotion);
  const [version, bump] = useReducer((value: number) => value + 1, 0);
  const alive = useRef(false);
  const registryRef = useRef<CadenceRegistry | null>(null);
  if (!registryRef.current) {
    registryRef.current = new CadenceRegistry(systemCadenceClock(), () => { if (alive.current) bump(); },
      { instant, reducedMotion }, error => { console.error("chat cadence", error); });
  }
  const registry = registryRef.current;
  registry.setPrefs({ instant, reducedMotion });

  useEffect(() => {
    alive.current = true;
    // A hidden window gets no useful timers and nobody sees the bubbles come out: a complete reply is shown in full. A reply still
    // being written is left alone: its last text is not final, and cutting it would split a sentence into a plain message. Its
    // silence watch also waits: a hidden window gets no frames, so no run events either, and the quiet is not the model's.
    const visibility = () => {
      const hidden = document.visibilityState === "hidden";
      registry.setHidden(hidden);
      if (hidden) registry.flushFinished();
    };
    visibility();
    document.addEventListener("visibilitychange", visibility);
    const media = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
    const motion = () => setReducedMotion(media?.matches === true);
    media?.addEventListener("change", motion);
    // The same setting changed in another window of the app.
    const storage = (event: StorageEvent) => {
      if (event.key === BUBBLE_CADENCE_KEY) setEnabledState(cadenceFlag(event.newValue));
      if (event.key === BUBBLE_INSTANT_KEY) setInstantState(event.newValue === "1");
    };
    window.addEventListener("storage", storage);
    return () => {
      alive.current = false;
      document.removeEventListener("visibilitychange", visibility);
      media?.removeEventListener("change", motion);
      window.removeEventListener("storage", storage);
      registry.dispose();
    };
  }, [registry]);

  // Turned off while a reply is coming out: nothing keeps a timer.
  useEffect(() => { if (!enabled) registry.dispose(); }, [enabled, registry]);

  return {
    enabled, instant, reducedMotion, registry, version,
    setInstant(value) {
      setInstantState(value);
      try { window.localStorage.setItem(BUBBLE_INSTANT_KEY, value ? "1" : "0"); } catch { /* blocked storage: the choice lasts until the window closes */ }
    },
    setEnabled(value) {
      setEnabledState(value);
      try { window.localStorage.setItem(BUBBLE_CADENCE_KEY, value ? "on" : "off"); } catch { /* blocked storage: the choice lasts until the window closes */ }
    },
  };
}
