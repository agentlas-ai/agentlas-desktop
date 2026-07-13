#!/usr/bin/env node
// 사이트 스튜디오 M4 게이트 — select-to-edit 루프의 결정적 절반(LLM 제외).
// 검증: 선택 id → 소스 범위 재해석 → 모델 응답(부분 블록/전체 문서) 적용 → 계약 검증.
// "선택한 버튼 텍스트 변경" 왕복이 splice 수준에서 정확함을 증명한다.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { resolveSiteSelection, applySiteEditReply, extractElementBlockFromReply, extractSiteFeedbackFromReply } = require("../dist/electron/site/generate.js");
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

// ── 사용자용 디자인 피드백 block ───────────────────────────
const feedbackReply = [
  "<agentlas-feedback>",
  "CTA를 더 눈에 띄게 만들고, 기존 카드 여백은 유지했습니다.",
  "이 변경은 전환 행동을 더 분명하게 만듭니다.",
  "</agentlas-feedback>",
  "```html",
  '<button class="cta" style="font-size:18px;background:#e8590c">지금 시작하기</button>',
  "```",
].join("\n");
assert.match(extractSiteFeedbackFromReply(feedbackReply), /CTA를 더 눈에 띄게/, "feedback block must be available for the visible Copilot transcript");
const feedbackPatched = applySiteEditReply(SOURCE, selection, feedbackReply, "agy");
assert.equal(feedbackPatched.ok, true, "feedback block before an HTML patch must not break the patch contract");
assert.ok(feedbackPatched.html.includes("지금 시작하기"), "patch still applies after the feedback block");

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

// ── Agent App 편집은 Astryx + main-owned I/O marker를 보존 ─────────────
const agentAppContext = {
  template: "form-two-column",
  contract: {
    schemaVersion: 1,
    source: "declared-package",
    inputs: [
      { name: "topic", type: "string", label: "Topic", description: "", required: true, format: "textarea", options: [], defaultValue: null },
      { name: "sources", type: "string", label: "Sources", description: "", required: false, format: "textarea", options: [], defaultValue: null },
    ],
    outputs: [
      { name: "brief", label: "Brief", type: "markdown", description: "" },
      { name: "citations", label: "Citations", type: "array", description: "" },
    ],
  },
  manifest: {
    app: {
      tools: [{
        parameters: [{ name: "topic" }, { name: "sources" }],
        outputs: [{ name: "brief" }, { name: "citations" }],
      }],
    },
  },
};
const VISUAL_META = [
  '<meta name="agentlas-visual-color-mode" content="light">',
  '<meta name="agentlas-visual-accent" content="teal">',
  '<meta name="agentlas-visual-density" content="comfortable">',
  '<meta name="agentlas-visual-radius" content="soft">',
  '<meta name="agentlas-visual-headline" content="Research with confidence">',
  '<meta name="agentlas-visual-description" content="Turn a question into a cited brief.">',
  '<meta name="agentlas-visual-input-heading" content="Research inputs">',
  '<meta name="agentlas-visual-output-heading" content="Evidence outputs">',
  '<meta name="agentlas-visual-run-label" content="Start research">',
  '<meta name="agentlas-visual-empty-output" content="Results will appear here after the runtime call.">',
].join("");
const ASTRYX_SOURCE = `<!doctype html><html><head><meta name="agentlas-design-system" content="@astryxdesign/core@0.1.4">${VISUAL_META}</head><body data-astryx-template="form-two-column" data-agentlas-agent-app="true" data-agentlas-inputs="topic,sources" data-agentlas-outputs="brief,citations"><main>Agent app</main></body></html>`;
const lostContract = applySiteEditReply(
  ASTRYX_SOURCE,
  null,
  "```html\n<!doctype html><html><head></head><body><main>Re-themed</main></body></html>\n```",
  "web-master",
  agentAppContext,
);
assert.equal(lostContract.ok, false, "Agent App edits must reject removal of Astryx or I/O contract markers");
const keptContract = applySiteEditReply(
  ASTRYX_SOURCE,
  null,
  `\`\`\`html\n${ASTRYX_SOURCE.replace("Agent app", "Polished Agent app")}\n\`\`\``,
  "web-master",
  agentAppContext,
);
assert.equal(keptContract.ok, true, `Agent App edits may change the design while preserving the contract: ${keptContract.reason ?? ""}`);

// 잘못된 태그 블록(선택은 button인데 div 반환) → 부분 patch 불성립.
assert.equal(extractElementBlockFromReply("```html\n<div>x</div>\n```", "button"), null, "wrong-tag block must not match");
// 닫히지 않은 블록도 불성립.
assert.equal(extractElementBlockFromReply("```html\n<button>x\n```", "button"), null, "unclosed block must not match");

const generatorSource = fs.readFileSync(path.join(__dirname, "..", "electron/site/generate.ts"), "utf8");
assert.doesNotMatch(generatorSource, /Now output the single fenced HTML document\./, "final generation instruction must not contradict the required feedback block");
assert.match(generatorSource, /required feedback block followed by the single fenced HTML document/, "generation prompt must keep feedback and HTML in one consistent contract");
assert.match(generatorSource, /Agent App edits must keep the document-level visual snapshot synchronized/, "selected Agent App edits must request a full document");

console.log("site studio select-to-edit contract ok");
