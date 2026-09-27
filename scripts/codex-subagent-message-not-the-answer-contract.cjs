#!/usr/bin/env node
/*
 * Codex 하위 에이전트(spawn_agent)의 메시지는 이번 턴의 답이 아니다.
 *
 * 실측(2026-09-27, 설치본 1.2.45, One 단톡 "Youtube launch"): One(Codex gpt-6-luna)이 조사용 하위
 * 에이전트("/root/youtube_niche_research", depth 1)를 띄웠다. 그 하위 스레드는 같은 app-server
 * 연결에서 자기 threadId 로 item/agentMessage 알림을 냈고, 러너가 threadId 를 보지 않아 그 글
 * ("**[Hope]** 공개 자료를 조회해 … 부모 에이전트에 전달했습니다")이 One 이 오너에게 쓴 답(11:53Z)
 * 한가운데에 두 번 끼어들었다. 부모에게는 하위 결과가 별도의 inter-agent 메시지로 이미 간다.
 *
 * 진짜 러너(runCodex)를 가짜 codex app-server 자식 프로세스와 돌린다. 가짜는 기록된 알림 모양을
 * 그대로 낸다: 부모 스레드의 답 + 다른 threadId 의 하위 에이전트 답 + threadId 없는 구형 알림.
 * sqlite 는 쓰지 않는다(순수 node, db 모듈 캐시 스텁).
 *
 * Run:
 *   npx tsc -p electron/tsconfig.json --outDir scripts/local/ytloop-dist --sourceMap false
 *   CODEX_SUBAGENT_DIST=scripts/local/ytloop-dist node scripts/codex-subagent-message-not-the-answer-contract.cjs
 * (CODEX_SUBAGENT_DIST 가 없으면 dist/ 를 쓴다.)
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repo = path.join(__dirname, "..");
const dist = path.join(path.resolve(repo, process.env.CODEX_SUBAGENT_DIST || "dist"), "electron");

const CHILD_TEXT = "**[Hope]** 공개 자료를 조회해 5개 분야의 비교 채널 15개를 부모 에이전트에 전달했습니다.";
const PARENT_TEXT = "채널 설정과 추적표를 준비했습니다.";
const LEGACY_TEXT = " 구형 알림도 우리 답이다.";

const FAKE_CODEX = String.raw`#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) { process.stdout.write("codex-cli 0.157.1-fake\n"); process.exit(0); }
if (args[0] !== "app-server") { process.stderr.write("exec path not supported by this fake\n"); process.exit(2); }
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
let seq = 0;
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined || !m.method) return;
  const reply = (result) => send({ jsonrpc: "2.0", id: m.id, result });
  if (m.method === "initialize") return reply({ userAgent: "fake", codexHome: process.env.CODEX_HOME, platformFamily: "unix", platformOs: "macos" });
  if (m.method === "thread/start") {
    const id = "th-parent";
    reply({ thread: { id, sessionId: id }, model: (m.params && m.params.model) || "fake", modelProvider: "openai", approvalPolicy: m.params && m.params.approvalPolicy, sandbox: m.params && m.params.sandbox, approvalsReviewer: null });
    return notify("thread/started", { thread: { id, sessionId: id } });
  }
  if (m.method === "turn/interrupt") return reply({});
  if (m.method === "turn/start") {
    const threadId = String(m.params && m.params.threadId);
    const turnId = "tn-" + (++seq);
    require("node:fs").appendFileSync(process.env.FAKE_CODEX_LOG, threadId + "\n");
    reply({ turn: { id: turnId, items: [], status: "inProgress", error: null } });
    notify("turn/started", { threadId, turn: { id: turnId, items: [], status: "inProgress" } });
    // The recorded shape: the child thread's own agentMessage on the same connection.
    const child = "th-child-shorts-research";
    notify("thread/started", { thread: { id: child, sessionId: child } });
    notify("item/started", { threadId: child, turnId: "tn-child", item: { type: "agentMessage", id: "msg-child", text: "" } });
    notify("item/agentMessage/delta", { threadId: child, turnId: "tn-child", itemId: "msg-child", delta: ${JSON.stringify(CHILD_TEXT)} });
    notify("item/completed", { threadId: child, turnId: "tn-child", item: { type: "agentMessage", id: "msg-child", text: ${JSON.stringify(CHILD_TEXT)} } });
    notify("turn/completed", { threadId: child, turn: { id: "tn-child", items: [], status: "completed", error: null } });
    // The parent's own answer.
    notify("item/started", { threadId, turnId, item: { type: "agentMessage", id: "msg-parent", text: "" } });
    notify("item/agentMessage/delta", { threadId, turnId, itemId: "msg-parent", delta: ${JSON.stringify(PARENT_TEXT)} });
    notify("item/completed", { threadId, turnId, item: { type: "agentMessage", id: "msg-parent", text: ${JSON.stringify(PARENT_TEXT)} } });
    // An older CLI's notification without threadId is still this turn's.
    notify("item/agentMessage/delta", { turnId, itemId: "msg-legacy", delta: ${JSON.stringify(LEGACY_TEXT)} });
    notify("turn/completed", { threadId, turn: { id: turnId, items: [], status: "completed", error: null } });
    return;
  }
  send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found: " + m.method } });
});
`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-codex-subagent-"));
const binDir = path.join(dir, "bin");
fs.mkdirSync(binDir, { recursive: true });
const shim = path.join(binDir, "codex");
fs.writeFileSync(shim, FAKE_CODEX, { mode: 0o755 });
process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
process.env.AGENTLAS_STORE_PATH = path.join(dir, "agentlas.sqlite");
process.env.CODEX_HOME = path.join(dir, "codex-home");
process.env.FAKE_CODEX_LOG = path.join(dir, "turn-threads.log");
delete process.env.AGENTLAS_DISABLE_RESIDENCY;
fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });

// Pure node: the runner imports the store statically; sqlite is never needed here.
const dbFile = require.resolve(path.join(dist, "store", "db.js"));
require.cache[dbFile] = {
  id: dbFile, filename: dbFile, loaded: true, paths: [],
  exports: {
    STORE_SCHEMA_VERSION: 0, AUTOMATION_RUN_STALE_AFTER_MS: 0, storeSchemaRefusalMessage: () => "",
    runPostContinuityStoreRepairs() {}, openedStorePath: () => null, initStore() {}, recoverStaleAutomationRuns() {},
    getDb() { throw new Error("sqlite intentionally disabled (pure node)"); },
  },
};

const survivors = () => spawnSync("pgrep", ["-f", shim], { encoding: "utf8" }).stdout.split("\n").map((s) => s.trim()).filter(Boolean);

(async () => {
  let failed = false;
  let residency = null;
  try {
    require(path.join(dist, "runtime-paths.js")).setUserDataDir(dir);
    residency = require(path.join(dist, "runtime", "agent-residency.js"));
    const codex = require(path.join(dist, "runtime", "codex.js"));
    const partials = [];
    const result = await codex.runCodex({
      systemPrompt: "contract", history: [], userPrompt: "유튜브 채널 키워줘", backendLabel: "Codex", locale: "ko",
      permission: "read", chatId: "chat-youtube-launch", cwd: dir, env: { ...process.env },
    }, { onPartial: (text) => partials.push(String(text)), onStatus() {}, onTool() {} });
    const text = String(result.text ?? "");
    assert.ok(text.includes(PARENT_TEXT), `the parent's answer is the reply: ${JSON.stringify(text)}`);
    assert.ok(text.includes(LEGACY_TEXT.trim()), "a notification without threadId is still this turn's");
    assert.ok(!text.includes("부모 에이전트에 전달했습니다") && !text.includes("[Hope]"), `the sub-agent's message is not the reply: ${JSON.stringify(text)}`);
    assert.ok(partials.every((partial) => !partial.includes("부모 에이전트에 전달했습니다")), "the sub-agent's message never streams to the owner either");
    console.log("ok   sub-agent thread messages are not One's answer; parent and threadless messages are");
    // The child's thread/started must not take over the session: the next turn continues the parent thread.
    await codex.runCodex({
      systemPrompt: "contract", history: [], userPrompt: "계속", backendLabel: "Codex", locale: "ko",
      permission: "read", chatId: "chat-youtube-launch", cwd: dir, env: { ...process.env },
    }, { onPartial() {}, onStatus() {}, onTool() {} });
    const turnThreads = fs.readFileSync(process.env.FAKE_CODEX_LOG, "utf8").trim().split("\n");
    assert.deepEqual(turnThreads, ["th-parent", "th-parent"], `every turn runs on the parent thread: ${turnThreads}`);
    console.log("ok   a sub-agent's thread/started does not take over the resident session");
  } catch (error) {
    failed = true;
    console.error("codex-subagent-message-not-the-answer-contract: FAIL");
    console.error(error && error.stack ? error.stack : error);
  } finally {
    try { residency?.disposeAgentResidency(); } catch { /* already released */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
    const left = survivors();
    for (const pid of left) { try { process.kill(Number(pid), "SIGKILL"); } catch { /* gone */ } }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* scratch */ }
    if (left.length > 0) { failed = true; console.error(`leftover fake codex processes: ${left.join(",")}`); }
  }
  if (!failed) console.log("codex-subagent-message-not-the-answer-contract: PASS");
  process.exit(failed ? 1 : 0);
})();
