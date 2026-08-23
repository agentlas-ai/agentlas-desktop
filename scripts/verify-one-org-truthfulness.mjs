// One 조직도가 "사실"을 말하는가 — PRD §3.5 §3.7 §4.29 §5.29 재발 방지.
//
// 이 게이트는 구현 문장이 아니라 네 가지 계약을 지킨다:
//   ① 자리 계산: 앉힐 수 있는 최대 인원 == 동시성 (동시성 1이면 1명 가능)
//   ② 종료 사유: 유휴 회수·축출·앱 종료·턴 종료는 실패가 아니다
//   ③ 크레딧 표시: 성공 정산이 부족 표시를 되돌린다
//   ④ 판번호: 실행이 만드는 상태 갱신은 사용자 편집 CAS 를 깨지 않는다
// 그리고 사람이 읽는 문구는 두 언어가 대칭이어야 한다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

const org = read("electron/one/org.ts");
const service = read("electron/invocation/service.ts");

// ① 자리 계산 — 한 칸 어긋나면 저사양(동시성 1) 머신이 0명이 된다.
assert.match(org, /const active = activeRows\(\)\.length;/, "seat math must count active members without an implicit +1");
assert.match(org, /if \(active >= limit\)/, "a member may be seated up to (not below) the concurrency limit");
assert.doesNotMatch(org, /const used = activeRows\(\)\.length \+ 1;/, "the off-by-one seat count must not come back");
// 거절 문구는 할 수 있는 행동만 말한다 — 0명에게 "보관하세요"는 길이 아니다.
assert.match(org, /active === 0[\s\S]{0,200}Increase concurrency in Settings/, "a zero-member refusal must not tell the user to archive a member");

// ② 종료 사유 — closed 를 전부 실패로 적으면 성공한 팀원이 실패로 남는다.
assert.match(
  service,
  /closedIsFailure[\s\S]{0,200}"reaped", "evicted", "shutdown", "turn-complete"/,
  "an idle reclaim / eviction / app shutdown / completed turn must not be recorded as a failure",
);
assert.doesNotMatch(service, /statusLine: change\.state === "running" \? "지금 작업 중"/, "the hardcoded Korean residency status line must not come back");

// 문구는 두 언어 대칭 — 한쪽만 있으면 다른 언어 사용자는 아무 말도 못 본다.
for (const [ko, en] of [["지금 작업 중", "Working now"], ["최근 작업 완료", "Recently completed"], ["실패 · 확인 필요", "Failed · review needed"], ["크레딧 부족", "Out of credits"]]) {
  assert.ok(service.includes(ko) && service.includes(en), `both locales must exist for the org status line: ${ko} / ${en}`);
}
// 내부 오류 코드를 사용자 문장에 붙이지 않는다.
assert.doesNotMatch(service, /실패 · \$\{receipt\.errorCode/, "an internal error code must not be pasted into a user-facing status line");

// ③ 크레딧 표시 — 성공 정산은 반드시 상태를 보낸다(안 보내면 옛 값이 남는다).
assert.match(service, /creditState: creditBlocked \? \("insufficient" as const\) : \("ok" as const\)/, "a successful settlement must clear a stale out-of-credit badge");

// ④ 판번호 — 상태 갱신은 사용자 편집의 CAS 를 깨지 않는다.
const statusUpdate = org.slice(org.indexOf("export function setOneOrgMemberStatus"));
const statusSql = statusUpdate.slice(0, statusUpdate.indexOf("emitOrgChanged"));
assert.ok(
  !/revision = revision \+ 1/.test(statusSql),
  "a run-driven status update must not bump the roster revision used for user-edit CAS",
);
// 반대로 사용자 편집은 여전히 판번호를 올려야 한다.
assert.match(org, /UPDATE one_org_members SET display_name = \?, updated_at = \?, revision = revision \+ 1/, "user edits must keep bumping the revision");

console.log("one org truthfulness PASS: seat math, close reasons, credit badge, revision boundary");
