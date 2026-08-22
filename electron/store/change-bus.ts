/**
 * Process-local invalidation bus for projections that mirror Desktop stores.
 *
 * Payloads deliberately contain only an entity kind and opaque id. Store rows,
 * prompts, paths, credentials, and user-authored text never cross this bus.
 * Consumers must re-read the authoritative store after the current mutation
 * commits instead of treating this notification as data.
 */
export type DesktopStoreEntity =
  | "agent"
  | "firm"
  | "project"
  | "chat"
  | "task"
  | "one-profile"
  | "one-org"
  | "one-taskforce"
  | "automation";

export interface DesktopStoreChange {
  entity: DesktopStoreEntity;
  id?: string;
}

type DesktopStoreChangeListener = (change: DesktopStoreChange) => void;

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
  for (const listener of listeners) {
    try {
      listener(safeChange);
    } catch {
      // A projection listener must never roll back or interrupt the source write.
    }
  }
}
