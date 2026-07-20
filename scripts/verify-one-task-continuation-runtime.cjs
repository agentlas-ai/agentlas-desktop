#!/usr/bin/env node
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function argument(name) {
  const prefix = `${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : null;
}

async function worker() {
  const { app } = require("electron");
  const userData = argument("--user-data");
  if (!userData) throw new Error("worker requires a user-data path");
  app.setPath("userData", userData);
  await app.whenReady();

  const dbStore = require("../dist/electron/store/db.js");
  dbStore.initStore();
  const db = dbStore.getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO installed_agents
       (id, slug, name, tagline, system_prompt, mcp_servers_json, trust_grade, installed_at, tone)
     VALUES (?, ?, ?, ?, '', '[]', 'A', ?, 'neutral')`,
  ).run("one-agent", "agentlas-orchestrator", "One", "Chief of Staff", now);

  const chats = require("../dist/electron/store/chats.js");
  const tasks = require("../dist/electron/store/tasks.js");
  const { continueOneFromTaskResult } = require("../dist/electron/one/task-continuation.js");
  const workingFolder = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-one-follow-up-folder-"));
  const source = chats.createChat({ agentId: "one-agent", title: "공기청정기 비교" });
  chats.setChatWorkingFolder(source.id, workingFolder);
  chats.setChatHiredAgents(source.id, [{
    slug: "borrowed-researcher",
    name: "Borrowed Researcher",
    source: "hub",
    hiredAt: now,
  }]);
  chats.appendChatMessage(source.id, "user", "raw transcript must not cross");
  chats.appendChatMessage(source.id, "assistant", "private raw result must not cross");
  const ready = tasks.setCanonicalTaskStatus(source.taskId, "partial");

  assert.throws(() => continueOneFromTaskResult({
    taskId: ready.id,
    expectedVersion: ready.version - 1,
    userPrompt: "그럼 예산을 30만원으로 낮추면 셋 중 어떤 걸 고르면 돼? 이전 추천과 달라진 이유도 짧게 알려줘.",
    summary: "LG 제품을 우선 추천했습니다.",
    locale: "ko",
  }), /Task changed/);

  const next = continueOneFromTaskResult({
    taskId: ready.id,
    expectedVersion: ready.version,
    userPrompt: "그럼 예산을 30만원으로 낮추면 셋 중 어떤 걸 고르면 돼? 이전 추천과 달라진 이유도 짧게 알려줘.",
    summary: `LG 제품을 우선 추천했습니다. /Users/mason/private sk-${"A".repeat(32)}`,
    locale: "ko",
  });
  assert.equal(next.taskId, undefined, "a follow-up must start Task-free until the new request promotes it");
  assert.equal(next.agentId, source.agentId);
  assert.equal(next.title, "예산을 30만원으로 낮추면 셋 중 어떤 걸 고르면 돼");
  assert.deepEqual(next.hiredAgents, [], "the previous hired roster must not carry into follow-up work");
  assert.equal(chats.getChatWorkingFolder(next.id), workingFolder, "only the approved working folder should carry forward");
  const history = chats.listChatMessages(next.id);
  assert.equal(history.length, 1, "raw transcript history must not be copied");
  assert.equal(history[0].role, "system");
  assert.match(history[0].text, /검토 중인 이전 일에서 이어갑니다/);
  assert.match(history[0].text, /이전 팀·권한·임시 첨부는 자동으로 이어받지 않았어요/);
  assert.doesNotMatch(history[0].text, /raw transcript|private raw result|\/Users\/mason|sk-[A-Z]{20}/);

  const promoted = tasks.getCanonicalTaskForChat(next.id);
  assert.ok(promoted && promoted.id !== ready.id, "the follow-up must promote into its own canonical Task");
  assert.equal(tasks.getCanonicalTask(ready.id).status, "partial", "the source Task must remain unchanged");

  const open = chats.createChat({ agentId: "one-agent", title: "아직 진행 중" });
  const openTask = tasks.getCanonicalTask(open.taskId);
  assert.throws(() => continueOneFromTaskResult({
    taskId: openTask.id,
    expectedVersion: openTask.version,
    userPrompt: "이어가자",
    summary: "아직 결과가 없습니다.",
    locale: "ko",
  }), /result-ready or completed/);

  fs.rmSync(workingFolder, { recursive: true, force: true });
  console.log(JSON.stringify({
    ok: true,
    sourceTaskId: ready.id,
    followUpChatId: next.id,
    followUpTaskId: promoted.id,
    copiedRawTranscript: false,
    copiedTeamOrPermissions: false,
  }));
  db.close();
  app.quit();
}

function orchestrate() {
  const electronModule = require("electron");
  const executable = typeof electronModule === "string" ? electronModule : process.execPath;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-one-follow-up-runtime-"));
  const env = { ...process.env, AGENTLAS_STORE_PATH: path.join(temp, "one.sqlite") };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const result = spawnSync(
      executable,
      [__filename, "--worker", `--user-data=${path.join(temp, "user-data")}`],
      { env, encoding: "utf8" },
    );
    if (result.status !== 0) {
      throw new Error(`One follow-up runtime worker failed (${result.status})\n${result.stdout}\n${result.stderr}`);
    }
    process.stdout.write(result.stdout);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv.includes("--worker")) {
  worker().then(() => process.exit(0)).catch((error) => {
    console.error(error);
    process.exit(1);
  });
} else {
  try {
    orchestrate();
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
