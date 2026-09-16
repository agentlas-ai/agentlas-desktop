#!/usr/bin/env node
// 계약: 사용자가 이미 도는 자동화의 규칙을 바꾸면, 모델은 그 자동화를 제자리에서
// 고쳐야 한다 — 말로만 받아들이면 저장된 job 은 옛 프롬프트로 계속 돈다.
//
// 실측 2026-09-16: 오너가 팔로우/게시/리플 하한을 새로 지시했는데 두 자동화 프롬프트
// 어느 쪽에도 반영되지 않았다. 호스트에는 수정 경로가 있었고(등록 블록의 automationId →
// action:"updated") 파서도 그 필드를 받고 있었지만, 모델이 받는 문장에는 그 칸이 없었다.
// 이 게이트는 문장 대조가 아니라 **해석기를 실제로 불러서** 계약을 단언한다.
const assert = require("node:assert/strict");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const { parseAutomations, AUTOMATION_PROTOCOL } = require(path.join(root, "dist/electron/automation-emitter.js"));
const { resolveAutomationRegistrationTarget } = require(path.join(root, "dist/electron/automation-registration.js"));

const CHAT = "chat-origin";
const existing = [{ id: "auto-77", name: "Threads 24h Ops", monitor: { originChatId: CHAT } }];

function block(entry) {
  return ["## Automation", "```json", JSON.stringify([entry]), "```"].join("\n");
}

// 1) 정확한 id 를 실으면, 이름이 바뀌었어도 기존 job 으로 해석된다(= 제자리 수정).
{
  const parsed = parseAutomations(block({
    automationId: "auto-77",
    name: "Threads 24h Ops (revised)",
    prompt: "follow 50/day, post 1 media/day, reply 10/day",
    schedule: { preset: "daily", time: "09:00", tz: "Asia/Seoul" },
  }));
  assert.deepEqual(parsed.errors, [], "id 를 실은 등록 블록은 파싱 오류가 없어야 한다");
  assert.equal(parsed.automations[0].automationId, "auto-77", "파서가 automationId 를 실어 와야 한다");
  const hit = resolveAutomationRegistrationTarget({ parsed: parsed.automations[0], automations: existing, chatId: CHAT });
  assert.equal(hit && hit.id, "auto-77", "정확한 id 는 이름이 달라도 기존 job 을 가리켜야 한다");
}

// 2) 옛 고장 모양 — id 없이 이름만 바꾸면 기존 job 을 못 찾는다(그래서 중복이 생겼다).
//    이 줄은 "id 를 실어야 한다"는 요구가 왜 계약인지 고정한다.
{
  const parsed = parseAutomations(block({
    name: "Threads 24h Ops (revised)",
    prompt: "follow 50/day",
    schedule: { preset: "daily", time: "09:00", tz: "Asia/Seoul" },
  }));
  const hit = resolveAutomationRegistrationTarget({ parsed: parsed.automations[0], automations: existing, chatId: CHAT });
  assert.equal(hit, undefined, "id 없이 이름만 바뀌면 기존 job 으로 해석되면 안 된다");
}

// 3) 같은 이름을 유지하면 id 없이도 같은 대화 안에서는 해석된다(기존 멱등 계약 보존).
{
  const parsed = parseAutomations(block({
    name: "Threads 24h Ops",
    prompt: "follow 50/day",
    schedule: { preset: "daily", time: "09:00", tz: "Asia/Seoul" },
  }));
  const hit = resolveAutomationRegistrationTarget({ parsed: parsed.automations[0], automations: existing, chatId: CHAT });
  assert.equal(hit && hit.id, "auto-77", "같은 대화 · 같은 이름은 기존 job 을 가리켜야 한다");
}

// 4) 모델이 실제로 받는 문장에 그 칸과 지시가 있어야 한다. 경로가 있어도 문장이 없으면
//    도달 불가였다는 것이 이 결함의 정체다.
// ★산문에 "automationId" 를 언급하는 것만으로는 부족하다 — 옛 프로토콜에도 그 단어는
//   있었고 모델이 채울 칸만 없었다. 그래서 **템플릿 첫 칸**으로 좁혀 단언한다.
assert.match(
  AUTOMATION_PROTOCOL,
  /\[\s*\{\s*"automationId"/,
  "등록 템플릿(JSON) 자체에 automationId 칸이 있어야 한다",
);
// 프로토콜은 줄 배열을 join 한 것이라 문장이 개행으로 끊긴다 — \s+ 로 받는다.
assert.match(
  AUTOMATION_PROTOCOL,
  /re-emit\s+this\s+registration\s+block/i,
  "규칙이 바뀌면 등록 블록을 다시 내라는 지시가 있어야 한다",
);
assert.match(
  AUTOMATION_PROTOCOL,
  /lifecycle\s+list/i,
  "영수증이 없을 때 id 를 어디서 얻는지 알려 줘야 한다",
);

console.log("ok scripts/test-automation-revision-contract.cjs — 4 contracts");
