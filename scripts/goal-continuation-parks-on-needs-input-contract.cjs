#!/usr/bin/env node
/*
 * 사람만 풀 수 있는 막힘(needs_input)으로 끝난 목표 이어가기는 목표 대화에 한 번 알리고 멈춘다 —
 * 같은 막힘을 10분마다 다시 확인하지 않는다.
 *
 * 실측(2026-09-27, 설치본 1.2.45, One 단톡 "Youtube launch", 자동화 "Goal continuation · Youtube
 * launch" every-10m): 12:25Z·12:35Z 두 번 숨은 세션에서 깨어나 같은 두 막힘(Google 재인증,
 * 유료 영상 생성 $0.40 승인)을 다시 확인하고 needs_input 으로 끝났다. 한 번에 약 4분, 입력 토큰
 * 약 71.6만(캐시 65만). 단톡에는 아무 줄도 생기지 않았다 — deliverAutomationResult 는 monitor 의
 * 원래 대화로만 보고하는데 목표 이어가기에는 monitor 가 없다. 원장 판정은 "미달·계속" 이라 매번
 * every-10m 로 다시 잡혔다.
 *
 * 뿌리: 모든 자동화 행은 이제 그래프 경로로 돈다(synthesizeLegacyGraph). 목표 이어가기의
 * 완료·정지·백오프 판정은 옛 직접 실행 갈래 안에만 있어 한 번도 닿지 않는다 — 그래서 needs_input
 * 이어도 every-10m 그대로 켜져 있었다. 멈춤은 두 경로가 함께 지나는 실행 뒤 공통 자리에 둔다.
 *
 * 진짜 스케줄러(runAutomationNow → runOne → runGraph, runDueAutomationsNow)를 격리 저장소에서
 * 돌린다. 가짜는 두 곳뿐: 모델 호출(runMcpInvocation), 판정기(classifyAutomationOutcome — 기록된
 * needs_input 판정과 사유 문장).
 *
 * Run:
 *   npx tsc -p electron/tsconfig.json --outDir scripts/local/ytloop-dist --sourceMap false
 *   GOAL_HOLD_DIST=scripts/local/ytloop-dist npx electron scripts/goal-continuation-parks-on-needs-input-contract.cjs
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-goal-hold-"));
process.env.AGENTLAS_STORE_PATH = path.join(tmp, "agentlas.sqlite");
app.setPath("userData", path.join(tmp, "user-data"));

const REASON = "기획서와 추적표는 준비됐지만 채널 설정과 영상 게시를 이어가려면 소유자 로그인과 영상 생성 비용 승인이 필요합니다.";
const OUTPUT = "YouTube Studio는 Google 계정 선택·로그인 화면으로 돌려보내고, 공개 채널은 콘텐츠가 없다고 표시됩니다. 미인증 상태와 아직 승인되지 않은 $0.40 영상 생성 비용을 재개 메모에 남깁니다.";

(async () => {
  let exitCode = 0;
  try {
    await app.whenReady();
    const store = require(dist("store/db.js"));
    store.initStore();
    const db = store.getDb();
    require(dist("architecture/seed.js")).seedBuiltinAgents();
    require(dist("ui-locale.js")).setCurrentUiLocale("ko");

    // The two fakes: the model and the judge (recorded shapes).
    const invocations = [];
    const client = require(dist("mcp/client.js"));
    let continueMarker = false;
    client.runMcpInvocation = async (req) => {
      invocations.push(req.chatId);
      return { finalText: OUTPUT, stormbreakerContinueRequested: continueMarker };
    };
    const result = require(dist("automation-result.js"));
    result.classifyAutomationOutcome = async () => ({ outcome: "needs_input", reasonCode: "controller_judged", reason: REASON });

    const chats = require(dist("store/chats.js"));
    const automations = require(dist("store/automations.js"));
    const scheduler = require(dist("automation-scheduler.js"));
    const { parseChatHostNotice } = require(path.join(distRoot, "shared/chat-host-notice.js"));

    const goalId = "goal:auto-message:0000test-youtube-launch";
    const source = chats.createChat({ title: "Youtube launch", originSurface: "one", taskMode: "conversation" });
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO chat_goal_contracts (goal_id, chat_id, objective, acceptance_criteria_json, status, created_at, updated_at)
      VALUES (?, ?, ?, '[]', 'active', ?, ?)`).run(goalId, source.id, "유튜브 키워서 실버버튼", now, now);
    const automation = automations.createAutomation({
      name: "Goal continuation · Youtube launch",
      scheduleHuman: "every-10m",
      targetType: "agent",
      targetId: "builtin-agentlas-one",
      promptTemplate: `<<stormbreaker-long-run>>\nSource chat: ${source.id}\nContinue the unfinished Stormbreaker Loop goal from the source chat.`,
      createdBy: "agent",
      goalId,
    });
    const visible = () => db.prepare("SELECT role, text, host_notice_json FROM chat_messages WHERE chat_id = ? ORDER BY created_at").all(source.id);

    await scheduler.runAutomationNow(automation.id);
    assert.equal(invocations.length, 1, "the continuation ran once");
    const after = automations.getAutomation(automation.id);
    assert.equal(after.enabled, false, "needs_input parks the continuation instead of keeping every-10m");
    const lines = visible();
    assert.equal(lines.length, 1, `exactly one owner-facing line in the goal chat: ${JSON.stringify(lines)}`);
    assert.equal(lines[0].role, "system");
    assert.ok(lines[0].text.includes(REASON), "the blocker is stated in the owner's chat");
    assert.match(lines[0].text, /멈춰 두었어요/);
    const notice = parseChatHostNotice("system", lines[0].host_notice_json);
    assert.equal(notice?.purpose, "automation-report", "a structural marker, so One's screen renders it (unmarked system lines are hidden)");
    assert.equal(notice.automationId, automation.id);
    console.log("ok   needs_input: one visible notice in the goal chat, continuation parked");

    // Ten minutes later nothing changed: the scheduler must not wake it again.
    await scheduler.runDueAutomationsNow(new Date(Date.now() + 11 * 60_000));
    await scheduler.runDueAutomationsNow(new Date(Date.now() + 21 * 60_000));
    assert.equal(invocations.length, 1, "no re-wake with the same blocker");
    assert.equal(visible().length, 1, "no duplicate notice");
    console.log("ok   parked: no wake at +10m / +20m, no duplicate notice");

    // A partial pass that asks to continue keeps its cadence (the park is scoped to needs_input).
    continueMarker = true;
    result.classifyAutomationOutcome = async () => ({ outcome: "partial", reasonCode: null, reason: "more work" });
    automations.toggleAutomation(automation.id, true);
    await scheduler.runAutomationNow(automation.id);
    assert.equal(automations.getAutomation(automation.id).enabled, true, "a partial pass with the continue marker keeps the continuation running");
    console.log("ok   partial: continuation stays on its schedule");
    console.log("goal-continuation-parks-on-needs-input-contract: PASS");
  } catch (error) {
    exitCode = 1;
    console.error("goal-continuation-parks-on-needs-input-contract: FAIL");
    console.error(error && error.stack ? error.stack : error);
  } finally {
    try { require(dist("automation-scheduler.js")).stopAutomationScheduler(); } catch { /* not started */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* scratch */ }
    app.exit(exitCode);
  }
})();
