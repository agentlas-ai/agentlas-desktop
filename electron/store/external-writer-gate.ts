import type { ExternalChatWatch } from "./external-chat-changes";
import { setExternalWritersPossible } from "./external-writer-presence";

/**
 * The external-change watcher (store/external-chat-changes.ts) is a 400 ms poll, and it has one job: to tell this process that ANOTHER process committed
 * chat rows. The only such process is the background service (Agentlas 2.0 P5-2: store/db.ts is opened by Main and by daemon/main.ts alone; the
 * update continuity worker runs while Main prepares to quit, engine hooks write the memory store, not this one, and the terminal product is closed,).
 * With no service there is nobody to hear, so the poll is not armed: a resting app with no service fires nothing.
 *
 * "On" is the default and the answer to every doubt. The poll stops only when the service is PROVEN gone (nothing listens on its control socket),
 * and starts again at the first sign of one (a protected launch or an attach that found it, a re-attach that succeeded). The watch keeps its cursors
 * while stopped, so a service that came back and wrote before Main noticed is reported by the first tick of the restart: a late answer, never a lost one.
 * No timer here: the gate is called from events (a socket closed, an attach finished) and its one proof is a single connect attempt.
 */
export interface ExternalWriterGate {
  /** A service answered, attached or started: another process may write. */
  servicePresent(): void;
  /** The service may be gone (its control socket closed, a launch or re-attach failed). Resolves true when the poll was stopped. */
  serviceMaybeGone(): Promise<boolean>;
  state(): "on" | "off";
  /**
   * While the poll is stopped: one proof again (a single connect attempt, the same one `serviceMaybeGone` makes) and the poll starts again if a service answers. Called when the owner
   * comes back to a window or the computer wakes (desktop 3, signal B7): a service started by something other than this process (a login item) is found then,
   * not only when this process happens to look for it. Nothing happens while the poll runs, and calls closer than 5 s apart share one proof.
   */
  recheckIfOff(): Promise<boolean>;
}

const RECHECK_MIN_GAP_MS = 5_000;

export function createExternalWriterGate(watch: ExternalChatWatch, confirmAbsent: () => Promise<boolean>, options: { now?: () => number; signals?: ReadonlyArray<(fire: () => void) => () => void> } = {}): ExternalWriterGate {
  let generation = 0, checking: Promise<boolean> | null = null, lastCheckAt = -Infinity;
  const now = options.now ?? Date.now;
  const gate: ExternalWriterGate = {
    servicePresent() {
      generation += 1; // a proof of absence that is still being made is out of date
      watch.start();
      setExternalWritersPossible(true);
    },
    async serviceMaybeGone() {
      const mine = ++generation;
      let absent = false;
      try { absent = await confirmAbsent(); } catch { absent = false; }
      // A service that came back while the proof was made wins: only the newest question may stop the poll.
      if (!absent || mine !== generation) return false;
      // "Possible" goes first: the watch's end then changes nothing for a queue that polls only while a writer may exist and nothing here hears it.
      setExternalWritersPossible(false);
      watch.stop();
      return true;
    },
    state: () => (watch.running() ? "on" : "off"),
    recheckIfOff() {
      if (watch.running()) return Promise.resolve(false);
      if (checking) return checking;
      if (now() - lastCheckAt < RECHECK_MIN_GAP_MS) return Promise.resolve(false);
      lastCheckAt = now();
      const mine = ++generation;
      checking = (async () => {
        let absent = true;
        try { absent = await confirmAbsent(); } catch { absent = true; }
        // Only the newest question counts, and only a poll that is still stopped is started.
        if (absent || mine !== generation || watch.running()) return false;
        gate.servicePresent();
        return true;
      })().finally(() => { checking = null; });
      return checking;
    },
  };
  // The two moments the owner's presence changes: a window comes to the front, the computer wakes. Both are events of the app, never a timer.
  for (const subscribe of options.signals ?? defaultRecheckSignals()) { try { subscribe(() => { void gate.recheckIfOff().catch(() => undefined); }); } catch { /* the next sign of a service starts it */ } }
  return gate;
}

function defaultRecheckSignals(): Array<(fire: () => void) => () => void> {
  try {
    const electron = require("electron") as typeof import("electron"); // eslint-disable-line @typescript-eslint/no-require-imports
    if (!electron || typeof electron !== "object" || typeof electron.app?.on !== "function") return [];
    return [
      (fire) => { electron.app.on("browser-window-focus", fire); return () => { electron.app.removeListener("browser-window-focus", fire); }; },
      (fire) => { try { electron.powerMonitor.on("resume", fire); } catch { /* no power events here */ } return () => { try { electron.powerMonitor.removeListener("resume", fire); } catch { /* never attached */ } }; },
    ];
  } catch { return []; }
}
