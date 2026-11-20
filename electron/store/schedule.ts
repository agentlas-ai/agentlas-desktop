// 스케줄 트리거 핵심 — 저장 문자열 / 문법 / 표시를 분리한다(설계 §2.1).
// 내부 진실은 ScheduleSpec discriminated union 하나이며, 모든 저작 경로(프리셋·cron·
// 시간피커·챗 NL·레거시 토큰)가 이 spec으로 컴파일된다. next-run 계산은 croner에 위임해
// IANA 타임존/DST 수학을 직접 구현하지 않는다(설계 §2.2, §2.4).
import { Cron } from "croner";
import type { ScheduleSpec } from "../../shared/types";

/** 호스트의 IANA 타임존(예: "Asia/Seoul"). 생성 시 기본값으로 저장. */
export function defaultTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * spec 기준 from 이후 다음 실행 시각(ISO UTC). 미래 발생이 없으면 null(종료 상태).
 * - cron: croner가 tz/DST 처리. 미래 매치 없으면 null.
 * - interval(wallclock): 그리드 정렬(드리프트 수정, 설계 한계 #1).
 * - interval(lastRun): from + everyMs 드리프트(레거시 동작 보존).
 * - once: atIso가 미래면 그대로, 아니면 null.
 * - manual: 항상 null(트리거 전용, 시계 없음).
 */
export function nextRun(spec: ScheduleSpec, from: Date = new Date()): string | null {
  switch (spec.kind) {
    case "cron": {
      try {
        const cron = new Cron(spec.expr, { timezone: spec.tz });
        if (!cronHasFilters(spec)) {
          const next = cron.nextRun(from);
          return next ? next.toISOString() : null;
        }
        // Slots the cron yields that the filters (every Nth week, skipped dates) remove are walked past. The walk is bounded: a filter that
        // removes every slot in two years of them (a skipped list covering them all) ends the schedule instead of spinning.
        let cursor = from;
        for (let guard = 0; guard < CRON_FILTER_WALK; guard += 1) {
          const next = cron.nextRun(cursor);
          if (!next) return null;
          // Past the last day nothing will ever run again: stop walking (the job ends: the scheduler turns a job with no next run off).
          if (spec.until && localDateIn(next, spec.tz) > spec.until) return null;
          if (cronSlotAllowed(spec, next)) return next.toISOString();
          cursor = next;
        }
        return null;
      } catch {
        return null;
      }
    }
    case "interval": {
      const every = spec.everyMs;
      if (!Number.isFinite(every) || every <= 0) return null;
      if (spec.anchor === "wallclock") {
        const aligned = Math.ceil((from.getTime() + 1) / every) * every;
        return new Date(aligned).toISOString();
      }
      return new Date(from.getTime() + every).toISOString();
    }
    case "once":
      return Date.parse(spec.atIso) > from.getTime() ? new Date(spec.atIso).toISOString() : null;
    case "manual":
      return null;
    default:
      return null;
  }
}

/** How many cron slots one nextRun may walk past while the filters remove them (every 52nd week of a daily cron is 51*7 = 357 slots). */
const CRON_FILTER_WALK = 800;
/** A skipDates list longer than this is refused when it is read from a model (a year of public holidays is ~20; a list of hundreds is not a list a person made). */
export const SKIP_DATES_MAX = 100;
export const EVERY_WEEKS_MAX = 52;

export function cronHasFilters(spec: { everyWeeks?: unknown; skipDates?: unknown; until?: unknown }): boolean {
  return !!spec.everyWeeks || typeof spec.until === "string" || (Array.isArray(spec.skipDates) && spec.skipDates.length > 0);
}

/** The local calendar date (YYYY-MM-DD) of an instant in a zone. */
export function localDateIn(at: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** Days since 1970-01-01 of a YYYY-MM-DD date, counted on the calendar (no zone, no DST). */
function dayNumber(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Math.floor(Date.UTC(y, (m || 1) - 1, d || 1) / 86_400_000);
}
/** Monday-start week index of a calendar date (1970-01-01 was a Thursday; day 4 = Monday 1970-01-05). */
function weekIndex(date: string): number {
  return Math.floor((dayNumber(date) - 4) / 7);
}

/** Does the cron slot `at` pass the spec's filters? (every Nth week from a date, skipped dates) */
export function cronSlotAllowed(spec: { tz: string; everyWeeks?: { every: number; from: string }; skipDates?: string[]; until?: string }, at: Date): boolean {
  const local = localDateIn(at, spec.tz);
  if (spec.until && local > spec.until) return false;
  if (spec.skipDates?.includes(local)) return false;
  const weeks = spec.everyWeeks;
  if (weeks) {
    if (local < weeks.from) return false;
    if ((weekIndex(local) - weekIndex(weeks.from)) % Math.max(1, weeks.every) !== 0) return false;
  }
  return true;
}

/** "YYYY-MM-DD" that is a real calendar date. */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** cron 표현식이 croner로 파싱 가능한지 검증(UI 라이브 검증 + insert 전 게이트). */
export function validateCron(expr: string): boolean {
  const trimmed = (expr || "").trim();
  if (!trimmed) return false;
  try {
    // 생성만으로 파싱 유효성 확인. 미래 매치 유무는 별개(nextRun에서 null 처리).
    new Cron(trimmed);
    return true;
  } catch {
    return false;
  }
}

const DOW: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/**
 * 레거시 하이픈 토큰(6종)을 ScheduleSpec으로 매핑한다. 기존 자동화가 계속 발사되도록
 * "daily-09:00" 같은 문자열을 cron/interval spec으로 승격한다(설계 §2.1 표).
 * - hourly           → interval 1h lastRun(레거시 드리프트 동작 보존 — 토큰에 분 정보가 없어 cron 고정 불가)
 * - every-Nm/every-Nh→ interval lastRun(레거시 드리프트 동작 보존)
 * - daily-HH:MM      → cron "M H * * *"
 * - weekday-HH:MM    → cron "M H * * 1-5"
 * - weekly-<dow>-HH:MM → cron "M H * * <dow#>"
 * - monthly-<day>-HH:MM → cron "M H <day> * *"
 * 알 수 없는 토큰은 null(호출부가 24h 폴백 등을 결정).
 */
export function parseLegacyToken(token: string, tz: string): ScheduleSpec | null {
  const parts = (token || "").split("-");
  const kind = parts[0];
  const time = parts[parts.length - 1] || "09:00";

  if (kind === "hourly") {
    return { kind: "interval", everyMs: 60 * 60 * 1000, anchor: "lastRun" };
  }
  if (kind === "every") {
    const raw = parts[1] ?? "";
    const match = raw.match(/^(\d+)(m|h)$/);
    if (match) {
      const amount = parseInt(match[1], 10);
      if (amount > 0) {
        const minutes = match[2] === "h" ? amount * 60 : amount;
        return { kind: "interval", everyMs: minutes * 60 * 1000, anchor: "lastRun" };
      }
    }
    return null;
  }

  const [hh, mm] = time.split(":").map((n) => parseInt(n, 10));
  if (Number.isNaN(hh) || Number.isNaN(mm)) return null;

  if (kind === "daily") {
    return { kind: "cron", expr: `${mm} ${hh} * * *`, tz };
  }
  if (kind === "weekday") {
    return { kind: "cron", expr: `${mm} ${hh} * * 1-5`, tz };
  }
  if (kind === "weekly") {
    const dow = DOW[parts[1]];
    if (dow === undefined) return null;
    return { kind: "cron", expr: `${mm} ${hh} * * ${dow}`, tz };
  }
  if (kind === "monthly") {
    const day = parseInt(parts[1], 10);
    if (Number.isNaN(day) || day < 1 || day > 31) return null;
    return { kind: "cron", expr: `${mm} ${hh} ${day} * *`, tz };
  }
  return null;
}

/**
 * 저장된 스케줄 값을 ScheduleSpec으로 해석한다. 저장 값은 둘 중 하나다:
 *  (a) JSON 직렬화된 ScheduleSpec(신규 경로) — schedule_json 컬럼.
 *  (b) 레거시 하이픈 토큰(기존 경로) — schedule 컬럼.
 * 우선 JSON 파싱을 시도하고, 실패하면 레거시 토큰으로 매핑한다. 둘 다 실패면 null.
 */
/**
 * 5칸(또는 초 포함 6칸) cron 식인가. 레거시 토큰("daily-09:00", "30m")과 겹치지 않게
 * 칸 수와 허용 문자로만 판별한다 — 여기서 관대해지면 오타가 조용히 cron으로 둔갑한다.
 */
function isCronExpression(raw: string): boolean {
  const parts = raw.split(/\s+/);
  if (parts.length !== 5 && parts.length !== 6) return false;
  // `5#L` (the last Friday) and `5#2` (the second Friday), `L` (the last day of the month): croner's own day-of-week / day-of-month forms.
  return parts.every((part) => /^[0-9*,\-/#L]+$/.test(part) || /^[A-Za-z]{3}(-[A-Za-z]{3})?$/.test(part));
}

export function specFromStored(stored: string, tz: string): ScheduleSpec | null {
  const raw = (stored || "").trim();
  if (!raw) return null;
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as ScheduleSpec;
      if (parsed && typeof parsed === "object" && typeof (parsed as { kind?: unknown }).kind === "string") {
        return parsed;
      }
    } catch {
      /* fallthrough to legacy */
    }
  }
  // 챗 emitter가 저장하는 "cron:<expr>" 미러 토큰 — schedule_json이 유실돼도 올바른 cron으로
  // 파싱되게 한다(그러지 않으면 parseLegacyToken이 매치 실패 → 잘못된 24h 폴백).
  if (raw.startsWith("cron:")) {
    const expr = raw.slice(5).trim();
    if (expr) return { kind: "cron", expr, tz: tz || "UTC" };
  }
  // ★접두사 없는 **맨 cron 식**도 받는다. 터미널 인터뷰는 사람이 고른 시각을
  //   "0 9-23 * * *" 형태로 저장하는데, 여기서 못 읽으면 24h 폴백으로 떨어져
  //   **사람이 고른 시각이 조용히 사라진다**(실측 2026-08-05: "09~23시 매시간"으로
  //   만든 자동화의 다음 실행이 24시간 뒤로 잡혔다 — 하루 15회가 1회가 됐다).
  if (isCronExpression(raw)) return { kind: "cron", expr: raw, tz: tz || "UTC" };
  return parseLegacyToken(raw, tz);
}

/**
 * The `scheduleSpec` a model sends to automations.create, read the way it meant it (the model entrance in ipc.ts, nowhere else).
 * Production (agentlas-light, "다음 주 금요일 3시 한 번"): three calls in a row sent {type:"once",at:"…+09:00",tz} and were
 * refused; the fourth, {kind:"once",atIso}, was stored. Each neighbouring name has exactly one reading, so a key that is ABSENT is
 * filled from it (`type` for kind, `at`/`time`/`datetime`/`when` for atIso, `cron`/`expression` for expr, `timezone` for tz,
 * `intervalMs` for everyMs); a value is never invented. null = still not a time the scheduler can use, and the caller refuses it:
 *  - once: the time has no offset (its instant would depend on this machine's zone) or is not a date or is already past
 *    (a once spec with no future time stores as a job that never runs).
 *  - cron: not a valid expression. interval: everyMs is not a positive number.
 */
/** The names a model's scheduleSpec may carry. A key outside this list is something the scheduler would NOT do: it is refused, never dropped (the answer would then promise it). */
const MODEL_SPEC_KEYS = new Set(["kind", "type", "atIso", "at", "time", "datetime", "when", "expr", "cron", "expression", "tz", "timezone", "everyMs", "intervalMs", "anchor", "everyWeeks", "skipDates", "until"]);

/** `everyWeeks` and `skipDates` of a cron spec. {} = none, null = present but not usable. */
export function readCronFilters(input: Record<string, unknown>): { everyWeeks?: { every: number; from: string }; skipDates?: string[]; until?: string } | null {
  const out: { everyWeeks?: { every: number; from: string }; skipDates?: string[]; until?: string } = {};
  const until = input.until;
  if (until !== undefined && until !== null) {
    if (!isCalendarDate(until)) return null;
    out.until = until;
  }
  const weeks = input.everyWeeks;
  if (weeks !== undefined && weeks !== null) {
    if (typeof weeks !== "object" || Array.isArray(weeks)) return null;
    const w = weeks as Record<string, unknown>;
    if (typeof w.every !== "number" || !Number.isInteger(w.every) || w.every < 2 || w.every > EVERY_WEEKS_MAX || !isCalendarDate(w.from)) return null;
    out.everyWeeks = { every: w.every, from: w.from };
  }
  const skip = input.skipDates;
  if (skip !== undefined && skip !== null) {
    if (!Array.isArray(skip) || skip.length > SKIP_DATES_MAX || !skip.every(isCalendarDate)) return null;
    if (skip.length) out.skipDates = [...new Set(skip as string[])].sort();
  }
  return out;
}

/**
 * Why a model's scheduleSpec is not usable, in the words the model gets back; null = nothing wrong with its keys. Two refusals the generic
 * "cannot be read" does not say: a key the scheduler has no meaning for (a model wrote {kind:"cron",expr,biweekly:true} and the answer then promised
 * every other week while the job ran every week:), and a malformed everyWeeks / skipDates.
 */
export function modelScheduleSpecProblem(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  const unknown = Object.keys(input).filter((key) => !MODEL_SPEC_KEYS.has(key));
  if (unknown.length) {
    return `scheduleSpec has ${unknown.map((key) => `"${key}"`).join(", ")}, which the scheduler does not act on, so the job would not do what that says. A cron spec can add everyWeeks {every:2..${EVERY_WEEKS_MAX}, from:"YYYY-MM-DD" (the first run's date)} for every Nth week, and skipDates ["YYYY-MM-DD", ...] (at most ${SKIP_DATES_MAX}) for dates that do not run, and until "YYYY-MM-DD" for the last day it runs (a job that ends on a date); the last Friday of the month is expr "0 17 * * 5#L". A rule beyond these (a holiday calendar by name, "unless it rains") cannot be stored: say so to the person instead of saving a plainer job.`;
  }
  if ((input.everyWeeks !== undefined && input.everyWeeks !== null) || (input.skipDates !== undefined && input.skipDates !== null) || (input.until !== undefined && input.until !== null)) {
    const kind = typeof input.kind === "string" ? input.kind : input.type;
    if (kind !== "cron") return "everyWeeks, skipDates and until belong to a {kind:\"cron\"} spec only";
    if (readCronFilters(input) === null) return `everyWeeks must be {every: integer 2..${EVERY_WEEKS_MAX}, from:"YYYY-MM-DD"} skipDates a list of at most ${SKIP_DATES_MAX} real "YYYY-MM-DD" dates and until a real "YYYY-MM-DD" (the last day it runs)`;
  }
  return null;
}

export function readModelScheduleSpec(raw: unknown, tz: string, now: Date = new Date()): ScheduleSpec | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  const pick = (...keys: string[]): unknown => {
    for (const key of keys) {
      const value = input[key];
      if (value !== undefined && value !== null && value !== "") return value;
    }
    return undefined;
  };
  // The kind as models spell it: "one_time" / "one-time" / "onetime" / "one_off" / "oneshot" are all "once" (prod {type:"one_time"} was refused twice).
  const rawKind = pick("kind", "type");
  const spelled = typeof rawKind === "string" ? rawKind.trim().toLowerCase().replace(/[\s-]+/g, "_") : rawKind;
  const kind = spelled === "one_time" || spelled === "onetime" || spelled === "one_off" || spelled === "oneoff" || spelled === "oneshot" || spelled === "one_shot" ? "once" : spelled;
  if (kind === "manual") return { kind: "manual" };
  if (kind === "once") {
    const at = pick("atIso", "at", "time", "datetime", "when");
    if (typeof at !== "string" || !/(Z|[+-]\d{2}:?\d{2})$/i.test(at.trim())) return null;
    const ms = Date.parse(at.trim());
    return Number.isFinite(ms) && ms > now.getTime() ? { kind: "once", atIso: new Date(ms).toISOString() } : null;
  }
  if (kind === "cron") {
    const expr = pick("expr", "cron", "expression");
    const zone = pick("tz", "timezone");
    if (typeof expr !== "string" || !isCronExpression(expr.trim())) return null;
    const useTz = typeof zone === "string" && zone ? zone : tz || "UTC";
    try {
      new Cron(expr.trim(), { timezone: useTz });
    } catch {
      return null;
    }
    const filters = readCronFilters(input);
    if (filters === null) return null;
    return { kind: "cron", expr: expr.trim(), tz: useTz, ...filters };
  }
  if (kind === "interval") {
    const every = pick("everyMs", "intervalMs");
    if (typeof every !== "number" || !Number.isFinite(every) || every <= 0) return null;
    return { kind: "interval", everyMs: every, anchor: pick("anchor") === "lastRun" ? "lastRun" : "wallclock" };
  }
  return null;
}

/**
 * Can the scheduler tell WHEN this stored automation runs? Same reading computeNextRun does (schedule_json first, else the schedule column).
 * false = computeNextRun would fall back to "24 hours from now" for it: a job at an hour nobody chose. Used by the start-up pause of such rows.
 */
export function storedScheduleReadable(schedule: string, scheduleJson: string | null | undefined, tz: string): boolean {
  return specFromStored(scheduleJson && scheduleJson.trim() ? scheduleJson : schedule, tz) !== null;
}

/**
 * What a model is told after it saved or changed a schedule: the words of the STORED spec and its next three runs, computed by the same nextRun
 * the scheduler uses, so the answer is written from what will happen and not from what was asked ("every other Tuesday" saved as every Tuesday).
 */
export function scheduleReceipt(a: { scheduleSpec?: ScheduleSpec | null; nextRunAt?: string | null }, locale: "ko" | "en"): { words: string; nextRuns: string[] } | null {
  const spec = a.scheduleSpec;
  if (!spec) return null;
  const runs: string[] = [];
  let cursor = a.nextRunAt && Number.isFinite(Date.parse(a.nextRunAt)) ? a.nextRunAt : nextRun(spec, new Date());
  while (cursor && runs.length < 3) {
    runs.push(cursor);
    cursor = nextRun(spec, new Date(Date.parse(cursor)));
  }
  return { words: describeSchedule(spec, locale), nextRuns: runs };
}

export type SchedulePreset = "daily" | "weekday" | "weekly" | "monthly" | "hourly";

/**
 * UI/모델 프리셋 + 시각을 cron ScheduleSpec으로 컴파일한다(설계 §2.1 표).
 * time은 "HH:MM"(24h). weekly는 dow(0=일..6=토 또는 mon/tue 문자열)를, monthly는 day(1-31)를
 * extra로 받는다. 유효하지 않으면 null.
 */
export function compilePreset(
  preset: SchedulePreset,
  time: string,
  tz: string,
  extra?: { dow?: number | string; day?: number },
): ScheduleSpec | null {
  const [hh, mm] = (time || "09:00").split(":").map((n) => parseInt(n, 10));
  if (Number.isNaN(hh) || Number.isNaN(mm)) return null;

  switch (preset) {
    case "hourly":
      return { kind: "cron", expr: `${mm} * * * *`, tz };
    case "daily":
      return { kind: "cron", expr: `${mm} ${hh} * * *`, tz };
    case "weekday":
      return { kind: "cron", expr: `${mm} ${hh} * * 1-5`, tz };
    case "weekly": {
      let dow: number | undefined;
      if (typeof extra?.dow === "number") dow = extra.dow;
      else if (typeof extra?.dow === "string") dow = DOW[extra.dow];
      if (dow === undefined || dow < 0 || dow > 6) dow = 1; // 기본 월요일
      return { kind: "cron", expr: `${mm} ${hh} * * ${dow}`, tz };
    }
    case "monthly": {
      const day = extra?.day && extra.day >= 1 && extra.day <= 31 ? extra.day : 1;
      return { kind: "cron", expr: `${mm} ${hh} ${day} * *`, tz };
    }
    default:
      return null;
  }
}

// 표시 문구는 shared/schedule-describe.ts(순수, croner 비의존)로 분리해 렌더러와 공유한다.
// 기존 import 경로를 유지하기 위해 여기서 그대로 재수출한다.
export { describeSchedule } from "../../shared/schedule-describe";
import { describeSchedule } from "../../shared/schedule-describe";
