#!/usr/bin/env node
"use strict";
/*
 * 모달은 **나가는 길**이 있어야 한다 — 계약.
 *
 * ★왜 (대화상자 실측 2026-09-08): 단추를 눌러 실제로 대화상자를 열어 보니
 *   - 설정의 "모바일 앱 설치 확인" 은 화면을 통째로 덮는데 닫기 단추도 Escape 도 없었다.
 *     나가는 길은 **어두운 배경을 클릭하는 것 하나뿐** — 아무도 안 알려 준다.
 *   - 사이트의 "앱으로 만들 에이전트 선택" 은 × 는 있는데 Escape 가 안 먹었다(9회 재현).
 *   - AppShell 의 "버그 신고" 도 바깥 클릭만.
 *
 * 이 게이트가 하는 일: aria-modal 을 쓰는 화면 파일에 Escape 처리가 **있는지**.
 *   ★한계를 분명히 적어 둔다 — 이건 문장 대조다. 실제로 닫히는지는
 *   `node scripts/qa-dialog-sweep.cjs` 가 단추를 눌러 확인한다. 이 게이트는
 *   "새로 만든 모달이 아예 Escape 를 안 달았다"를 빨리 잡는 그물일 뿐이다.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
let checks = 0;
const check = (name, fn) => { fn(); checks += 1; process.stdout.write(`  ok  ${name}\n`); };

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== "node_modules" && entry.name !== ".next") walk(full, out); }
    else if (entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/** 주석은 길이를 유지한 채 지운다 — 주석 속 "Escape" 를 처리로 세면 안 된다. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));
}

function hasModalMarkup(src) {
  // A selector string such as '[aria-modal="true"]' observes other modals;
  // it does not create a modal owned by this component.
  return /<[A-Za-z][\w.:-]*\b[^>]*\baria-modal\s*=\s*(?:["']true["']|\{\s*(?:true|["']true["'])\s*\})/.test(src);
}

const files = ["renderer/app", "renderer/components"].flatMap((d) => walk(path.join(root, d)))
  .map((f) => ({ rel: path.relative(root, f), src: stripComments(fs.readFileSync(f, "utf8")) }))
  .filter((f) => hasModalMarkup(f.src));

/*
 * 예외 — 이유가 있는 자리만. 이유 없이 늘리면 이 계약은 장식이 된다.
 */
const EXEMPT = new Map([
  // 이 파일의 모달 껍데기(StageShell)는 부모(PluginPickerDialog)가 Escape 를 쥔다.
  // 키 입력 단계에서만 Escape 를 막는데, 그건 **타이핑한 비밀값을 실수로 날리지 않기**
  // 위한 것이고 "다음에 입력하기" 라는 나가는 길이 화면에 보인다.
  ["renderer/components/plugins/PluginPickerCore.tsx", "부모가 Escape 를 쥔다 + 화면에 보이는 건너뛰기 단추"],
]);

check("★전제 — 모달을 쓰는 화면을 실제로 찾아냈다", () => {
  assert.ok(files.length >= 15, `모달 파일을 ${files.length}개밖에 못 찾았습니다 — 이 게이트가 헛돌고 있습니다`);
});

check("★모달에는 Escape 로 나가는 길이 있다", () => {
  const missing = [];
  for (const file of files) {
    if (EXEMPT.has(file.rel)) continue;
    /*
     * 공용 레이어(useDismissibleLayer)가 Escape·바깥클릭·포커스 복원을 쥔다 —
     * 그걸 쓰는 파일에는 "Escape" 라는 글자가 없는 게 정상이다.
     * (TelegramOneDialog 가 그렇다. 이걸 모르면 멀쩡한 모달을 결함으로 부른다.)
     */
    if (/useDismissibleLayer\s*\(/.test(file.src)) continue;
    if (!/["']Escape["']/.test(file.src)) missing.push(file.rel);
  }
  assert.deepEqual(missing, [], `모달을 여는데 Escape 처리가 없습니다:\n  ${missing.join("\n  ")}`);
});

check("★예외 목록은 실재하는 파일만 담는다", () => {
  const stale = [...EXEMPT.keys()].filter((rel) => !fs.existsSync(path.join(root, rel)));
  assert.deepEqual(stale, [], `없는 파일이 예외로 남아 있습니다: ${stale.join(", ")}`);
  const unused = [...EXEMPT.keys()].filter((rel) => !files.some((f) => f.rel === rel));
  assert.deepEqual(unused, [], `모달이 아닌데 예외에 있습니다(예외를 지우세요): ${unused.join(", ")}`);
});

/* SELFTEST */
check("SELFTEST 주석 속 Escape 는 처리로 세지 않는다", () => {
  const src = stripComments(`// Escape 로 닫아야 한다(아직 안 함)\nconst x = 1;`);
  assert.equal(/["']Escape["']/.test(src), false);
});

check("SELFTEST Escape 없는 모달은 잡힌다", () => {
  const src = stripComments(`<div role="dialog" aria-modal="true">x</div>`);
  assert.ok(hasModalMarkup(src));
  assert.equal(/["']Escape["']/.test(src), false);
});

check("SELFTEST 모달 감지용 CSS 선택자는 모달 선언이 아니다", () => {
  assert.equal(hasModalMarkup(`const selector = '[role="dialog"], [aria-modal="true"]';`), false);
  assert.equal(hasModalMarkup(`<div aria-modal={true}>modal</div>`), true);
  assert.equal(hasModalMarkup(`<div aria-modal={false}>not modal</div>`), false);
});

process.stdout.write(`modals-have-a-way-out: ${checks} checks passed (문장 대조 — 실제 확인은 scripts/qa-dialog-sweep.cjs)\n`);
