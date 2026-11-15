// Where an OS notification click takes the person, and how a live toast stays clickable.
//
// Owner decision 2026-10-24 (Windows audit ui.md #12, "알림이 생긴 곳"): a click opens the place the
// notification came from. A Work run alert opens that Work room in the main window; a One
// notification opens One. Until then every run alert opened the One companion, even for a Work run.
//
// Windows also drops a toast's click handler when the JavaScript Notification object is garbage
// collected (nothing kept a reference: run-alerts.ts and main.ts created locals). Live toasts are
// kept here until they are clicked, closed or fail.
//
// Pure, no Electron import: scripts/test-windows-shell-integration.cjs drives it in plain Node.

export type NotificationClickTarget =
  | { kind: "one"; chatId?: string; taskId?: string }
  | { kind: "work-room"; chatId: string; route: string };

/**
 * The screen address that opens a conversation's tab in Home's Space: the same place the left list opens it.
 * Space reads `open`, opens (or brings forward) the tab and removes the parameter. Work chats and Agent Chat rooms alike.
 */
export function workRoomRoute(chatId: string): string {
  return `/workspace?open=${encodeURIComponent(chatId)}`;
}

/**
 * `originSurface` is the chat's stored origin (store/chats.ts chatOriginSurface): "work" opens its tab in Space, "room" (an
 * Agent Chat room of an agent, solo or group) opens its tab in Space too, "one" (the personal agent's own conversation) opens
 * One. An unknown chat (deleted, or no chat at all) opens One, as before.
 */
export function notificationClickTarget(input: {
  chatId?: string | null;
  taskId?: string | null;
  originSurface: "one" | "work" | "room" | null;
}): NotificationClickTarget {
  const chatId = typeof input.chatId === "string" && input.chatId.trim() ? input.chatId : undefined;
  const taskId = typeof input.taskId === "string" && input.taskId.trim() ? input.taskId : undefined;
  if (chatId && (input.originSurface === "work" || input.originSurface === "room")) return { kind: "work-room", chatId, route: workRoomRoute(chatId) };
  return { kind: "one", ...(chatId ? { chatId } : {}), ...(taskId ? { taskId } : {}) };
}

/** The part of an Electron Notification this file reads. */
export interface RetainableNotification {
  on(event: "click" | "close" | "failed", listener: (...args: unknown[]) => void): unknown;
}

const live = new Set<RetainableNotification>();
const LIVE_LIMIT = 64;

/** Keep a reference until the toast is clicked, closed or failed (Windows GC drops click handlers). */
export function retainNotification<T extends RetainableNotification>(notification: T): T {
  live.add(notification);
  if (live.size > LIVE_LIMIT) live.delete(live.values().next().value as RetainableNotification);
  const release = () => { live.delete(notification); };
  notification.on("click", release);
  notification.on("close", release);
  notification.on("failed", release);
  return notification;
}

export function liveNotificationCount(): number {
  return live.size;
}
