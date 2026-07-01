#!/usr/bin/env node
// splitStreamingSegments 회귀 테스트 — 스트리밍 세그먼트 분할의 불변식 검증.
// 실행: npm run build:electron && node scripts/test-streaming-segments.cjs
const assert = require("node:assert/strict");
const { splitStreamingSegments } = require("../dist/shared/streaming-segments.js");

// 세그먼트를 이어 붙이면 항상 원문과 같아야 한다(내용 무손실).
function joined(segments, tailless) {
  return segments.join("");
}

// 1) 빈 텍스트
{
  const { segments, cache } = splitStreamingSegments("", null);
  assert.deepEqual(segments, []);
  assert.equal(cache.tailStart, 0);
}

// 2) 단락 하나(미완결) — 통째로 tail
{
  const { segments } = splitStreamingSegments("hello world", null);
  assert.deepEqual(segments, ["hello world"]);
}

// 3) 빈 줄 경계에서 완결 세그먼트로 잘림
{
  const { segments, cache } = splitStreamingSegments("para one\n\npara two", null);
  assert.deepEqual(segments, ["para one\n\n", "para two"]);
  assert.equal(cache.closed.length, 1);
  assert.equal(joined(segments), "para one\n\npara two");
}

// 4) 펜스 코드블록 내부 빈 줄은 자르지 않는다
{
  const text = "```js\ncode();\n\nmore();\n```\n\nafter";
  const { segments } = splitStreamingSegments(text, null);
  assert.equal(segments.length, 2);
  assert.equal(segments[0], "```js\ncode();\n\nmore();\n```\n\n");
  assert.equal(segments[1], "after");
  assert.equal(joined(segments), text);
}

// 5) append-only 증분 — 캐시 재사용으로 closed가 유지되고 재분할 결과가 동일
{
  let r = splitStreamingSegments("a\n\nb", null);
  assert.deepEqual(r.segments, ["a\n\n", "b"]);
  r = splitStreamingSegments("a\n\nb c d\n\ne", r.cache);
  assert.deepEqual(r.segments, ["a\n\n", "b c d\n\n", "e"]);
  // 처음부터 다시 계산한 것과 동일해야 한다
  const fresh = splitStreamingSegments("a\n\nb c d\n\ne", null);
  assert.deepEqual(r.segments, fresh.segments);
}

// 6) 비-append 변화(재동기화) — 캐시 무시하고 전체 재계산
{
  const first = splitStreamingSegments("hello\n\nworld", null);
  const changed = splitStreamingSegments("different text", first.cache);
  assert.deepEqual(changed.segments, ["different text"]);
}

// 7) 연속 빈 줄 — 공백-만 세그먼트를 만들지 않는다
{
  const { segments } = splitStreamingSegments("a\n\n\n\nb", null);
  assert.equal(joined(segments), "a\n\n\n\nb");
  for (const s of segments) assert.notEqual(s.trim(), "");
}

// 8) 열린 펜스(미완결 코드블록)는 tail에 통째로 남는다
{
  const text = "intro\n\n```py\nprint(1)\n\nprint(2)\n";
  const { segments } = splitStreamingSegments(text, null);
  assert.equal(segments[0], "intro\n\n");
  assert.equal(segments[1], "```py\nprint(1)\n\nprint(2)\n");
}

// 9) 증분으로 펜스가 닫힌 뒤 빈 줄이 오면 그제야 잘린다
{
  let r = splitStreamingSegments("```\nx\n", null);
  r = splitStreamingSegments("```\nx\n```\n\nnext", r.cache);
  assert.deepEqual(r.segments, ["```\nx\n```\n\n", "next"]);
}

// 10) 대량 증분 스트림 시뮬레이션 — 청크 누적 결과가 항상 무손실 & fresh와 동일
{
  const chunks = [
    "# Title\n", "\n", "First paragraph grows", " and grows.\n", "\n",
    "- item 1\n", "- item 2\n", "\n", "```ts\n", "const a = 1;\n", "\n",
    "const b = 2;\n", "```\n", "\n", "Closing thoughts ", "streamed in ", "pieces.",
  ];
  let acc = "";
  let cache = null;
  for (const c of chunks) {
    acc += c;
    const r = splitStreamingSegments(acc, cache);
    cache = r.cache;
    assert.equal(joined(r.segments), acc, "무손실 불변식 위반");
    const fresh = splitStreamingSegments(acc, null);
    assert.deepEqual(r.segments, fresh.segments, "캐시/fresh 결과 불일치");
  }
}

console.log("test-streaming-segments: 10/10 PASS");
