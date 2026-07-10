#!/usr/bin/env node
// 사이트 스튜디오 M3 게이트 — 태거/렌더 준비/계약 검증 계약 테스트.
// 핵심 불변식: (1) 태깅은 원본과 시각적으로 동일(주입 속성 제거 시 바이트 동일),
// (2) id = "a"+소스오프셋이며 소스 범위를 정확히 가리킨다, (3) 렌더 HTML엔
// 네트워크 차단 CSP와 nonce 오버레이가 주입된다.
const assert = require("node:assert/strict");

const { tagSiteHtml, prepareSiteRenderHtml, SITE_PREVIEW_CSP } = require("../dist/electron/site/html-tagger.js");
const { validateSiteScreenHtml, extractSiteHtmlFromReply } = require("../dist/shared/site-studio.js");

const SOURCE = [
  "<!doctype html>",
  '<html lang="ko">',
  "<head>",
  "<meta charset=\"utf-8\">",
  "<title>테스트 화면</title>",
  "<style>.hero{color:#123}</style>",
  "</head>",
  "<body>",
  '<header class="top" data-x="a > b">',
  "<h1>안녕하세요</h1>",
  '<img src="data:image/svg+xml,x" alt="로고">',
  "</header>",
  "<main>",
  '<button class="cta" aria-label="시작">시작하기</button>',
  "<svg viewBox=\"0 0 10 10\"><rect width=\"10\" height=\"10\"/></svg>",
  "<script>var s = \"<div>가짜 태그</div>\";<\/script>",
  "<p>본문",
  "</main>",
  "</body>",
  "</html>",
].join("\n");

// ── tagSiteHtml ─────────────────────────────────────────────
const { taggedHtml, elements } = tagSiteHtml(SOURCE);

// 1) 시각 동등성: 주입 속성만 제거하면 원본과 완전 동일.
assert.equal(taggedHtml.replace(/ data-agentlas-id="a\d+"/g, ""), SOURCE, "tagging must be visually equivalent");

// 2) id 유일성 + 오프셋 계약.
const ids = elements.map((e) => e.id);
assert.equal(new Set(ids).size, ids.length, "ids must be unique");
for (const el of elements) {
  assert.equal(el.id, `a${el.start}`, "id must encode the source offset");
  assert.equal(SOURCE[el.start], "<", "start must point at the open tag");
  const slice = SOURCE.slice(el.start, el.end);
  assert.ok(new RegExp(`^<${el.tagName}[\\s>/]`, "i").test(slice), `range of ${el.id} must start with <${el.tagName}>`);
}

// 3) 메타/구조 태그는 태깅 제외, body 콘텐츠는 포함.
const tags = elements.map((e) => e.tagName);
for (const banned of ["html", "head", "meta", "title", "style", "script"]) {
  assert.ok(!tags.includes(banned), `${banned} must not be tagged`);
}
for (const expected of ["body", "header", "h1", "img", "button", "svg", "rect", "p"]) {
  assert.ok(tags.includes(expected), `${expected} must be tagged`);
}

// 4) 개별 범위 검증: button 요소 범위가 정확히 그 블록이다.
const button = elements.find((e) => e.tagName === "button");
assert.equal(SOURCE.slice(button.start, button.end), '<button class="cta" aria-label="시작">시작하기</button>');
// void 요소(img)는 open tag까지가 범위.
const img = elements.find((e) => e.tagName === "img");
assert.ok(SOURCE.slice(img.start, img.end).endsWith(">"), "void element range ends at open tag");
assert.ok(!SOURCE.slice(img.start, img.end).includes("</img"), "void element has no close tag");
// 자기닫힘 svg rect.
const rect = elements.find((e) => e.tagName === "rect");
assert.ok(SOURCE.slice(rect.start, rect.end).endsWith("/>"), "self-closing range ends at />");
// raw-text: script 내부 "<div>"는 요소로 파싱되지 않는다.
assert.ok(!tags.includes("div"), "tags inside raw-text script must not be parsed");
// 따옴표 안의 ">"(data-x="a > b")가 태그를 조기 종료시키지 않는다.
const header = elements.find((e) => e.tagName === "header");
assert.ok(SOURCE.slice(header.start, header.end).includes("<h1>"), "quoted '>' must not break attribute scanning");
// 미닫힘 <p>는 상위가 닫힐 때 회복된다.
const p = elements.find((e) => e.tagName === "p");
assert.ok(p.end <= SOURCE.length && p.end > p.start, "unclosed <p> must recover a range");

// ── prepareSiteRenderHtml ───────────────────────────────────
const NONCE = "test-nonce-1234";
const { renderHtml, elements: renderElements } = prepareSiteRenderHtml(SOURCE, NONCE);
assert.equal(renderElements.length, elements.length, "render prep must reuse the tagger");
assert.ok(renderHtml.includes(SITE_PREVIEW_CSP), "CSP meta must be injected");
assert.ok(renderHtml.includes("default-src 'none'"), "CSP must block network by default");
assert.ok(renderHtml.indexOf("Content-Security-Policy") < renderHtml.indexOf("<body"), "CSP must live in <head>");
assert.ok(renderHtml.includes('data-agentlas-overlay="1"'), "overlay script must be injected");
assert.ok(renderHtml.includes(JSON.stringify(NONCE)), "overlay must be nonce-scoped");
// 오버레이는 <head> 최상단(CSP 직후)에 주입 — 디자인 스크립트의 파싱 시점 오류까지 후킹.
const overlayAt = renderHtml.indexOf('data-agentlas-overlay="1"');
assert.ok(overlayAt > renderHtml.indexOf("Content-Security-Policy"), "overlay must follow the CSP meta");
assert.ok(overlayAt < renderHtml.indexOf("<body"), "overlay must be injected in <head>, before any body script runs");
// fiber/_debugSource 의존 금지(React 19 계약) — 오버레이는 data-agentlas-id만 쓴다.
assert.ok(!renderHtml.includes("_debugSource"), "overlay must not rely on React fiber internals");

// ── validateSiteScreenHtml (디자인 전용 계약) ────────────────
assert.equal(validateSiteScreenHtml(SOURCE).ok, true, "contract doc must validate");
const reject = (html, label) => {
  const res = validateSiteScreenHtml(html);
  assert.equal(res.ok, false, `${label} must be rejected`);
};
reject('<!doctype html><html><head><script src="https://cdn.x/a.js"></script></head><body>x</body></html>', "external script");
reject('<!doctype html><html><head><link rel="stylesheet" href="https://cdn.x/a.css"></head><body>x</body></html>', "external stylesheet");
reject('<!doctype html><html><body><img src="https://x.y/a.png"></body></html>', "external image");
reject('<!doctype html><html><head><style>@import "a.css";</style></head><body>x</body></html>', "css @import");
reject('<!doctype html><html><body><iframe src="a"></iframe></body></html>', "iframe");
reject("<!doctype html><html><head></head></html>", "missing body");
reject("", "empty document");
// 앵커의 외부 href는 리소스 로드가 아니므로 허용(샌드박스가 네비게이션 차단).
assert.equal(
  validateSiteScreenHtml('<!doctype html><html><body><a href="https://x.y">링크</a></body></html>').ok,
  true,
  "external anchor href must be allowed",
);

// ── extractSiteHtmlFromReply ────────────────────────────────
const DOC = "<!doctype html><html><body><p>ok</p></body></html>";
assert.equal(extractSiteHtmlFromReply("```html\n" + DOC + "\n```"), DOC, "fenced doc");
assert.equal(extractSiteHtmlFromReply(DOC), DOC, "raw doc");
assert.equal(extractSiteHtmlFromReply("서론 텍스트\n" + DOC + "\n감사합니다"), DOC, "prose-wrapped doc");
assert.equal(extractSiteHtmlFromReply("문서가 없습니다"), null, "no doc → null");

console.log(`site studio tagging contract ok (${elements.length} tagged elements)`);
