/** Content-free invalidation shared by Electron IPC and the authenticated Mobile projection. */
export interface GoalControlChange {
  kind: "alive" | "agi-limits";
  surface?: "one" | "work";
  chatId?: string;
  scopeId?: string;
}
const listeners = new Set<(change: GoalControlChange) => void>();
export function onGoalControlChange(listener: (change: GoalControlChange) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function emitGoalControlChange(change: GoalControlChange): void {
  for (const listener of listeners) {
    try { listener(change); } catch { /* A projection must never interrupt a committed owner edit. */ }
  }
}
