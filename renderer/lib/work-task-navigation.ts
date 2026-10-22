import type { CanonicalTask } from "./types";

/** Keep existing project work visible; unassigned work needs an authoritative chat surface. */
export function isVisibleWorkTask(task: CanonicalTask): boolean {
  return Boolean(task.originChatId && !task.archivedAt && task.status !== "archived"
    && (task.projectId || task.originSurface === "work"));
}

export function workTaskHref(task: CanonicalTask): string {
  const base = `/workspace/task?id=${encodeURIComponent(task.originChatId ?? "")}&task=${encodeURIComponent(task.id)}`;
  return task.projectId ? `${base}&projectId=${encodeURIComponent(task.projectId)}` : base;
}
