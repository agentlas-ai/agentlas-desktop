/**







 */

export const PROJECTION_MAX_AGE_MS = 30_000;
/** Store-change entities that can move a One task projection. Daemon writes reach Main's watcher as `chat`. */
export const PROJECTION_DIRTY_ENTITIES: ReadonlySet<string> = new Set(["task", "chat", "long-run", "one-taskforce", "automation"]);

export interface ProjectionRefreshInput {
  dirty: boolean;
  /** When the projections were last read; null before the first read. */
  lastAt: number | null;
  now: number;
  activeChanged: boolean;
  pendingChanged: boolean;
  /** Profile or locale changed. */
  contextChanged: boolean;
  maxAgeMs?: number;
}

export function needsProjectionRefresh(input: ProjectionRefreshInput): boolean {
  if (input.lastAt === null) return true;
  if (input.dirty || input.activeChanged || input.pendingChanged || input.contextChanged) return true;
  return input.now - input.lastAt >= (input.maxAgeMs ?? PROJECTION_MAX_AGE_MS);
}
