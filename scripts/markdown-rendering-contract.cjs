#!/usr/bin/env node
/*
 * 답변 렌더링 계약.
 *
 * 여기 있는 규칙은 전부 실측에서 나왔다. 라이브러리를 붙였는데 화면에는 아무것도 안
 * 나오던 이유가 매번 "붙이는 곳"이 아니라 "닿는 길"에 있었기 때문이다.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const md = fs.readFileSync(path.join(root, "renderer/components/Markdown.tsx"), "utf8");

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); failed++; }
}

console.log("markdown-rendering-contract");

/*
 * ★matcher 목록과 "다음 특수문자 점프표"는 함께 움직여야 한다.
 *
 * 실측: 인라인 수식 matcher 를 정확한 정규식으로 추가하고도 화면에 전혀 나오지 않았다.
 * 매칭 실패 시 커서를 다음 특수문자로 옮기는 search() 목록에 `$` 가 없어서, 커서가
 * `$` 에 닿지 못했고 matcher 는 시험조차 되지 않았다. 정규식이 옳아도 도달하지 못하면
 * 죽은 코드다.
 */
check("★인라인 문법 문자는 점프표에도 있어야 한다(도달하지 못하면 죽은 코드)", () => {
  const jump = md.match(/const next = remaining\.search\(([^\n]+)\);/);
  assert.ok(jump, "점프표(search) 를 못 찾았다 — 탐지가 깨졌다");
  const table = jump[1];
  // matcher 가 첫 글자로 삼는 문자들
  for (const [label, ch] of [["인라인 코드", "`"], ["강조", "*"], ["이미지", "!"], ["링크", "["], ["수식", "$"]]) {
    assert.ok(table.includes(ch === "$" ? "$" : ch), `${label} 문자 ${ch} 가 점프표에 없다`);
  }
});

check("★mermaid 코드블록은 그림으로 그린다", () => {
  assert.match(md, /=== "mermaid"/, "mermaid 언어 분기가 없다");
  assert.match(md, /<MermaidBlock/, "MermaidBlock 을 쓰지 않는다");
});

check("★그리지 못하면 원문을 잃지 않는다(fallback)", () => {
  assert.match(md, /fallback=\{<CodeBlock/, "mermaid 렌더 실패 시 코드블록으로 되돌아가지 않는다");
  const mb = fs.readFileSync(path.join(root, "renderer/components/MermaidBlock.tsx"), "utf8");
  assert.match(mb, /return <>\{fallback\}<\/>/, "실패 경로가 fallback 을 렌더하지 않는다");
});

check("★생성된 SVG 는 위생 처리를 거친다", () => {
  const mb = fs.readFileSync(path.join(root, "renderer/components/MermaidBlock.tsx"), "utf8");
  assert.match(mb, /dompurify/, "DOMPurify 를 쓰지 않는다");
  assert.match(mb, /sanitize\(/, "sanitize 를 호출하지 않는다");
  const purifyIdx = mb.indexOf("sanitize(");
  const htmlIdx = mb.indexOf("dangerouslySetInnerHTML");
  assert.ok(purifyIdx >= 0 && purifyIdx < htmlIdx, "위생 처리 없이 innerHTML 에 넣는다");
});

check("★수식은 블록·인라인 두 형태를 모두 안다", () => {
  assert.match(md, /oneLineMath/, "한 줄 $$...$$ 를 처리하지 않는다 — 모델은 대부분 이 형태로 낸다");
  assert.match(md, /type: "math"/, "블록 수식 타입이 없다");
  assert.match(md, /<MathSpan/, "MathSpan 을 쓰지 않는다");
});

/*
 * ★금액을 수식으로 먹으면 안 된다.
 *
 * "$100 에서 $200" 은 흔한 문장이고, 이것을 수식으로 잡으면 두 금액이 화면에서 사라진다.
 * 수식을 못 그리는 것보다 사람이 쓴 숫자를 지우는 쪽이 훨씬 나쁘다.
 */
check("★금액 표기($100 …)는 수식으로 먹히지 않는다", () => {
  const m = md.match(/regex: (\/\^\\\$[^\n]+?\/),\n\s*render/);
  assert.ok(m, "인라인 수식 정규식을 못 찾았다");
  // eslint-disable-next-line no-eval
  const re = eval(m[1]);
  assert.equal(re.test("$100 에서 $200 이 되었다"), false, "금액 문장이 수식으로 매칭된다");
  assert.ok(re.test("$m$ 이 커지면"), "단일 변수 수식이 매칭되지 않는다");
  assert.ok(re.test("$E = mc^2$ 다"), "일반 수식이 매칭되지 않는다");
});

check("★KaTeX 스타일이 앱에 실려 있다(폰트 없이는 글자가 흩어진다)", () => {
  const layout = fs.readFileSync(path.join(root, "renderer/app/layout.tsx"), "utf8");
  assert.match(layout, /katex\/dist\/katex\.min\.css/, "KaTeX CSS 를 불러오지 않는다");
});

check("★렌더 라이브러리는 초기 번들이 아니라 필요할 때 불러온다", () => {
  const mb = fs.readFileSync(path.join(root, "renderer/components/MermaidBlock.tsx"), "utf8");
  const ms = fs.readFileSync(path.join(root, "renderer/components/MathSpan.tsx"), "utf8");
  // 계약은 "정적 import 가 없고 동적 import 가 있다" — 감싸는 형태(Promise.all 등)는 자유다.
  assert.ok(!/^import .*beautiful-mermaid/m.test(mb), "mermaid 를 정적 import 한다(초기 번들에 실린다)");
  assert.match(mb, /import\("beautiful-mermaid"\)/, "mermaid 를 동적으로 불러오지 않는다");
  assert.ok(!/^import .*"katex"/m.test(ms), "katex 를 정적 import 한다(초기 번들에 실린다)");
  assert.match(ms, /import\("katex"\)/, "katex 를 동적으로 불러오지 않는다");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
