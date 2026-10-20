// Visible-only polling. Each async read settles before its next interval starts.
// An optional initial read shares the same ownership as timer and visibility refreshes.
"use client";
import { useEffect, useRef } from "react";

export function useVisibleInterval(
  fn: () => void | Promise<unknown>,
  ms: number,
  opts?: { immediate?: boolean; enabled?: boolean; initial?: () => void | Promise<unknown> },
): void {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const immediateRef = useRef(opts?.immediate);
  immediateRef.current = opts?.immediate;
  // Begun reads are not cancelled: callers still fence their async state updates.
  // Preserve ownership across an interval change while an older read settles.
  const inFlight = useRef<Promise<unknown> | null>(null);

  const enabled = opts?.enabled !== false;
  const initial = opts?.initial;
  const initialOwner = useRef(initial);
  useEffect(() => {
    // A new data owner must not wait for an old owner's unresponsive bridge.
    // A period/visibility change keeps ownership of the same ongoing read.
    if (initialOwner.current !== initial) {
      initialOwner.current = initial;
      inFlight.current = null;
    }
    if (!enabled || typeof document === "undefined" || !Number.isFinite(ms) || ms <= 0) return;
    let timer: number | null = null;
    let disposed = false;
    let waiting = false;
    const visible = () => !disposed && document.visibilityState !== "hidden";
    const stop = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
    };
    const schedule = () => {
      stop();
      if (visible()) timer = window.setTimeout(() => { timer = null; void tick(); }, ms);
    };
    const tick = async (callback?: () => void | Promise<unknown>) => {
      if (!visible()) return;
      stop();
      if (inFlight.current) {
        // Focus/visibility bursts collapse into one read after the current one.
        if (!waiting) {
          waiting = true;
          const resume = () => { waiting = false; if (visible()) void tick(callback); };
          void inFlight.current.then(resume, resume);
        }
        return;
      }
      const pending = Promise.resolve().then(() => visible() ? (callback ?? fnRef.current)() : undefined);
      inFlight.current = pending;
      try { await pending; }
      catch { /* The caller owns its error presentation; the next visible tick retries. */ }
      finally {
        if (inFlight.current === pending) inFlight.current = null;
        if (visible()) schedule();
      }
    };
    const onVisibility = () => {
      if (!visible()) stop();
      else if (immediateRef.current !== false) void tick();
      else schedule();
    };
    document.addEventListener("visibilitychange", onVisibility);
    if (initial) void tick(initial);
    else schedule();
    return () => {
      disposed = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [ms, enabled, initial]);
}
