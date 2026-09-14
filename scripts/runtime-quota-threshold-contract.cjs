#!/usr/bin/env node
"use strict";

/*
 * 사용량 한도 기준은 하나여야 한다.
 *
 * 오너 신고 2026-09-14: Codex 카드는 "Weekly 90% resets in 5d" 인데 모델 표는 세 모델을
 * "Quota exceeded · skipped" 로 지웠다. 기준이 두 벌이었다 — 역할 풀 선택(detect.ts)은 90%,
 * 실행 선택(selection.ts)은 100%. 오너 결정: **100 으로 통일.**
 *
 * 이 게이트는 문장을 대조하지 않는다. 판정 함수를 실제로 불러 90 과 100 을 갈라 보고,
 * 호출부 두 곳이 자기만의 숫자 기준을 되살렸는지까지 본다. 문장 대조였다면 상수 이름만
 * 바꿔도 통과한다 — [[gate-must-call-the-decision-not-match-text]].
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

/** TS 한 파일에서 판정을 꺼내 실제로 부른다. dist 빌드에 기대지 않는다(커밋 관문에는 dist 가 없다). */
function loadQuotaRule(source) {
  const body = source
    .replace(/^export\s+/gm, "")
    .replace(/:\s*number\s*\|\s*null\s*\|\s*undefined/g, "")
    .replace(/\)\s*:\s*boolean/g, ")")
    .replace(/^\s*\/\*[\s\S]*?\*\/\s*$/gm, "");
  return new Function(`${body}\nreturn { QUOTA_EXHAUSTED_PERCENT, quotaExhausted };`)();
}

const sharedPath = path.join(ROOT, "shared/runtime-quota.ts");
check(fs.existsSync(sharedPath), "shared/runtime-quota.ts 가 없다 — 기준이 살 곳이 사라졌다");
const rule = loadQuotaRule(fs.readFileSync(sharedPath, "utf8"));

check(rule.QUOTA_EXHAUSTED_PERCENT === 100, `기준은 100 이어야 한다 (지금 ${rule.QUOTA_EXHAUSTED_PERCENT})`);

// 오너가 실제로 본 화면: 주간 90%. 이건 건너뛰면 안 된다.
check(rule.quotaExhausted(90) === false, "90% 를 소진으로 판정했다 — 오너가 신고한 바로 그 화면");
check(rule.quotaExhausted(99.9) === false, "99.9% 를 소진으로 판정했다 — 남은 몫을 버린다");
check(rule.quotaExhausted(100) === true, "100% 인데 건너뛰지 않는다");
check(rule.quotaExhausted(120) === true, "100% 초과인데 건너뛰지 않는다");

// 사용률을 모르면 막지 않는다. 모름을 소진으로 읽으면 멀쩡한 런타임이 통째로 사라진다.
for (const unknown of [null, undefined, NaN, Infinity, "90", {}]) {
  check(rule.quotaExhausted(unknown) === false, `사용률 ${String(unknown)} 을 소진으로 판정했다 — 모름은 소진이 아니다`);
}

// 옛 고장 주입: 기준을 90 으로 되돌리면 이 게이트가 반드시 빨간불이어야 한다.
const injected = loadQuotaRule(
  fs.readFileSync(sharedPath, "utf8").replace("QUOTA_EXHAUSTED_PERCENT = 100", "QUOTA_EXHAUSTED_PERCENT = 90"),
);
check(injected.quotaExhausted(90) === true, "옛 고장(90) 주입이 통과했다 — 이 게이트는 아무것도 못 잡는다");

/*
 * 호출부가 자기 숫자를 되살렸는가.
 *
 * detect.ts 의 주석은 이미 "두 벌로 두면 한쪽만 고쳐진다"고 경고하고 있었는데, 정작 두 번째
 * 벌이 다른 파일에 있었다. 그래서 파일 하나가 아니라 '한도로 건너뛰는 자리 전부'를 본다.
 */
for (const relative of ["electron/runtime/detect.ts", "electron/runtime/selection.ts"]) {
  const text = fs.readFileSync(path.join(ROOT, relative), "utf8");
  check(text.includes("quotaExhausted("), `${relative} 가 공용 판정을 부르지 않는다`);
  const ownThreshold = text.match(/^\s*const\s+QUOTA_[A-Z_]*PERCENT\s*=\s*\d+/m);
  check(!ownThreshold, `${relative} 가 자기 한도 상수를 되살렸다: ${ownThreshold && ownThreshold[0].trim()}`);
  const compared = text.match(/peekProviderUsedPercent\([^)]*\)[^;\n]*>=\s*\d+/);
  check(!compared, `${relative} 가 사용률을 숫자와 직접 비교한다: ${compared && compared[0]}`);
}

if (failures.length) {
  console.error(`runtime-quota-threshold-contract FAIL (${failures.length})`);
  for (const message of failures) console.error(`  - ${message}`);
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, threshold: rule.QUOTA_EXHAUSTED_PERCENT, callSites: 2 }));
