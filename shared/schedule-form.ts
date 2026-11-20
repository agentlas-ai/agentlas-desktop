// 예약 폼의 정본 규칙(순수 함수) — 칸에 쓴 글 -> 일정 -> "이대로 저장해도 되는가".
// 폼 칸 정규화·빈 값의 뜻·저장 불가 사유·편집 왕복(저장된 일정 -> 칸)이 여기 한 곳에 있다.
// ScheduleBuilder(새 자동화·편집·그래프 트리거 노드)가 같은 규칙을 쓴다. croner 에 의존하지 않는다
// (렌더러가 croner 를 import 할 수 없다). 미래 실행일이 있는지는 호출부가 IPC 로 읽어 넣는다.
import type { ScheduleSpec } from "./types";
import { describeSchedule } from "./schedule-describe";

export type FormMode = "preset" | "cron" | "once" | "manual";
export type FormPreset = "daily" | "weekday" | "weekly" | "monthly" | "hourly" | "interval";

export interface PresetFields {
  preset: FormPreset;
  /** "HH:MM" 24h. 비어 있으면 아직 고르지 않은 것이다(기본값으로 대신하지 않는다). */
  time: string;
  /** 0=일..6=토. 하나 이상. */
  dows: number[];
  day: number;
  everyMin: number;
  aligned: boolean;
}

// ── 숫자 칸 ────────────────────────────────────────────────────────────────
// 쓰는 도중에는 빈 값을 허용하고, 칸을 떠날 때만 맞춘다. 지우자마자 1 로 되돌리면
// 5 를 쓰려던 사람이 15 를 얻는다.

/** 쓰는 도중의 값: 범위 안의 정수면 그 수, 아니면 null(아직 반영하지 않는다). */
export function readIntDraft(raw: string, min: number, max?: number): number | null {
  const text = String(raw ?? "").trim();
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < min || (max !== undefined && value > max)) return null;
  return value;
}

export type IntNote = "empty" | "range" | "round";

/** 칸을 떠날 때의 값. note 가 있으면 칸 곁에 한 줄로 알린다. */
export function settleInt(
  raw: string,
  current: number,
  min: number,
  max?: number,
): { value: number; note: IntNote | null } {
  const text = String(raw ?? "").trim();
  if (!text) return { value: current, note: "empty" };
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return { value: current, note: "empty" };
  let note: IntNote | null = null;
  let value = parsed;
  if (!Number.isInteger(value)) {
    value = Math.trunc(value);
    note = "round";
  }
  if (value < min) {
    value = min;
    note = "range";
  } else if (max !== undefined && value > max) {
    value = max;
    note = "range";
  } else if (!Number.isSafeInteger(value)) {
    value = Number.MAX_SAFE_INTEGER;
    note = "range";
  }
  return { value, note };
}

export function intNoteText(
  note: IntNote,
  locale: "ko" | "en",
  bounds: { min: number; max?: number },
  value: number,
): string {
  const ko = locale === "ko";
  if (note === "empty") {
    return ko ? `비워 둘 수 없어서 이전 값(${value})으로 되돌렸어요.` : `This can't be empty, so it went back to ${value}.`;
  }
  if (note === "round") {
    return ko ? `정수만 쓸 수 있어서 ${value}(으)로 맞췄어요.` : `Whole numbers only, so it is now ${value}.`;
  }
  const range = bounds.max === undefined
    ? (ko ? `${bounds.min} 이상` : `${bounds.min} or more`)
    : (ko ? `${bounds.min}~${bounds.max}` : `${bounds.min} to ${bounds.max}`);
  return ko ? `${range}만 쓸 수 있어서 ${value}(으)로 맞췄어요.` : `Only ${range} is allowed, so it is now ${value}.`;
}

/** 매월 N일에서 N 이 29 이상이면 그 날이 없는 달이 있다. 있으면 그 날짜, 없으면 null. */
export function monthlySkipDay(day: number): number | null {
  return Number.isInteger(day) && day >= 29 && day <= 31 ? day : null;
}

// ── 시각·날짜 ──────────────────────────────────────────────────────────────

export function hostTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** IANA 타임존 이름인가(croner 가 쓰는 Intl 과 같은 판정). "KST"·"Asia/Soul" 은 아니다. */
export function isValidTimeZone(tz: string): boolean {
  const zone = String(tz ?? "").trim();
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** "HH:MM" 이 정확한 시각이면 {h,m}. 비었거나 범위 밖이면 null. */
export function parseClock(time: string): { h: number; m: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(time ?? "").trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  return h <= 23 && m <= 59 ? { h, m } : null;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** datetime-local 칸의 글("YYYY-MM-DDTHH:mm", 이 컴퓨터의 시각)을 시각(ms)으로. 아니면 null. */
export function localInputToMs(text: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(text ?? "").trim());
  if (!match) return null;
  const [y, mo, d, h, mi, s] = [match[1], match[2], match[3], match[4], match[5], match[6] ?? "0"].map(Number);
  const date = new Date(2000, 0, 1, 0, 0, 0, 0);
  date.setFullYear(y, mo - 1, d);
  date.setHours(h, mi, s, 0);
  // 2월 31일처럼 달력에 없는 날은 Date 가 옆 달로 밀어낸다 — 밀렸으면 잘못된 값이다.
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d || date.getHours() !== h) return null;
  const ms = date.getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** 저장된 UTC 시각(ISO)을 datetime-local 칸의 글(이 컴퓨터의 시각)로. 읽을 수 없으면 "". */
export function isoToLocalInput(iso: string): string {
  const date = new Date(String(iso ?? ""));
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

// ── 요일 ───────────────────────────────────────────────────────────────────

const DOW_TOKENS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export function normalizeDows(days: number[]): number[] {
  const set = new Set<number>();
  for (const day of days) {
    if (!Number.isInteger(day)) continue;
    const normalized = day === 7 ? 0 : day;
    if (normalized >= 0 && normalized <= 6) set.add(normalized);
  }
  return [...set].sort((a, b) => a - b);
}

/** 눌린 요일을 켜고 끈다. 마지막 하나는 끌 수 없다(요일이 없는 주간 일정은 없다). */
export function toggleDow(days: number[], day: number): number[] {
  const current = normalizeDows(days);
  if (current.includes(day)) return current.length > 1 ? current.filter((d) => d !== day) : current;
  return normalizeDows([...current, day]);
}

/** cron 요일 칸 "1,3" -> [1,3]. 숫자 목록이 아니면(범위·이름) null. */
export function parseDowField(field: string): number[] | null {
  if (!/^[0-7](,[0-7])*$/.test(field)) return null;
  return normalizeDows(field.split(",").map(Number));
}

// ── 프리셋 <-> 일정 ────────────────────────────────────────────────────────

/** 프리셋 칸들을 일정으로. 시각이 비었으면 09:00 으로 *짐작*하되, 그 상태는 scheduleProblem 이 막는다. */
export function compilePresetFields(f: PresetFields, tz: string): ScheduleSpec {
  const clock = parseClock(f.time) ?? { h: 9, m: 0 };
  const { h, m } = clock;
  switch (f.preset) {
    case "hourly":
      return { kind: "cron", expr: `${m} * * * *`, tz };
    case "daily":
      return { kind: "cron", expr: `${m} ${h} * * *`, tz };
    case "weekday":
      return { kind: "cron", expr: `${m} ${h} * * 1-5`, tz };
    case "weekly": {
      const days = normalizeDows(f.dows);
      return { kind: "cron", expr: `${m} ${h} * * ${(days.length ? days : [1]).join(",")}`, tz };
    }
    case "monthly":
      return { kind: "cron", expr: `${m} ${h} ${Math.min(31, Math.max(1, f.day))} * *`, tz };
    case "interval":
      return { kind: "interval", everyMs: Math.max(1, f.everyMin) * 60_000, anchor: f.aligned ? "wallclock" : "lastRun" };
    default:
      return { kind: "cron", expr: `${m} ${h} * * *`, tz };
  }
}

/**
 * 레거시 미러 토큰(scheduleHuman). 토큰 문법이 있는 프리셋만 토큰으로, 나머지는 요약줄과 같은 문장으로.
 * 발사의 진실은 schedule_json 이다 — 이 값은 표시·구버전 폴백용이다.
 */
export function toLegacyToken(mode: FormMode, f: PresetFields, spec: ScheduleSpec, locale: "ko" | "en"): string {
  if (mode !== "preset") return describeSchedule(spec, locale);
  const clock = parseClock(f.time) ?? { h: 9, m: 0 };
  const time = `${pad2(clock.h)}:${pad2(clock.m)}`;
  switch (f.preset) {
    case "hourly":
      return "hourly";
    case "daily":
      return `daily-${time}`;
    case "weekday":
      return `weekday-${time}`;
    case "weekly": {
      const days = normalizeDows(f.dows);
      // 요일이 둘 이상이면 토큰 문법이 없다 — 사람이 읽을 문장을 저장한다.
      return days.length === 1 ? `weekly-${DOW_TOKENS[days[0]]}-${time}` : describeSchedule(spec, locale);
    }
    case "monthly":
      return `monthly-${Math.min(31, Math.max(1, f.day))}-${time}`;
    case "interval":
      return describeSchedule(spec, locale);
    default:
      return `daily-${time}`;
  }
}

export type HydratedForm =
  | { mode: "manual" }
  | { mode: "once"; onceAt: string }
  | { mode: "cron"; cronExpr: string; tz: string }
  | ({ mode: "preset"; tz?: string } & PresetFields);

const PRESET_DEFAULTS: PresetFields = { preset: "daily", time: "09:00", dows: [1], day: 1, everyMin: 30, aligned: true };

/**
 * 저장된 일정을 폼 칸으로(편집 왕복). 프리셋 칸으로 *손실 없이* 되돌릴 수 있는 cron 만 프리셋으로 읽고,
 * 나머지(월이 정해진 연간 식·간격·이름·범위)는 cron 칸에 그대로 둔다. 손실이 있는 읽기는 이름만 고쳐도
 * 일정이 바뀌는 사고가 된다("0 9 5 3 *" 가 매월 5일로 읽히던 것).
 */
export function hydrateSchedule(value: ScheduleSpec): HydratedForm {
  if (value.kind === "manual") return { mode: "manual" };
  if (value.kind === "once") return { mode: "once", onceAt: isoToLocalInput(value.atIso) };
  if (value.kind === "interval") {
    return {
      mode: "preset",
      ...PRESET_DEFAULTS,
      preset: "interval",
      everyMin: Math.max(1, Math.round(value.everyMs / 60_000)),
      aligned: value.anchor === "wallclock",
    };
  }
  const tz = value.tz || "UTC";
  const expr = value.expr;
  const asCron: HydratedForm = { mode: "cron", cronExpr: expr, tz };
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return asCron;
  const [mm, hh, dom, month, dw] = f;
  if (!/^\d+$/.test(mm) || !(/^\d+$/.test(hh) || hh === "*") || month !== "*") return asCron;
  const minute = Number(mm);
  const hour = hh === "*" ? 0 : Number(hh);
  if (minute > 59 || hour > 23) return asCron;
  const base = { mode: "preset" as const, tz, ...PRESET_DEFAULTS, time: `${pad2(hour)}:${pad2(minute)}` };
  if (hh === "*") return dom === "*" && dw === "*" ? { ...base, preset: "hourly" } : asCron;
  if (dom === "*" && dw === "*") return { ...base, preset: "daily" };
  if (dom === "*" && dw === "1-5") return { ...base, preset: "weekday" };
  if (dom === "*") {
    const days = parseDowField(dw);
    return days && days.length > 0 ? { ...base, preset: "weekly", dows: days } : asCron;
  }
  if (/^\d+$/.test(dom) && dw === "*") {
    const day = Number(dom);
    return day >= 1 && day <= 31 ? { ...base, preset: "monthly", day } : asCron;
  }
  return asCron;
}

// ── 저장 불가 사유 ─────────────────────────────────────────────────────────

/**
 * 이 폼 상태로는 일정을 만들 수 없는 이유(기계 키). null = 저장해도 된다.
 *  cron_blank·time_blank·once_blank: 비운 칸은 기본값으로 대신하지 않는다 — 사람이 고르지 않은 시각이 일정이 된다.
 *  cron_invalid: 문법 오류. cron_never: 문법은 맞는데 앞으로 실행될 날이 없다("0 9 31 2 *").
 *  tz_invalid: 알 수 없는 타임존. 조용히 안 도는 예약이 된다.
 *  once_past: 이미 지난 시각. 한 번짜리가 영영 안 돈다.
 */
export type ScheduleProblem =
  | "cron_blank"
  | "cron_invalid"
  | "cron_never"
  | "tz_invalid"
  | "time_blank"
  | "once_blank"
  | "once_invalid"
  | "once_past";

export interface ScheduleProblemInput {
  mode: FormMode;
  preset: FormPreset;
  time: string;
  cronExpr: string;
  tz: string;
  onceAt: string;
  /** 현재 시각(ms). 호출부가 넣는다 — 이 함수는 시계를 읽지 않는다. */
  now: number;
  /** 비어 있어도 쓰는 시간대(이 컴퓨터의 시간대). */
  hostTz: string;
  /** cron 문법 검사 결과. undefined = 아직 모른다. */
  cronValid?: boolean;
  /** 현재 일정의 다음 실행(ISO). null = 앞으로 없음, undefined = 아직 모른다. */
  nextRun?: string | null;
}

export function scheduleProblem(input: ScheduleProblemInput): ScheduleProblem | null {
  const { mode } = input;
  if (mode === "manual") return null;
  if (mode === "once") {
    if (!input.onceAt.trim()) return "once_blank";
    const ms = localInputToMs(input.onceAt);
    if (ms === null) return "once_invalid";
    return ms <= input.now ? "once_past" : null;
  }
  const zone = input.tz.trim() || input.hostTz;
  if (mode === "cron") {
    if (!input.cronExpr.trim()) return "cron_blank";
    if (input.cronValid === false) return "cron_invalid";
    if (!isValidTimeZone(zone)) return "tz_invalid";
    if (input.cronValid === true && input.nextRun === null) return "cron_never";
    return null;
  }
  if (input.preset === "interval") return null; // 간격 일정에는 시간대가 없다.
  if (input.preset !== "hourly" && parseClock(input.time) === null) return "time_blank";
  return isValidTimeZone(zone) ? null : "tz_invalid";
}
