#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const selectedCase = process.argv[2] ?? "all";
assert.ok(["all", "lease", "chain"].includes(selectedCase), `unknown case: ${selectedCase}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-automation-safety-"));
process.env.AGENTLAS_STORE_PATH = path.join(tmp, "agentlas.sqlite");
app.setPath("userData", path.join(tmp, "user-data"));

// chats.ts imports currentUiLocale from main.ts. Stub only that dependency so
// requiring the scheduler cannot boot the real app or replace this test's
// injected trigger runner from main's whenReady callback.
const mainModulePath = require.resolve("../dist/electron/main.js");
require.cache[mainModulePath] = {
  id: mainModulePath,
  filename: mainModulePath,
  loaded: true,
  exports: { currentUiLocale: () => "en" },
  children: [],
  paths: [],
};

// Trigger manager normally opens the one shared localhost webhook listener.
// This regression needs only the chain bus, so keep it socket-free.
const webhookServer = require("../dist/electron/triggers/webhook-server.js");
webhookServer.startWebhookServer = async () => 0;
webhookServer.stopWebhookServer = () => {};

let triggerManager = null;

function rowFor(db, id) {
  return db.getDb()
    .prepare("SELECT claimed_at, lease_owner FROM automations WHERE id = ?")
    .get(id);
}

function automationInput(name) {
  return {
    name,
    scheduleHuman: "daily-09:00",
    targetType: "agent",
    targetId: "automation-safety-agent",
    promptTemplate: `Run ${name}`,
  };
}

async function testLeaseOwnership(db, automations) {
  const a = automations.createAutomation(automationInput("Lease ownership"));
  const t0 = new Date("2026-07-10T00:00:00.000Z");
  assert.equal(automations.claimAutomationRun(a.id, "runner-a", t0), true);
  assert.equal(automations.claimAutomationRun(a.id, "runner-b", t0), false);

  const wrongRelease = automations.releaseAutomationRun(a.id, "runner-b");
  assert.equal(rowFor(db, a.id).lease_owner, "runner-a", "a non-owner must not clear another runner's lease");
  assert.equal(wrongRelease, false, "non-owner release must report that nothing changed");
  assert.equal(automations.releaseAutomationRun(a.id, "runner-a"), true);
  assert.deepEqual(rowFor(db, a.id), { claimed_at: null, lease_owner: null });

  // If a stale lease is legitimately taken over after TTL, the old runner's
  // late finally block must not erase the new owner's lease.
  assert.equal(automations.claimAutomationRun(a.id, "runner-old", t0), true);
  const afterTtl = new Date(t0.getTime() + 16 * 60 * 1000);
  assert.equal(automations.claimAutomationRun(a.id, "runner-new", afterTtl), true);
  assert.equal(automations.releaseAutomationRun(a.id, "runner-old"), false);
  assert.equal(rowFor(db, a.id).lease_owner, "runner-new", "stale owner must not clobber a takeover lease");
  assert.equal(automations.releaseAutomationRun(a.id, "runner-new"), true);

  // Run now and event-triggered executions never acquired the cross-process
  // due lease, so their finally blocks must leave a headless runner's lease intact.
  const immediate = automations.createAutomation(automationInput("Immediate paths preserve lease"));
  assert.equal(automations.claimAutomationRun(immediate.id, "headless-owner", t0), true);
  const mcpClient = require("../dist/electron/mcp/client.js");
  const originalRunMcpInvocation = mcpClient.runMcpInvocation;
  mcpClient.runMcpInvocation = async () => ({
    finalText: "done",
    stormbreakerContinueRequested: false,
  });
  try {
    const scheduler = require("../dist/electron/automation-scheduler.js");
    await scheduler.runAutomationNow(immediate.id);
    assert.equal(rowFor(db, immediate.id).lease_owner, "headless-owner", "Run now must not release a due lease");
    await scheduler.runAutomationFromTrigger(immediate.id);
    assert.equal(rowFor(db, immediate.id).lease_owner, "headless-owner", "trigger runs must not release a due lease");
  } finally {
    mcpClient.runMcpInvocation = originalRunMcpInvocation;
  }
  assert.equal(automations.releaseAutomationRun(immediate.id, "headless-owner"), true);
}

async function testChainCycles(automations) {
  const self = automations.createAutomation(automationInput("Self cycle"));
  automations.updateAutomation(self.id, {
    triggerType: "chain",
    trigger: { kind: "chain", afterAutomationId: self.id },
  });

  const left = automations.createAutomation(automationInput("Cycle left"));
  const right = automations.createAutomation(automationInput("Cycle right"));
  automations.updateAutomation(left.id, {
    triggerType: "chain",
    trigger: { kind: "chain", afterAutomationId: right.id },
  });
  automations.updateAutomation(right.id, {
    triggerType: "chain",
    trigger: { kind: "chain", afterAutomationId: left.id },
  });

  const source = automations.createAutomation(automationInput("DAG source"));
  const middle = automations.createAutomation(automationInput("DAG middle"));
  const leaf = automations.createAutomation(automationInput("DAG leaf"));
  automations.updateAutomation(middle.id, {
    triggerType: "chain",
    trigger: { kind: "chain", afterAutomationId: source.id },
  });
  automations.updateAutomation(leaf.id, {
    triggerType: "chain",
    trigger: { kind: "chain", afterAutomationId: middle.id },
  });

  const calls = [];
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => {
    const message = args.map(String).join(" ");
    if (message.includes("blocked cyclic chain")) warnings.push(message);
    else originalWarn(...args);
  };
  try {
    triggerManager = require("../dist/electron/triggers/manager.js");
    const { emitAutomationDone } = require("../dist/electron/triggers/chain-bus.js");
    triggerManager.startTriggerManager(async (id) => {
      calls.push(id);
    });

    // Repeated completion events simulate the high-speed failure mode without
    // allowing the fake runner to recursively emit more completions.
    for (let i = 0; i < 20; i += 1) {
      emitAutomationDone({ automationId: self.id, ok: true, at: new Date().toISOString() });
      emitAutomationDone({ automationId: left.id, ok: true, at: new Date().toISOString() });
      emitAutomationDone({ automationId: right.id, ok: true, at: new Date().toISOString() });
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      calls.filter((id) => id === self.id || id === left.id || id === right.id).length,
      0,
      "self and indirect cycles must never reach the automation runner",
    );
    assert.ok(warnings.length >= 3, "each blocked cycle edge should surface a diagnostic once");
    assert.ok(warnings.length <= 3, "repeated cyclic completions must not spam diagnostics");

    emitAutomationDone({ automationId: source.id, ok: true, output: "source", at: new Date().toISOString() });
    emitAutomationDone({ automationId: middle.id, ok: true, output: "middle", at: new Date().toISOString() });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.filter((id) => id === middle.id).length, 1, "a valid chain edge must still fire");
    assert.equal(calls.filter((id) => id === leaf.id).length, 1, "a valid multi-step DAG must still fire");
  } finally {
    console.warn = originalWarn;
    triggerManager?.stopTriggerManager();
    triggerManager = null;
  }
}

async function main() {
  await app.whenReady();
  const db = require("../dist/electron/store/db.js");
  const automations = require("../dist/electron/store/automations.js");
  db.initStore();
  db.getDb()
    .prepare(
      `INSERT INTO installed_agents
        (id, slug, name, tagline, system_prompt, mcp_servers_json,
         preferred_backend, trust_grade, installed_at, tone)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "automation-safety-agent",
      "automation-safety-agent",
      "Automation Safety Agent",
      "Test fixture",
      "# Test",
      "[]",
      "codex",
      "A",
      new Date("2026-07-10T00:00:00.000Z").toISOString(),
      "blue",
    );

  if (selectedCase === "all" || selectedCase === "lease") {
    await testLeaseOwnership(db, automations);
  }
  if (selectedCase === "all" || selectedCase === "chain") {
    await testChainCycles(automations);
  }
  console.log(`automation trigger safety contract ok (${selectedCase})`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      triggerManager?.stopTriggerManager();
    } catch {
      // best-effort test cleanup
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    app.quit();
  });
