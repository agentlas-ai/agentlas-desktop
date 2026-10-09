/** A collapsed window follows the live tail; an opened window retains its oldest visible ID. */
export function oneHistoryWindowStart(
  ids: readonly string[],
  oldestVisibleId: string | null,
  pageSize = 40,
): number {
  const anchor = oldestVisibleId == null ? -1 : ids.indexOf(oldestVisibleId);
  if (anchor >= 0) return anchor;
  const size = Number.isFinite(pageSize) ? Math.max(1, Math.floor(pageSize)) : 40;
  return Math.max(0, ids.length - size);
}

/** Reveal a bounded earlier page explicitly; null means no earlier history exists. */
export function revealOneHistoryPage(ids: readonly string[], start: number, pageSize = 40): string | null {
  if (!ids.length || start <= 0 || !Number.isFinite(start)) return null;
  const size = Number.isFinite(pageSize) ? Math.max(1, Math.floor(pageSize)) : 40;
  return ids[Math.max(0, Math.min(ids.length, Math.floor(start)) - size)] ?? null;
}
