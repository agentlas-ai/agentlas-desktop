#!/usr/bin/env node
// One turn work block — Codex-parity contract (owner decision 2026-08-15).
//
// What this guards (rules, not code shapes):
//   1. Every turn keeps its process: one block per run, drawn after the prompt
//      that started it and before the answer it produced (Paseo/Codex keep it,
//      the old single-Activity design lost every previous turn's process).
//   2. Rows are what the runtime actually did, in Codex vocabulary — reads/lists/
//      searches fold into "Explored", a command is "Ran <cmd>", a patch is
//      "Edited file (+n −m)"; no fixed paraphrase list.
//   3. The live headline is the model's latest thought headline (its own words),
//      falling back to the running row's verb — never a hard-coded status.
//   4. Reasoning text streams as its own protocol row (start/delta/end + text) and
//      the ledger keeps the span's summary so a reopened thread still shows it.
//   5. The answer stays the answer: the Markdown message is never hidden behind
//      a result card, and Main persists the model's text, not a "ready" floor.
//
// Run: node scripts/qa-one-turn-work-contract.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

// Load renderer/shared TS with `@shared/*` and relative imports resolved to source.
const cache = new Map();
function loadTs(rel) {
  const file = path.join(root, rel);
  if (cache.has(file)) return cache.get(file);
  const source = fs.readFileSync(file, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: file,
  }).outputText;
  const loaded = new Module(file, module);
  loaded.filename = file;
  loaded.paths = Module._nodeModulePaths(path.dirname(file));
  const originalRequire = loaded.require.bind(loaded);
  loaded.require = (request) => {
    if (request.startsWith("@shared/")) return loadTs(`shared/${request.slice("@shared/".length)}.ts`);
    if (request.startsWith("./") && !request.endsWith(".json")) {
      const target = path.relative(root, path.join(path.dirname(file), request));
      const candidate = fs.existsSync(path.join(root, `${target}.ts`)) ? `${target}.ts` : `${target}.tsx`;
      return loadTs(candidate);
    }
    return originalRequire(request);
  };
  cache.set(file, loaded.exports);
  loaded._compile(output, file);
  return loaded.exports;
}

const shellParse = loadTs("shared/exploratory-shell.ts");
const turnWork = loadTs("renderer/lib/one-turn-work.ts");
const threadWork = loadTs("renderer/lib/one-thread-work.ts");
const activity = loadTs("renderer/lib/one-activity.ts");

let checks = 0;
const check = (name, fn) => {
  fn();
  checks += 1;
  process.stdout.write(`  ✓ ${name}\n`);
};

// ── 1. shell parsing (Codex parse_command subset) ─────────────────────────
check("zsh -lc wrapper is stripped and read/list segments classified", () => {
  const parsed = shellParse.parseShellCommand("/bin/zsh -lc 'ls -la && cat README.md'");
  assert.deepEqual(parsed.map((s) => s.op), ["list", "read"]);
  assert.equal(parsed[1].name, "README.md");
  assert.equal(shellParse.isExploratoryShellCommand("/bin/zsh -lc 'ls -la && cat README.md'"), true);
});
check("sed -n range and rg are exploration; sed -i and npm test are runs", () => {
  assert.equal(shellParse.parseShellCommand("sed -n '1,80p' src/foo.ts")[0].op, "read");
  assert.equal(shellParse.parseShellCommand("sed -n '1,80p' src/foo.ts")[0].name, "foo.ts");
  const search = shellParse.parseShellCommand("rg -n 'needle' src")[0];
  assert.equal(search.op, "search");
  assert.equal(search.query, "needle");
  assert.equal(search.path, "src");
  assert.equal(shellParse.parseShellCommand("sed -i '' 's/a/b/' x.ts")[0].op, "run");
  assert.equal(shellParse.isExploratoryShellCommand("npm test"), false);
  assert.equal(shellParse.isExploratoryShellCommand("pwd && ls"), false, "one unknown segment makes the whole line a Ran");
});
check("a pipe into wc/head after exploration stays exploration", () => {
  assert.equal(shellParse.isExploratoryShellCommand("rg -l foo | head -20"), true);
});

// ── 2. presentation: grouping, headline, verbs ─────────────────────────────
const t0 = "2026-08-15T12:00:00.000Z";
const at = (offsetMs) => new Date(Date.parse(t0) + offsetMs).toISOString();
function reduceAll(events) {
  let state = activity.initialOneActivityState();
  events.forEach((event, index) => {
    state = activity.reduceOneActivity(state, { sequence: index + 1, observedAt: at(index * 1000), ...event });
  });
  return state;
}

check("consecutive reads/searches fold into one Explored cell with merged names", () => {
  const state = reduceAll([
    { kind: "lifecycle", lifecycle: { phase: "start", cwd: "/w" } },
    { kind: "tool-use", tool: { name: "Read", id: "a", args: JSON.stringify({ file_path: "/w/src/a.ts" }), result: "ok" } },
    { kind: "tool-use", tool: { name: "Read", id: "b", args: JSON.stringify({ file_path: "/w/src/b.ts" }), result: "ok" } },
    { kind: "tool-use", tool: { name: "Grep", id: "c", args: JSON.stringify({ pattern: "foo", path: "/w/src" }), result: "1 match" } },
    { kind: "tool-use", tool: { name: "Bash", id: "d", args: JSON.stringify({ command: "npm test" }), result: "exit 0" } },
  ]);
  const p = turnWork.buildOneWorkPresentation(state, "ko", null);
  const kinds = p.cells.map((c) => c.kind);
  assert.deepEqual(kinds, ["explore", "run"], JSON.stringify(kinds));
  assert.equal(p.cells[0].entries[0].op, "read");
  assert.equal(p.cells[0].entries[0].label, "a.ts, b.ts", "reads coalesce like Codex");
  assert.equal(p.cells[0].entries[1].op, "search");
  assert.match(p.cells[0].entries[1].label, /foo in src/, "paths are relative to the run cwd");
  assert.equal(p.cells[1].command, "npm test");
  assert.equal(turnWork.cellVerb(p.cells[0], "ko"), "탐색함");
  assert.equal(turnWork.cellVerb(p.cells[1], "en"), "Ran");
});

check("a tool completion without args keeps the start event's command on the live row", () => {
  const state = reduceAll([
    { kind: "tool-use", tool: { name: "Bash", id: "k", args: JSON.stringify({ command: "npm test" }) } },
    { kind: "tool-use", tool: { name: "Bash", id: "k", result: "ok" } },
  ]);
  const row = state.items.find((item) => item.id === "tool:k");
  assert.equal(row.status, "completed");
  assert.match(row.tool.args, /npm test/, "completion must not wipe the start event's args");
  const p = turnWork.buildOneWorkPresentation(state, "en", null);
  assert.equal(p.cells[0].command, "npm test");
});

check("an edit becomes Edited with its diff stat; a write is Wrote", () => {
  const state = reduceAll([
    { kind: "tool-use", tool: { name: "Edit", id: "e", args: JSON.stringify({ file_path: "/w/x.ts", old_string: "a\nb", new_string: "a\nc\nd" }), result: "ok" } },
    { kind: "tool-use", tool: { name: "Write", id: "f", args: JSON.stringify({ file_path: "/w/y.txt", content: "hi" }), result: "ok" } },
  ]);
  const p = turnWork.buildOneWorkPresentation(state, "en", "/w");
  assert.equal(p.cells.length, 1, "consecutive edits fold into one Edited cell");
  assert.equal(p.cells[0].kind, "edit");
  assert.equal(p.cells[0].files.length, 2);
  assert.equal(p.cells[0].files[0].path, "x.ts");
  assert.ok(p.cells[0].files[0].added >= 1 && p.cells[0].files[0].removed >= 1);
  assert.equal(turnWork.cellVerb(p.cells[0], "en"), "Edited");
});

check("the model's thought headline drives the live headline; verbs are the fallback", () => {
  const running = reduceAll([
    { kind: "lifecycle", lifecycle: { phase: "start" } },
    { kind: "reasoning", reasoning: { phase: "start" } },
    { kind: "reasoning", reasoning: { phase: "delta", text: "**Planning applypatch creation**\n" } },
  ]);
  const p = turnWork.buildOneWorkPresentation(running, "ko", null);
  assert.equal(p.running, true);
  assert.equal(p.headline, "Planning applypatch creation", "headline is the model's own summary, emphasis stripped");
  assert.equal(p.cells[0].kind, "thought");
  const toolRunning = reduceAll([
    { kind: "lifecycle", lifecycle: { phase: "start" } },
    { kind: "tool-use", tool: { name: "Bash", id: "z", args: JSON.stringify({ command: "npm test" }) } },
  ]);
  const q = turnWork.buildOneWorkPresentation(toolRunning, "ko", null);
  assert.equal(q.headline, "실행하는 중 · npm test");
  const bare = reduceAll([{ kind: "lifecycle", lifecycle: { phase: "start" } }]);
  assert.equal(turnWork.buildOneWorkPresentation(bare, "en", null).headline, "Working");
});

check("reasoning end carries the span text and a replay without start still keeps the thought", () => {
  const state = reduceAll([
    { kind: "reasoning", reasoning: { phase: "start" } },
    { kind: "reasoning", reasoning: { phase: "delta", text: "first " } },
    { kind: "reasoning", reasoning: { phase: "end", durationMs: 2500, text: "first second" } },
    { kind: "reasoning", reasoning: { phase: "end", durationMs: 10, text: "**Confirming answer**" } },
  ]);
  const thoughts = state.items.filter((item) => item.kind === "reasoning");
  assert.equal(thoughts.length, 2);
  assert.equal(thoughts[0].text, "first second", "end text replaces the accumulated deltas");
  assert.equal(thoughts[0].status, "completed");
  assert.equal(thoughts[1].text, "**Confirming answer**", "an end-only span (ledger replay / codex summary) is kept");
  const p = turnWork.buildOneWorkPresentation(state, "en", null);
  assert.equal(p.cells[1].headline, "Confirming answer");
});

check("a turn with neither thought nor tool still shows one row: the answer", () => {
  const state = reduceAll([
    { kind: "lifecycle", lifecycle: { phase: "start" } },
    { kind: "partial", delta: "hello", textLen: 5 },
    { kind: "final", textLen: 12 },
  ]);
  const p = turnWork.buildOneWorkPresentation(state, "ko", null);
  assert.equal(p.cells.length, 1);
  assert.equal(p.cells[0].kind, "answer");
  assert.equal(p.cells[0].chars, 12);
  assert.equal(p.terminal, "completed");
  assert.equal(turnWork.cellVerb(p.cells[0], "ko"), "답변 작성함");
});

check("compaction is a divider outside the block; a failed run marks the header", () => {
  const state = reduceAll([
    { kind: "lifecycle", lifecycle: { phase: "start" } },
    { kind: "notice", notice: { level: "info", message: "컨텍스트가 자동으로 압축됨", display: "divider" } },
    { kind: "error", error: { code: "runtime_error", message: "boom" } },
  ]);
  const p = turnWork.buildOneWorkPresentation(state, "ko", null);
  assert.equal(p.dividers.length, 1);
  assert.equal(p.cells.filter((c) => c.kind === "notice").length, 0);
  assert.equal(p.terminal, "failed");
});

check("a Codex mcp_tool_call envelope reads as a connected tool, never the raw envelope name", () => {
  const state = reduceAll([
    { kind: "tool-use", tool: { name: "mcp_tool_call", id: "m", args: JSON.stringify({ server: "notion", tool: "search" }), result: "ok" } },
    { kind: "tool-use", tool: { name: "mcp_tool_call", id: "n", result: "ok" } },
  ]);
  const p = turnWork.buildOneWorkPresentation(state, "en", null);
  assert.equal(p.cells[0].kind, "call");
  assert.equal(p.cells[0].label, "notion · search");
  assert.equal(p.cells[1].label, turnWork.CONNECTED_TOOL_LABEL);
  assert.equal(turnWork.cellVerb(p.cells[0], "en"), "Called");
});

// ── 3. thread plan: which prompt owns which run ────────────────────────────
check("a run is anchored after its own prompt row (durable rows: prompt persisted just after start)", () => {
  const runs = [
    { runId: "r1", startedAt: at(500), status: "completed", state: activity.initialOneActivityState() },
    { runId: "r2", startedAt: at(60_500), status: "completed", state: activity.initialOneActivityState() },
  ];
  const messages = [
    { id: "u1", role: "user", createdAt: at(900) },
    { id: "a1", role: "assistant", createdAt: at(30_000) },
    { id: "u2", role: "user", createdAt: at(60_900) },
    { id: "a2", role: "assistant", createdAt: at(90_000) },
  ];
  const plan = threadWork.planOneThreadWork({ messages, runs });
  assert.deepEqual(plan.afterMessage.get("u1").map((r) => r.runId), ["r1"]);
  assert.deepEqual(plan.afterMessage.get("u2").map((r) => r.runId), ["r2"]);
  assert.equal(plan.leading.length, 0);
});
check("optimistic rows stamped just before the run start anchor the same way", () => {
  const runs = [{ runId: "r1", startedAt: at(500), status: "running", state: activity.initialOneActivityState() }];
  const messages = [{ id: "u1", role: "user", createdAt: at(200) }, { id: "one-live-response", role: "assistant" }];
  const plan = threadWork.planOneThreadWork({ messages, runs });
  assert.deepEqual(plan.afterMessage.get("u1").map((r) => r.runId), ["r1"]);
});
check("a session-only conversation (client-stamped rows) anchors each run to its own prompt, not the next", () => {
  // renderer stamps the prompt ~300ms before Main's invoke_started; the next
  // turn's prompt is 40s later — the nearest prompt row wins.
  const runs = [
    { runId: "r1", startedAt: at(300), status: "completed", state: activity.initialOneActivityState() },
    { runId: "r2", startedAt: at(40_300), status: "completed", state: activity.initialOneActivityState() },
  ];
  const messages = [
    { id: "u1", role: "user", createdAt: at(0) },
    { id: "one-answer:r1", role: "assistant", createdAt: at(30_000) },
    { id: "u2", role: "user", createdAt: at(40_000) },
    { id: "one-answer:r2", role: "assistant", createdAt: at(70_000) },
  ];
  const plan = threadWork.planOneThreadWork({ messages, runs });
  assert.deepEqual(plan.afterMessage.get("u1").map((r) => r.runId), ["r1"]);
  assert.deepEqual(plan.afterMessage.get("u2").map((r) => r.runId), ["r2"]);
});
check("rows without timestamps fall back to the last prompt row; the live run is excluded", () => {
  const runs = [
    { runId: "old", startedAt: at(0), status: "completed", state: activity.initialOneActivityState() },
    { runId: "live", startedAt: at(5000), status: "running", state: activity.initialOneActivityState() },
  ];
  const messages = [{ id: "u1", role: "user" }, { id: "a1", role: "assistant" }, { id: "u2", role: "user" }];
  const plan = threadWork.planOneThreadWork({ messages, runs, excludeRunId: "live" });
  assert.deepEqual(plan.afterMessage.get("u2").map((r) => r.runId), ["old"]);
  assert.equal([...plan.afterMessage.values()].flat().some((r) => r.runId === "live"), false);
});

// ── 4. wiring contracts (source) ───────────────────────────────────────────
const shell = read("renderer/components/one/OneShell.tsx");
const turnWorkView = read("renderer/components/one/OneTurnWork.tsx");
check("OneShell draws one block per turn and never hides the Markdown answer", () => {
  assert.match(shell, /\{blocksAfter\.map\(\(block\) => \([\s\S]{0,180}!activeTaskforce && <OneTurnWork/, "settled direct turns must render their own work block");
  assert.match(shell, /\{blocksAfter\.map\(\(block\) => \([\s\S]{0,1200}activeTaskforce && <OneTaskforceConversation/, "settled Taskforce turns must render teammate messages instead of machine receipts");
  assert.match(shell, /\{liveBefore && !preflightPrompt && <>[\s\S]{0,100}\{liveWorkBlock\}/, "the live block sits before the streaming answer");
  assert.match(shell, /api\.runLedger\.chatTimeline\(chatId/, "past turns are projected from the ledger");
  assert.match(shell, /const visibleText = visibleOneMessageText\(message\);/, "the answer renders as written");
  assert.doesNotMatch(shell, /dedicatedResultMessageId|narrativeResultMessage/, "no result card may replace the answer");
  assert.match(shell, /className=\{styles\.systemTurn\}/, "One's own system prompts are quiet lines, not alert bars");
  assert.match(shell, /message\.id\.startsWith\("one-steer:"\)/, "optimistic next-instruction rows are reconciled with their durable twin");
});
check("the block collapses to Codex's Worked-for line and shimmers while live", () => {
  assert.match(turnWorkView, /동안 작업` : `Worked for/);
  assert.match(turnWorkView, /styles\.shimmer/);
  assert.match(read("renderer/components/one/OneTurnWork.module.css"), /@keyframes oneWorkShimmer[\s\S]*background-position: 100% 0;[\s\S]*background-position: -20% 0;/, "the light sweeps left→right");
  assert.match(turnWorkView, /setExpanded\(active\)/, "a settled block collapses; a running one opens");
});
check("reasoning text is a typed protocol row: runtimes emit it, Main persists the span, mobile gets a bounded copy", () => {
  assert.match(read("shared/types.ts"), /reasoning\?: \{ phase: "start" \| "delta" \| "end"; durationMs\?: number; text\?: string \}/);
  assert.match(read("electron/runtime/claude-code.ts"), /events\.onThinking\?\.\("delta", undefined, delta\.thinking\)/, "Claude thinking deltas stream as reasoning text");
  assert.match(read("electron/runtime/codex.ts"), /model_reasoning_summary=auto/, "Codex reasoning summaries must be switched on");
  assert.match(read("electron/runtime/codex.ts"), /ev\.item\?\.type === "reasoning"[\s\S]*?onThinking\?\.\("delta", undefined/, "Codex summary text streams as reasoning text");
  assert.match(read("electron/runtime/acp.ts"), /agent_thought_chunk[\s\S]*?onThinking\?\.\("delta", undefined, thought\)/, "ACP thought chunks stream as reasoning text");
  assert.match(read("electron/runtime/local-tool-loop.ts"), /reasoning_content \?\? delta\?\.reasoning \?\? delta\?\.thinking/, "OpenAI-compatible local runtimes stream their thinking field");
  assert.match(read("electron/mcp/client.ts"), /reasoningSpanText/, "Main accumulates the span for the end event");
  assert.match(read("electron/store/run-events.ts"), /reasoningText: ev\.reasoning\?\.phase === "end" \? ev\.reasoning\?\.text : undefined/, "the ledger keeps the span summary");
  assert.match(read("electron/store/run-events.ts"), /toolArgs: ev\.tool\?\.args,\s*toolResultPreview: ev\.tool\?\.result/, "the ledger keeps bounded tool evidence for reopened threads");
  assert.match(read("electron/mobile-bridge/authority.ts"), /boundedRedactedText\(event\.reasoning\.text, 2_000\)/, "the phone gets a bounded, redacted copy on end only");
  assert.match(read("electron/invocation/service.ts"), /event\.reasoning\?\.phase === "delta"[\s\S]*?record\.events\[record\.events\.length - 1\] = \{/, "delta chatter is coalesced in the replay buffer");
});
check("no wording judgments: compaction is the typed display flag, a stop is a typed code or cancel_requested", () => {
  const lib = read("renderer/lib/one-turn-work.ts") + read("renderer/lib/one-activity.ts");
  assert.doesNotMatch(lib, /압축\|compact|\/cancel\|중지\|중단\//, "no regex over notice/error wording");
  assert.match(read("renderer/lib/one-turn-work.ts"), /item\.noticeDisplay === "divider"/);
  const wordedOnly = reduceAll([
    { kind: "lifecycle", lifecycle: { phase: "start" } },
    { kind: "notice", notice: { level: "info", message: "컨텍스트가 자동으로 압축됨" } },
    { kind: "error", error: { code: "runtime_error", message: "실행이 중지되었습니다" } },
  ]);
  const p = turnWork.buildOneWorkPresentation(wordedOnly, "ko", null);
  assert.equal(p.dividers.length, 0, "a plain notice whose words mention compaction is still a row");
  assert.equal(p.terminal, "failed", "an error whose message says 중지 is not a user stop without the typed fact");
  const typedStop = reduceAll([
    { kind: "lifecycle", lifecycle: { phase: "start" } },
    { kind: "lifecycle", lifecycle: { phase: "cancel_requested" } },
    { kind: "error", error: { code: "runtime_error", message: "x" } },
  ]);
  assert.equal(turnWork.buildOneWorkPresentation(typedStop, "ko", null).terminal, "cancelled");
});

check("agy forwards tool parameters and output; Main keeps the model's answer text", () => {
  assert.match(read("electron/runtime/antigravity.ts"), /events\.onTool\?\.\(step\.tool\.name, step\.tool\.args, step\.tool\.result, step\.tool\.id, step\.tool\.failed\)/);
  assert.match(read("electron/mcp/client.ts"), /const modelText = surfaceParse\.cleanedText\.trim\(\);\s*displayText = modelText\s*\|\| deterministicOneCompletionCopy/, "the persisted assistant message is the model's text whenever it wrote one");
  assert.match(read("electron/one/markdown-surface.ts"), /allowBulletShape: judgedIntent === "product-comparison"/, "bold key/value bullets become a product table only on a model verdict");
});

process.stdout.write(`One turn work contract: PASS (${checks} checks)\n`);
