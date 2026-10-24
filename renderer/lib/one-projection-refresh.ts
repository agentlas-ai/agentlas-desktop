/**
 * When the One home's 5 s poll re-reads the task projections (perf review 2026-10-17, R-05).
 *
 * Each read costs two IPCs per projection plus a task list (about 92 IPCs for 46 projections), and nearly every idle
 * tick found nothing new. The poll now re-reads them only when something that feeds them moved: a store change about
 * tasks, chats, long runs, taskforces or automations; the active chats or pending confirmations read in the same tick;
 * the profile or locale; or the last read is older than maxAgeMs. Every other refresh (focus, settle, an owner action)
 * still re-reads them at once.
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
