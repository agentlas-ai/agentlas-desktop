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

  const liveHubListing = (slug, entityKind, patch = {}) => ({
    slug,
    name: `${entityKind} ${slug}`,
    nameEn: `${entityKind} ${slug}`,
    tagline: "Callable Hub fixture",
    taglineEn: "Callable Hub fixture",
    trustGrade: "A",
    installCount: 0,
    manifestUrl: "mock",
    kind: "cloud-callable",
    callable: true,
    routingReady: true,
    source: "hub-profile",
    entityKind,
    ...patch,
  });
  const marketplace = require("../dist/electron/marketplace/index.js");
  marketplace.getSource = () => ({
    searchAgents: async () => [
      liveHubListing("agentlas-prd-maker-studio", "team"),
      liveHubListing("same-group-slug", "agent"),
      liveHubListing("same-group-slug", "team", { agentCount: 3 }),
      liveHubListing("legacy-slug-only", "agent"),
      liveHubListing("group-install-only", "agent", { kind: "install-only", callable: false }),
      liveHubListing("group-routing-disabled", "team", { routingReady: false, agentCount: 2 }),
    ],
  });
  const groups = require("../dist/electron/store/agent-groups.js");
  const chats = require("../dist/electron/store/chats.js");

  const created = groups.createAgentGroup({
    name: "Launch crew",
    description: "Release checks",
    members: [
      {
        id: "draft-member",
        source: "hub",
        agentSlug: "agentlas-prd-maker-studio",
        hubSlug: "agentlas-prd-maker-studio",
        hubEntityKind: "team",
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
  assert.equal(listed[0].members[0].hubEntityKind, "team");
  const createdRuntime = await groups.resolveAgentGroupForRuntime(created.id);
  assert.equal(createdRuntime.members[0].entityKind, "team", "an unambiguous Hub member must retain its namespace at runtime");

  const composite = groups.createAgentGroup({
    name: "Composite Hub identities",
    members: [
      {
        id: "same-agent",
        source: "hub",
        hubSlug: "same-group-slug",
        hubEntityKind: "agent",
        addedAt: "2026-06-30T00:00:00.000Z",
        snapshot: { name: "Same agent", nameEn: "Same agent", tagline: "", taglineEn: "", routeLabel: "Hub", entityKind: "agent" },
      },
      {
        id: "same-team",
        source: "hub",
        hubSlug: "same-group-slug",
        hubEntityKind: "team",
        addedAt: "2026-06-30T00:00:00.000Z",
        snapshot: { name: "Same team", nameEn: "Same team", tagline: "", taglineEn: "", routeLabel: "Hub", entityKind: "team" },
      },
      {
        id: "same-agent-duplicate",
        source: "hub",
        hubSlug: "same-group-slug",
        hubEntityKind: "agent",
        addedAt: "2026-06-30T00:00:00.000Z",
        snapshot: { name: "Duplicate agent", nameEn: "Duplicate agent", tagline: "", taglineEn: "", routeLabel: "Hub", entityKind: "agent" },
      },
      {
        id: "install-only",
        source: "hub",
        hubSlug: "group-install-only",
        hubEntityKind: "agent",
        addedAt: "2026-06-30T00:00:00.000Z",
        snapshot: { name: "Install only", nameEn: "Install only", tagline: "", taglineEn: "", routeLabel: "Hub", entityKind: "agent" },
      },
      {
        id: "routing-disabled",
        source: "hub",
        hubSlug: "group-routing-disabled",
        hubEntityKind: "team",
        addedAt: "2026-06-30T00:00:00.000Z",
        snapshot: { name: "Routing disabled", nameEn: "Routing disabled", tagline: "", taglineEn: "", routeLabel: "Hub", entityKind: "team" },
      },
    ],
  });
  assert.equal(composite.members.length, 4, "same-slug agent/team must survive dedupe while an exact duplicate is removed");
  assert.deepEqual(
    composite.members.filter((member) => member.hubSlug === "same-group-slug").map((member) => member.hubEntityKind).sort(),
    ["agent", "team"],
  );
  const compositeRuntime = await groups.resolveAgentGroupForRuntime(composite.id);
  assert.equal(
    compositeRuntime.members.filter((member) => member.slug === "same-group-slug").length,
    0,
    "same-slug agent/team cannot become runnable while hep-call remains slug-only",
  );
  assert.deepEqual(
    compositeRuntime.skipped.map((member) => member.id).sort(),
    ["install-only", "routing-disabled", "same-agent", "same-team"],
    "ambiguous/non-callable/install-only/routing-disabled Hub listings must never become runnable group members",
  );

  const legacy = groups.createAgentGroup({
    name: "Legacy slug-only group",
    members: [
      {
        id: "legacy-slug-only-member",
        source: "hub",
        hubSlug: "legacy-slug-only",
        addedAt: "2026-06-30T00:00:00.000Z",
        snapshot: { name: "Legacy", nameEn: "Legacy", tagline: "", taglineEn: "", routeLabel: "Hub" },
      },
    ],
  });
  assert.equal(legacy.members[0].hubEntityKind, undefined, "legacy slug-only rows must remain readable without a forced namespace");
  const legacyRuntime = await groups.resolveAgentGroupForRuntime(legacy.id);
  assert.equal(legacyRuntime.members[0].slug, "legacy-slug-only");
  assert.equal(legacyRuntime.members[0].entityKind, "agent");

  const chat = chats.createChat({ agentGroupId: created.id, title: "Launch crew" });
  assert.equal(chat.agentGroupId, created.id);
  assert.equal(chat.firmId, null);
  assert.equal(chat.agentId, "agent-orchestrator-test");

  const empty = groups.removeAgentGroupMember(created.id, created.members[0].id);
  assert.equal(empty.members.length, 0, "members must be removable one at a time, including the last one");

  groups.removeAgentGroup(created.id);
  groups.removeAgentGroup(composite.id);
  groups.removeAgentGroup(legacy.id);
  assert.equal(groups.listAgentGroups().length, 0);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("agent groups store contract ok");
  app.quit();
}

main().catch((err) => {
  console.error(err);
  app.exit(1);
});
