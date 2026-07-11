#!/usr/bin/env node
// 대화 컨텍스트 리셋 계약: /clear는 visible history뿐 아니라 CLI resume 포인터도
// 없애고, /new는 main-owned 작업 폴더만 안전하게 이어받아야 한다.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-chat-session-reset-"));
  const userData = path.join(temp, "user-data");
  const workspace = path.join(temp, "workspace");
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  app.setPath("userData", userData);
  process.env.AGENTLAS_STORE_PATH = path.join(userData, "test.sqlite");

  const db = require("../dist/electron/store/db.js");
  const chats = require("../dist/electron/store/chats.js");
  const sessions = require("../dist/electron/store/runtime-sessions.js");
  db.initStore();
  const now = new Date().toISOString();
  db.getDb().prepare(
    `INSERT INTO installed_agents
      (id, slug, name, tagline, system_prompt, mcp_servers_json, preferred_backend, trust_grade, installed_at, tone)
     VALUES (?, ?, ?, ?, '', '[]', NULL, 'local', ?, 'neutral')`,
  ).run("agent-session-reset", "agent-session-reset", "Session Reset", "test", now);

  const source = chats.createChat({ agentId: "agent-session-reset", title: "Original workspace chat" });
  chats.setChatWorkingFolder(source.id, workspace);
  chats.appendChatMessage(source.id, "user", "This conversation will be cleared");
  sessions.saveRuntimeSession(source.id, "codex", "thread-codex", "fp-codex");
  sessions.saveRuntimeSession(source.id, "claude-code", "thread-claude", "fp-claude");

  const fresh = chats.createChat({ agentId: "agent-session-reset", continueFromChatId: source.id });
  assert.equal(chats.getChatWorkingFolder(fresh.id), workspace, "new session must retain the approved workspace without renderer path input");
  assert.deepEqual(chats.listChatMessages(fresh.id), [], "new session must start with no message history");

  // 어느 한쪽 삭제가 실패하면 transaction 전체가 rollback되어, 빈 화면이
  // 예전 provider session을 재개하는 부분 성공이 절대 생기지 않아야 한다.
  db.getDb().exec(`
    CREATE TEMP TRIGGER abort_chat_context_clear
    BEFORE DELETE ON chat_messages
    BEGIN
      SELECT RAISE(ABORT, 'injected chat clear failure');
    END;
  `);
  assert.throws(() => chats.clearChatContext(source.id), /injected chat clear failure/);
  assert.equal(chats.listChatMessages(source.id).length, 1, "failed clear must preserve visible history");
  assert.equal(sessions.getRuntimeSession(source.id, "codex")?.sessionId, "thread-codex", "failed clear must roll back the resume-pointer delete");
  db.getDb().exec("DROP TRIGGER abort_chat_context_clear");

  chats.clearChatContext(source.id);
  assert.deepEqual(chats.listChatMessages(source.id), [], "clear must remove visible message history");
  assert.equal(sessions.getRuntimeSession(source.id, "codex"), null, "clear must remove the Codex resume pointer");
  assert.equal(sessions.getRuntimeSession(source.id, "claude-code"), null, "clear must remove every runtime resume pointer");
  assert.equal(chats.getChatWorkingFolder(source.id), workspace, "clear must retain the selected workspace");

  const inputSource = fs.readFileSync(path.join(__dirname, "..", "renderer/components/ChatInput.tsx"), "utf8");
  const chatPageSource = fs.readFileSync(path.join(__dirname, "..", "renderer/app/(shell)/chat/page.tsx"), "utf8");
  const receiptSource = fs.readFileSync(path.join(__dirname, "..", "renderer/components/ChatRightPanel.tsx"), "utf8");
  const ipcSource = fs.readFileSync(path.join(__dirname, "..", "electron/ipc.ts"), "utf8");
  const receiptStateSource = fs.readFileSync(path.join(__dirname, "..", "renderer/lib/run-receipt-state.ts"), "utf8");
  const ts = require("typescript");
  const receiptStateCompiled = ts.transpileModule(receiptStateSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const receiptStateModule = { exports: {} };
  new Function("exports", "module", receiptStateCompiled)(receiptStateModule.exports, receiptStateModule);
  const { receiptAutoExpanded } = receiptStateModule.exports;
  assert.match(inputSource, /data-chat-context-menu="true"/, "context meter must expose visible session actions");
  assert.doesNotMatch(inputSource, /contextOwnerLabel/, "composer must not show a misleading Runtime owner label");
  assert.match(chatPageSource, /continueFromChatId: chat\.id/, "new-session command must carry forward the current workspace through main-owned state");
  assert.match(chatPageSource, /setSessionNotice\(/, "clear action must visibly acknowledge the reset");
  assert.match(chatPageSource, /setRecap\(null\)/, "clear action must remove a stale recap banner");
  assert.match(chatPageSource, /steerQueueRef\.current = \[\]/, "clear action must invalidate queued steering before it can drain");
  assert.match(chatPageSource, /recapGenerationRef\.current \+= 1/, "clear action must invalidate an in-flight recap response");
  assert.match(chatPageSource, /const requestGeneration = \+\+recapGenerationRef\.current/, "a later visibility return must be able to start a fresh recap after clear");
  assert.match(chatPageSource, /requestGeneration === recapGenerationRef\.current/, "only the newest recap response may update the banner");
  assert.match(ipcSource, /clearChatContext\(chatId\)/, "IPC clear must use the atomic message-and-session boundary");
  assert.match(ipcSource, /activeChatIds\(\)\.includes\(chatId\)/, "main must reject clear while the chat still owns a live or cancelling run");
  assert.match(receiptSource, /aria-expanded=\{expanded\}/, "run receipts must collapse after completion instead of permanently consuming panel space");
  assert.equal(receiptAutoExpanded(true, "running"), true, "an active receipt must expand");
  assert.equal(receiptAutoExpanded(false, "completed"), false, "running to completed must collapse automatically");
  assert.equal(receiptAutoExpanded(false, "failed"), true, "a failed receipt must remain expanded for recovery");
  assert.match(receiptSource, /\[busy, receipt\?\.runId, receipt\?\.status\]/, "manual reopening after completion must not retrigger auto-collapse from expanded state alone");
  assert.match(receiptSource, /setOpenError\(null\);[\s\S]{0,80}\[receipt\?\.runId\]/, "a new run must not inherit the previous result-folder error");
  assert.doesNotMatch(receiptSource, /<code>\{receipt\.resultFolder\}<\/code>/, "result folder paths must not overflow the receipt card");

  console.log("chat session reset + receipt compactness contract ok");
  db.getDb().close();
  fs.rmSync(temp, { recursive: true, force: true });
}

app.whenReady().then(() => main().then(() => app.quit())).catch((error) => {
  console.error(error);
  app.exit(1);
});
