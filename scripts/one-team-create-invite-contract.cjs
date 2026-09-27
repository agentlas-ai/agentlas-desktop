#!/usr/bin/env node
/*
 * One 이 스스로 팀원을 만들고 단톡방에 초대하고, 다음 턴에 그 팀원에게 일을 맡길 수 있는가.
 *
 * 실측(2026-09-27, 설치본 1.2.45, 단톡 "Youtube launch" — 팀원 0명인 group 좌석):
 *   오너 "너가 알아서 단톡방에 에이전트 만들던지 팀원 초대하던지 해서 유투브 키우셈 모든 권한 줄테니까…"
 *   One 은 one-team.one_team_list 만 부를 수 있었다. 만들기 길은 렌더러의 "새 에이전트" 창,
 *   초대 길은 단톡 설정 시트에만 있어서 One 에게는 도구가 0개였다(오너: "스스로 좌석에 새로운
 *   에이전트 만들어서 단톡방에 불러오는 건 못 하나 보네").
 *
 * 이 계약은 실제 제품 함수(org.createOneTeamAgent · taskforces.updateOneTaskforce ·
 * chats.appendChatMessage · team-dispatch 의 도구 연산)를 격리 저장소에서 부르고, 인라인 MCP
 * 자식을 실제로 띄워 tools/list·tools/call 을 한 번 왕복한다. 모델·CLI 실행만 가짜다.
 *
 * Run:
 *   npx tsc -p electron/tsconfig.json --outDir scripts/local/ytloop-dist --sourceMap false
 *   ONE_TEAM_DIST=scripts/local/ytloop-dist npx electron scripts/one-team-create-invite-contract.cjs
 * (ONE_TEAM_DIST 가 없으면 dist/ 를 쓴다.)
 */
process.env.AGENTLAS_E2E = "1";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { spawn } = require("node:child_process");
const { app } = require("electron");

app.disableHardwareAcceleration();
const root = path.resolve(__dirname, "..");
const distRoot = path.resolve(root, process.env.ONE_TEAM_DIST || "dist");
const dist = (relative) => path.join(distRoot, "electron", relative);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-one-team-roster-"));
process.env.AGENTLAS_STORE_PATH = path.join(tmp, "agentlas.sqlite");
app.setPath("userData", path.join(tmp, "user-data"));

// The model/CLI is the only fake: a start records the request instead of spawning a runtime.
const started = [];
const servicePath = dist("invocation/service.js");
const serviceStub = new Module(servicePath);
serviceStub.filename = servicePath;
serviceStub.loaded = true;
serviceStub.exports = {
  invocationService: {
    activeChatIds: () => [],
    attach: () => null,
    start: (request) => { started.push(request); },
    steer: () => ({ runId: "steer", queued: false }),
    onSettled: () => {},
  },
};
require.cache[servicePath] = serviceStub;

let passed = 0;
function ok(name) { passed += 1; console.log(`ok   ${name}`); }

function rpc(child, message) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("mcp child did not answer")), 20_000);
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      resolve(JSON.parse(buffer.slice(0, end)));
    };
    child.stdout.on("data", onData);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  });
}

(async () => {
  let exitCode = 0;
  let child = null;
  try {
    await app.whenReady();
    const store = require(dist("store/db.js"));
    store.initStore();
    const db = store.getDb();
    require(dist("architecture/seed.js")).seedBuiltinAgents();
    const ui = require(dist("ui-locale.js"));
    ui.setCurrentUiLocale("ko");
    const taskforces = require(dist("one/taskforces.js"));
    const chats = require(dist("store/chats.js"));
    const team = require(dist("one/team-dispatch.js"));
    const control = require(dist("one/team-control-server.js"));
    const mcp = require(dist("one/team-mcp-server.js"));
    const { parseChatHostNotice } = require(path.join(distRoot, "shared/chat-host-notice.js"));

    // The recorded shape: a One group chat whose seat has no members yet.
    const group = taskforces.createOneTaskforce({ title: "Youtube launch", description: "Agentlas 유투브 운영", memberAgentIds: [] });
    const full = { chatId: group.chatId, permission: "full" };
    const count = (sql, ...args) => db.prepare(sql).get(...args).n;
    const members = () => count("SELECT COUNT(*) AS n FROM one_org_members WHERE archived_at IS NULL");
    const groupMembers = () => taskforces.listOneTaskforces().find((row) => row.id === group.id).memberAgentIds;

    // 1) create → invited into this group, same rows the New Agent dialog writes, visible receipt.
    const created = team.oneTeamCreateMember(full, { name: "숏츠 프로듀서", role: "Blender 10–20초 쇼츠 기획·제작", personality: "빠르고 데이터로 말한다" });
    assert.equal(created.confirmed, true);
    assert.equal(created.created, true);
    assert.equal(created.invited, true);
    const agentRow = db.prepare("SELECT a.id, a.tone, a.system_prompt FROM installed_agents a JOIN one_org_members m ON m.installed_agent_id = a.id WHERE m.id = ?").get(created.member_id);
    assert.ok(agentRow, "the teammate exists in installed_agents + one_org_members");
    assert.match(agentRow.tone, /^character:/, "a default character avatar like the dialog's preset");
    assert.match(agentRow.system_prompt, /Your role is: Blender/, "role went through the product prompt");
    assert.ok(db.prepare("SELECT 1 FROM chats WHERE agent_id = ? AND origin_surface = 'one'").get(agentRow.id), "the teammate has its own chat");
    assert.deepEqual(groupMembers(), [agentRow.id], "the group chat now holds the new teammate");
    const seat = db.prepare("SELECT seat_id FROM chats WHERE id = ?").get(group.chatId).seat_id;
    assert.equal(count("SELECT COUNT(*) AS n FROM one_seat_occupants WHERE seat_id = ? AND agent_id = ? AND until IS NULL", seat, agentRow.id), 1, "seated in the group seat");
    const receipt = db.prepare("SELECT role, text, host_notice_json FROM chat_messages WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1").get(group.chatId);
    assert.equal(receipt.role, "system");
    assert.equal(receipt.text, "새 팀원 숏츠 프로듀서를 만들어 이 단톡방에 초대했어요.");
    assert.deepEqual(parseChatHostNotice("system", receipt.host_notice_json), { purpose: "one-team-member-joined", memberName: "숏츠 프로듀서", created: true },
      "the receipt carries a structural marker, so One's screen shows it (unmarked system lines are hidden)");
    ok("create: product creation path, invited into the group seat, visible receipt in the owner's language");

    // 2) the same name again is never a twin.
    const before = members();
    const again = team.oneTeamCreateMember(full, { name: "숏츠 프로듀서" });
    assert.equal(again.already_exists, true);
    assert.equal(members(), before);
    ok("retry: the same name returns the existing teammate, nothing duplicated");

    // 3) read-only run creates nothing and says so.
    assert.throws(() => team.oneTeamCreateMember({ chatId: group.chatId, permission: "read" }, { name: "리서처" }), /^Error: one-team-permission-required: .*만들거나 초대하지 않았어요/);
    assert.equal(members(), before);
    ok("read-only: refused with the reason, nothing created");

    // 4) invite an existing teammate made elsewhere.
    const other = team.oneTeamCreateMember(full, { name: "Trend Scout", role: "topic research", invite: false });
    assert.equal(other.invited, false);
    assert.equal(groupMembers().length, 1);
    const invited = team.oneTeamInvite(full, { member: "trend scout" });
    assert.equal(invited.confirmed, true);
    assert.equal(groupMembers().length, 2);
    assert.equal(team.oneTeamInvite(full, { member: "Trend Scout" }).already_member, true);
    assert.equal(groupMembers().length, 2);
    ok("invite: an existing teammate joins once; a second invite is a no-op");

    // 5) a One 1:1 conversation is not a group: honest refusal, nothing changes.
    const solo = chats.createChat({ title: "solo", originSurface: "one", taskMode: "conversation" });
    assert.throws(() => team.oneTeamInvite({ chatId: solo.id, permission: "full" }, { member: "Trend Scout" }), /^Error: one-team-not-a-group-chat: /);
    ok("not a group chat: refused with the way forward");

    // 6) the team is full: the product's slot limit refuses with its own sentence, nothing created.
    let refusal = null;
    for (let index = 0; index < 64 && !refusal; index += 1) {
      try { team.oneTeamCreateMember(full, { name: `Worker ${index}`, invite: false }); } catch (error) { refusal = error; }
    }
    assert.ok(refusal, "the slot limit eventually refuses");
    const atLimit = members();
    assert.match(String(refusal.message), /^one-team-create-refused: .*아무도 만들어지지 않았어요\.$/);
    assert.throws(() => team.oneTeamCreateMember(full, { name: "One more" }));
    assert.equal(members(), atLimit);
    ok("team full: refused with the product's reason, the roster is unchanged");

    // 6b) recorded: One tried to hand work to a Hub team name that is not a teammate. The refusal points at the way out.
    assert.throws(() => team.oneTeamStartSession(full, { member: "Research Intelligence Desk", brief: "채널 조사" }),
      /^Error: one-team-member-not-found: .*아무것도 시작되지 않았어요\. .*one_team_create_member/);
    ok("unknown teammate: refusal names one_team_create_member as the way out");

    // 7) the next turn can hand the new teammate work in their own session.
    const dispatched = team.oneTeamStartSession(full, { member: "숏츠 프로듀서", brief: "AI 쇼츠 주제 5개를 조회수 근거와 함께 뽑아 줘" });
    assert.equal(dispatched.confirmed, true);
    assert.equal(started.length, 1);
    assert.equal(db.prepare("SELECT agent_id FROM chats WHERE id = ?").get(started[0].chatId).agent_id, agentRow.id, "the session runs as the new teammate");
    assert.equal(started[0].permissions, "full", "the owner's grant carries over");
    ok("dispatch: the created teammate takes work in its own session");

    // 8) the real inline MCP child exposes both tools and reaches Main through the capability.
    const capability = await control.createOneTeamCapability(full, "contract");
    const args = mcp.oneTeamMcpLaunchArgs();
    assert.ok(mcp.isAuthenticOneTeamMcpLaunch(process.execPath, args), "the launch stays authentic and within budget");
    child = spawn(process.execPath, args, { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", [mcp.ONE_TEAM_CONTROL_ENV]: capability.path }, stdio: ["pipe", "pipe", "inherit"] });
    await rpc(child, { id: 1, method: "initialize", params: {} });
    const listed = await rpc(child, { id: 2, method: "tools/list", params: {} });
    const names = listed.result.tools.map((tool) => tool.name);
    for (const name of mcp.AGENTLAS_ONE_TEAM_TOOL_NAMES) assert.ok(names.includes(name), `tools/list exposes ${name}`);
    assert.ok(names.includes("one_team_create_member") && names.includes("one_team_invite"));
    // Free a slot first: archive one filler through the product.
    const org = require(dist("one/org.js"));
    const filler = org.getOneOrgState().members.find((member) => !member.archivedAt && member.displayName.startsWith("Worker"));
    org.archiveOneOrgMember({ id: filler.id });
    const call = await rpc(child, { id: 3, method: "tools/call", params: { name: "one_team_create_member", arguments: { name: "썸네일 디자이너", role: "thumbnails" } } });
    assert.equal(call.result.isError, undefined, JSON.stringify(call.result));
    const payload = JSON.parse(call.result.content[0].text);
    assert.equal(payload.created, true);
    assert.equal(payload.invited, true);
    assert.equal(groupMembers().length, 3);
    ok("inline MCP: tools/list shows create/invite and tools/call creates + invites through Main");
    control.removeOneTeamCapability("contract", capability.binding.capabilityId);
    console.log(`one-team-create-invite-contract: PASS (${passed})`);
  } catch (error) {
    exitCode = 1;
    console.error("one-team-create-invite-contract: FAIL");
    console.error(error && error.stack ? error.stack : error);
  } finally {
    try { child?.kill(); } catch { /* already gone */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* scratch */ }
    app.exit(exitCode);
  }
})();
