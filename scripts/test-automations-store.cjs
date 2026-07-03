#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-automation-store-"));
const userDataDir = path.join(tempDir, "user-data");
process.env.AGENTLAS_STORE_PATH = path.join(tempDir, "agentlas.sqlite");
app.setPath("userData", userDataDir);

const { initStore, getDb } = require("../dist/electron/store/db.js");
const {
  computeNextRun,
  createAutomation,
  dueAutomations,
  getAutomation,
  listAutomations,
  markAutomationRun,
  removeAutomation,
  toggleAutomation,
} = require("../dist/electron/store/automations.js");
const { parseAutomations } = require("../dist/electron/automation-emitter.js");
const mcpClient = require("../dist/electron/mcp/client.js");
const { runDueAutomationsNow } = require("../dist/electron/automation-scheduler.js");
const { getChat } = require("../dist/electron/store/chats.js");

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
    assert.equal(created.toolMode, "auto", "non-web automations should keep auto mode");
    assert.ok(created.nextRunAt, "nextRunAt should be set on create");
    assert.equal(listAutomations().length, 1);

    const disabled = toggleAutomation(created.id, false);
    assert.equal(disabled.enabled, false);
    assert.equal(dueAutomations(new Date("2999-01-01T00:00:00.000Z")).length, 0, "disabled automation is not due");

    const enabled = toggleAutomation(created.id, true);
    assert.equal(enabled.enabled, true);
    assert.ok(enabled.nextRunAt, "nextRunAt should be recomputed when re-enabled");

    const redditAutomation = createAutomation({
      name: "Reddit daily comments",
      scheduleHuman: "daily-09:00",
      targetType: "agent",
      targetId: "agent-1",
      promptTemplate: "Search Reddit, pick relevant threads, and post comments",
    });
    assert.equal(redditAutomation.toolMode, "computer-use", "social/web action automations should default to computer-use");

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
      const automationChat = getChat(schedulerCalls[0].chatId);
      assert.ok(automationChat, "scheduler should create a hidden automation chat");
      assert.equal(automationChat.kind, "division");
      const dueAfterRun = getAutomation(dueRun.id);
      assert.ok(dueAfterRun.lastRunAt, "scheduler should mark lastRunAt");
      assert.ok(new Date(dueAfterRun.nextRunAt).getTime() > new Date(dueAfterRun.lastRunAt).getTime());

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
      resolveLongRun();
      await Promise.all([firstTick, secondTick]);

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
      assert.equal(getAutomation(storm.id).enabled, false, "long-run automation without continue should disable itself");
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
    assert.equal(new Date(synced.nextRunAt).getHours(), 18, "next_run_at should follow edited trigger schedule");
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

    console.log("automation store smoke passed");
  } catch (err) {
    exitCode = 1;
    console.error(err);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (app && typeof app.quit === "function") app.quit();
    process.exit(exitCode);
  }
})();
