#!/usr/bin/env node
// ✳ 상태줄 파이프라인 계약 — 가짜 claude CLI의 stream-json을 러너가
//   · thinking 구간 신호(onThinking start/end + duration)
//   · 라이브 토큰(onUsage, 단조 증가, message_delta 실측 반영)
//   · 글자 델타 스트리밍(onPartial), 도구 호출/결과(onTool), 최종 토큰(result.usage)
// 로 정확히 방출하는지 검증한다. (영상 재현 UX의 데이터 근거 게이트)
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-run-status-"));
  const userData = path.join(temp, "user-data");
  const binDir = path.join(temp, "bin");
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  app.setPath("userData", userData);
  process.env.AGENTLAS_STORE_PATH = path.join(userData, "test.sqlite");
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH || ""}`;

  // 가짜 claude CLI — 라인을 70ms 간격으로 흘려 partial 스로틀(60ms)과
  // thinking duration(>0)을 실제 스트림처럼 재현한다.
  const fakeClaude = path.join(binDir, "claude");
  const script = `#!/usr/bin/env node
if (process.argv.includes("--version")) { console.log("2.0.0 (Claude Code)"); process.exit(0); }
if (process.argv.includes("--help")) { console.log("--effort <level>  low, medium, high"); process.exit(0); }
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { input += c; });
process.stdin.on("end", () => {
  const lines = [
    { type: "system", session_id: "sess-1" },
    { type: "stream_event", event: { type: "message_start" } },
    { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } } },
    { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "궁리 중" } } },
    { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
    { type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "text" } } },
    { type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "기획안 파일을 " } } },
    { type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "먼저 확인해볼게요." } } },
    { type: "stream_event", event: { type: "content_block_stop", index: 1 } },
    { type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 54 } } },
    { type: "assistant", message: { content: [
      { type: "text", text: "기획안 파일을 먼저 확인해볼게요." },
      { type: "tool_use", id: "tu-1", name: "Read", input: { file_path: "/tmp/PRD.md" } },
    ] } },
    { type: "stream_event", event: { type: "message_stop" } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu-1", content: "PRD 본문" }] } },
    { type: "stream_event", event: { type: "message_start" } },
    { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } } },
    { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "더 궁리" } } },
    { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
    { type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "좋은 기획안입니다." } } },
    { type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 121 } } },
    { type: "assistant", message: { content: [{ type: "text", text: "좋은 기획안입니다." }] } },
    { type: "stream_event", event: { type: "message_stop" } },
    // 실제 CLI 의미론: result.result는 '마지막 assistant 메시지'만 담는다 — 러너가
    // finalText로 본문을 교체하면 중간 해설이 소실되는 회귀를 이 픽스처가 잡는다.
    { type: "result", result: "좋은 기획안입니다.", usage: { output_tokens: 175 } },
  ];
  let i = 0;
  const tick = () => {
    if (i >= lines.length) { process.exit(0); return; }
    console.log(JSON.stringify(lines[i]));
    i += 1;
    setTimeout(tick, 70);
  };
  tick();
});
`;
  fs.writeFileSync(fakeClaude, script, { mode: 0o755 });

  const { runClaudeCode } = require("../dist/electron/runtime/claude-code.js");
  const thinking = [];
  const usages = [];
  const partials = [];
  const tools = [];
  const result = await runClaudeCode(
    {
      systemPrompt: "sys",
      history: [],
      userPrompt: "이 기획안 구체화해봐",
      backendLabel: "Claude Code",
      locale: "ko",
    },
    {
      onStatus() {},
      onPartial: (t) => partials.push(t),
      onTool: (name, args, res, id, isErr) => tools.push({ name, args, res, id, isErr }),
      onUsage: (n) => usages.push(n),
      onThinking: (phase, durationMs) => thinking.push({ phase, durationMs }),
    },
  );

  // thinking 구간 2회 — start/end 짝, end에 duration 동봉
  assert.deepEqual(
    thinking.map((t) => t.phase),
    ["start", "end", "start", "end"],
    "thinking start/end pairs",
  );
  assert.ok(thinking[1].durationMs != null && thinking[1].durationMs > 0, "thinking end carries duration");
  // 라이브 토큰 — 단조 증가 + message_delta 실측 반영(54 → 175)
  assert.ok(usages.length >= 2, "usage events emitted");
  for (let i = 1; i < usages.length; i += 1) {
    assert.ok(usages[i] >= usages[i - 1], "usage monotonic");
  }
  assert.ok(usages.includes(54), "first message usage observed");
  assert.equal(usages[usages.length - 1], 175, "final live usage = base(54) + current(121)");
  // 본문 스트리밍 — 델타가 이어붙어 전문이 흐른다
  assert.ok(partials.length >= 2, "partial stream flows");
  assert.ok(partials.some((p) => p.includes("기획안 파일을")), "text deltas streamed");
  // 도구 — tool_use(인자)와 tool_result가 같은 이름으로 이어진다
  assert.ok(tools.some((t) => t.name === "Read" && t.args && t.args.includes("file_path")), "tool_use forwarded");
  assert.ok(tools.some((t) => t.name === "Read" && t.res && t.res.includes("PRD 본문")), "tool_result forwarded");
  // 최종 토큰 + 본문 — 스트리밍 전사본(중간 해설 포함)이 최종본에 보존돼야 한다.
  // (result.result는 마지막 메시지만 담으므로, 그걸 본문으로 삼으면 인터리브가 무너진다)
  assert.equal(result.tokens, 175, "result tokens from usage");
  assert.ok(result.text.includes("좋은 기획안입니다."), "final text intact");
  assert.ok(
    result.text.includes("기획안 파일을 먼저 확인해볼게요."),
    "mid-run commentary preserved in final text (transcript, not last-message swap)",
  );
  console.log("run status stream contract ok");
  app.exit(0);
}

main().catch((err) => {
  console.error(err);
  app.exit(1);
});
