#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const chat = fs.readFileSync(path.join(root, "renderer/app/(shell)/chat/page.tsx"), "utf8");
const marketplace = fs.readFileSync(path.join(root, "renderer/app/(shell)/marketplace/page.tsx"), "utf8");

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing section start: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
}

// R3: every terminal/scope boundary must clear the one-shot steering-cancel bit.
const finalBranch = section(chat, '} else if (ev.kind === "final") {', '} else if (ev.kind === "error") {');
assert.match(finalBranch, /steerCancelRef\.current = false;/, "final must clear stale steering cancellation state");
assert.ok(
  finalBranch.indexOf("steerCancelRef.current = false;") < finalBranch.indexOf("setBusy(false);"),
  "final must clear steering state before busy=false can drain the next queued turn",
);

const errorBranch = section(chat, '} else if (ev.kind === "error") {', "\n    },\n    [agent,");
const captureIndex = errorBranch.indexOf("const wasSteer = steerCancelRef.current;");
const resetIndex = errorBranch.indexOf("steerCancelRef.current = false;");
const decisionIndex = errorBranch.indexOf("if (wasSteer)");
assert.ok(captureIndex >= 0 && captureIndex < resetIndex, "error must capture whether this error belongs to steering");
assert.ok(resetIndex < decisionIndex, "error must reset the one-shot flag before rendering or suppressing the error");

const chatSwitchReset = section(chat, "// 채팅 전환 시 이전 채팅의 진행 상태", "// 메타데이터 로드");
assert.match(chatSwitchReset, /steerCancelRef\.current = false;/, "chat switches must not inherit steering state");

const invokeFailure = section(chat, "// invoke 실패 — 미리 건 구독을 정리", "\n        return false;");
assert.match(invokeFailure, /steerCancelRef\.current = false;/, "invoke rejection must clear steering state");

// R4: Hub search, status, and hep-search fallback all belong to one request generation.
assert.match(
  marketplace,
  /const marketplaceSearchGenerationRef = useRef\(0\);/,
  "marketplace search needs a monotonic request generation",
);
assert.match(
  marketplace,
  /const marketplaceSearchAbortRef = useRef<AbortController \| null>\(null\);/,
  "marketplace search needs an AbortController for superseded requests",
);
const initialRefresh = section(marketplace, "async function refresh()", "\n  useEffect(() => {\n    void refresh();");
assert.doesNotMatch(
  initialRefresh,
  /marketplace\.search|setListings|setSourceStatus/,
  "initial metadata refresh must not be a second unguarded writer for marketplace results",
);

const searchEffect = section(
  marketplace,
  "marketplaceSearchAbortRef.current?.abort();",
  "\n  }, [q]);",
);
assert.match(searchEffect, /const controller = new AbortController\(\);/, "each query must own a new abort controller");
assert.match(
  searchEffect,
  /const generation = \+\+marketplaceSearchGenerationRef\.current;/,
  "each query must advance the request generation",
);
assert.match(
  searchEffect,
  /const response = await api\.marketplace\.search\(q\);\s*if \(!isCurrent\(\)\) return;/,
  "late Hub search responses must be ignored",
);
assert.match(
  searchEffect,
  /const status = await api\.marketplace\.status\(\);\s*if \(!isCurrent\(\)\) return;/,
  "late Hub status responses must be ignored",
);
assert.match(searchEffect, /controller\.abort\(\);/, "effect cleanup must abort the superseded query");
assert.match(
  searchEffect,
  /runHepFallback\(query, generation, controller\.signal\)/,
  "fallback search must inherit the same generation and abort signal",
);

const fallback = section(
  marketplace,
  "async function runHepFallback(query: string, generation: number, signal: AbortSignal)",
  "\n  async function bookmarkOne",
);
assert.match(
  fallback,
  /!signal\.aborted && marketplaceSearchGenerationRef\.current === generation/,
  "late fallback responses must be tied to the active request generation",
);
assert.match(
  fallback,
  /if \(!isCurrent\(\) \|\| hepSeqRef\.current !== seq\) return;/,
  "fallback completion must reject both aborted generations and older fallback calls",
);

console.log("test-chat-marketplace-race-guards: PASS");
