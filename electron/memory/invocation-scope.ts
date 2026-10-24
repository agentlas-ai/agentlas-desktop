import { workingSessionScope } from "../runtime/session-scope";
import type Database from "better-sqlite3";

export interface AssignedTargetMemoryBoundary {
  readonly kind: "assigned-target";
  readonly scopeKey: string;
  assertCurrent(): void;
}
const boundaries = new WeakSet<AssignedTargetMemoryBoundary>();
export function assertAssignedTargetMemoryBoundary(boundary: AssignedTargetMemoryBoundary): void {
  if (!boundaries.has(boundary)) throw new Error("assigned_target_memory_host_binding_required");
  boundary.assertCurrent();
}
/** Host facts only. A prompt role, actor alias, or copied DTO cannot mint this
 * boundary; both the immutable working scope and actual chat actor are read. */
export function captureAssignedTargetMemoryBoundary(db: Pick<Database.Database, "prepare">, input: {
  chatId: string; agentId: string; review?: { projectId: string; assertCurrent(): void };
}): AssignedTargetMemoryBoundary | null {
  const read = () => {
    const scope = workingSessionScope(db, input.chatId);
    const row = db.prepare("SELECT agent_id FROM chats WHERE id=?").get(input.chatId) as { agent_id: string | null } | undefined;
    if (!input.review && !scope?.subSessionId) return null;
    input.review?.assertCurrent();
    if (!row || row.agent_id !== input.agentId || (input.review && scope && scope.projectId !== input.review.projectId))
      throw new Error("assigned_target_memory_scope_changed");
    return input.review ? `assigned-review:${input.review.projectId}:${input.chatId}:${input.agentId}`
      : `assigned-work:${scope!.projectId}:${scope!.subSessionId}:${input.agentId}`;
  };
  const scopeKey = read(); if (!scopeKey) return null;
  const boundary: AssignedTargetMemoryBoundary = Object.freeze({ kind: "assigned-target", scopeKey,
    assertCurrent() { if (read() !== scopeKey) throw new Error("assigned_target_memory_scope_changed"); } });
  boundaries.add(boundary); return boundary;
}

/** Recall and curation follow the executing actor, not the storage chat's UI owner. */
export function invocationMemoryScope(
  context: { source: string; science?: { projectId: string; researchDirectorAgentId: string } } | undefined,
  chatAgentId: string,
  desktopProjectId: string | null,
  /** Canonical project returned by Main's opaque criterion-review authority. */
  resolvedReviewScope?: { projectId: string },
  boundary?: AssignedTargetMemoryBoundary | null,
): { agentId: string | null; projectId: string | null; boundary?: AssignedTargetMemoryBoundary } {
  if (boundary) assertAssignedTargetMemoryBoundary(boundary);
  if (context?.source === "science") return {
    // Science context keeps the Director's package pins even when a helper
    // executes. Main has already bound and authenticated the actual actor;
    // recall and curation follow that same actor as every other surface.
    agentId: context.science || resolvedReviewScope ? chatAgentId : null,
    projectId: context.science?.projectId ?? resolvedReviewScope?.projectId ?? null,
    ...(boundary ? { boundary } : {}),
  };
  return { agentId: chatAgentId, projectId: desktopProjectId, ...(boundary ? { boundary } : {}) };
}
