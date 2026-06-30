const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-agent-groups-"));
  process.env.AGENTLAS_STORE_PATH = path.join(tmp, "agentlas.sqlite");

  await app.whenReady();
  const db = require("../dist/electron/store/db.js");
  const groups = require("../dist/electron/store/agent-groups.js");
  const chats = require("../dist/electron/store/chats.js");
  db.initStore();
  db.getDb()
    .prepare(
      `INSERT INTO installed_agents
       (id, slug, name, name_en, tagline, tagline_en, system_prompt, mcp_servers_json,
        env_requirements_json, preferred_backend, trust_grade, installed_at, tone, builtin, role, visibility)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "agent-orchestrator-test",
      "agentlas-orchestrator",
      "Agentlas Orchestrator",
      "Agentlas Orchestrator",
      "Routes work",
      "Routes work",
      "You coordinate Agentlas work.",
      "[]",
      "[]",
      null,
      "A",
      "2026-06-30T00:00:00.000Z",
      "blue",
      1,
      null,
      "visible",
    );

  const created = groups.createAgentGroup({
    name: "Launch crew",
    description: "Release checks",
    members: [
      {
        id: "draft-member",
        source: "hub",
        agentSlug: "agentlas-prd-maker-studio",
        hubSlug: "agentlas-prd-maker-studio",
        addedAt: "2026-06-30T00:00:00.000Z",
        snapshot: {
          name: "PRD Maker",
          nameEn: "PRD Maker",
          tagline: "Write specs",
          taglineEn: "Write specs",
          routeLabel: "Hub",
          trustGrade: "A",
          entityKind: "team",
        },
      },
    ],
  });

  assert.equal(created.name, "Launch crew");
  assert.equal(created.orchestratorName, "Launch crew Orchestrator");
  assert.equal(created.members.length, 1);

  const listed = groups.listAgentGroups();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].members[0].hubSlug, "agentlas-prd-maker-studio");

  const chat = chats.createChat({ agentGroupId: created.id, title: "Launch crew" });
  assert.equal(chat.agentGroupId, created.id);
  assert.equal(chat.firmId, null);
  assert.equal(chat.agentId, "agent-orchestrator-test");

  const empty = groups.removeAgentGroupMember(created.id, listed[0].members[0].id);
  assert.equal(empty.members.length, 0, "members must be removable one at a time, including the last one");

  groups.removeAgentGroup(created.id);
  assert.equal(groups.listAgentGroups().length, 0);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("agent groups store contract ok");
  app.quit();
}

main().catch((err) => {
  console.error(err);
  app.exit(1);
});
