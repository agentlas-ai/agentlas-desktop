#!/usr/bin/env node
// 사이트 스튜디오 M4 게이트 — select-to-edit 루프의 결정적 절반(LLM 제외).
// 검증: 선택 id → 소스 범위 재해석 → 모델 응답(부분 블록/전체 문서) 적용 → 계약 검증.
// "선택한 버튼 텍스트 변경" 왕복이 splice 수준에서 정확함을 증명한다.
const assert = require("node:assert/strict");

const { resolveSiteSelection, applySiteEditReply, extractElementBlockFromReply } = require("../dist/electron/site/generate.js");
const { tagSiteHtml } = require("../dist/electron/site/html-tagger.js");

const SOURCE = [
  "<!doctype html>",
  "<html><head><title>t</title><style>.cta{color:#fff}</style></head>",
  "<body>",
  "<main>",
  '<button class="cta">시작하기</button>',
  "<p>설명 문단</p>",
  "</main>",
  "</body></html>",
].join("\n");

// 렌더러가 실제로 받는 선택 id는 태거가 부여한 것 — 그대로 재현.
const { elements } = tagSiteHtml(SOURCE);
const buttonEl = elements.find((e) => e.tagName === "button");
assert.ok(buttonEl, "button must be taggable");

// ── resolveSiteSelection ───────────────────────────────────
const selection = resolveSiteSelection(SOURCE, buttonEl.id);
assert.ok(selection, "selection id must resolve against the current source");
assert.equal(selection.tagName, "button");
assert.equal(SOURCE.slice(selection.start, selection.end), '<button class="cta">시작하기</button>');
assert.equal(resolveSiteSelection(SOURCE, "a999999"), null, "unknown id must resolve to null");
assert.equal(resolveSiteSelection(SOURCE, null), null, "no id → null");

// ── 부분 patch: 선택한 버튼의 텍스트/스타일 변경 ─────────────
const patchReply = [
  "요청하신 대로 버튼을 키우고 주황색으로 바꿨습니다.",
  "```html",
  '<button class="cta" style="font-size:18px;background:#e8590c">지금 시작하기</button>',
  "```",
].join("\n");
const patched = applySiteEditReply(SOURCE, selection, patchReply, "agy");
assert.equal(patched.ok, true, `patch must apply: ${patched.reason ?? ""}`);
assert.equal(patched.mode, "patch", "selection + element block → partial patch");
assert.ok(patched.html.includes("지금 시작하기"), "button text must change");
assert.ok(patched.html.includes("#e8590c"), "button style must change");
assert.ok(patched.html.includes("<p>설명 문단</p>"), "rest of the document must be untouched");
// splice가 정확히 그 범위만 바꿨는지: 앞뒤 조각이 바이트 동일.
assert.equal(patched.html.slice(0, selection.start), SOURCE.slice(0, selection.start), "prefix must be identical");
assert.ok(patched.html.endsWith(SOURCE.slice(selection.end)), "suffix must be identical");
// patch 결과도 다시 태깅 가능(다음 선택 라운드).
const retagged = tagSiteHtml(patched.html);
const retagIds = retagged.elements.map((e) => e.id);
assert.equal(new Set(retagIds).size, retagIds.length, "patched html must retag with unique ids");

// ── 전체 문서 폴백 ──────────────────────────────────────────
const FULL = "<!doctype html><html><head><style>body{margin:0}</style></head><body><h1>새 화면</h1></body></html>";
const full = applySiteEditReply(SOURCE, selection, "전체를 다시 짰습니다.\n```html\n" + FULL + "\n```", "codex");
assert.equal(full.ok, true);
assert.equal(full.mode, "full", "full document reply → full replacement");
assert.equal(full.html, FULL);

// 선택이 없으면 부분 블록은 무의미 — 전체 문서만 허용.
const noSelection = applySiteEditReply(SOURCE, null, "```html\n<button>x</button>\n```", "agy");
assert.equal(noSelection.ok, false, "element block without selection must be rejected");

// ── 계약 위반 patch 거부 ────────────────────────────────────
const evilReply = "```html\n<button class=\"cta\"><img src=\"https://cdn.x/a.png\">시작</button>\n```";
const evil = applySiteEditReply(SOURCE, selection, evilReply, "agy");
assert.equal(evil.ok, false, "patch that injects external resources must be rejected");

// 잘못된 태그 블록(선택은 button인데 div 반환) → 부분 patch 불성립.
assert.equal(extractElementBlockFromReply("```html\n<div>x</div>\n```", "button"), null, "wrong-tag block must not match");
// 닫히지 않은 블록도 불성립.
assert.equal(extractElementBlockFromReply("```html\n<button>x\n```", "button"), null, "unclosed block must not match");

console.log("site studio select-to-edit contract ok");
