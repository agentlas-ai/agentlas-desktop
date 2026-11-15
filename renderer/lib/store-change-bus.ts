"use client";

import { ipcEvents } from "@/lib/ipc";

/*
 * One subscription to Main's `store:changed` broadcast for any number of panes and strips. Four Space panes each
 * listening would be four handlers on one channel; this keeps it at one while anyone listens, and none otherwise.
 */
export interface StoreChange { entity: string; id?: string }
const listeners = new Set<(change: StoreChange) => void>();
let off: (() => void) | null = null;

export function subscribeStoreChanges(listener: (change: StoreChange) => void): () => void {
  listeners.add(listener);
  if (!off) off = ipcEvents()?.onStoreChanged?.((change) => { for (const item of [...listeners]) item(change); }) ?? null;
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && off) { off(); off = null; }
  };
}
