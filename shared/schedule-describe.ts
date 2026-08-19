// 스케줄 표시 문구(순수 함수) — croner에 의존하지 않으므로 메인/렌더러 양쪽이 같은 문구를 쓴다.
// electron/store/schedule.ts에서 분리한 이유: 렌더러가 croner를 import할 수 없어
// 표시 문구를 만들 수단이 없었고, 그래서 ScheduleBuilder가 `spec` 같은 자리표시자를
// scheduleHuman에 저장해 사용자 화면에 그대로 노출되는 결함이 생겼다.
import type { ScheduleSpec } from "./types";

const KO_DOW = ["일", "월", "화", "수", "목", "금", "토"];

/**
 * 한국어 시각 — 사람이 말하는 대로 "오전 8시", "오후 2시 30분" (오너 결정 2026-08-19).
 *
 * ★`08:00` 은 기계가 저장한 모양이지 사람이 말하는 모양이 아니다. 이 문장은 자동화 목록·
 *   미리보기·폰 알림에 그대로 나가므로, 한국어 표면은 한국어 시각 표기를 쓴다.
 *   영어는 `08:00` 그대로 둔다 — 그쪽은 원래 그렇게 읽는다.
 */
function koClock(hh: string, mm: string): string {
  const hour = Number(hh);
  const minute = Number(mm);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return `${hh}:${mm}`;
  const half = hour < 12 ? "오전" : "오후";
  // 0시와 12시는 12시간제에서 둘 다 "12시"다 — 0시를 "0시"로 적으면 사람 말이 아니다.
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return minute === 0 ? `${half} ${display}시` : `${half} ${display}시 ${minute}분`;
}
const EN_DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** 사람이 읽을 스케줄 설명(표시 전용, 파싱 아님). locale=ko|en. */
export function describeSchedule(spec: ScheduleSpec, locale: "ko" | "en" = "en"): string {
  const ko = locale === "ko";
  // 저장된 spec 이 항상 온전하다는 보장은 없다(레거시 행·부분 마이그레이션).
  // 여기서 던지면 그 자동화 하나 때문에 **폰 스냅샷 전체**가 만들어지지 않는다.
  if (!spec || typeof spec !== "object") return ko ? "알 수 없음" : "Unknown";
  switch (spec.kind) {
    case "manual":
      return ko ? "수동 실행" : "Manual only";
    case "once": {
      const d = new Date(String(spec.atIso ?? ""));
      const when = Number.isNaN(d.getTime())
        ? String(spec.atIso ?? (ko ? "알 수 없음" : "Unknown"))
        : d.toLocaleString(ko ? "ko-KR" : "en-US");
      return ko ? `1회: ${when}` : `Once: ${when}`;
    }
    case "interval": {
      const everyMs = Number(spec.everyMs);
      if (!Number.isFinite(everyMs) || everyMs <= 0) {
        return ko ? "알 수 없음" : "Unknown";
      }
      const min = Math.round(everyMs / 60000);
      const aligned = spec.anchor === "wallclock" ? (ko ? " (정렬)" : " (aligned)") : "";
      if (min % 60 === 0 && min >= 60) {
        const h = min / 60;
        return ko ? `${h}시간마다${aligned}` : `Every ${h}h${aligned}`;
      }
      return ko ? `${min}분마다${aligned}` : `Every ${min}m${aligned}`;
    }
    case "cron": {
      const expr = typeof spec.expr === "string" ? spec.expr : "";
      if (!expr.trim()) return ko ? "알 수 없음" : "Unknown";
      const described = describeCronExpression(expr, locale);
      if (described) return described;
      // 해석하지 못하면 원문을 보여준다 — 지어내는 것보다 낫다.
      return `cron ${expr} (${typeof spec.tz === "string" ? spec.tz : "?"})`;
    }
    default:
      return ko ? "알 수 없음" : "Unknown";
  }
}

/**
 * 5필드 cron 을 사람 문장으로. 해석하지 못하면 **null** 을 돌려준다 —
 * 호출부가 원문을 보여줄지 감출지 스스로 정하게 하기 위해서다.
 *
 * `*​/20 * * * *` 이 폰 화면에 그대로 노출되던 결함이 이 함수의 존재 이유다.
 * 자동화를 만든 사람은 개발자가 아니다.
 */
export function describeCronExpression(
  expression: string,
  locale: "ko" | "en" = "en",
): string | null {
  const ko = locale === "ko";
  if (typeof expression !== "string") return null;
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [mm, hh, dom, month, rawDow] = fields;
  // cron accepts 7 as Sunday. Indexing a 7-element table with it produced the
  // literal word "undefined" in the user-visible sentence.
  const dow = rawDow === "7" ? "0" : rawDow;
  // Anything month-scoped is NOT the recurrence these branches describe.
  // Claiming "매일 09:00" for `0 9 * 3 *` states a schedule the automation does
  // not have; say nothing rather than something false.
  if (month !== "*") return null;
  const time = /^\d+$/.test(hh) && /^\d+$/.test(mm)
    ? `${hh.padStart(2, "0")}:${mm.padStart(2, "0")}`
    : null;
  // 같은 시각의 한국어 표기. 영어는 기존 `HH:MM` 그대로 쓴다.
  const koAt = time ? koClock(hh, mm) : null;

  // ── 간격형 (*/N) ────────────────────────────────────────────────────────
  const everyMinutes = /^\*\/(\d+)$/.exec(mm);
  if (everyMinutes && hh === "*" && dom === "*" && month === "*" && dow === "*") {
    const step = Number(everyMinutes[1]);
    if (step === 60) return ko ? "1시간마다" : "Every hour";
    return ko ? `${step}분마다` : `Every ${step} minutes`;
  }
  const everyHours = /^\*\/(\d+)$/.exec(hh);
  if (everyHours && /^\d+$/.test(mm) && dom === "*" && month === "*" && dow === "*") {
    const step = Number(everyHours[1]);
    const at = mm === "0" ? "" : ko ? ` ${mm}분에` : ` at :${mm.padStart(2, "0")}`;
    return ko ? `${step}시간마다${at}` : `Every ${step} hours${at}`;
  }

  // ── 시각형 ──────────────────────────────────────────────────────────────
  if (time && dom === "*" && dow === "*") return ko ? `매일 ${koAt}` : `Daily at ${time}`;
  if (time && dom === "*" && dow === "1-5") return ko ? `평일 ${koAt}` : `Weekdays at ${time}`;
  if (time && dom === "*" && dow === "0,6") return ko ? `주말 ${koAt}` : `Weekends at ${time}`;
  if (time && dom === "*" && /^\d$/.test(dow)) {
    const label = ko ? `매주 ${KO_DOW[Number(dow)]}요일` : `Every ${EN_DOW[Number(dow)]}`;
    return `${label} ${ko ? koAt : time}`;
  }
  // 요일 목록: 0,2,4 → "매주 일·화·목"
  if (time && dom === "*" && /^\d(,\d)+$/.test(dow)) {
    const days = dow.split(",").map((value) => (value === "7" ? 0 : Number(value)));
    const label = ko
      ? `매주 ${days.map((day) => KO_DOW[day]).join("·")}요일`
      : `Every ${days.map((day) => EN_DOW[day]).join(", ")}`;
    return `${label} ${ko ? koAt : time}`;
  }
  if (time && /^\d+$/.test(dom) && dow === "*") {
    return ko ? `매월 ${dom}일 ${koAt}` : `Monthly on day ${dom} at ${time}`;
  }
  // ── 시각 목록·범위 ────────────────────────────────────────────────────
  // `0 9,18 * * *`(하루 두 번), `0 9-18 * * *`(업무시간 매시)는 흔한데 예전에는
  // 전부 null 이라 폰 화면 제목에 크론 원문이 그대로 올라갔다.
  if (/^\d+$/.test(mm) && /^\d+(,\d+)+$/.test(hh) && dom === "*" && dow === "*") {
    const hours = hh.split(",");
    const times = hours.map((hour) => `${hour.padStart(2, "0")}:${mm.padStart(2, "0")}`);
    return ko
      ? `매일 ${hours.map((hour) => koClock(hour, mm)).join(", ")}`
      : `Daily at ${times.join(", ")}`;
  }
  const hourRange = /^(\d+)-(\d+)$/.exec(hh);
  if (hourRange && /^\d+$/.test(mm) && dom === "*" && dow === "*") {
    const from = hourRange[1].padStart(2, "0");
    const to = hourRange[2].padStart(2, "0");
    const at = mm === "0" ? "" : ko ? ` ${mm}분` : `:${mm.padStart(2, "0")}`;
    return ko
      ? `매일 ${from}시~${to}시 매시${at}`
      : `Hourly from ${from}:00 to ${to}:00${at ? ` at ${at.trim()}` : ""}`;
  }
  // 분 목록 — `0,30 * * * *`(30분마다 정각·30분)
  if (/^\d+(,\d+)+$/.test(mm) && hh === "*" && dom === "*" && dow === "*") {
    const minutes = mm.split(",").map((value) => value.padStart(2, "0"));
    return ko
      ? `매시 ${minutes.join("분, ")}분`
      : `Hourly at :${minutes.join(", :")}`;
  }
  if (hh === "*" && /^\d+$/.test(mm) && dom === "*" && dow === "*") {
    return mm === "0"
      ? (ko ? "매시 정각" : "Hourly, on the hour")
      : (ko ? `매시 ${mm}분` : `Hourly at :${mm.padStart(2, "0")}`);
  }
  return null;
}

/**
 * 저장된 `scheduleHuman` 을 표시용 문구로 바꾼다.
 *
 * 이 칸에는 사람 문장이 들어 있을 때도 있고 cron 원문이 그대로 들어 있을 때도
 * 있다(레거시). cron 으로 읽히면 사람 문장으로 바꾸고, 아니면 그대로 둔다.
 * 해석 실패 시 원문을 지어내지 않는다.
 */
export function humanizeScheduleLabel(
  scheduleHuman: string,
  locale: "ko" | "en" = "en",
): string {
  const raw = typeof scheduleHuman === "string" ? scheduleHuman.trim() : "";
  if (!raw) return locale === "ko" ? "수동 실행" : "Manual only";
  if (raw === "manual") return locale === "ko" ? "수동 실행" : "Manual only";
  // 레거시 미러 토큰들. 이 칸에는 사람 문장뿐 아니라 `cron:<expr>`,
  // `daily-09:00`, `every-10m` 같은 저장 토큰이 그대로 들어 있다.
  const cronToken = raw.startsWith("cron:") ? raw.slice(5).trim() : raw;
  const described = describeCronExpression(cronToken, locale);
  if (described) return described;
  const ko = locale === "ko";
  const daily = /^daily-(\d{1,2}):(\d{2})$/.exec(raw);
  if (daily) {
    const time = `${daily[1].padStart(2, "0")}:${daily[2]}`;
    return ko ? `매일 ${koClock(daily[1], daily[2])}` : `Daily at ${time}`;
  }
  const every = /^every-(\d+)(m|h)$/.exec(raw);
  if (every) {
    const step = Number(every[1]);
    if (every[2] === "h") return ko ? `${step}시간마다` : `Every ${step} hours`;
    return ko ? `${step}분마다` : `Every ${step} minutes`;
  }
  const weekly = /^weekly-([0-6])-(\d{1,2}):(\d{2})$/.exec(raw);
  if (weekly) {
    const day = Number(weekly[1]);
    const time = `${weekly[2].padStart(2, "0")}:${weekly[3]}`;
    return ko
      ? `매주 ${KO_DOW[day]}요일 ${koClock(weekly[2], weekly[3])}`
      : `Every ${EN_DOW[day]} ${time}`;
  }
  return raw;
}
