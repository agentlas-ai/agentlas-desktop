/*
 * "Another process wrote memory" -> the mirror's existing "memory" signal (Agentlas 2.0 E2E-2 follow-up).
 *
 * The background service hosts the personal agent's turns, and the curator that writes the Personal lines after a turn (memory_ticket -> curateEvents, turn-tools/control-server.ts) runs in THAT process. Its
 * `notifyMemoryWritten` / `notifyMemoryRowsChanged` (memory/memory-written-signal.ts) are process-local, so the mirror in Main (home.ts `onMemoryRowsChanged`) never heard a line the service wrote: it waited for
 * the next unrelated signal. The same root as the turn end (one/personal-request-ends.ts).
 *
 * What is read: the memory store's own write mark (`memory_store_meta.revision`, bumped by the store's triggers in every process; the mark the mirror already keeps its `settledMark` by). When Main's data_version
 * watch hears another process commit (`onExternalWrite`) the mark is read once; when it differs from the one kept here, the listeners run once. This process's own writes already signal through
 * `onMemoryRowsChanged`, so that signal only moves the kept mark (it never raises this one): one signal per write, never two. No timer, no stored column, the mark lives in memory. Only the mirror listens to this
 * (the unattended memory jobs - dreaming, the learning proposer - listen to `onMemoryWritten` and are NOT woken by another process's write: they run in the process that wrote).
 * A foreign write of another scope (a project or an agent's memory) moves the mark too: the mirror runs once, finds nothing of the Personal lines changed (it compares with its own record) and sends nothing.
 */
export interface ForeignMemoryRowsPorts {
  /** The store's write mark, or null when it cannot be read now (another owner, a closing store). */
  mark(): string | null;
  /** Another process committed (Main's data_version watch). Returns the unsubscribe. */
  onExternalWrite(listener: () => void): () => void;
  /** This process wrote Personal memory (`onMemoryRowsChanged`). Returns the unsubscribe. */
  onOwnWrite(listener: () => void): () => void;
}
export interface ForeignMemoryRows {
  start(): void;
  stop(): void;
  onChanged(listener: () => void): () => void;
  running(): boolean;
}

export function createForeignMemoryRows(ports: ForeignMemoryRowsPorts): ForeignMemoryRows {
  const listeners = new Set<() => void>();
  let kept: string | null = null;
  let stops: Array<() => void> = [];
  const read = (): string | null => { try { return ports.mark(); } catch { return null; } };
  return {
    start() {
      if (stops.length) return;
      kept = read();
      stops = [
        // this process's own write: its own signal runs the mirror; only the kept mark moves
        ports.onOwnWrite(() => { const m = read(); if (m !== null) kept = m; }),
        ports.onExternalWrite(() => {
          const m = read();
          if (m === null) return;
          if (kept === null) { kept = m; return; }   // not readable at start: the first readable moment takes the mark
          if (m === kept) return;
          kept = m;
          for (const listener of [...listeners]) { try { listener(); } catch { /* a listener never decides for the others */ } }
        }),
      ];
    },
    stop() { for (const stop of stops) { try { stop(); } catch { /* already gone */ } } stops = []; },
    onChanged(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    running: () => stops.length > 0,
  };
}

let shared: ForeignMemoryRows | null = null;
/** The Main process's one watch over the real stores. Created on first use; `start()` is idempotent. */
export function foreignMemoryRows(): ForeignMemoryRows {
  return shared ??= createForeignMemoryRows({
    mark: () => {
      const row = (require("../memory/database") as typeof import("../memory/database")).getMemoryDb()
        .prepare("SELECT value FROM memory_store_meta WHERE key='revision'").get() as { value?: unknown } | undefined;
      return row?.value === undefined || row.value === null ? "0" : String(row.value);
    },
    onExternalWrite: (listener) => (require("../store/external-writer-presence") as typeof import("../store/external-writer-presence")).onExternalWrite(listener),
    onOwnWrite: (listener) => (require("../memory/memory-written-signal") as typeof import("../memory/memory-written-signal")).onMemoryRowsChanged(listener),
  });
}
