/**
 * A wait's due time for a person: always with its day unless it is today. A bare clock time ("오전 9:00:00") cannot say whether it is
 * this morning or tomorrow's, and a reminder asked for "tomorrow 9" read as already due.
 */
export function waitTimeLabel(iso: string | null | undefined, locale: "ko" | "en", now: Date = new Date()): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return null;
  const tag = locale === "ko" ? "ko-KR" : "en-US";
  const clock = at.toLocaleTimeString(tag, { hour: "numeric", minute: "2-digit" });
  const startOfDay = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((startOfDay(at) - startOfDay(now)) / 86_400_000);
  if (days === 0) return clock;
  if (days === 1) return `${locale === "ko" ? "내일" : "Tomorrow"} ${clock}`;
  const date = at.toLocaleDateString(tag, { month: "long", day: "numeric", ...(at.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
  return `${date} ${clock}`;
}
