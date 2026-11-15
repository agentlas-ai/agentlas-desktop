// F-D17b H: how Finance writes "when" for the owner - short, no seconds, no year for this year (the confirmed picture desktop-impl-gaps-2, piece H).
//   same calendar day   -> the time                    "11:43 PM"          "오후 11:43"
//   the next day        -> "Tomorrow" + time           "Tomorrow 9:00 AM"  "내일 오전 9:00"      (past: "Yesterday" / "어제")
//   2..6 days away      -> the weekday + time          "Fri 9:00 AM"       "금 오전 9:00"
//   7+ days, this year  -> month and day + time        "Nov 20, 9:00 AM"   "11월 20일 오전 9:00"
//   another year        -> the date alone              "Jan 3, 2027"       "2027년 1월 3일"
// (The relative rows come first, then the year: see the comment at the year check.)
// Day 7 is the same weekday as today, so a bare weekday would be ambiguous: it is written as a date. The days are CALENDAR days in `timeZone`
// (the viewer's own zone unless a test names one), counted from `now`; a time just after midnight is "tomorrow", not "in 1 hour".
// `title` is the full moment for a tooltip. A value that is not a date gives null: the caller keeps its own "unknown" word.
export interface FinanceMoment { text: string; title: string }

const tidy = (value: string): string => value.replace(/[  ]/g, " ");

function dayParts(at: Date, timeZone?: string): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(at);
  const read = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
  return { y: read("year"), m: read("month"), d: read("day") };
}
const dayNumber = ({ y, m, d }: { y: number; m: number; d: number }): number => Date.UTC(y, m - 1, d) / 86_400_000;

export function financeMoment(value: string | number | Date | null | undefined, ko: boolean, now: Date = new Date(), timeZone?: string): FinanceMoment | null {
  if (value === null || value === undefined || value === "") return null;
  const at = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(at.getTime())) return null;
  const locale = ko ? "ko-KR" : "en-US";
  const time = tidy(new Intl.DateTimeFormat(locale, { timeZone, hour: "numeric", minute: "2-digit", hour12: true }).format(at));
  const title = tidy(new Intl.DateTimeFormat(locale, ko
    ? { timeZone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true }
    : { timeZone, dateStyle: "medium", timeStyle: "short" }).format(at));
  const target = dayParts(at, timeZone), today = dayParts(now, timeZone);
  const days = dayNumber(target) - dayNumber(today);
  if (days === 0) return { text: time, title };
  if (days === 1) return { text: `${ko ? "내일" : "Tomorrow"} ${time}`, title };
  if (days === -1) return { text: `${ko ? "어제" : "Yesterday"} ${time}`, title };
  if (Math.abs(days) <= 6) return { text: `${tidy(new Intl.DateTimeFormat(locale, { timeZone, weekday: "short" }).format(at))} ${time}`, title };
  // 7+ days away. Another year: the date alone (no time, no guess about "this year"). The relative words above win over the year, so 00:10 on Jan 1 seen
  // at 23:30 on Dec 31 is "Tomorrow 12:10 AM", not "Jan 1, 2027".
  if (target.y !== today.y) {
    return { text: tidy(new Intl.DateTimeFormat(locale, { timeZone, year: "numeric", month: ko ? "long" : "short", day: "numeric" }).format(at)), title };
  }
  return { text: `${tidy(new Intl.DateTimeFormat(locale, { timeZone, month: ko ? "long" : "short", day: "numeric" }).format(at))}${ko ? " " : ", "}${time}`, title };
}
