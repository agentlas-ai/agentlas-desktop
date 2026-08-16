#!/usr/bin/env node
/*
 * 기억 하드 훅 계약.
 *
 * 기억 방출은 오랫동안 프롬프트 계약이었다 — 모델에게 "매 턴 Memory Events 를 내라"고
 * 지시하고 그것을 믿는 구조. 지시를 따르는 런타임에서는 잘 돌지만(실측: One 813건),
 * 같은 지시를 받고도 한 건도 내지 않는 에이전트가 있었다: Pitch Deck Architect 913회
 * 실행에 기억 0, 큐레이션 영수증은 memoryEventCount 0 / discarded 0 — 버려진 게 아니라
 * 애초에 후보가 없었다. 기억이 0이면 경험 후보도 0이고 칩도 0이라, 사용자 눈에는 제품이
 * 고장난 것과 구분되지 않는다.
 *
 * 오너 결정(2026-08-16): 모델의 자발적 협조에 기대지 말고 호스트가 직접 남긴다.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const curator = fs.readFileSync(path.join(root, "electron/memory/curator.ts"), "utf8");
const experienceStore = fs.readFileSync(path.join(root, "electron/experience/store.ts"), "utf8");

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); failed++; }
}

console.log("memory-hard-hook-contract");

check("★모델이 침묵한 턴을 호스트가 대신 기록한다", () => {
  assert.match(curator, /function hostObservedTurnEvents/,
    "호스트 관측 경로가 없다 — 기억은 다시 모델의 협조에만 달린다");
  assert.match(curator, /const hostObserved = parsed\.events\.length === 0 \? hostObservedTurnEvents\(ctx\)/,
    "모델이 0건일 때 호스트 경로로 넘어가지 않는다");
  assert.match(curator, /const effectiveEvents = parsed\.events\.length > 0 \? parsed\.events : hostObserved/,
    "호스트 관측이 큐레이션에 실제로 들어가지 않는다");
});

/*
 * ★모델이 낸 것을 밀어내면 안 된다. 호스트 기록은 침묵한 턴의 대체재이지 보강재가
 * 아니다 — 둘을 합치면 같은 사실이 두 번 쌓인다.
 */
check("★모델이 낸 턴에는 호스트가 끼어들지 않는다", () => {
  const idx = curator.indexOf("const hostObserved =");
  const line = curator.slice(idx, idx + 200);
  assert.match(line, /parsed\.events\.length === 0/,
    "모델 산출이 있어도 호스트 기록을 만든다");
});

/** 함수 본문만 정확히 잘라낸다 — 고정 길이 창은 이웃 코드를 끌어와 오탐을 만든다. */
function hookBody() {
  const idx = curator.indexOf("function hostObservedTurnEvents");
  assert.ok(idx > 0, "호스트 관측 함수를 못 찾았다");
  const open = curator.indexOf("{", idx);
  let depth = 0;
  for (let i = open; i < curator.length; i += 1) {
    if (curator[i] === "{") depth += 1;
    else if (curator[i] === "}") {
      depth -= 1;
      if (depth === 0) return curator.slice(open, i + 1);
    }
  }
  throw new Error("함수 본문 끝을 못 찾았다");
}

check("★내용을 지어내지 않는다(요청 문구와 실행 id 만)", () => {
  const body = hookBody();
  assert.match(body, /ctx\.experienceIntake\?\.taskHint/, "요청 문구를 쓰지 않는다");
  assert.match(body, /evidence_refs: \[runId\]/, "증거로 실행 id 를 달지 않는다");
  /*
   * ★종류는 "경험이 될 수 있는 것"이어야 한다.
   *
   * 첫 판은 `fact` 로 저장했다. 관측 사실이라는 뜻으로는 맞지만, 수집은 운영 종류
   * (procedure/decision/risk)만 후보로 만든다(store.ts 의 operationalKinds). 그래서 기억은
   * 쌓이는데 칩은 영원히 0이었다 — 이 훅이 고치려던 병이 한 칸 뒤로 밀렸을 뿐이다.
   * 종류 이름을 못박지 않고, 수집이 실제로 받는 집합에 속하는지 본다.
   */
  const kind = body.match(/memory_kind: "([^"]+)"/)?.[1];
  const operational = experienceStore.match(/const operationalKinds = new Set\(\[([^\]]+)\]\)/)?.[1] ?? "";
  assert.ok(kind, "저장할 기억 종류가 없다");
  assert.ok(
    operational.includes(`"${kind}"`),
    `호스트 기록이 "${kind}" 로 저장되는데 수집은 ${operational} 만 후보로 만든다 — 기억은 쌓여도 칩은 0이 된다`,
  );
  assert.ok(!/replyText|cleanedText/.test(body),
    "모델의 답을 요약해 넣는다 — 그건 모델이 할 일이고, 호스트가 하면 지어내는 것이다");
});

check("★근거가 없으면 아무것도 만들지 않는다", () => {
  const body = hookBody();
  assert.match(body, /if \(!runId\) return \[\]/, "실행 id 없이도 기록한다");
  assert.match(body, /if \(!ctx\.agentId\) return \[\]/, "주인 없는 기억을 만든다");
  assert.match(body, /hint\.length < 12/, "빈 내용도 기억으로 쌓는다 — 0건보다 나쁘다");
});

check("★출처가 구분된다(모델이 낸 것과 섞이지 않는다)", () => {
  const body = hookBody();
  assert.match(body, /source: "host-observed"/, "호스트 관측임을 표시하지 않는다");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
