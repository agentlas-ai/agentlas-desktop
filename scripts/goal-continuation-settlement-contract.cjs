#!/usr/bin/env node
/*
 * 숨은 목표 이어가기의 정산(완료·예산 소진·정체 정지·일시 실패 백오프·계속)이 실제 실행 경로에서 돈다.
 *
 * 실측(2026-09-27, 설치본 1.2.45): 모든 자동화 행은 synthesizeLegacyGraph 로 그래프 경로를 돈다.
 * 정산은 옛 직접 실행 갈래 안에만 있어 한 번도 닿지 않았다 — "Youtube launch" 이어가기는 같은
 * needs_input 으로 10분마다(1회 약 71.6만 입력 토큰), "X Marketing" 이어가기는 needs_input 7회를
 * 연달아 깨어났다. 완료·예산·정체 정지·2시간 백오프도 같은 이유로 한 번도 적용된 적이 없다.
 *
 * 진짜 runAutomationNow → runOne → runGraph, runDueAutomationsNow, 진짜 목표 원장(long_runs)을
 * 격리 저장소에서 쓴다. 가짜는 모델 호출(runMcpInvocation)과 두 판정기(결과·실패)뿐이다.
 *
 * Run:
 *   npx tsc -p electron/tsconfig.json --outDir scripts/local/ytloop-dist --sourceMap false
 *   GOAL_HOLD_DIST=scripts/local/ytloop-dist npx electron scripts/goal-continuation-settlement-contract.cjs
 * (GOAL_HOLD_DIST 가 없으면 dist/ 를 쓴다.)
 */
process.env.AGENTLAS_E2E = "1";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

app.disableHardwareAcceleration();
const root = path.resolve(__dirname, "..");
const distRoot = path.resolve(root, process.env.GOAL_HOLD_DIST || "dist");
const dist = (relative) => path.join(distRoot, "electron", relative);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-goal-settle-"));
process.env.AGENTLAS_STORE_PATH = path.join(tmp, "agentlas.sqlite");
app.setPath("userData", path.join(tmp, "user-data"));

const MARKER = "<<stormbreaker-long-run>>";
let passed = 0;
const ok = (name) => { passed += 1; console.log(`ok   ${name}`); };

(async () => {
  let exitCode = 0;
  try {
    await app.whenReady();
    const store = require(dist("store/db.js"));
    store.initStore();
    const db = store.getDb();
    require(dist("architecture/seed.js")).seedBuiltinAgents();
    require(dist("ui-locale.js")).setCurrentUiLocale("ko");

    // Per-automation scripted behaviour of the only fakes: the model and the judges.
    const script = new Map();
    const calls = new Map();
    const client = require(dist("mcp/client.js"));
    client.runMcpInvocation = async (req) => {
      const behaviour = script.get(req.automationId);
      if (!behaviour || !String(req.userPrompt ?? "").includes(MARKER)) return { finalText: "optimizer: nothing to do", stormbreakerContinueRequested: false };
      calls.set(req.automationId, (calls.get(req.automationId) ?? 0) + 1);
      if (behaviour.throws) throw new Error(behaviour.throws);
      behaviour.during?.();
      return { finalText: behaviour.text, stormbreakerContinueRequested: behaviour.continue === true };
    };
    const judge = require(dist("automation-result.js"));
    let verdict = new Map();
    judge.classifyAutomationOutcome = async (text) => {
      for (const [needle, value] of verdict) if (String(text).includes(needle)) return value;
      return { outcome: "partial", reasonCode: null, reason: "more work" };
    };
    judge.classifyAutomationFailure = async (text) => ({ status: "error", reasonCode: "runtime_unavailable", reason: `runtime unavailable: ${String(text ?? "").slice(0, 80)}` });

    const chats = require(dist("store/chats.js"));
    const automations = require(dist("store/automations.js"));
    const longRuns = require(dist("store/long-runs.js"));
    const ledger = require(dist("mcp/goal-ledger.js"));
    const scheduler = require(dist("automation-scheduler.js"));
    const { parseChatHostNotice } = require(path.join(distRoot, "shared/chat-host-notice.js"));

    let seq = 0;
    function goalContinuation(name, ledgerOptions, openTasks) {
      seq += 1;
      const goalId = `goal:auto-message:settle-${seq}`;
      const chat = chats.createChat({ title: name, originSurface: "one", taskMode: "conversation" });
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO chat_goal_contracts (goal_id, chat_id, objective, acceptance_criteria_json, status, created_at, updated_at)
        VALUES (?, ?, ?, '[]', 'active', ?, ?)`).run(goalId, chat.id, name, now, now);
      assert.equal(ledger.ensureGoalLedgerGoal({ goalId, objective: name, acceptanceCriteria: [`${name} is done`], ...ledgerOptions }), true, `ledger goal created: ${JSON.stringify(ledger.lastGoalLedgerFailure())}`);
      const run = longRuns.getLongRunByGoalId(goalId);
      for (let i = 0; i < openTasks; i += 1) longRuns.addLongRunTask({ runId: run.id, title: `task ${i}`, objective: `task ${i}` });
      const automation = automations.createAutomation({
        name: `Goal continuation · ${name}`, scheduleHuman: "every-10m", targetType: "agent", targetId: "builtin-agentlas-one",
        promptTemplate: `${MARKER}\nSource chat: ${chat.id}\nContinue the unfinished goal.`, createdBy: "agent", goalId,
      });
      return { goalId, chatId: chat.id, id: automation.id };
    }
    const notices = (chatId) => db.prepare("SELECT text, host_notice_json FROM chat_messages WHERE chat_id = ? AND role = 'system' ORDER BY created_at").all(chatId)
      .filter((row) => parseChatHostNotice("system", row.host_notice_json)?.purpose === "automation-report");
    const row = (id) => automations.getAutomation(id);
    const contract = (goalId) => db.prepare("SELECT status FROM chat_goal_contracts WHERE goal_id = ?").get(goalId).status;
    const due = (minutes) => scheduler.runDueAutomationsNow(new Date(Date.now() + minutes * 60_000));

    // 1) complete: the pass finishes the last open task (its receipt lands during the pass),
    //    the judge accepts, and the model does not ask to continue.
    const done = goalContinuation("complete", {}, 0);
    const doneRun = longRuns.getLongRunByGoalId(done.goalId);
    assert.ok(longRuns.listLongRunTasks(doneRun.id, true).length > 0, "the goal starts with open work");
    script.set(done.id, { text: "DONE-all verified", during: () => {
      for (const task of longRuns.listLongRunTasks(doneRun.id, true)) {
        longRuns.setLongRunTaskState({ runId: doneRun.id, taskId: task.id, state: "completed", evidenceRef: "verified in this pass" });
      }
    } });
    verdict.set("DONE-all", { outcome: "ok", reasonCode: null, reason: "모든 산출물이 확인됐습니다." });
    await scheduler.runAutomationNow(done.id);
    assert.equal(row(done.id).enabled, false, "completed continuation is off");
    assert.equal(contract(done.goalId), "completed");
    // The long run itself closes only through its verification receipts (tryCompleteVerifiedLongRun);
    // this contract does not forge receipts, so its status is not asserted here.
    assert.equal(notices(done.chatId).length, 1, "goal chat told once");
    assert.match(notices(done.chatId)[0].text, /완료로 닫고/);
    await due(11);
    assert.equal(calls.get(done.id), 1, "no wake after completion");
    ok("complete → goal contract closed, continuation off, goal chat notified once, no further wake");

    // 2) budget exhausted: one cycle allowed, the first pass spends it.
    const budget = goalContinuation("budget", { maxCycles: 1 }, 1);
    script.set(budget.id, { text: "BUDGET-pass one", continue: true });
    await scheduler.runAutomationNow(budget.id);
    assert.equal(row(budget.id).enabled, false, "stopped on budget");
    assert.equal(contract(budget.goalId), "blocked");
    assert.equal(notices(budget.chatId).length, 1);
    assert.match(notices(budget.chatId)[0].text, /budget_cycles_exhausted/, "the reason is in the notice");
    assert.match(notices(budget.chatId)[0].text, /멈췄어요/);
    ok("budget exhausted → stopped with the reason (budget_cycles_exhausted), notified once");

    // 3) no-progress stall: the same output three times on a stall window of 2.
    const stall = goalContinuation("stall", { stallWindow: 2 }, 1);
    script.set(stall.id, { text: "STALL-same result every time", continue: true });
    for (let i = 0; i < 3 && row(stall.id).enabled; i += 1) await scheduler.runAutomationNow(stall.id);
    assert.equal(row(stall.id).enabled, false, "stalled continuation is hard-stopped");
    assert.equal(contract(stall.goalId), "blocked");
    assert.equal(notices(stall.chatId).length, 1, "one stop notice, not one per pass");
    assert.match(notices(stall.chatId)[0].text, /goal_blocked/);
    ok(`no-progress stall → hard stop after ${calls.get(stall.id)} identical passes, notified once`);

    // 4) transient failure: the run itself fails → every-2h, enabled, no wake before 2h.
    const flaky = goalContinuation("transient", {}, 1);
    script.set(flaky.id, { throws: "codex exited 1: connection reset" });
    await scheduler.runAutomationNow(flaky.id);
    const backedOff = row(flaky.id);
    assert.equal(backedOff.enabled, true, "a transient failure does not stop the goal");
    assert.equal(backedOff.scheduleHuman, "every-2h", "cadence backs off");
    const nextAt = Date.parse(backedOff.nextRunAt);
    assert.ok(nextAt - Date.now() > 110 * 60_000, `next wake about 2h out: ${backedOff.nextRunAt}`);
    assert.equal(notices(flaky.chatId).length, 0, "a transient failure is not an owner notice");
    await due(11);
    await due(61);
    assert.equal(calls.get(flaky.id), 1, "no wake before 2h");
    script.set(flaky.id, { text: "FLAKY-recovered, more to do", continue: true });
    await due(125);
    assert.equal(calls.get(flaky.id), 2, "wakes once the backoff elapses");
    assert.equal(row(flaky.id).scheduleHuman, "every-10m", "a good pass restores the active cadence");
    ok("transient failure → every-2h honoured (no wake at +11m/+61m, wake at +125m), recovery restores every-10m");

    // 5) partial with more to do keeps the active cadence.
    const partial = goalContinuation("partial", {}, 2);
    script.set(partial.id, { text: "PARTIAL-one of two done", continue: true });
    await scheduler.runAutomationNow(partial.id);
    assert.equal(row(partial.id).enabled, true);
    assert.equal(row(partial.id).scheduleHuman, "every-10m");
    assert.equal(notices(partial.chatId).length, 0);
    ok("partial → keeps its every-10m cadence, no notice");

    // 6) X Marketing shape: the ledger is blocked for owner review, the row is still on with a
    //    past next_run_at. The pre-run gate refuses; it must park the row and tell the chat once.
    const review = goalContinuation("x-marketing", {}, 1);
    script.set(review.id, { text: "REVIEW-should never run", continue: true });
    const reviewRun = longRuns.getLongRunByGoalId(review.goalId);
    longRuns.transitionLongRun({ runId: reviewRun.id, to: "blocked", actorKind: "host", reason: "auto_goal_owner_review_required" });
    db.prepare("UPDATE automations SET next_run_at = ? WHERE id = ?").run(new Date(Date.now() - 60 * 60_000).toISOString(), review.id);
    assert.equal(row(review.id).enabled, true);
    await due(0);
    assert.equal(calls.get(review.id) ?? 0, 0, "the refused continuation never calls the model");
    assert.equal(row(review.id).enabled, false, "a ledger stop parks the row");
    assert.equal(notices(review.chatId).length, 1, "the goal chat is told once");
    assert.match(notices(review.chatId)[0].text, /auto_goal_owner_review_required/);
    await due(11);
    await due(21);
    await scheduler.runAutomationNow(review.id); // a manual re-gate on the same ledger state
    assert.equal(calls.get(review.id) ?? 0, 0, "zero further wakes");
    assert.equal(notices(review.chatId).length, 1, "no duplicate notice on re-gate");
    assert.equal(contract(review.goalId), "active", "the goal contract stays for the owner to resume");
    ok("ledger-blocked (X Marketing shape) → pre-run gate parks the row, one notice, zero wakes, no duplicate on re-gate");

    console.log(`goal-continuation-settlement-contract: PASS (${passed})`);
  } catch (error) {
    exitCode = 1;
    console.error("goal-continuation-settlement-contract: FAIL");
    console.error(error && error.stack ? error.stack : error);
  } finally {
    try { require(dist("automation-scheduler.js")).stopAutomationScheduler(); } catch { /* not started */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* scratch */ }
    app.exit(exitCode);
  }
})();
