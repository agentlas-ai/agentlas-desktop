#!/usr/bin/env node
/*
 * 구성요소(Loadout) 편집기 계약.
 *
 * 이 섹션은 오래도록 "무엇이 있다/없다"는 배지와 고정 설명 카드뿐이었다. 배관은 이미
 * 있었는데(agentFiles.read/write) 쓸 자리가 없었던 것이다. 그래서 이 계약은 두 가지를
 * 지킨다: 편집기가 실제로 붙어 있는가, 그리고 저장 결과를 지어내지 않는가.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const editor = fs.readFileSync(path.join(root, "renderer/components/AgentFileEditor.tsx"), "utf8");
const page = fs.readFileSync(path.join(root, "renderer/app/(shell)/library/agents/page.tsx"), "utf8");
const preload = fs.readFileSync(path.join(root, "electron/preload.ts"), "utf8");

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); failed++; }
}

console.log("loadout-editor-contract");

check("★구성요소 탭에 편집기가 실제로 붙어 있다", () => {
  assert.match(page, /import \{ AgentFileEditor \}/, "편집기를 import 하지 않는다");
  const tabIdx = page.indexOf('activeTab === "playbook"');
  assert.ok(tabIdx > 0, "구성요소 탭을 못 찾았다");
  const section = page.slice(tabIdx, tabIdx + 1200);
  assert.match(section, /<AgentFileEditor/, "구성요소 탭이 편집기를 렌더하지 않는다 — 컴포넌트만 있고 화면에는 없다");
});

check("★읽기와 쓰기를 모두 쓴다(보기만 하는 뷰어가 아니다)", () => {
  assert.match(editor, /agentFiles\.list\(/, "파일 목록을 불러오지 않는다");
  assert.match(editor, /agentFiles\.read\(/, "파일을 읽지 않는다");
  assert.match(editor, /agentFiles\.write\(/, "파일을 쓰지 않는다 — 편집이 저장되지 않는다");
});

/*
 * ★저장했다는 말은 저장됐을 때만 한다.
 *
 * 첫 판은 저장 후 읽은 값을 loaded 와 draft 양쪽에 넣었다. 그러면 쓰기가 무시돼도 두
 * 값이 같아져 "변경 없음 = 저장됨"으로 보인다 — 저장되지 않은 편집을 저장됐다고 말하는
 * 쪽이 저장 실패보다 나쁘다.
 */
check("★저장 후 디스크를 다시 읽고, 다르면 성공이라 하지 않는다", () => {
  const saveIdx = editor.indexOf("const save = useCallback");
  assert.ok(saveIdx > 0, "저장 경로를 못 찾았다");
  const body = editor.slice(saveIdx, saveIdx + 1800);
  assert.match(body, /agentFiles\.read\(/, "저장 후 되읽기가 없다");
  assert.match(body, /value === intended/, "되읽은 내용과 편집한 내용을 비교하지 않는다");
  const okIdx = body.indexOf('kind: "saved"');
  const cmpIdx = body.indexOf("value === intended");
  assert.ok(cmpIdx > 0 && okIdx > cmpIdx, "비교하기 전에 저장 성공을 표시한다");
});

check("★저장하지 않은 편집을 조용히 버리지 않는다", () => {
  const openIdx = editor.indexOf("const openFile = useCallback");
  const body = editor.slice(openIdx, openIdx + 900);
  assert.match(body, /dirty/, "다른 파일로 옮길 때 미저장 여부를 보지 않는다");
  assert.match(body, /confirm\(/, "미저장 편집이 있어도 확인 없이 버린다");
});

check("★파일이 어디 있는지 화면에 있다", () => {
  assert.match(editor, /rootPath/, "폴더 경로를 보여주지 않는다 — 앱 밖에서 찾을 방법이 없어진다");
});

check("★배관(preload)이 read/write 를 노출한다", () => {
  const idx = preload.indexOf("agentFiles: {");
  const body = preload.slice(idx, idx + 500);
  assert.match(body, /read:/, "preload 에 read 가 없다");
  assert.match(body, /write:/, "preload 에 write 가 없다");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
