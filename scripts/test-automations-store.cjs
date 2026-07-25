#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-automation-store-"));
const userDataDir = path.join(tempDir, "user-data");
process.env.AGENTLAS_STORE_PATH = path.join(tempDir, "agentlas.sqlite");
process.env.AGENTLAS_AUTOMATION_LEASE_HEARTBEAT_MS = "1000";
app.setPath("userData", userDataDir);

const { initStore, getDb, recoverStaleAutomationRuns } = require("../dist/electron/store/db.js");
const automationStore = require("../dist/electron/store/automations.js");
const {
  computeNextRun,
  createAutomation,
  dueAutomations,
  getAutomation,
  listAutomations,
  markAutomationRun,
  claimAutomationRun,
  renewAutomationRunLease,
  releaseAutomationRun,
  removeAutomation,
  startGraphRun,
  touchGraphRun,
  finishGraphRun,
  toggleAutomation,
  updateAutomation,
  getAutomationExecutionContractState,
  pinAutomationRuntimeIfUnset,
  pinLegacyAutomationHubVersions,
} = automationStore;
const { parseAutomations } = require("../dist/electron/automation-emitter.js");
const mcpClient = require("../dist/electron/mcp/client.js");
let runDueAutomationsNow;
let runAutomationNow;
const { removeAutomationSafely } = require("../dist/electron/automation-removal.js");
const { getChat, appendChatMessage } = require("../dist/electron/store/chats.js");

function assertLocalTime(iso, expected) {
  const d = new Date(iso);
  assert.equal(d.getFullYear(), expected.year, "year");
  assert.equal(d.getMonth() + 1, expected.month, "month");
  assert.equal(d.getDate(), expected.day, "day");
  assert.equal(d.getHours(), expected.hour, "hour");
  assert.equal(d.getMinutes(), expected.minute, "minute");
}

(async () => {
  let exitCode = 0;
  try {
    initStore();
    getDb()
      .prepare(
        `INSERT INTO installed_agents
          (id, slug, name, tagline, system_prompt, mcp_servers_json, preferred_backend, trust_grade, installed_at, tone)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "agent-1",
        "qa-agent",
        "QA Agent",
        "Runs QA automation",
        "# QA",
        "[]",
        "codex",
        "A",
        new Date("2026-06-01T00:00:00.000Z").toISOString(),
        "blue",
      );

    assert.equal(listAutomations().length, 0, "new store should start empty");

    const leaseCase = createAutomation({
      name: "Lease Heartbeat Contract",
      scheduleHuman: "daily-09:00",
      targetType: "agent",
      targetId: "agent-1",
      promptTemplate: "lease contract",
    });
    const leaseT0 = new Date("2026-06-01T00:00:00.000Z");
    assert.equal(claimAutomationRun(leaseCase.id, "owner-a", leaseT0), true);
    assert.equal(
      renewAutomationRunLease(leaseCase.id, "owner-a", new Date(leaseT0.getTime() + 14 * 60_000)),
      true,
    );
    assert.equal(
      claimAutomationRun(leaseCase.id, "owner-b", new Date(leaseT0.getTime() + 16 * 60_000)),
      false,
      "a refreshed lease must reject a peer even after the original 15-minute claim window",
    );
    assert.equal(releaseAutomationRun(leaseCase.id, "owner-a"), true);
    assert.equal(
      claimAutomationRun(leaseCase.id, "owner-b", new Date(leaseT0.getTime() + 16 * 60_000)),
      true,
      "owner release must make the due lease immediately reclaimable",
    );
    assert.equal(releaseAutomationRun(leaseCase.id, "owner-b"), true);
    removeAutomation(leaseCase.id);

    const sleepingOwnerLease = createAutomation({
      name: "Sleeping Mac live-owner guard",
      scheduleHuman: "daily-09:00",
      targetType: "agent",
      targetId: "agent-1",
      promptTemplate: "protect a paused heartbeat",
    });
    const liveOwner = `${process.pid}:gui`;
    assert.equal(claimAutomationRun(sleepingOwnerLease.id, liveOwner, leaseT0), true);
    assert.equal(
      claimAutomationRun(sleepingOwnerLease.id, "peer-after-sleep", new Date(leaseT0.getTime() + 20 * 60_000)),
      false,
      "a sleeping Mac must not let a peer steal an expired heartbeat while the trusted owner PID is alive",
    );
    assert.equal(
      claimAutomationRun(
        sleepingOwnerLease.id,
        "peer-after-hard-ceiling",
        new Date(leaseT0.getTime() + automationStore.AUTOMATION_LIVE_OWNER_GUARD_MS + 1),
      ),
      true,
      "the live-PID guard must remain bounded so PID reuse cannot create a permanent lease",
    );
    assert.equal(releaseAutomationRun(sleepingOwnerLease.id, "peer-after-hard-ceiling"), true);
    removeAutomation(sleepingOwnerLease.id);

    const deadOwnerLease = createAutomation({
      name: "Dead lease owner recovery",
      scheduleHuman: "daily-09:00",
      targetType: "agent",
      targetId: "agent-1",
      promptTemplate: "recover a dead owner",
    });
    assert.equal(claimAutomationRun(deadOwnerLease.id, "2147483647:headless", leaseT0), true);
    assert.equal(
      claimAutomationRun(deadOwnerLease.id, "peer-after-crash", new Date(leaseT0.getTime() + 20 * 60_000)),
      true,
      "an expired lease with a dead trusted PID must remain reclaimable",
    );
    assert.equal(releaseAutomationRun(deadOwnerLease.id, "peer-after-crash"), true);
    removeAutomation(deadOwnerLease.id);

    const crossProcessRemoval = createAutomation({
      name: "Cross-process removal guard",
      scheduleHuman: "daily-09:00",
      targetType: "agent",
      targetId: "agent-1",
      promptTemplate: "shared database guard",
    });
    assert.equal(claimAutomationRun(crossProcessRemoval.id, "2147483647:headless", new Date()), true);
    assert.throws(
      () => removeAutomationSafely(crossProcessRemoval.id),
      (error) => error?.code === "automation_active_removal_blocked",
      "a fresh lease owned by another process must block destructive removal",
    );
    assert.ok(getAutomation(crossProcessRemoval.id));
    assert.equal(releaseAutomationRun(crossProcessRemoval.id, "2147483647:headless"), true);
    startGraphRun({
      runId: "cross-process-running-snapshot",
      automationId: crossProcessRemoval.id,
      nodeIds: ["worker"],
    });
    assert.throws(
      () => removeAutomationSafely(crossProcessRemoval.id),
      (error) => error?.code === "automation_active_removal_blocked",
      "a fresh running snapshot must block removal even when this process has no in-memory run",
    );
    finishGraphRun("cross-process-running-snapshot", "error");
    removeAutomationSafely(crossProcessRemoval.id);
    assert.equal(getAutomation(crossProcessRemoval.id), null);

    const from = new Date(2026, 5, 26, 8, 30, 0, 0); // local Fri Jun 26 2026 08:30
    assert.equal(
      new Date(computeNextRun("hourly", from)).getTime(),
      from.getTime() + 60 * 60 * 1000,
      "hourly should advance one hour",
    );
    assert.equal(
      new Date(computeNextRun("every-15m", from)).getTime(),
      from.getTime() + 15 * 60 * 1000,
      "every-15m should advance fifteen minutes",
    );
    assertLocalTime(computeNextRun("daily-09:00", from), {
      year: 2026,
      month: 6,
      day: 26,
      hour: 9,
      minute: 0,
    });
    assertLocalTime(computeNextRun("weekday-09:00", new Date(2026, 5, 26, 10, 0, 0, 0)), {
      year: 2026,
      month: 6,
      day: 29,
      hour: 9,
      minute: 0,
    });
    assertLocalTime(computeNextRun("weekly-mon-10:00", from), {
      year: 2026,
      month: 6,
      day: 29,
      hour: 10,
      minute: 0,
    });
    assertLocalTime(computeNextRun("monthly-1-09:00", new Date(2026, 5, 2, 12, 0, 0, 0)), {
      year: 2026,
      month: 7,
      day: 1,
      hour: 9,
      minute: 0,
    });

    const created = createAutomation({
      name: "  Morning Digest  ",
      scheduleHuman: "daily-09:00",
      targetType: "agent",
      targetId: "agent-1",
      promptTemplate: "Summarize the inbox",
    });
    assert.equal(created.name, "Morning Digest");
    assert.equal(created.enabled, true);
    assert.equal(created.targetType, "agent");
    assert.equal(created.targetId, "agent-1");
    assert.equal(created.promptTemplate, "Summarize the inbox");
    assert.equal(created.executionPermission, "write", "UI/legacy create must keep the explicit write default");
    assert.equal(
      getDb().prepare("SELECT execution_permission FROM automations WHERE id = ?").get(created.id).execution_permission,
      "write",
      "the backward-compatible default must be durable, not scheduler-only",
    );
    assert.equal(created.toolMode, "auto", "non-web automations should keep auto mode");

    const exactRuntimeContract = createAutomation({
      name: "Exact runtime contract",
      scheduleHuman: "daily-09:00",
      targetType: "agent",
      targetId: "agent-1",
      promptTemplate: "runtime contract",
    });
    assert.deepEqual(
      getAutomationExecutionContractState(exactRuntimeContract.id),
      { runtimeSelection: "missing", hubMode: "valid" },
      "legacy NULL pins are the only state eligible for first-run pinning",
    );
    const firstPin = { kind: "codex", backend: "openai", source: "/usr/local/bin/codex", model: "gpt-exact" };
    assert.deepEqual(pinAutomationRuntimeIfUnset(exactRuntimeContract.id, firstPin).runtimeSelection, firstPin);
    assert.equal(getAutomationExecutionContractState(exactRuntimeContract.id).runtimeSelection, "valid");

    getDb().prepare("UPDATE automations SET runtime_selection_json = ? WHERE id = ?")
      .run("{malformed", exactRuntimeContract.id);
    assert.equal(
      getAutomationExecutionContractState(exactRuntimeContract.id).runtimeSelection,
      "invalid",
      "malformed JSON must not be treated as a missing pin",
    );
    pinAutomationRuntimeIfUnset(exactRuntimeContract.id, firstPin);
    assert.equal(
      getDb().prepare("SELECT runtime_selection_json AS value FROM automations WHERE id = ?").get(exactRuntimeContract.id).value,
      "{malformed",
      "first-run CAS must never overwrite damaged non-NULL state",
    );

    getDb().prepare("UPDATE automations SET runtime_selection_json = ? WHERE id = ?")
      .run(JSON.stringify({ kind: 42 }), exactRuntimeContract.id);
    assert.equal(
      getAutomationExecutionContractState(exactRuntimeContract.id).runtimeSelection,
      "invalid",
      "wrong-shaped runtime pins fail closed",
    );

    getDb().prepare("UPDATE automations SET runtime_selection_json = ? WHERE id = ?")
      .run(JSON.stringify({ kind: "future-runtime" }), exactRuntimeContract.id);
    assert.equal(
      getAutomationExecutionContractState(exactRuntimeContract.id).runtimeSelection,
      "invalid",
      "unknown future runtime kinds require an explicit migration",
    );

    getDb().prepare("UPDATE automations SET runtime_selection_json = NULL WHERE id = ?").run(exactRuntimeContract.id);
    pinAutomationRuntimeIfUnset(exactRuntimeContract.id, firstPin);
    pinAutomationRuntimeIfUnset(exactRuntimeContract.id, { kind: "claude-code", backend: "anthropic" });
    assert.deepEqual(
      getAutomation(exactRuntimeContract.id).runtimeSelection,
      firstPin,
      "concurrent first-run pin attempts preserve the CAS winner",
    );

    getDb().prepare("UPDATE automations SET hub_mode = ? WHERE id = ?")
      .run("future-hub-policy", exactRuntimeContract.id);
    assert.equal(
      getAutomationExecutionContractState(exactRuntimeContract.id).hubMode,
      "invalid",
      "unknown Hub policies must not widen to hub-allowed",
    );
    assert.equal(getAutomation(exactRuntimeContract.id).hubMode, "local-only", "damaged Hub policy projects fail-closed");
    removeAutomation(exactRuntimeContract.id);

    const hashA = "a".repeat(64);
    const hashB = "b".repeat(64);
    const legacyTopHub = createAutomation({
      name: "Legacy top-level Hub pin",
      scheduleHuman: "daily-09:00",
      targetType: "hub",
      targetId: "exact-hub-agent",
      promptTemplate: "run exact Hub release",
    });
    const topPinned = pinLegacyAutomationHubVersions(legacyTopHub.id, { "exact-hub-agent": hashA });
    assert.equal(topPinned.automation.targetVersion, hashA, "legacy top-level Hub target must freeze once");
    assert.equal(topPinned.pinned.length, 1);

    const legacyGraphHub = createAutomation({
      name: "Legacy graph Hub pin",
      scheduleHuman: "daily-09:00",
      targetType: "agent",
      targetId: "agent-1",
      promptTemplate: "graph exact Hub release",
      graphJson: {
        version: 1,
        nodes: [{
          id: "hub-node",
          type: "agent",
          position: { x: 0, y: 0 },
          config: { targetType: "hub", ref: "graph-hub-agent", prompt: "run" },
        }],
        edges: [],
      },
    });
    const graphPinned = pinLegacyAutomationHubVersions(legacyGraphHub.id, { "graph-hub-agent": hashA });
    assert.equal(graphPinned.automation.graph.nodes[0].config.targetVersion, hashA, "legacy graph node must freeze once");

    const losingConcurrentPin = pinLegacyAutomationHubVersions(legacyTopHub.id, { "exact-hub-agent": hashB });
    assert.equal(
      losingConcurrentPin.automation.targetVersion,
      hashA,
      "a concurrent GUI/headless pin attempt must preserve the transaction winner",
    );
    assert.equal(losingConcurrentPin.pinned.length, 0);

    const changedRemoteAfterPin = pinLegacyAutomationHubVersions(legacyGraphHub.id, { "graph-hub-agent": hashB });
    assert.equal(
      changedRemoteAfterPin.automation.graph.nodes[0].config.targetVersion,
      hashA,
      "a newer Hub publication after migration must not drift an existing automation",
    );

    const unavailableLegacyHub = createAutomation({
      name: "Unavailable legacy Hub pin",
      scheduleHuman: "daily-09:00",
      targetType: "hub",
      targetId: "offline-hub-agent",
      promptTemplate: "wait for exact Hub release",
    });
    assert.throws(
      () => pinLegacyAutomationHubVersions(unavailableLegacyHub.id, {}),
      /automation_hub_version_pin_unavailable/,
      "an unavailable Hub must leave the automation intact for deferred retry",
    );
    assert.equal(getAutomation(unavailableLegacyHub.id).targetVersion, undefined);

    getDb().prepare("UPDATE automations SET target_version = ? WHERE id = ?")
      .run("latest", unavailableLegacyHub.id);
    assert.throws(
      () => pinLegacyAutomationHubVersions(unavailableLegacyHub.id, { "offline-hub-agent": hashA }),
      /automation_hub_version_pin_invalid/,
      "present-but-non-immutable Hub version state must fail closed",
    );
    removeAutomation(legacyTopHub.id);
    removeAutomation(legacyGraphHub.id);
    removeAutomation(unavailableLegacyHub.id);
    assert.ok(created.nextRunAt, "nextRunAt should be set on create");
    assert.equal(listAutomations().length, 1);

    const heartbeatAutomation = createAutomation({
      name: "Durable heartbeat",
      scheduleHuman: "daily-09:00",
      targetType: "agent",
      targetId: "agent-1",
      promptTemplate: "long healthy run",
    });
    const heartbeatRunId = "run-durable-heartbeat";
    startGraphRun({
      runId: heartbeatRunId,
      automationId: heartbeatAutomation.id,
      nodeIds: ["worker"],
      startedAt: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(),
    });
    assert.equal(touchGraphRun(heartbeatRunId), true);
    assert.equal(
      recoverStaleAutomationRuns(),
      0,
      "recent durable progress must protect a long-running peer from stale recovery",
    );
    assert.equal(
      getDb().prepare("SELECT status FROM automation_runs WHERE id = ?").get(heartbeatRunId).status,
      "running",
    );
    finishGraphRun(heartbeatRunId, "ok");
    toggleAutomation(heartbeatAutomation.id, false);

    assert.throws(
      () => startGraphRun({ runId: "run-deleted-parent", automationId: "deleted-parent", nodeIds: ["worker"] }),
      /Automation not found/,
      "a peer with a deleted parent must not recreate an orphan snapshot",
    );
    getDb().prepare(
      `INSERT INTO automation_runs
         (id, automation_id, started_at, last_activity_at, status, node_states_json)
       VALUES ('legacy-peer-orphan', 'legacy-deleted-parent', ?, ?, 'running', '{}')`,
    ).run(new Date().toISOString(), new Date().toISOString());
    getDb().prepare(
      `INSERT INTO run_history
         (id, automation_id, scheduled_for, ran_at, status, skipped_count, error)
       VALUES ('legacy-peer-history', 'legacy-deleted-parent', NULL, ?, 'error', 0, 'legacy peer')`,
    ).run(new Date().toISOString());
    recoverStaleAutomationRuns();
    assert.equal(
      getDb().prepare("SELECT COUNT(*) AS n FROM automation_runs WHERE id = 'legacy-peer-orphan'").get().n,
      0,
      "periodic recovery must prune an orphan committed by an older peer",
    );
    assert.equal(
      getDb().prepare("SELECT COUNT(*) AS n FROM run_history WHERE id = 'legacy-peer-history'").get().n,
      0,
    );

    const disabled = toggleAutomation(created.id, false);
    assert.equal(disabled.enabled, false);
    assert.equal(dueAutomations(new Date("2999-01-01T00:00:00.000Z")).length, 0, "disabled automation is not due");

    const enabled = toggleAutomation(created.id, true);
    assert.equal(enabled.enabled, true);
    assert.ok(enabled.nextRunAt, "nextRunAt should be recomputed when re-enabled");

    // The connected model decides the tool mode at creation (the create IPC handler warms
    // it; see prejudgeAutomationComputerUse). Inject the model's "yes" verdict here — a job
    // that must drive a signed-in Reddit page needs the real browser / computer-use path.
    const redditAutomation = createAutomation({
      name: "Reddit daily comments",
      scheduleHuman: "daily-09:00",
      targetType: "agent",
      targetId: "agent-1",
      promptTemplate: "Search Reddit, pick relevant threads, and post comments",
      judged: () => true,
    });
    assert.equal(redditAutomation.toolMode, "computer-use", "a model-judged human-web automation uses computer-use");

    // No connected model verdict → the neutral "auto" default, NEVER a keyword guess. The
    // old English/Korean wordlist that forced computer-use from words like "Reddit/post" is
    // gone; auto still keeps the browser reachable when the task genuinely needs it.
    const unjudgedSocial = createAutomation({
      name: "Reddit daily comments",
      scheduleHuman: "daily-09:00",
      targetType: "agent",
      targetId: "agent-1",
      promptTemplate: "Search Reddit, pick relevant threads, and post comments",
      judged: () => null,
    });
    assert.equal(unjudgedSocial.toolMode, "auto", "no model verdict must default to auto, not a keyword-forced computer-use");

    const explicitBrowserAutomation = createAutomation({
      name: "Explicit browser smoke",
      scheduleHuman: "daily-09:00",
      targetType: "agent",
      targetId: "agent-1",
      promptTemplate: "Search Reddit in the browser",
      toolMode: "browser",
    });
    assert.equal(explicitBrowserAutomation.toolMode, "browser", "explicit browser choice should be preserved");

    getDb()
      .prepare("UPDATE automations SET next_run_at = ? WHERE id = ?")
      .run(new Date("2026-06-01T00:00:00.000Z").toISOString(), created.id);
    const due = dueAutomations(new Date("2026-06-01T00:00:01.000Z"));
    assert.equal(due.length, 1);
    assert.equal(due[0].id, created.id);

    markAutomationRun(created.id, new Date(2026, 5, 26, 9, 5, 0, 0));
    const afterRun = getAutomation(created.id);
    assert.ok(afterRun.lastRunAt, "lastRunAt should be written");
    assert.ok(new Date(afterRun.nextRunAt).getTime() > new Date(afterRun.lastRunAt).getTime());

    const parsed = parseAutomations(
      [
        "좋아요. 매일 확인하도록 걸어둘게요.",
        "",
        "## Automation",
        "```json",
        '[{"name":"Daily report","schedule":"daily-09:00","prompt":"Send the daily report"}]',
        "```",
      ].join("\n"),
    );
    assert.equal(parsed.automations.length, 1);
    assert.equal(parsed.automations[0].name, "Daily report");
    assert.equal(parsed.automations[0].schedule, "daily-09:00");
    assert.equal(parsed.automations[0].prompt, "Send the daily report");
    assert.equal(parsed.cleanedText, "좋아요. 매일 확인하도록 걸어둘게요.");

    const invalid = parseAutomations("일회성 답변\n\n## Automation\n```json\nnot json\n```");
    assert.equal(invalid.automations.length, 0);
    assert.equal(invalid.cleanedText, "일회성 답변");

    const originalRunMcpInvocation = mcpClient.runMcpInvocation;
    try {
      const { runGraph } = require("../dist/electron/workflow/run-graph.js");
      const { getOrCreateAutomationSession } = require("../dist/electron/store/chats.js");
      let deletedParentRuntimeCalls = 0;
      mcpClient.runMcpInvocation = async () => {
        deletedParentRuntimeCalls += 1;
        return { finalText: "must not execute", stormbreakerContinueRequested: false };
      };
      const deletedGraph = createAutomation({
        name: "Deleted graph must not run",
        scheduleHuman: "daily-09:00",
        targetType: "agent",
        targetId: "agent-1",
        promptTemplate: "must not execute",
        graphJson: {
          version: 1,
          nodes: [{ id: "worker", type: "agent", position: { x: 0, y: 0 }, config: { prompt: "must not execute" } }],
          edges: [],
        },
      });
      const cachedDeletedGraph = getAutomation(deletedGraph.id);
      removeAutomation(deletedGraph.id);
      await assert.rejects(
        runGraph(cachedDeletedGraph, cachedDeletedGraph.graph, { runId: "run-deleted-graph" }),
        (error) => error?.code === "automation_parent_missing",
        "a cached graph whose parent was deleted must stop before chat/runtime side effects",
      );
      assert.equal(deletedParentRuntimeCalls, 0);
      assert.equal(
        getDb().prepare("SELECT COUNT(*) AS n FROM chats WHERE title LIKE ?").get(`⟦automation⟧${deletedGraph.id}%`).n,
        0,
      );

      const deletedLegacy = createAutomation({
        name: "Deleted legacy must not run",
        scheduleHuman: "daily-09:00",
        targetType: "agent",
        targetId: "agent-1",
        promptTemplate: "must not execute legacy",
        runtimeSelection: { kind: "codex", backend: "openai", source: "test-codex" },
      });
      const originalStartGraphRun = automationStore.startGraphRun;
      let deletedLegacyRuntimeCalls = 0;
      mcpClient.runMcpInvocation = async () => {
        deletedLegacyRuntimeCalls += 1;
        return { finalText: "must not execute", stormbreakerContinueRequested: false };
      };
      automationStore.startGraphRun = (input) => {
        if (input.automationId === deletedLegacy.id) removeAutomation(deletedLegacy.id);
        return originalStartGraphRun(input);
      };
      const runtimeDetect = require("../dist/electron/runtime/detect.js");
      runtimeDetect.detectRuntimes = async () => [{
        kind: "codex",
        backend: "openai",
        source: "test-codex",
        ready: true,
        active: true,
        model: "test-codex-model",
        longContextEnabled: false,
      }];
      ({ runDueAutomationsNow, runAutomationNow } = require("../dist/electron/automation-scheduler.js"));
      try {
        await runAutomationNow(deletedLegacy.id);
      } finally {
        automationStore.startGraphRun = originalStartGraphRun;
      }
      assert.equal(deletedLegacyRuntimeCalls, 0, "deleted cached legacy automation must stop before runtime dispatch");
      assert.equal(getAutomation(deletedLegacy.id), null);
      assert.equal(
        getDb().prepare("SELECT COUNT(*) AS n FROM automation_runs WHERE automation_id = ?").get(deletedLegacy.id).n,
        0,
      );
      assert.equal(
        getDb().prepare("SELECT COUNT(*) AS n FROM chats WHERE title LIKE ?").get(`⟦automation⟧${deletedLegacy.id}%`).n,
        0,
      );

      const graphCalls = [];
      mcpClient.runMcpInvocation = async (payload) => {
        graphCalls.push(payload);
        return { finalText: "GATE_OK\nready", stormbreakerContinueRequested: false };
      };
      const graphRun = createAutomation({
        name: "Graph Session Unified",
        scheduleHuman: "daily-09:00",
        targetType: "agent",
        targetId: "agent-1",
        promptTemplate: "fallback",
        graphJson: {
          version: 1,
          nodes: [
            { id: "trg", type: "trigger", position: { x: 0, y: 0 }, config: {} },
            {
              id: "gate",
              type: "agent",
              position: { x: 280, y: 0 },
              config: { ref: "agent-1", produces: "gate", prompt: "gate prompt" },
            },
          ],
          edges: [{ id: "e0", source: "trg", target: "gate" }],
        },
      });
      const graph = getAutomation(graphRun.id).graph;
      const graphResult = await runGraph(graphRun, graph, { runId: "graph-session-unified" });
      assert.equal(graphResult.ok, true, "graph run should succeed with a non-empty assistant result");
      const unifiedChat = getOrCreateAutomationSession({ automationId: graphRun.id, agentId: "agent-1" });
      assert.equal(graphCalls.length, 1, "graph should call the runner once");
      assert.equal(graphCalls[0].chatId, unifiedChat.id, "same-target graph nodes should write into the automation result session");
      const splitRows = getDb()
        .prepare("SELECT COUNT(*) as n FROM chats WHERE title = ?")
        .get(`⟦automation⟧${graphRun.id}::a:agent-1`);
      assert.equal(splitRows.n, 0, "same-target graph nodes should not create a split node session");

      mcpClient.runMcpInvocation = async () => ({ finalText: "   ", stormbreakerContinueRequested: false });
      const emptyGraphRun = createAutomation({
        name: "Graph Empty Result Fails",
        scheduleHuman: "daily-09:00",
        targetType: "agent",
        targetId: "agent-1",
        promptTemplate: "fallback",
        graphJson: {
          version: 1,
          nodes: [
            { id: "trg", type: "trigger", position: { x: 0, y: 0 }, config: {} },
            { id: "node", type: "agent", position: { x: 280, y: 0 }, config: { prompt: "empty" } },
          ],
          edges: [{ id: "e0", source: "trg", target: "node" }],
        },
      });
      const emptyResult = await runGraph(emptyGraphRun, getAutomation(emptyGraphRun.id).graph, { runId: "graph-empty-result" });
      assert.equal(emptyResult.ok, false, "empty assistant result must fail the graph run");
      const emptySnapshot = getDb()
        .prepare("SELECT status, node_states_json FROM automation_runs WHERE id = ?")
        .get("graph-empty-result");
      assert.equal(emptySnapshot.status, "error", "empty-result graph snapshot should be error");
      assert.match(emptySnapshot.node_states_json, /"node":"failed"/, "empty-result graph node should be failed");

      let ignoredAbortRuntimeStarted;
      const ignoredAbortRuntimeReady = new Promise((resolve) => {
        ignoredAbortRuntimeStarted = resolve;
      });
      mcpClient.runMcpInvocation = async () => {
        ignoredAbortRuntimeStarted();
        return new Promise(() => {});
      };
      const ignoredAbortGraphRun = createAutomation({
        name: "Abort-ignoring Graph Runtime",
        scheduleHuman: "daily-09:00",
        targetType: "agent",
        targetId: "agent-1",
        promptTemplate: "never settles",
        graphJson: {
          version: 1,
          nodes: [
            { id: "stuck", type: "agent", position: { x: 0, y: 0 }, config: { prompt: "never settles" } },
          ],
          edges: [],
        },
      });
      const ignoredAbortController = new AbortController();
      const ignoredAbortRunId = "graph-ignored-abort-runtime";
      const ignoredAbortResultPromise = runGraph(
        ignoredAbortGraphRun,
        getAutomation(ignoredAbortGraphRun.id).graph,
        {
          runId: ignoredAbortRunId,
          signal: ignoredAbortController.signal,
          abortGraceMs: 20,
        },
      );
      await Promise.race([
        ignoredAbortRuntimeReady,
        new Promise((_, reject) => setTimeout(() => reject(new Error("stuck graph node did not start")), 250)),
      ]);
      ignoredAbortController.abort(new Error("caller aborted an uncooperative runtime"));
      const ignoredAbortResult = await Promise.race([
        ignoredAbortResultPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error("aborted graph did not terminalize")), 250)),
      ]);
      assert.equal(ignoredAbortResult.ok, false);
      assert.equal(ignoredAbortResult.error, "aborted");
      const ignoredAbortSnapshot = getDb()
        .prepare("SELECT status, node_states_json FROM automation_runs WHERE id = ?")
        .get(ignoredAbortRunId);
      assert.equal(ignoredAbortSnapshot.status, "error", "abort must terminalize the graph snapshot");
      assert.match(
        ignoredAbortSnapshot.node_states_json,
        /"stuck":"failed"/,
        "terminalization must not leave the cancellation-ignoring node projected as running",
      );

      getDb().prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('agent_concurrency', '2')").run();
      let siblingStarted = false;
      let siblingAbortObserved = false;
      mcpClient.runMcpInvocation = async (payload, _sink, signal) => {
        if (payload.userPrompt !== "sibling side effect") {
          return { finalText: "unexpected", stormbreakerContinueRequested: false };
        }
        siblingStarted = true;
        return new Promise((_resolve, reject) => {
          const abort = () => {
            siblingAbortObserved = true;
            reject(new Error("sibling aborted"));
          };
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        });
      };
      const unexpectedGraphRun = createAutomation({
        name: "Unexpected Graph Finalization",
        scheduleHuman: "daily-09:00",
        targetType: "agent",
        targetId: "agent-1",
        promptTemplate: "fallback",
        graphJson: {
          version: 1,
          nodes: [
            { id: "trg", type: "trigger", position: { x: 0, y: 0 }, config: {} },
            { id: "node", type: "agent", position: { x: 280, y: 0 }, config: { prompt: "never dispatched" } },
            { id: "sibling", type: "agent", position: { x: 280, y: 180 }, config: { prompt: "sibling side effect" } },
          ],
          edges: [
            { id: "e0", source: "trg", target: "node" },
            { id: "e1", source: "trg", target: "sibling" },
          ],
        },
      });
      await assert.rejects(
        runGraph(unexpectedGraphRun, getAutomation(unexpectedGraphRun.id).graph, {
          runId: "graph-unexpected-finalization",
          sink: (event) => {
            if (event.nodeId === "node" && event.nodeState === "running") {
              throw new Error("forced live sink failure");
            }
          },
        }),
        /forced live sink failure/,
        "unexpected graph exceptions must preserve the caller-visible rejection",
      );
      assert.equal(siblingStarted, true, "parallel sibling must be active before the forced branch failure");
      assert.equal(siblingAbortObserved, true, "unexpected branch failure must abort and drain its active sibling");
      const unexpectedSnapshot = getDb()
        .prepare("SELECT status, node_states_json FROM automation_runs WHERE id = ?")
        .get("graph-unexpected-finalization");
      assert.equal(unexpectedSnapshot.status, "error", "unexpected graph exit must terminalize its snapshot");
      assert.match(
        unexpectedSnapshot.node_states_json,
        /"node":"failed"/,
        "a terminal error must not leave a node projected as running",
      );
      assert.match(unexpectedSnapshot.node_states_json, /"sibling":"failed"/);

      const schedulerCalls = [];
      mcpClient.runMcpInvocation = async (payload) => {
        schedulerCalls.push(payload);
        return { finalText: "done", stormbreakerContinueRequested: false };
      };

      const dueRun = createAutomation({
        name: "Due Runner",
        scheduleHuman: "daily-09:00",
        targetType: "agent",
        targetId: "agent-1",
        promptTemplate: "Run due automation",
      });
      getDb()
        .prepare("UPDATE automations SET next_run_at = ? WHERE id = ?")
        .run(new Date("2026-06-01T00:00:00.000Z").toISOString(), dueRun.id);
      await runDueAutomationsNow(new Date("2026-06-01T00:00:01.000Z"));
      assert.equal(schedulerCalls.length, 1, "due scheduler should invoke once");
      assert.equal(schedulerCalls[0].userPrompt, "Run due automation");
      assert.equal(schedulerCalls[0].permissions, "write");
      assert.ok(schedulerCalls[0].runtimeSelection?.kind, "first run must pin an exact runtime before invocation");
      const automationChat = getChat(schedulerCalls[0].chatId);
      assert.ok(automationChat, "scheduler should create a hidden automation chat");
      assert.equal(automationChat.kind, "division");
      const dueAfterRun = getAutomation(dueRun.id);
      assert.deepEqual(dueAfterRun.runtimeSelection, schedulerCalls[0].runtimeSelection, "runtime pin must persist on the automation row");
      assert.ok(dueAfterRun.lastRunAt, "scheduler should mark lastRunAt");
      assert.ok(new Date(dueAfterRun.nextRunAt).getTime() > new Date(dueAfterRun.lastRunAt).getTime());
      appendChatMessage(automationChat.id, "assistant", "first durable outcome: ledger updated");
      schedulerCalls.length = 0;
      await runAutomationNow(dueRun.id);
      assert.match(schedulerCalls[0].userPrompt, /automation continuity capsule/);
      assert.match(schedulerCalls[0].userPrompt, /first durable outcome: ledger updated/);
      assert.deepEqual(schedulerCalls[0].runtimeSelection, dueAfterRun.runtimeSelection, "later runs must ignore global runtime drift");

      schedulerCalls.length = 0;
      const readOnlyRun = createAutomation({
        name: "Read-only Scheduler",
        scheduleHuman: "daily-09:00",
        targetType: "agent",
        targetId: "agent-1",
        promptTemplate: "Inspect without changing anything",
        executionPermission: "read",
      });
      assert.equal(readOnlyRun.executionPermission, "read");
      assert.equal(
        getDb().prepare("SELECT execution_permission FROM automations WHERE id = ?").get(readOnlyRun.id)
          .execution_permission,
        "read",
      );
      assert.equal(
        updateAutomation(readOnlyRun.id, { name: "Read-only Scheduler renamed" }).executionPermission,
        "read",
        "an unrelated update must not promote a stored read automation",
      );
      await runAutomationNow(readOnlyRun.id);
      assert.equal(schedulerCalls.length, 1);
      assert.equal(schedulerCalls[0].permissions, "read", "legacy scheduler path must use the stored read authority");
      assert.equal(updateAutomation(readOnlyRun.id, { executionPermission: "write" }).executionPermission, "write");
      assert.equal(updateAutomation(readOnlyRun.id, { executionPermission: "read" }).executionPermission, "read");

      schedulerCalls.length = 0;
      const readOnlyGraph = createAutomation({
        name: "Read-only Graph Scheduler",
        scheduleHuman: "daily-09:00",
        targetType: "agent",
        targetId: "agent-1",
        promptTemplate: "Read graph fallback",
        executionPermission: "read",
        graphJson: {
          version: 1,
          nodes: [
            {
              id: "reader",
              type: "agent",
              position: { x: 0, y: 0 },
              config: { prompt: "Inspect the project" },
            },
          ],
          edges: [],
        },
      });
      await runAutomationNow(readOnlyGraph.id);
      assert.equal(schedulerCalls.length, 1);
      assert.equal(schedulerCalls[0].permissions, "read", "graph scheduler path must not re-escalate to write");

      const malformedPermission = createAutomation({
        name: "Malformed Scheduler Permission",
        scheduleHuman: "daily-09:00",
        targetType: "agent",
        targetId: "agent-1",
        promptTemplate: "Do not accept full",
        executionPermission: "full",
      });
      assert.equal(
        malformedPermission.executionPermission,
        "read",
        "a present invalid/full scheduler permission must fail closed instead of using the legacy write default",
      );

      schedulerCalls.length = 0;
      let resolveLongRun;
      mcpClient.runMcpInvocation = async (payload) => {
        schedulerCalls.push(payload);
        await new Promise((resolve) => {
          resolveLongRun = resolve;
        });
        return { finalText: "slow done", stormbreakerContinueRequested: false };
      };
      const duplicateGuard = createAutomation({
        name: "Duplicate Guard",
        scheduleHuman: "daily-09:00",
        targetType: "agent",
        targetId: "agent-1",
        promptTemplate: "Long running automation",
      });
      getDb()
        .prepare("UPDATE automations SET next_run_at = ? WHERE id = ?")
        .run(new Date("2026-06-01T00:00:00.000Z").toISOString(), duplicateGuard.id);
      const firstTick = runDueAutomationsNow(new Date("2026-06-01T00:00:01.000Z"));
      const secondTick = runDueAutomationsNow(new Date("2026-06-01T00:00:01.000Z"));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(schedulerCalls.length, 1, "running automation should not invoke twice");
      assert.throws(
        () => removeAutomationSafely(duplicateGuard.id),
        (error) => error?.code === "automation_active_removal_blocked" && error?.phase === "run",
        "deleting a write-capable active automation must fail closed",
      );
      assert.ok(getAutomation(duplicateGuard.id), "blocked removal must preserve the automation parent");
      assert.ok(
        getDb().prepare("SELECT 1 FROM chats WHERE title LIKE ? LIMIT 1").get(`⟦automation⟧${duplicateGuard.id}::%`),
        "blocked removal must preserve the active run chat",
      );
      const claimedBeforeHeartbeat = getDb()
        .prepare("SELECT claimed_at FROM automations WHERE id = ?")
        .get(duplicateGuard.id).claimed_at;
      const originalRenewLease = automationStore.renewAutomationRunLease;
      let renewAttempts = 0;
      automationStore.renewAutomationRunLease = (...args) => {
        renewAttempts += 1;
        if (renewAttempts === 1) {
          const busy = new Error("synthetic busy");
          busy.code = "SQLITE_BUSY";
          throw busy;
        }
        return originalRenewLease(...args);
      };
      await new Promise((resolve) => setTimeout(resolve, 2200));
      automationStore.renewAutomationRunLease = originalRenewLease;
      const claimedAfterHeartbeat = getDb()
        .prepare("SELECT claimed_at FROM automations WHERE id = ?")
        .get(duplicateGuard.id).claimed_at;
      assert.ok(renewAttempts >= 2, "silent runner must renew its due lease on an independent timer");
      assert.ok(
        new Date(claimedAfterHeartbeat).getTime() > new Date(claimedBeforeHeartbeat).getTime(),
        "a transient renewal error must retry and eventually advance claimed_at",
      );
      await assert.rejects(
        require("../dist/electron/automation-scheduler.js").quiesceAutomationSchedulerForUpdate(50),
        /did not drain/,
        "an update must fail closed instead of snapshotting while an automation is still writing",
      );
      resolveLongRun();
      await Promise.all([firstTick, secondTick]);
      const resumeAfterUpdateAttempt = await require("../dist/electron/automation-scheduler.js")
        .quiesceAutomationSchedulerForUpdate(100);
      await assert.rejects(
        runAutomationNow(duplicateGuard.id),
        /paused while an update is prepared/,
        "new immediate runs must remain blocked inside the continuity-capture window",
      );
      resumeAfterUpdateAttempt();
      removeAutomationSafely(duplicateGuard.id);
      assert.equal(getAutomation(duplicateGuard.id), null, "the same automation may be removed after its run settles");
      assert.equal(
        getDb().prepare("SELECT COUNT(*) AS n FROM chats WHERE title LIKE ?").get(`⟦automation⟧${duplicateGuard.id}::%`).n,
        0,
        "successful removal must delete its settled run chat",
      );

      let leaseLossAbortObserved = false;
      const koreanWorkspaceRoot = path.join("/tmp", `agentlas-korean-workspace-${process.pid}`);
      assert.equal(
        mcpClient.inferWorkingFolderFromPrompt(`작업 루트는 ${koreanWorkspaceRoot} 이고 이 폴더에서만 실행해.`),
        koreanWorkspaceRoot,
        "Korean 작업 루트 authority must bind the automation cwd instead of falling back to agent-cwd",
      );
      assert.ok(fs.statSync(koreanWorkspaceRoot).isDirectory());
      fs.rmSync(koreanWorkspaceRoot, { recursive: true, force: true });

      mcpClient.runMcpInvocation = async (_payload, _onEvent, signal) => {
        await new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => {
            leaseLossAbortObserved = true;
            reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
          }, { once: true });
        });
        return { finalText: "unreachable", stormbreakerContinueRequested: false };
      };
      const stolenLease = createAutomation({
        name: "Stolen Lease Guard",
        scheduleHuman: "daily-09:00",
        targetType: "agent",
        targetId: "agent-1",
        promptTemplate: "Wait until lease ownership changes",
      });
      const stolenDueAt = new Date("2026-06-01T00:00:00.000Z").toISOString();
      getDb().prepare("UPDATE automations SET next_run_at = ? WHERE id = ?").run(stolenDueAt, stolenLease.id);
      const stolenRun = runDueAutomationsNow(new Date("2026-06-01T00:00:01.000Z"));
      await new Promise((resolve) => setImmediate(resolve));
      getDb().prepare("UPDATE automations SET lease_owner = ? WHERE id = ?").run("peer-owner", stolenLease.id);
      await stolenRun;
      assert.equal(leaseLossAbortObserved, true, "definitive owner mismatch must abort the local runner");
      const stolenAfter = getDb()
        .prepare("SELECT last_run_at, next_run_at, lease_owner FROM automations WHERE id = ?")
        .get(stolenLease.id);
      assert.equal(stolenAfter.last_run_at, null, "lost owner must not record/advance another owner's due run");
      assert.equal(stolenAfter.next_run_at, stolenDueAt);
      assert.equal(stolenAfter.lease_owner, "peer-owner", "owner-conditional release must not clear the peer lease");
      assert.equal(releaseAutomationRun(stolenLease.id, "peer-owner"), true);
      removeAutomation(stolenLease.id);

      schedulerCalls.length = 0;
      mcpClient.runMcpInvocation = async () => {
        schedulerCalls.push({ failed: true });
        throw new Error("mock invocation failed");
      };
      const failing = createAutomation({
        name: "Failure Advances",
        scheduleHuman: "daily-09:00",
        targetType: "agent",
        targetId: "agent-1",
        promptTemplate: "This run fails",
      });
      getDb()
        .prepare("UPDATE automations SET next_run_at = ? WHERE id = ?")
        .run(new Date("2026-06-01T00:00:00.000Z").toISOString(), failing.id);
      await runDueAutomationsNow(new Date("2026-06-01T00:00:01.000Z"));
      assert.equal(schedulerCalls.length, 1);
      const failedAfterRun = getAutomation(failing.id);
      assert.ok(failedAfterRun.lastRunAt, "failed scheduler run should still mark lastRunAt");
      assert.ok(new Date(failedAfterRun.nextRunAt).getTime() > new Date(failedAfterRun.lastRunAt).getTime());

      mcpClient.runMcpInvocation = async () => ({ finalText: "no continue", stormbreakerContinueRequested: false });
      const storm = createAutomation({
        name: "Storm Long Run",
        scheduleHuman: "daily-09:00",
        targetType: "agent",
        targetId: "agent-1",
        promptTemplate: "<<stormbreaker-long-run>>\nContinue a previous job",
      });
      getDb()
        .prepare("UPDATE automations SET next_run_at = ? WHERE id = ?")
        .run(new Date("2026-06-01T00:00:00.000Z").toISOString(), storm.id);
      await runDueAutomationsNow(new Date("2026-06-01T00:00:01.000Z"));
      assert.equal(
        getAutomation(storm.id).enabled,
        true,
        "a missing long-run continuation signal must not silently disable a recurring automation",
      );
    } finally {
      mcpClient.runMcpInvocation = originalRunMcpInvocation;
    }

    // ── 그래프 트리거 스케줄 편집 → 발사 컬럼(schedule_json/next_run_at) 동기화 회귀 ──
    const { updateAutomationGraph } = require("../dist/electron/store/automations.js");
    const graphEdit = createAutomation({
      name: "Graph Trigger Sync",
      scheduleHuman: "daily-09:00",
      targetType: "agent",
      targetId: "agent-1",
      promptTemplate: "graph sync",
    });
    const editedSpec = { kind: "cron", expr: "0 18 * * *", tz: "Asia/Seoul" };
    updateAutomationGraph(graphEdit.id, {
      version: 1,
      nodes: [
        {
          id: "n0",
          type: "trigger",
          position: { x: 0, y: 0 },
          config: { scheduleSpec: editedSpec, schedule: "daily-18:00" },
        },
        { id: "n1", type: "agent", position: { x: 280, y: 0 }, config: { prompt: "hi" } },
      ],
      edges: [{ id: "e0", source: "n0", target: "n1" }],
    });
    const synced = getAutomation(graphEdit.id);
    assert.equal(synced.scheduleHuman, "daily-18:00", "trigger edit should sync legacy token");
    assert.deepEqual(synced.scheduleSpec, editedSpec, "trigger edit should sync schedule_json");
    // 스케줄에 명시된 tz(Asia/Seoul) 기준으로 검증한다 — 실행 호스트 TZ에 의존하는
    // getHours()는 CI(UTC)에서 18→9로 어긋난다. 글로벌 사용자·CI 어느 TZ에서도 통과해야 하고,
    // 이렇게 해야 next_run_at이 사용자가 지정한 tz대로 계산됐는지 실제로 검증된다.
    const editedTzHour = Number(
      new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", hour: "numeric", hour12: false })
        .format(new Date(synced.nextRunAt)),
    );
    assert.equal(editedTzHour, 18, "next_run_at should follow edited trigger schedule (in the schedule's tz)");
    // 이벤트 트리거는 시계 승격 금지 — 그래프 저장이 next_run_at을 만들면 안 된다.
    const fsTrig = createAutomation({
      name: "FS Trigger Graph Save",
      scheduleHuman: "daily-09:00",
      targetType: "agent",
      targetId: "agent-1",
      promptTemplate: "fs",
      triggerType: "fs",
      trigger: { kind: "fs", path: "/tmp/watch", on: "modify" },
    });
    updateAutomationGraph(fsTrig.id, {
      version: 1,
      nodes: [
        { id: "n0", type: "trigger", position: { x: 0, y: 0 }, config: { scheduleSpec: editedSpec, schedule: "daily-18:00" } },
        { id: "n1", type: "agent", position: { x: 280, y: 0 }, config: { prompt: "hi" } },
      ],
      edges: [{ id: "e0", source: "n0", target: "n1" }],
    });
    assert.equal(getAutomation(fsTrig.id).nextRunAt, null, "event trigger must not gain a clock from graph save");

    removeAutomation(created.id);
    for (const item of listAutomations()) removeAutomation(item.id);
    assert.equal(listAutomations().length, 0);
    assert.equal(
      getDb().prepare("SELECT COUNT(*) AS n FROM automation_runs").get().n,
      0,
      "automation deletion must remove every linked live snapshot",
    );
    assert.equal(
      getDb().prepare("SELECT COUNT(*) AS n FROM run_history").get().n,
      0,
      "automation deletion must remove every linked run-history projection",
    );

    console.log("automation store smoke passed");
  } catch (err) {
    exitCode = 1;
    console.error(err);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (app && typeof app.exit === "function") app.exit(exitCode);
  }
})();
