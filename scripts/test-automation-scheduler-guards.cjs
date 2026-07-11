#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const selectedCase = process.argv[2] ?? "all";
assert.ok(
  ["all", "limits", "optimizer", "optimizer-cancel", "optimizer-timeout"].includes(selectedCase),
  `unknown case: ${selectedCase}`,
);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-scheduler-guards-"));
process.env.AGENTLAS_STORE_PATH = path.join(tmp, "agentlas.sqlite");
process.env.AGENTLAS_AUTOMATION_CONCURRENCY = "not-a-number";
process.env.AGENTLAS_AUTOMATION_STALL_MS = "Infinity";
process.env.AGENTLAS_AUTOMATION_OPTIMIZER_TIMEOUT_MS = "1000";
app.setPath("userData", path.join(tmp, "user-data"));

// Prevent chats.ts from booting the real Electron entrypoint during this store test.
const mainModulePath = require.resolve("../dist/electron/main.js");
require.cache[mainModulePath] = {
  id: mainModulePath,
  filename: mainModulePath,
  loaded: true,
  exports: { currentUiLocale: () => "en" },
  children: [],
  paths: [],
};

const mcpClient = require("../dist/electron/mcp/client.js");
const originalRunMcpInvocation = mcpClient.runMcpInvocation;
let primaryMode = "success";
let primaryCalls = 0;
const optimizerRuns = [];
mcpClient.runMcpInvocation = async (request, _sink, signal) => {
  if (String(request.userPrompt).includes("## System Optimizer — automation failure triage")) {
    optimizerRuns.push({ request, signal });
    // Deliberately ignore AbortSignal. The scheduler's outer watchdog must still
    // settle its own lifecycle and release the in-flight slot.
    return new Promise(() => {});
  }
  primaryCalls += 1;
  if (primaryMode === "failure") throw new Error("forced scheduler guard failure");
  return { finalText: "done", stormbreakerContinueRequested: false };
};

function automationInput(name) {
  return {
    name,
    scheduleHuman: "daily-09:00",
    targetType: "agent",
    targetId: "scheduler-guard-agent",
    promptTemplate: `Run ${name}`,
  };
}

async function waitFor(predicate, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for scheduler guard condition");
}

async function main() {
  await app.whenReady();
  const db = require("../dist/electron/store/db.js");
  const automations = require("../dist/electron/store/automations.js");
  const scheduler = require("../dist/electron/automation-scheduler.js");
  db.initStore();
  db.getDb()
    .prepare(
      `INSERT INTO installed_agents
        (id, slug, name, tagline, system_prompt, mcp_servers_json,
         preferred_backend, trust_grade, installed_at, tone)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "scheduler-guard-agent",
      "scheduler-guard-agent",
      "Scheduler Guard Agent",
      "Test fixture",
      "# Test",
      "[]",
      "codex",
      "A",
      new Date("2026-07-10T00:00:00.000Z").toISOString(),
      "blue",
    );

  if (selectedCase === "all" || selectedCase === "limits") {
    const due = automations.createAutomation(automationInput("Invalid concurrency fallback"));
    db.getDb()
      .prepare("UPDATE automations SET next_run_at = ? WHERE id = ?")
      .run("2026-07-09T00:00:00.000Z", due.id);
    const before = primaryCalls;
    await scheduler.runDueAutomationsNow(new Date("2026-07-10T00:00:00.000Z"));
    assert.equal(primaryCalls - before, 1, "invalid concurrency must fall back instead of silently skipping every due run");
    const limits = scheduler.automationSchedulerDiagnostics();
    assert.deepEqual(limits, {
      maxConcurrentAutomations: 2,
      stallInactivityMs: 8 * 60 * 1000,
      activeToolStallMs: 20 * 60 * 1000,
      optimizerTimeoutMs: 1000,
    });

    const watchdog = require("../dist/electron/automation-watchdog.js");
    const state = watchdog.createAutomationWatchdogState(0);
    assert.equal(
      watchdog.evaluateAutomationWatchdog(state, limits.stallInactivityMs, limits.activeToolStallMs, 480_001).stalled,
      true,
      "an idle runner must still fail fast after eight silent minutes",
    );
    watchdog.noteAutomationWatchdogEvent(
      state,
      { kind: "tool-use", tool: { name: "long-build", id: "tool-1", args: "{}" } },
      500_000,
    );
    assert.equal(
      watchdog.evaluateAutomationWatchdog(state, limits.stallInactivityMs, limits.activeToolStallMs, 500_000 + 480_001).stalled,
      false,
      "a known active tool must not be mistaken for an idle runner at 480 seconds",
    );
    const activeTimeout = watchdog.evaluateAutomationWatchdog(
      state,
      limits.stallInactivityMs,
      limits.activeToolStallMs,
      500_000 + 1_200_001,
    );
    assert.equal(activeTimeout.stalled, true, "an active tool still needs a finite silence cap");
    assert.equal(activeTimeout.mode, "active-tool");
    assert.match(watchdog.automationWatchdogError(activeTimeout), /active tool produced no event for 1200s/);

    watchdog.noteAutomationWatchdogEvent(
      state,
      { kind: "tool-use", tool: { name: "long-build", id: "tool-1", result: "done" } },
      1_000_000,
    );
    const afterTool = watchdog.evaluateAutomationWatchdog(
      state,
      limits.stallInactivityMs,
      limits.activeToolStallMs,
      1_000_000 + 480_001,
    );
    assert.equal(afterTool.mode, "idle", "a tool result must return the watchdog to the idle budget");
    assert.equal(afterTool.stalled, true);
  }

  if (
    selectedCase === "all" ||
    selectedCase === "optimizer" ||
    selectedCase === "optimizer-cancel" ||
    selectedCase === "optimizer-timeout"
  ) {
    primaryMode = "failure";
    const triggerOptimizer = async (name) => {
      const automation = automations.createAutomation(automationInput(name));
      const expectedOptimizerIndex = optimizerRuns.length + 1;
      await scheduler.runAutomationNow(automation.id);
      await scheduler.runAutomationNow(automation.id);
      await waitFor(() => optimizerRuns.length >= expectedOptimizerIndex);
      return automation;
    };

    let cancelled = null;
    let timedOut = null;
    const testCancellation = selectedCase !== "optimizer-timeout";
    const testTimeout = selectedCase !== "optimizer-cancel";
    if (testCancellation) {
      cancelled = await triggerOptimizer("Optimizer cancellation");
      const cancelRun = optimizerRuns[optimizerRuns.length - 1];
      assert.equal(cancelRun.signal.aborted, false);
      scheduler.stopAutomationScheduler();
      await waitFor(() => cancelRun.signal.aborted);
    }

    if (testTimeout) {
      timedOut = await triggerOptimizer("Optimizer total timeout");
      const timeoutRun = optimizerRuns[optimizerRuns.length - 1];
      await waitFor(() => timeoutRun.signal.aborted);
      assert.ok(timeoutRun.signal.reason instanceof Error, "watchdog abort should include an actionable reason");
      assert.match(timeoutRun.signal.reason.message, /total timeout/i);
    }

    const messageRows = db.getDb()
      .prepare(
        `SELECT text FROM chat_messages
          WHERE role = 'system' AND text LIKE '%System Optimizer 진단 런 자체가 실패%'
          ORDER BY created_at ASC`,
      )
      .all();
    const messages = messageRows.map((row) => row.text).join("\n");
    if (testCancellation) {
      assert.match(messages, /scheduler stopped/i, "scheduler shutdown cancellation must be visible");
    }
    if (testTimeout) {
      assert.match(messages, /total timeout/i, "optimizer timeout must be visible");
    }

    // Both optimizer lifecycles should have settled even though the mocked runner
    // ignored cancellation; the original automations remain queryable.
    if (cancelled) assert.ok(automations.getAutomation(cancelled.id));
    if (timedOut) assert.ok(automations.getAutomation(timedOut.id));
  }

  console.log(`automation scheduler finite-config/optimizer-watchdog contract ok (${selectedCase})`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      const scheduler = require("../dist/electron/automation-scheduler.js");
      scheduler.stopAutomationScheduler();
    } catch {
      // best-effort cleanup
    }
    mcpClient.runMcpInvocation = originalRunMcpInvocation;
    fs.rmSync(tmp, { recursive: true, force: true });
    app.quit();
  });
