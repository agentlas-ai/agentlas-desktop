/**
 * The one clock line of a turn: today's date, weekday and time in the owner's time zone.
 *
 * Runtimes that call a model API directly (BYOK, Agentlas serving, the local-model loops) carry no clock of their own, so a model
 * that is not told the date answers "that date is already past" from its training years. The zone is the owner's profile zone
 * (not the machine's: a Windows guest or a remote host often runs UTC while the account lives elsewhere); an unreadable zone
 * falls back to the machine's. Pure: the caller passes the instant.
 */
export function turnClockLine(nowMs: number, timeZone: string | null | undefined): string {
  const usable = (zone: string | null | undefined): string | null => {
    if (!zone || !zone.trim()) return null;
    try { new Intl.DateTimeFormat("en-US", { timeZone: zone.trim() }); return zone.trim(); } catch { return null; }
  };
  const zone = usable(timeZone) ?? usable(Intl.DateTimeFormat().resolvedOptions().timeZone) ?? "UTC";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(nowMs));
  const at = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `now: ${at("year")}-${at("month")}-${at("day")} ${at("weekday")} ${at("hour")}:${at("minute")} (${zone})`;
}
