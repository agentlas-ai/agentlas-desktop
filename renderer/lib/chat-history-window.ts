/**
 * The slice of a long conversation a pane draws ("이전 N개 · 더 보기" above, "다음 N개 · 더 보기" below).
 *
 * A window that is pinned (the person scrolled, jumped to a prompt, or revealed older rows) used to remember its last row by id.
 * When that row was the newest one at the time, every row that arrived afterwards fell outside the window and hid behind the lower
 * pager: the answer to the next message, the queued messages' answers and the next run's work line were all in the conversation
 * and not on the screen, and the person read it as "no answer". A window that reached the newest row follows the newest row
 * (lastId null); only a window that stops earlier keeps its edge.
 */
export interface HistoryWindow { scope?: string; firstId: string; lastId: string | null }

/** The id to keep as a window's last edge: none when the window already reaches the newest row. */
export function historyWindowLastId(rows: ReadonlyArray<{ id: string }>, end: number): string | null {
  return end >= rows.length ? null : rows[end - 1].id;
}

/** The rows [start, end) a pinned window draws now, or null when its rows are gone (the caller falls back to the newest page). */
export function resolveHistoryWindow(rows: ReadonlyArray<{ id: string }>, window: HistoryWindow | null): { start: number; end: number } | null {
  if (!window) return null;
  const start = rows.findIndex((row) => row.id === window.firstId);
  const last = window.lastId === null ? rows.length - 1 : rows.findIndex((row) => row.id === window.lastId);
  return start >= 0 && last >= start ? { start, end: last + 1 } : null;
}
