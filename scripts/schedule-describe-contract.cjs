#!/usr/bin/env node
/*
 * 스케줄 표시 문구 게이트.
 *
 * 실측(모바일 1.0.9): 자동화 상세의 `일정` 칸에 `*​/20 * * * *` 이 그대로 떴다.
 * 자동화를 만드는 사람은 개발자가 아니다 — 크론 원문은 부가 정보이지 제목이 아니다.
 */

const assert = require("node:assert/strict");

const {
  describeCronExpression,
  humanizeScheduleLabel,
  describeSchedule,
} = require("../dist/shared/schedule-describe.js");

// ── 간격형 — 이게 1.0.9 에서 폰에 노출된 바로 그 표현식이다 ──────────────────
assert.equal(describeCronExpression("*/20 * * * *", "ko"), "20분마다");
assert.equal(describeCronExpression("*/20 * * * *", "en"), "Every 20 minutes");
assert.equal(describeCronExpression("*/60 * * * *", "ko"), "1시간마다");
assert.equal(describeCronExpression("0 */3 * * *", "ko"), "3시간마다");
assert.equal(describeCronExpression("30 */6 * * *", "en"), "Every 6 hours at :30");

// ── 시각형 ────────────────────────────────────────────────────────────────
assert.equal(describeCronExpression("0 9 * * *", "ko"), "매일 09:00");
assert.equal(describeCronExpression("0 9 * * 1-5", "en"), "Weekdays at 09:00");
assert.equal(describeCronExpression("0 9 * * 0,6", "ko"), "주말 09:00");
assert.equal(describeCronExpression("0 9 * * 1", "ko"), "매주 월요일 09:00");
assert.equal(describeCronExpression("0 9 * * 0,2,4", "ko"), "매주 일·화·목요일 09:00");
assert.equal(describeCronExpression("0 9 1 * *", "en"), "Monthly on day 1 at 09:00");
assert.equal(describeCronExpression("0 * * * *", "ko"), "매시 정각");
assert.equal(describeCronExpression("15 * * * *", "en"), "Hourly at :15");

// ── cron 7 = 일요일. 7칸 표를 7로 색인해 "undefined"가 문장에 박혔었다 ──────
assert.equal(describeCronExpression("0 9 * * 7", "ko"), "매주 일요일 09:00");
assert.equal(describeCronExpression("0 9 * * 0,7", "ko"), "매주 일·일요일 09:00");
for (const locale of ["ko", "en"]) {
  assert.ok(
    !String(describeCronExpression("0 9 * * 7", locale)).includes("undefined"),
    "a day-of-week table lookup must never reach the user as 'undefined'",
  );
}

// ── 월 필드가 있으면 그 재발주기가 아니다 — 지어내지 않는다 ────────────────
assert.equal(describeCronExpression("0 9 * 3 *", "ko"), null);
assert.equal(describeCronExpression("*/20 * * 6 *", "ko"), null);

// ── 해석 불가는 **지어내지 않는다** ────────────────────────────────────────
assert.equal(describeCronExpression("weird", "ko"), null);
assert.equal(describeCronExpression("1 2 3 4 5 6", "ko"), null);
assert.equal(describeCronExpression("0 9 5 * 1", "ko"), null);

// ── 저장된 라벨 정규화 ─────────────────────────────────────────────────────
assert.equal(humanizeScheduleLabel("*/20 * * * *", "ko"), "20분마다");
assert.equal(humanizeScheduleLabel("manual", "ko"), "수동 실행");
assert.equal(humanizeScheduleLabel("", "en"), "Manual only");
// 이미 사람 문장이면 그대로 둔다 — 다시 지어내지 않는다.
assert.equal(humanizeScheduleLabel("매일 오전 8시", "ko"), "매일 오전 8시");

// ── 레거시 미러 토큰 — scheduleHuman 에 실제로 저장돼 있는 형태들 ──────────
// 이 칸은 사람 문장 전용이 아니다. `cron:<expr>`, `daily-09:00`, `every-10m`,
// `weekly-1-09:00` 같은 저장 토큰이 그대로 들어 있고, 그걸 사람 문장이라며 폰에
// 보내면 화면에 토큰이 뜬다.
assert.equal(humanizeScheduleLabel("cron:*/20 * * * *", "ko"), "20분마다");
assert.equal(humanizeScheduleLabel("daily-09:00", "ko"), "매일 09:00");
assert.equal(humanizeScheduleLabel("daily-9:05", "en"), "Daily at 09:05");
assert.equal(humanizeScheduleLabel("every-10m", "ko"), "10분마다");
assert.equal(humanizeScheduleLabel("every-3h", "en"), "Every 3 hours");
assert.equal(humanizeScheduleLabel("weekly-1-09:00", "ko"), "매주 월요일 09:00");
// 모르는 토큰은 지어내지 않고 그대로 둔다.
assert.equal(humanizeScheduleLabel("some-custom-label", "ko"), "some-custom-label");

// ── 표시 문구에 크론 원문이 남으면 실패 ────────────────────────────────────
for (const expression of [
  "*/20 * * * *",
  "0 9 * * 1-5",
  "0 * * * *",
  "cron:*/20 * * * *",
  "daily-09:00",
  "every-10m",
]) {
  for (const locale of ["ko", "en"]) {
    const shown = humanizeScheduleLabel(expression, locale);
    assert.ok(
      !shown.includes("*"),
      `${expression} (${locale}) still shows a raw cron expression: ${shown}`,
    );
  }
}

// ── ScheduleSpec 경로도 같은 규칙을 쓴다 ──────────────────────────────────
assert.equal(
  describeSchedule({ kind: "cron", expr: "*/20 * * * *", tz: "Asia/Seoul" }, "ko"),
  "20분마다",
);
assert.equal(
  describeSchedule({ kind: "cron", expr: "weird expr here now", tz: "Asia/Seoul" }, "ko"),
  "cron weird expr here now (Asia/Seoul)",
  "an unreadable expression falls back to the raw value rather than a guess",
);

// ── 두 표면이 같은 자동화를 같은 말로 불러야 한다 ──────────────────────────
// 데스크탑 자동화 화면은 `graph-blueprint.humanSchedule` 을, 모바일 브리지는
// `humanizeScheduleLabel` 을 쓴다. 예전에는 각자 파서를 갖고 있어서 `*/20 * * * *`
// 를 폰은 "20분마다"로, 데스크탑은 **크론 원문 그대로** 보여줬다. 규칙은 한 벌이
// 소유한다 — 이 단언이 그 소유권을 지킨다.
const { humanSchedule } = require("../dist/shared/graph-blueprint.js");
for (const expression of [
  "*/20 * * * *",
  "0 9 * * *",
  "0 9 * * 1-5",
  "0 9 * * 0,6",
  "0 9 * * 1",
  "0 * * * *",
  "15 * * * *",
  "0 9 1 * *",
  "cron:*/20 * * * *",
  "daily-09:00",
  "every-10m",
  "weekly-1-09:00",
  "some-custom-label",
]) {
  for (const locale of ["ko", "en"]) {
    assert.equal(
      humanSchedule(expression, locale),
      humanizeScheduleLabel(expression, locale),
      `desktop and mobile disagree about "${expression}" (${locale})`,
    );
  }
}
// `manual` 은 그래프 화면에서만 뜻이 다르다("값을 넣을 때만" = 네가 시작한다).
// 그 한 문장은 의도적으로 갈라져 있고, 갈라진 채로 유지돼야 한다.
assert.equal(humanSchedule("manual", "ko"), "값을 넣을 때만");
assert.equal(humanizeScheduleLabel("manual", "ko"), "수동 실행");

// ── 목록·범위형 — 흔한데 예전엔 전부 null 이라 크론 원문이 제목에 올라갔다 ──
assert.equal(describeCronExpression("0 9,18 * * *", "ko"), "매일 09:00, 18:00");
assert.equal(describeCronExpression("0 9,13,18 * * *", "en"), "Daily at 09:00, 13:00, 18:00");
assert.equal(describeCronExpression("0 9-18 * * *", "ko"), "매일 09시~18시 매시");
assert.equal(describeCronExpression("0,30 * * * *", "ko"), "매시 00분, 30분");
assert.equal(describeCronExpression("0,30 * * * *", "en"), "Hourly at :00, :30");
for (const expression of ["0 9,18 * * *", "0 9-18 * * *", "0,30 * * * *"]) {
  for (const locale of ["ko", "en"]) {
    assert.ok(
      !humanizeScheduleLabel(expression, locale).includes("*"),
      `${expression} (${locale}) still leaks a raw cron expression`,
    );
  }
}

// ── 망가진 spec 하나가 폰 스냅샷 전체를 죽이면 안 된다 ────────────────────
// 투영은 자동화를 통째로 순회한다. 여기서 던지면 그 한 행 때문에 폰이 **아무것도**
// 못 받는다. 레거시/부분 마이그레이션 행은 실제로 존재한다.
for (const broken of [
  null,
  undefined,
  {},
  { kind: "cron" },
  { kind: "cron", expr: null, tz: null },
  { kind: "cron", expr: "   ", tz: "Asia/Seoul" },
  { kind: "once" },
  { kind: "once", atIso: "not-a-date" },
  { kind: "interval" },
  { kind: "interval", everyMs: 0 },
  { kind: "interval", everyMs: "많이" },
  { kind: "무엇" },
]) {
  for (const locale of ["ko", "en"]) {
    let shown;
    assert.doesNotThrow(() => {
      shown = describeSchedule(broken, locale);
    }, `describeSchedule threw on ${JSON.stringify(broken)} (${locale})`);
    assert.equal(typeof shown, "string");
    assert.ok(shown.length > 0, "a broken spec must still produce something to show");
  }
}
for (const broken of [null, undefined, 42, {}]) {
  assert.doesNotThrow(() => humanizeScheduleLabel(broken, "ko"));
  assert.equal(describeCronExpression(broken, "ko"), null);
}

console.log("schedule copy: cron expressions are described, never shown raw");
console.log("schedule copy: a malformed spec degrades, it never throws");
console.log("schedule copy: desktop and mobile say the same thing");
