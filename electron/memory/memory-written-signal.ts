// "Memory was written in this process": the signal the unattended memory jobs (dreaming, the English migration, the
// learning proposer) start from, instead of looking on a timer. Writers call notifyMemoryWritten after they commit.
const listeners = new Set<() => void>();

/** Calls `listener` after each commit that wrote or merged memory in this process. Returns the unsubscribe. */
export function onMemoryWritten(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function notifyMemoryWritten(): void {
  for (const listener of [...listeners]) {
    try { listener(); } catch { /* A listener cannot fail the write that raised it. */ }
  }
  notifyMemoryRowsChanged();
}

// TG (Agentlas 2.0): "a Personal line was written, replaced or forgotten in this process" - the signal the personal agent's mirror (one/home-mirror.ts) starts from.
// Separate from the one above on purpose: the unattended memory jobs must not wake for a forget, and the mirror must (a forgotten line is told to the server). A listener only
// RUNS the mirror, which finds what changed by comparing the store with its own record; nothing about the line travels through here.
const rowListeners = new Set<() => void>();
export function onMemoryRowsChanged(listener: () => void): () => void {
  rowListeners.add(listener);
  return () => { rowListeners.delete(listener); };
}
export function notifyMemoryRowsChanged(): void {
  for (const listener of [...rowListeners]) {
    try { listener(); } catch { /* A listener cannot fail the write that raised it. */ }
  }
}
