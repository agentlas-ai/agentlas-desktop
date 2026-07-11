#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { app } = require("electron");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-v52-automation-runs-"));
const storePath = path.join(tempDir, "legacy-v51.sqlite");
process.env.AGENTLAS_STORE_PATH = storePath;
app.setPath("userData", path.join(tempDir, "user-data"));

const now = new Date();
const hoursAgo = (hours) => new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString();
const minutesAgo = (minutes) => new Date(now.getTime() - minutes * 60 * 1000).toISOString();

function seedV51Fixture() {
  const db = new Database(storePath);
  db.exec(`
    CREATE TABLE automations (id TEXT PRIMARY KEY);
    CREATE TABLE automation_runs (
      id TEXT PRIMARY KEY,
      automation_id TEXT,
      started_at TEXT,
      status TEXT,
      node_states_json TEXT
    );
    CREATE INDEX idx_automation_runs_auto ON automation_runs(automation_id, started_at);
    CREATE TABLE run_history (
      id TEXT PRIMARY KEY,
      automation_id TEXT,
      scheduled_for TEXT,
      ran_at TEXT,
      status TEXT,
      skipped_count INTEGER DEFAULT 0,
      error TEXT
    );
    CREATE TABLE run_events (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      ts TEXT NOT NULL
    );
    CREATE TABLE failure_events (
      id TEXT PRIMARY KEY,
      run_id TEXT,
      ts TEXT NOT NULL
    );
  `);

  const automationIds = [
    "stale-no-event",
    "stale-old-event",
    "peer-recent-event",
    "peer-recent-failure",
    "recent-start",
    "terminal-ok",
  ];
  const insertAutomation = db.prepare("INSERT INTO automations (id) VALUES (?)");
  for (const id of automationIds) insertAutomation.run(id);

  const insertRun = db.prepare(
    `INSERT INTO automation_runs
       (id, automation_id, started_at, status, node_states_json)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const runningNodes = JSON.stringify({ trigger: "done", worker: "running", output: "pending" });
  insertRun.run("run-stale-no-event", "stale-no-event", hoursAgo(8), "running", runningNodes);
  insertRun.run("run-stale-old-event", "stale-old-event", hoursAgo(8), "running", runningNodes);
  insertRun.run("run-peer-recent-event", "peer-recent-event", hoursAgo(8), "running", runningNodes);
  insertRun.run("run-peer-recent-failure", "peer-recent-failure", hoursAgo(8), "running", runningNodes);
  insertRun.run("run-recent-start", "recent-start", minutesAgo(1), "running", runningNodes);
  insertRun.run("run-terminal-ok", "terminal-ok", hoursAgo(8), "ok", JSON.stringify({ worker: "done" }));
  insertRun.run("run-orphan-running", "deleted-parent", hoursAgo(8), "running", runningNodes);
  insertRun.run("run-orphan-ok", "deleted-parent", hoursAgo(8), "ok", JSON.stringify({ worker: "done" }));

  db.prepare("INSERT INTO run_events VALUES (?, ?, ?)")
    .run("event-old", "run-stale-old-event", hoursAgo(7));
  db.prepare("INSERT INTO run_events VALUES (?, ?, ?)")
    .run("event-peer", "run-peer-recent-event", minutesAgo(1));
  db.prepare("INSERT INTO failure_events VALUES (?, ?, ?)")
    .run("failure-peer", "run-peer-recent-failure", minutesAgo(1));

  const insertHistory = db.prepare(
    `INSERT INTO run_history
       (id, automation_id, scheduled_for, ran_at, status, skipped_count, error)
     VALUES (?, ?, NULL, ?, ?, 0, NULL)`,
  );
  insertHistory.run("history-live", "terminal-ok", hoursAgo(8), "ok");
  insertHistory.run("history-orphan", "deleted-parent", hoursAgo(8), "error");
  insertHistory.run("history-null", null, hoursAgo(8), "error");
  db.pragma("user_version = 51");
  db.close();
}

function freshStoreModule() {
  const modulePath = require.resolve("../dist/electron/store/db.js");
  delete require.cache[modulePath];
  return require(modulePath);
}

function summary(db) {
  return {
    userVersion: db.pragma("user_version", { simple: true }),
    runs: db.prepare("SELECT * FROM automation_runs ORDER BY id").all(),
    history: db.prepare("SELECT * FROM run_history ORDER BY id").all(),
    runEvents: db.prepare("SELECT * FROM run_events ORDER BY id").all(),
    failures: db.prepare("SELECT * FROM failure_events ORDER BY id").all(),
  };
}

function openAndSummarize() {
  const store = freshStoreModule();
  store.initStore();
  const result = summary(store.getDb());
  return { store, result };
}

async function main() {
  seedV51Fixture();
  await app.whenReady();

  const first = openAndSummarize();
  try {
    assert.ok(first.result.userVersion >= 52, "v52 recovery must reach v52 or a later schema");
    assert.equal(first.result.runs.length, 6, "v52 must delete only orphan snapshots");
    assert.deepEqual(
      first.result.history.map((row) => row.id),
      ["history-live"],
      "v52 must delete null/orphan run history while preserving a live parent's history",
    );
    assert.equal(first.result.runEvents.length, 2, "append-only run evidence must be preserved");
    assert.equal(first.result.failures.length, 1, "append-only failure evidence must be preserved");

    const runs = new Map(first.result.runs.map((row) => [row.id, row]));
    for (const id of ["run-stale-no-event", "run-stale-old-event"]) {
      assert.equal(runs.get(id).status, "error", `${id} must recover after prolonged silence`);
      assert.match(runs.get(id).node_states_json, /"worker":"failed"/);
      assert.doesNotMatch(runs.get(id).node_states_json, /"worker":"running"/);
    }
    for (const id of ["run-peer-recent-event", "run-peer-recent-failure", "run-recent-start"]) {
      assert.equal(runs.get(id).status, "running", `${id} must remain owned by the recent/peer process`);
    }
    assert.equal(runs.get("run-terminal-ok").status, "ok", "terminal snapshots must never be rewritten");
  } finally {
    first.store.getDb().close();
  }

  const second = openAndSummarize();
  try {
    assert.deepEqual(second.result, first.result, "reopening v52 immediately must be idempotent and peer-safe");

    const advancedNow = new Date(now.getTime() + 5 * 60 * 60 * 1000);
    assert.equal(
      second.store.recoverStaleAutomationRuns(advancedNow),
      3,
      "periodic recovery must close formerly-recent rows after their silence ceiling expires",
    );
    assert.equal(second.store.recoverStaleAutomationRuns(advancedNow), 0, "recovery must be idempotent");
    const remainingRunning = second.store.getDb()
      .prepare("SELECT COUNT(*) AS n FROM automation_runs WHERE status = 'running'")
      .get().n;
    assert.equal(remainingRunning, 0);
  } finally {
    second.store.getDb().close();
  }

  const peerWriter = new Database(storePath);
  peerWriter.pragma("journal_mode = WAL");
  peerWriter.exec("BEGIN IMMEDIATE");
  try {
    const contendedStore = freshStoreModule();
    assert.doesNotThrow(
      () => contendedStore.initStore(),
      "a healthy peer WAL writer must defer recovery rather than block application boot",
    );
    assert.ok(contendedStore.getDb().pragma("user_version", { simple: true }) >= 52);
    contendedStore.getDb().close();
  } finally {
    peerWriter.exec("ROLLBACK");
    peerWriter.close();
  }

  console.log(JSON.stringify({
    ok: true,
    schema: first.result.userVersion,
    orphanRunsRemoved: 2,
    staleRunsRecovered: 5,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    app.exit(process.exitCode ?? 0);
  });
