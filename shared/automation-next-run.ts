/** Present the persisted instant in its schedule's zone, including a zone
 * label. Invalid historical values never appear as a fabricated next run. */
export function formatAutomationNextRun(value: string, timezone: string | null, locale: "ko" | "en"): string {
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) return locale === "ko" ? "시각 확인 필요" : "time unavailable";
  const options: Intl.DateTimeFormatOptions = {
    year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
    ...(timezone ? { timeZone: timezone } : {}),
  };
  const language = locale === "ko" ? "ko-KR" : "en-US";
  try { return new Intl.DateTimeFormat(language, options).format(instant); }
  catch { return new Intl.DateTimeFormat(language, { ...options, timeZone: undefined }).format(instant); }
}
