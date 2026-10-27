import type { CanonicalTask } from "./types";

/**
 * Keep existing project work visible; unassigned work needs an authoritative chat surface. A room the personal agent runs
 * is reached from the personal agent, not from the Work lists (owner 2026-10-27; Main's supervisedByPersonalAgent).
 */
export function isVisibleWorkTask(task: CanonicalTask): boolean {
  return Boolean(task.originChatId && !task.archivedAt && task.status !== "archived"
    && (task.projectId || task.originSurface === "work") && task.supervisedByPersonalAgent !== true);
}

export function workTaskHref(task: CanonicalTask): string {
  const base = `/workspace/task?id=${encodeURIComponent(task.originChatId ?? "")}&task=${encodeURIComponent(task.id)}`;
  return task.projectId ? `${base}&projectId=${encodeURIComponent(task.projectId)}` : base;
}
