// Agentlas Reach: the one place the Settings switch tells the Reach service that the owner flipped it. The service registers a
// listener when it starts; with none registered (the service is not running in this process) the switch is still stored and the
// service reads the stored value when it starts. No Electron import, so any host can load it.
export type ReachExploreListener = (enabled: boolean) => void | Promise<void>;

let listener: ReachExploreListener | null = null;

export function setReachExploreListener(fn: ReachExploreListener | null): void {
  listener = fn;
}

/** Called after the switch is stored. A listener that throws never undoes the owner's switch. */
export function notifyReachExploreChanged(enabled: boolean): void {
  // A listener that fails (throws, or returns a promise that rejects) never undoes the stored switch; the service reads it again
  // on its next pass.
  try {
    const pending = listener?.(enabled);
    if (pending && typeof pending.then === "function") pending.then(undefined, () => {});
  } catch { /* see above */ }
}
