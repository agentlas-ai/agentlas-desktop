#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { app } = require("electron");

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const NEXT_RUN_ID = "22222222-2222-4222-8222-222222222222";
const INTERRUPTED_RUN_ID = "33333333-3333-4333-8333-333333333333";
const START_GATE_FAILURE_RUN_ID = "44444444-4444-4444-8444-444444444444";

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for invocation lifecycle condition");
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-invocation-lifecycle-"));
  const userData = path.join(temp, "user-data");
  const pidFile = path.join(temp, "host-pids.json");
  const resultFolder = path.join(temp, "result-folder");
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(resultFolder, { recursive: true });
  app.setPath("userData", userData);
  process.env.AGENTLAS_STORE_PATH = path.join(userData, "test.sqlite");

  const store = require("../dist/electron/store/db.js");
  const ledger = require("../dist/electron/store/run-events.js");
  const { killCliTree } = require("../dist/electron/runtime/exec.js");
  const {
    InvocationLifecycleRegistry,
    registerDurableInvocationStart,
  } = require("../dist/electron/runtime/invocation-lifecycle.js");
  store.initStore();

  const hostProgram = [
    'const fs = require("node:fs");',
    'const { spawn } = require("node:child_process");',
    'const grand = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
    `fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ root: process.pid, grand: grand.pid }));`,
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const child = spawn(process.execPath, ["-e", hostProgram], {
    detached: process.platform !== "win32",
    stdio: "ignore",
    // This test itself runs under Electron; make child process.execPath act as
    // Node so it represents the CLI adapter process tree.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  const controller = new AbortController();
  controller.signal.addEventListener("abort", () => killCliTree(child, 200), { once: true });

  const registry = new InvocationLifecycleRegistry(32);
  const startedAt = new Date().toISOString();
  registry.register(RUN_ID, {
    controller,
    chatId: "chat-lifecycle",
    startedAt,
    cancelRequestedAt: null,
    events: [],
    partialText: "",
    resultFolder,
  });
  ledger.recordRunEvent({
    runId: RUN_ID,
    kind: "invoke_started",
    chatId: "chat-lifecycle",
    payload: { hasImages: true, borrowAgents: ["qa-hub-agent"] },
  });

  await waitFor(() => fs.existsSync(pidFile));
  const pids = JSON.parse(fs.readFileSync(pidFile, "utf8"));
  assert.equal(isAlive(pids.root), true, "host process must be live before cancel");
  assert.equal(isAlive(pids.grand), true, "host descendant must be live before cancel");

  assert.equal(registry.requestCancel(RUN_ID, "2026-07-10T00:00:01.000Z"), "requested");
  ledger.recordRunEvent({ runId: RUN_ID, kind: "invoke_cancel_requested", chatId: "chat-lifecycle" });
  assert.deepEqual(registry.activeChatIds(), ["chat-lifecycle"]);
  assert.throws(
    () => registry.register(NEXT_RUN_ID, {
      controller: new AbortController(),
      chatId: "chat-lifecycle",
      startedAt: new Date().toISOString(),
      cancelRequestedAt: null,
      events: [],
      partialText: "",
    }),
    /already has an active invocation/,
    "retry must remain blocked until the old host process settles",
  );
  assert.equal(registry.requestCancel(RUN_ID), "already-requested", "cancel must be idempotent");

  await new Promise((resolve, reject) => {
    child.once("close", resolve);
    child.once("error", reject);
  });
  await waitFor(() => !isAlive(pids.root) && !isAlive(pids.grand));
  assert.equal(registry.activeChatIds().length, 1, "process exit alone must not bypass the terminal receipt gate");

  ledger.recordRunEvent({
    runId: RUN_ID,
    kind: "invoke_cancelled",
    chatId: "chat-lifecycle",
    payload: { resultFolder, errorMessage: "Cancelled by operator" },
  });
  assert.equal(registry.settle(RUN_ID), true);
  assert.equal(registry.activeChatIds().length, 0);
  assert.throws(
    () => registry.register(RUN_ID, {
      controller: new AbortController(),
      chatId: "chat-other",
      startedAt: new Date().toISOString(),
      cancelRequestedAt: null,
      events: [],
      partialText: "",
    }),
    /already been used/,
    "same-process retry with a settled id must not execute twice",
  );

  const receipt = ledger.getInvocationRunReceipt(RUN_ID);
  assert.equal(receipt.status, "cancelled");
  assert.equal(receipt.resultFolder, resultFolder);
  assert.equal(receipt.hasImages, true);
  assert.deepEqual(receipt.borrowAgents, ["qa-hub-agent"]);
  assert.equal(ledger.hasInvocationRunReceipt(RUN_ID), true);

  ledger.recordRunEvent({
    runId: INTERRUPTED_RUN_ID,
    kind: "invoke_started",
    chatId: "chat-lifecycle",
    payload: { hasImages: false },
  });
  const interrupted = ledger.getInvocationRunReceipt(INTERRUPTED_RUN_ID);
  assert.equal(interrupted.status, "interrupted", "DB start without live/terminal proof must recover as interrupted");
  assert.equal(ledger.getLatestInvocationRunReceipt("chat-lifecycle").runId, INTERRUPTED_RUN_ID);

  // Force the real SQLite ledger to fail, then prove the pre-host gate rolls
  // back the live registry and never reaches the host-start line.
  store.getDb().close();
  let activeStatePublishes = 0;
  let hostStarts = 0;
  assert.throws(() => {
    registerDurableInvocationStart({
      registry,
      runId: START_GATE_FAILURE_RUN_ID,
      record: {
        controller: new AbortController(),
        chatId: "chat-start-gate",
        startedAt: new Date().toISOString(),
        cancelRequestedAt: null,
        events: [],
        partialText: "",
        resultFolder,
      },
      persistStart: () => ledger.recordRunEvent({
        runId: START_GATE_FAILURE_RUN_ID,
        kind: "invoke_started",
        chatId: "chat-start-gate",
      }),
      publishActiveState: () => { activeStatePublishes += 1; },
    });
    hostStarts += 1;
  }, /closed|not open/i, "a failed durable start insert must reject the invocation");
  assert.equal(hostStarts, 0, "host adapter must not start after a ledger failure");
  assert.equal(registry.has(START_GATE_FAILURE_RUN_ID), false, "failed start must roll back the live registry");
  assert.equal(registry.hasSeen(START_GATE_FAILURE_RUN_ID), false, "a no-host rollback must not consume the run id");
  assert.equal(activeStatePublishes, 1, "rollback must publish the corrected active-chat state");

  console.log(JSON.stringify({
    ok: true,
    checks: 23,
    hostTreeTerminated: true,
    retryBlockedUntilSettlement: true,
    durableReceipt: receipt.status,
    crashRecoveryState: interrupted.status,
    startLedgerFailureBlockedHost: hostStarts === 0,
  }, null, 2));

  fs.rmSync(temp, { recursive: true, force: true });
}

app.whenReady().then(() => main().then(() => app.quit())).catch((error) => {
  console.error(error);
  app.exit(1);
});
