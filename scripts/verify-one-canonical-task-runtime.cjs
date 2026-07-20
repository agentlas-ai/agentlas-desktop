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
  const storePath = argument("--store");
  const userData = argument("--user-data");
  if (!storePath || !userData) throw new Error("worker requires store and user-data paths");
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
  ).run("one-agent", "one-owner", "One", "Chief of Staff", now);
  db.prepare(
    `INSERT INTO installed_agents
       (id, slug, name, tagline, system_prompt, mcp_servers_json, trust_grade, installed_at, tone)
     VALUES (?, ?, ?, ?, '', '[]', 'A', ?, 'neutral')`,
  ).run("worker-agent", "research-worker", "Research", "Worker", now);

  const chats = require("../dist/electron/store/chats.js");
  const tasks = require("../dist/electron/store/tasks.js");
  const oneSurfaceResults = require("../dist/electron/store/one-surface-results.js");
  const runEvents = require("../dist/electron/store/run-events.js");
  const {
    attachOneSurfaceProjection,
    invocationEventPromotesTask,
    terminalTaskStatus,
  } = require("../dist/electron/invocation/service.js");

  assert.equal(invocationEventPromotesTask({ kind: "final", text: "A direct answer" }), false);
  assert.equal(invocationEventPromotesTask({ kind: "partial", text: "Thinking" }), false);
  assert.equal(invocationEventPromotesTask({ kind: "tool-use", status: "Calling local runtime..." }), false);
  assert.equal(invocationEventPromotesTask({ kind: "tool-use", tool: { name: "Read", args: "{}", id: "tool-1" } }), true);
  assert.equal(invocationEventPromotesTask({ kind: "surface", surfaceId: "surface_1" }), true);
  assert.equal(invocationEventPromotesTask({ kind: "thinking", agentId: "worker-agent" }), true);
  assert.equal(invocationEventPromotesTask({ kind: "thinking", phase: "delegate" }), true);
  assert.equal(
    invocationEventPromotesTask({ kind: "final", text: "<<agentlas-ask>>{}<</agentlas-ask>>" }),
    true,
  );
  assert.equal(
    terminalTaskStatus({ kind: "final", requestsDecision: false, cancelled: false, hasPartialText: true }),
    "partial",
    "a runtime final is result-ready, not verified Task completion",
  );
  assert.equal(
    terminalTaskStatus({ kind: "final", requestsDecision: true, cancelled: false, hasPartialText: true }),
    "waiting-decision",
  );

  const root = chats.createChat({ agentId: "one-agent", title: "Launch review" });
  assert.match(root.taskId, /^task_/);
  const first = tasks.getCanonicalTaskForChat(root.id);
  assert.ok(first);
  assert.equal(first.id, root.taskId);
  assert.ok(Number.isSafeInteger(first.version) && first.version > 0);
  assert.equal(first.originChatId, root.id);
  assert.equal(first.title, "Launch review");
  assert.equal(first.status, "open");
  assert.deepEqual(first.participants.map((item) => item.agentSlug), ["one-owner"]);

  const division = chats.createChat({
    agentId: "worker-agent",
    title: "Research role",
    kind: "division",
    parentChatId: root.id,
  });
  assert.equal(division.taskId, root.taskId);
  const withWorker = tasks.getCanonicalTask(root.taskId);
  assert.deepEqual(
    new Set(withWorker.participants.map((item) => item.agentSlug)),
    new Set(["one-owner", "research-worker"]),
  );
  assert.ok(
    withWorker.version > first.version,
    "adding a participant must advance the canonical Task version",
  );

  chats.renameChat(root.id, "Launch risk review");
  const renamed = tasks.getCanonicalTask(root.taskId);
  assert.equal(renamed.title, "Launch risk review");
  assert.ok(renamed.version > withWorker.version);
  const initiallyCompleted = tasks.setCanonicalTaskStatus(root.taskId, "completed");
  assert.ok(initiallyCompleted.version > renamed.version);
  assert.equal(chats.getChat(root.id).taskId, root.taskId);
  assert.equal(tasks.getCanonicalTask(root.taskId).status, "completed");

  chats.archiveChat(root.id);
  assert.equal(tasks.getCanonicalTask(root.taskId).status, "archived");
  chats.unarchiveChat(root.id);
  assert.equal(tasks.getCanonicalTask(root.taskId).status, "open");

  const listed = tasks.listCanonicalTasks({ limit: 10 });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, root.taskId);

  chats.removeChat(division.id);
  assert.ok(tasks.getCanonicalTask(root.taskId), "deleting a worker projection must preserve the Task");
  chats.removeChat(root.id);
  assert.equal(tasks.getCanonicalTask(root.taskId), null, "deleting the origin chat deletes its Task");

  const conversation = chats.createChat({
    agentId: "one-agent",
    title: "Quick question",
    taskMode: "conversation",
  });
  assert.equal(conversation.taskId, undefined, "general conversation must not manufacture a Task");
  assert.equal(tasks.findCanonicalTaskForChat(conversation.id), null);
  assert.equal(tasks.listCanonicalTasks({ limit: 10 }).length, 0, "listing Tasks must not promote a conversation");
  const promoted = tasks.getCanonicalTaskForChat(conversation.id);
  assert.ok(promoted, "an explicit work signal promotes the same conversation to a Task");
  assert.equal(promoted.originChatId, conversation.id);
  assert.equal(chats.getChat(conversation.id).taskId, promoted.id);
  const secret = `sk-${"A".repeat(32)}`;
  const surfaceEvent = attachOneSurfaceProjection({
    kind: "surface",
    surfaceId: "surface_runtime_test",
    surface: {
      version: "0.1",
      kind: "surface",
      title: "Runtime comparison",
      domain: "test",
      layout: "table",
      data: {
        comparison: {
          type: "table",
          columns: ["name", "note"],
          rows: [{ name: "A", note: `/Users/mason/private ${secret}` }],
        },
      },
      widgets: [{ type: "table", data: "comparison", title: "Comparison" }],
    },
  }, conversation.id, "2026-07-18T00:00:00.000Z");
  assert.equal(surfaceEvent.oneSurface.taskId, promoted.id);
  assert.equal(surfaceEvent.oneSurface.blocks[0].type, "Table");
  assert.equal(JSON.stringify(surfaceEvent.oneSurface).includes(secret), false);
  assert.equal(JSON.stringify(surfaceEvent.oneSurface).includes("/Users/mason"), false);
  const resultReady = tasks.setCanonicalTaskStatus(promoted.id, "partial");
  const accepted = tasks.acceptCanonicalTaskResult({
    taskId: promoted.id,
    expectedVersion: resultReady.version,
    expectedRunId: "run_acceptance_receipt",
  }, {
    runId: "run_acceptance_receipt",
    chatId: conversation.id,
    status: "completed",
    startedAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:01:00.000Z",
    finishedAt: "2026-07-18T00:01:00.000Z",
    eventCount: 4,
  });
  assert.equal(accepted.status, "completed", "explicit receipt-bound user acceptance completes the Task");
  assert.ok(
    accepted.version > resultReady.version,
    "result acceptance must advance version even when both writes share a wall-clock millisecond",
  );
  assert.throws(
    () => tasks.acceptCanonicalTaskResult({
      taskId: promoted.id,
      expectedVersion: resultReady.version,
      expectedRunId: "run_acceptance_receipt",
    }, null),
    /Only a result-ready partial Task|Task changed/,
  );
  const pairingTask = tasks.ensurePairingVerificationTask(
    "host_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "2026-07-18T00:00:00.000Z",
    "device_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  );
  assert.equal(
    pairingTask.id,
    "task_pairing_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  );
  assert.equal(pairingTask.version, Date.parse("2026-07-18T00:00:00.000Z"));
  assert.equal(
    tasks.listCanonicalTasks({ limit: 10 }).some((item) => item.id === pairingTask.id),
    false,
    "system pairing Tasks must stay out of the user Task list",
  );
  chats.removeChat(conversation.id);
  assert.equal(tasks.getCanonicalTask(promoted.id), null);

  const durableChat = chats.createChat({ agentId: "one-agent", title: "Durable OneSurface restart probe" });
  const durableTask = tasks.getCanonicalTaskForChat(durableChat.id);
  const durableEvent = attachOneSurfaceProjection({
    kind: "surface",
    surfaceId: "surface_durable_restart_probe",
    surface: {
      version: "0.1",
      kind: "surface",
      title: "Durable comparison",
      domain: "test",
      layout: "table",
      data: {
        comparison: {
          type: "table",
          columns: ["name", "score"],
          rows: [{ name: "A", score: 91 }, { name: "B", score: 84 }],
        },
      },
      widgets: [{ type: "table", data: "comparison", title: "Comparison" }],
    },
  }, durableChat.id, "2026-07-18T02:00:00.000Z");
  assert.ok(durableEvent.oneSurface);
  const durableSnapshot = oneSurfaceResults.recordDurableOneSurfaceResult({
    runId: "run_one_surface_restart_probe",
    chatId: durableChat.id,
    manifest: durableEvent.oneSurface,
  });
  assert.deepEqual(durableSnapshot.manifest, durableEvent.oneSurface, "the durable write must not recompose the Main manifest");
  assert.deepEqual(
    oneSurfaceResults.getDurableOneSurfaceResult({
      runId: "run_one_surface_restart_probe",
      chatId: durableChat.id,
      taskId: durableTask.id,
    }).manifest,
    durableEvent.oneSurface,
  );
  const genericLedgerRows = runEvents.listRunEvents("run_one_surface_restart_probe");
  assert.equal(genericLedgerRows.length, 1);
  assert.equal(genericLedgerRows[0].payload.oneSurfaceJson, undefined, "generic run ledger must not expose the exact manifest");
  assert.equal(genericLedgerRows[0].payload.taskId, durableTask.id);
  const hostile = structuredClone(durableEvent.oneSurface);
  hostile.title = "/srv/agentlas/private/result.html";
  assert.throws(
    () => oneSurfaceResults.recordDurableOneSurfaceResult({
      runId: "run_one_surface_hostile_probe",
      chatId: durableChat.id,
      manifest: hostile,
    }),
    /durable safe contract/,
    "all POSIX absolute roots must fail closed at the persistence boundary",
  );
  assert.equal(db.pragma("foreign_key_check").length, 0);

  console.log(JSON.stringify({ ok: true, taskId: root.taskId, lifecycle: "create-project-archive-delete+conversation-promote" }));
  db.close();
  app.quit();
}

async function verifyReload() {
  const { app } = require("electron");
  const storePath = argument("--store");
  const userData = argument("--user-data");
  if (!storePath || !userData) throw new Error("reload verifier requires store and user-data paths");
  app.setPath("userData", userData);
  await app.whenReady();
  const dbStore = require("../dist/electron/store/db.js");
  dbStore.initStore();
  const db = dbStore.getDb();
  const row = db.prepare("SELECT id FROM chats WHERE title = ? LIMIT 1").get("Durable OneSurface restart probe");
  assert.ok(row?.id, "restart probe chat must survive the first Electron process");
  const tasks = require("../dist/electron/store/tasks.js");
  const oneSurfaceResults = require("../dist/electron/store/one-surface-results.js");
  const task = tasks.findCanonicalTaskForChat(row.id);
  assert.ok(task);
  const restored = oneSurfaceResults.getDurableOneSurfaceResult({
    runId: "run_one_surface_restart_probe",
    chatId: row.id,
    taskId: task.id,
  });
  assert.ok(restored, "a fresh Main process must restore the exact Task/run surface");
  assert.equal(restored.manifest.manifestId, "surface_durable_restart_probe");
  assert.equal(restored.manifest.blocks[0].type, "Table");
  assert.equal(JSON.stringify(restored.manifest).includes("/srv/"), false);
  assert.equal(oneSurfaceResults.getDurableOneSurfaceResult({
    runId: "run_different_receipt",
    chatId: row.id,
    taskId: task.id,
  }), null, "a newer/different run must never inherit an older structured result");
  console.log(JSON.stringify({ ok: true, restoredAfterRestart: true, runId: restored.runId, taskId: restored.taskId }));
  db.close();
  app.quit();
}

function orchestrate() {
  const electronModule = require("electron");
  const executable = typeof electronModule === "string" ? electronModule : process.execPath;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-one-task-runtime-"));
  const env = { ...process.env, AGENTLAS_STORE_PATH: path.join(temp, "one.sqlite") };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const result = spawnSync(
      executable,
      [__filename, "--worker", `--store=${env.AGENTLAS_STORE_PATH}`, `--user-data=${path.join(temp, "user-data")}`],
      { env, encoding: "utf8" },
    );
    if (result.status !== 0) {
      throw new Error(`One Task runtime worker failed (${result.status})\n${result.stdout}\n${result.stderr}`);
    }
    process.stdout.write(result.stdout);
    const reload = spawnSync(
      executable,
      [__filename, "--verify-reload", `--store=${env.AGENTLAS_STORE_PATH}`, `--user-data=${path.join(temp, "user-data-reload")}`],
      { env, encoding: "utf8" },
    );
    if (reload.status !== 0) {
      throw new Error(`OneSurface reload verifier failed (${reload.status})\n${reload.stdout}\n${reload.stderr}`);
    }
    process.stdout.write(reload.stdout);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv.includes("--verify-reload")) {
  verifyReload()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
} else if (process.argv.includes("--worker")) {
  worker()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
} else {
  try {
    orchestrate();
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
