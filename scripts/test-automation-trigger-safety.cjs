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

  // Run now and event-triggered executions must respect a live peer lease. Otherwise
  // a GUI click can duplicate the external side effects of a headless due run.
  const immediate = automations.createAutomation(automationInput("Immediate paths respect lease"));
  // Durable-run contract: unattended execution requires an exact runtime pin.
  // CI runners have no local CLI for the first-run auto-pin, so pin explicitly
  // the way a configured automation already is.
  automations.pinAutomationRuntimeIfUnset(immediate.id, { kind: "codex" });
  const peerClaimedAt = new Date();
  const peerOwner = "2147483647:headless";
  assert.equal(automations.claimAutomationRun(immediate.id, peerOwner, peerClaimedAt), true);
  const mcpClient = require("../dist/electron/mcp/client.js");
  const originalRunMcpInvocation = mcpClient.runMcpInvocation;
  let immediateCalls = 0;
  mcpClient.runMcpInvocation = async () => {
    immediateCalls += 1;
    return { finalText: "done", stormbreakerContinueRequested: false };
  };
  try {
    const scheduler = require("../dist/electron/automation-scheduler.js");
    await scheduler.runAutomationNow(immediate.id);
    assert.equal(immediateCalls, 0, "Run now must not execute while a headless peer owns the lease");
    assert.equal(rowFor(db, immediate.id).lease_owner, peerOwner, "Run now must preserve the peer lease");
    await scheduler.runAutomationFromTrigger(immediate.id);
    assert.equal(immediateCalls, 0, "event triggers must not execute while a headless peer owns the lease");
    assert.equal(rowFor(db, immediate.id).lease_owner, peerOwner, "trigger runs must preserve the peer lease");

    assert.equal(automations.releaseAutomationRun(immediate.id, peerOwner), true);
    await scheduler.runAutomationFromTrigger(immediate.id);
    assert.equal(immediateCalls, 1, "an event trigger must run after it acquires the released lease");
    assert.deepEqual(rowFor(db, immediate.id), { claimed_at: null, lease_owner: null });

    const disabled = automations.createAutomation(automationInput("Disabled manual run"));
    automations.pinAutomationRuntimeIfUnset(disabled.id, { kind: "codex" });
    automations.toggleAutomation(disabled.id, false);
    await scheduler.runAutomationNow(disabled.id);
    assert.equal(immediateCalls, 2, "Run now must remain available for a disabled automation");
    assert.deepEqual(rowFor(db, disabled.id), { claimed_at: null, lease_owner: null });
  } finally {
    mcpClient.runMcpInvocation = originalRunMcpInvocation;
  }
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
    if (message.includes("blocked cyclic durable chain edge")) warnings.push(message);
    else originalWarn(...args);
  };
  const waitFor = async (predicate, timeoutMs = 8_000) => {
    const startedAt = Date.now();
    while (!predicate() && Date.now() - startedAt < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return predicate();
  };
  try {
    triggerManager = require("../dist/electron/triggers/manager.js");
    const { emitAutomationDone } = require("../dist/electron/triggers/chain-bus.js");
    // The outbox hands each durable occurrence to the scheduler contract.
    // Accept and classify ok so a delivery can be acknowledged exactly once.
    triggerManager.startTriggerManager(async (id, _ctx, hooks) => {
      hooks.onAccepted();
      calls.push(id);
      return { accepted: true, status: "ok" };
    });

    // Durable truth: the scheduler seals one terminal receipt per finished run
    // (markAutomationRun with sourceRunId). Cycle policy fires while the
    // receipt's fan-out is computed; the chain bus is only a wake accelerator.
    const sealTerminalReceipt = (automation, runId, output) => {
      automations.markAutomationRun(automation.id, new Date(), {
        status: "ok",
        advanceSchedule: false,
        sourceRunId: runId,
        output,
      });
      emitAutomationDone({ automationId: automation.id, ok: true, output, at: new Date().toISOString() });
    };

    sealTerminalReceipt(self, "run-cycle-self", "self");
    sealTerminalReceipt(left, "run-cycle-left", "left");
    sealTerminalReceipt(right, "run-cycle-right", "right");
    assert.equal(warnings.length, 3, "each blocked cycle edge should surface a diagnostic once");

    // Repeated completion signals simulate the high-speed failure mode. The
    // receipts already exist, so reconciliation must neither warn again nor
    // create occurrences for the cyclic edges.
    for (let i = 0; i < 20; i += 1) {
      emitAutomationDone({ automationId: self.id, ok: true, at: new Date().toISOString() });
      emitAutomationDone({ automationId: left.id, ok: true, at: new Date().toISOString() });
      emitAutomationDone({ automationId: right.id, ok: true, at: new Date().toISOString() });
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(
      calls.filter((id) => id === self.id || id === left.id || id === right.id).length,
      0,
      "self and indirect cycles must never reach the automation runner",
    );
    assert.equal(warnings.length, 3, "repeated cyclic completions must not spam diagnostics");

    sealTerminalReceipt(source, "run-dag-source", "source");
    assert.ok(
      await waitFor(() => calls.filter((id) => id === middle.id).length >= 1),
      "a valid chain edge must still fire",
    );
    sealTerminalReceipt(middle, "run-dag-middle", "middle");
    assert.ok(
      await waitFor(() => calls.filter((id) => id === leaf.id).length >= 1),
      "a valid multi-step DAG must still fire",
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(calls.filter((id) => id === middle.id).length, 1, "a chain edge must deliver exactly once");
    assert.equal(calls.filter((id) => id === leaf.id).length, 1, "a DAG leaf must deliver exactly once");
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
