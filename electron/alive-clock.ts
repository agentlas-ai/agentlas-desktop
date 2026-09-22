/** App-owned clock shared by autonomous agents; a playground supplies work, not time. */
const timers = new Map<string, ReturnType<typeof setInterval>>();

export const desktopAliveClock = {
  schedule(input: { ownerId: string; intervalMs: number; onBeat: () => void }): () => void {
    if (!/^[a-z][a-z0-9._-]{2,119}$/.test(input.ownerId)
      || !Number.isSafeInteger(input.intervalMs) || input.intervalMs < 1_000
      || input.intervalMs > 24 * 60 * 60 * 1_000 || typeof input.onBeat !== "function") {
      throw new Error("alive-clock-registration-invalid");
    }
    if (timers.has(input.ownerId)) throw new Error("alive-clock-owner-already-scheduled");
    const timer = setInterval(() => {
      try { input.onBeat(); }
      catch (error) { console.warn(`[alive-clock] ${input.ownerId} beat failed`, error); }
    }, input.intervalMs);
    timer.unref?.();
    timers.set(input.ownerId, timer);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (timers.get(input.ownerId) === timer) timers.delete(input.ownerId);
      clearInterval(timer);
    };
  },
};
