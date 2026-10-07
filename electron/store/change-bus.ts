import type Database from "better-sqlite3";
/**
 * Process-local invalidation bus for projections that mirror Desktop stores.
 *
 * Payloads deliberately contain only an entity kind and opaque id. Store rows,
 * prompts, paths, credentials, and user-authored text never cross this bus.
 * Consumers must re-read the authoritative store after the current mutation
 * commits instead of treating this notification as data.
 */
export type DesktopStoreEntity =
  | "capability-grant"
  | "agent"
  | "firm"
  | "project"
  | "chat"
  | "task"
  | "one-profile"
  | "one-org"
  | "one-taskforce"
  | "long-run"
  | "automation"
  | "runtime"
  | "surface";

export interface DesktopStoreChange {
  entity: DesktopStoreEntity;
  id?: string;
}

type DesktopStoreChangeListener = (change: DesktopStoreChange) => void;

const deferredChanges: DesktopStoreChange[][] = [];

/** Own the synchronous SQLite commit as well as its projection notifications.
 * Nested savepoint failures discard their changes; only the outer commit emits.
 * An unrelated outer transaction must opt in rather than emit before its commit. */
export function desktopStoreTransaction<T>(db: Database.Database, body: () => T): { (): T; immediate(): T } {
  const execute = (immediate: boolean): T => {
    if (db.inTransaction && !deferredChanges.length) throw new Error("store_change_outer_transaction_unowned");
    if (body.constructor.name === "AsyncFunction") throw new Error("store_change_async_transaction");
    const changes: DesktopStoreChange[] = [];
    deferredChanges.push(changes);
    let value: T;
    try {
      const transaction = db.transaction(() => {
        const result = body();
        if (result && typeof (result as { then?: unknown }).then === "function") throw new Error("store_change_async_transaction");
        return result;
      });
      value = immediate ? transaction.immediate() : transaction();
    } catch (error) { deferredChanges.pop(); throw error; }
    deferredChanges.pop();
    const parent = deferredChanges[deferredChanges.length - 1];
    if (parent) parent.push(...changes);
    else {
      const unique = new Map(changes.map(change => [JSON.stringify(change), change]));
      for (const change of unique.values()) emitDesktopStoreChange(change);
    }
    return value;
  };
  return Object.assign(() => execute(false), { immediate: () => execute(true) });
}

const listeners = new Set<DesktopStoreChangeListener>();

export function onDesktopStoreChange(listener: DesktopStoreChangeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitDesktopStoreChange(change: DesktopStoreChange): void {
  const safeChange: DesktopStoreChange = {
    entity: change.entity,
    ...(typeof change.id === "string" && change.id.length > 0 && change.id.length <= 256
      ? { id: change.id }
      : {}),
  };
  const pending = deferredChanges[deferredChanges.length - 1];
  if (pending) { pending.push(safeChange); return; }
  for (const listener of listeners) {
    try {
      listener(safeChange);
    } catch {
      // A projection listener must never roll back or interrupt the source write.
    }
  }
}
