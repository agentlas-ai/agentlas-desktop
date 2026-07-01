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
        const next = new Cron(spec.expr, { timezone: spec.tz }).nextRun(from);
        return next ? next.toISOString() : null;
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
 * - hourly           → cron "m * * * *"(현재 분에 고정, 매시)
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
    return { kind: "cron", expr: "0 * * * *", tz };
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
  return parseLegacyToken(raw, tz);
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

const KO_DOW = ["일", "월", "화", "수", "목", "금", "토"];
const EN_DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** 사람이 읽을 스케줄 설명(표시 전용, 파싱 아님). locale=ko|en. */
export function describeSchedule(spec: ScheduleSpec, locale: "ko" | "en" = "en"): string {
  const ko = locale === "ko";
  switch (spec.kind) {
    case "manual":
      return ko ? "수동 실행" : "Manual only";
    case "once": {
      const d = new Date(spec.atIso);
      const when = Number.isNaN(d.getTime()) ? spec.atIso : d.toLocaleString(ko ? "ko-KR" : "en-US");
      return ko ? `1회: ${when}` : `Once: ${when}`;
    }
    case "interval": {
      const min = Math.round(spec.everyMs / 60000);
      const aligned = spec.anchor === "wallclock" ? (ko ? " (정렬)" : " (aligned)") : "";
      if (min % 60 === 0 && min >= 60) {
        const h = min / 60;
        return ko ? `${h}시간마다${aligned}` : `Every ${h}h${aligned}`;
      }
      return ko ? `${min}분마다${aligned}` : `Every ${min}m${aligned}`;
    }
    case "cron": {
      const fields = spec.expr.trim().split(/\s+/);
      if (fields.length === 5) {
        const [mm, hh, dom, , dow] = fields;
        const time = /^\d+$/.test(hh) && /^\d+$/.test(mm)
          ? `${hh.padStart(2, "0")}:${mm.padStart(2, "0")}`
          : null;
        if (time && dom === "*" && dow === "*") {
          return ko ? `매일 ${time}` : `Daily at ${time}`;
        }
        if (time && dom === "*" && dow === "1-5") {
          return ko ? `평일 ${time}` : `Weekdays at ${time}`;
        }
        if (time && dom === "*" && /^\d$/.test(dow)) {
          const label = ko ? `매주 ${KO_DOW[Number(dow)]}` : `Every ${EN_DOW[Number(dow)]}`;
          return `${label} ${time}`;
        }
        if (time && /^\d+$/.test(dom) && dow === "*") {
          return ko ? `매월 ${dom}일 ${time}` : `Monthly on day ${dom} at ${time}`;
        }
        if (hh === "*" && /^\d+$/.test(mm)) {
          return ko ? "매시" : "Hourly";
        }
      }
      return ko ? `cron ${spec.expr} (${spec.tz})` : `cron ${spec.expr} (${spec.tz})`;
    }
    default:
      return ko ? "알 수 없음" : "Unknown";
  }
}
