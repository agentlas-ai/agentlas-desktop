#!/usr/bin/env node
// Agent Group planner failure regression. The runner is a pure stub and no
// model, provider, browser, network, MCP server, or user credential is used.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-site-group-isolation-"));
app.setPath("userData", path.join(tmp, "user-data"));
process.env.AGENTLAS_STORE_PATH = path.join(tmp, "agentlas.sqlite");
process.env.AGENTLAS_E2E = "1";

const SENTINELS = [
  "SENTINEL_GROUP_STDERR_DO_NOT_EXPOSE",
  "/Users/sentinel/group-private-workspace",
  "sk-group-sentinel_12345678901234567890",
];

async function main() {
  await app.whenReady();
  const store = require("../dist/electron/store/db.js");
  store.initStore();
  const db = store.getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO installed_agents (
       id, slug, name, name_en, tagline, tagline_en, system_prompt,
       mcp_servers_json, env_requirements_json, preferred_backend,
       trust_grade, installed_at, tone, builtin, role, visibility, entity_kind
     ) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', '[]', NULL, 'A', ?, 'blue', 0, NULL, 'visible', 'agent')`,
  ).run(
    "site-group-fixture-agent",
    "site-group-fixture-agent",
    "Site Group Fixture",
    "Site Group Fixture",
    "Isolation fixture",
    "Isolation fixture",
    "Return the declared contract only.",
    now,
  );

  const chats = require("../dist/electron/store/chats.js");
  const chat = chats.createChat({ agentId: "site-group-fixture-agent", title: "Persistent group host chat" });
  chats.appendChatMessage(chat.id, "user", "GROUP_HOST_HISTORY_SENTINEL");
  const beforeMessages = chats.listChatMessages(chat.id).map(({ role, text }) => ({ role, text }));
  const orchestratorAgent = require("../dist/electron/mcp/registry.js").getAgentById("site-group-fixture-agent");
  assert.ok(orchestratorAgent);

  const safeConfigPath = path.join(tmp, "sentinel-private-agent-app.mcp.json");
  fs.writeFileSync(safeConfigPath, JSON.stringify({
    mcpServers: { "brave-search": { command: "/fixture/pinned/brave-search", args: [] } },
  }));
  const opaqueAlias = "AGENTLAS_MCP_SECRET_ABCDEF0123456789ABCDEF0123456789";
  const exactReadOnlyTools = [
    "mcp__brave-search__brave_web_search",
    "mcp__brave-search__brave_local_search",
  ];
  const failureText = [...SENTINELS, safeConfigPath, "stderr=permission denied"].join(" | ");
  const runnerRequests = [];
  const picked = {
    label: "Deterministic group failure stub",
    runner: async (request) => {
      runnerRequests.push(request);
      throw new Error(failureText);
    },
  };
  const active = {
    kind: "claude-code",
    backend: null,
    source: "site-group-isolation-test",
    ready: true,
    active: true,
    model: "stub-model",
    longContextEnabled: false,
  };
  const events = [];
  const { runBorrowedTaskForceInvocation } = require("../dist/electron/mcp/borrowed-task-force.js");
  await assert.rejects(
    () => runBorrowedTaskForceInvocation({
      req: {
        runId: "site-group-isolation-run",
        chatId: chat.id,
        userPrompt: "BROWSER_GROUP_INPUT_SENTINEL",
        locale: "en",
        permissions: "full",
        agentAppMode: true,
        borrowAgents: [],
        images: [{ id: "untrusted", name: "secret.png", mimeType: "image/png", dataUrl: "data:image/png;base64,AA==" }],
      },
      chat,
      orchestratorAgent,
      taskForceName: "Fixture group",
      taskForceKind: "agent-group",
      taskForceSpecs: [{
        slug: orchestratorAgent.slug,
        name: orchestratorAgent.name,
        directive: orchestratorAgent.systemPrompt,
        source: "installed",
        installedAgentId: orchestratorAgent.id,
      }],
      active,
      picked,
      workingFolder: SENTINELS[1],
      mcpConfigPath: safeConfigPath,
      mcpAllowedTools: exactReadOnlyTools,
      mcpCodexConfigArgs: ["-c", "mcp_servers.untrusted.enabled=true"],
      agentAppMcpRuntimeEnv: { [opaqueAlias]: "GROUP_OPAQUE_SECRET" },
      runnerEnv: {
        PATH: "/fixture/bin",
        HOME: "/fixture/home",
        OPENAI_API_KEY: SENTINELS[2],
        NODE_OPTIONS: "--require /tmp/group-preload.js",
      },
      locale: "en",
      sink: (event) => events.push(event),
    }),
    (error) => {
      assert.equal(error.code, "agent-app-runtime-failed");
      assert.equal(error.message, "Agent App runtime failed.");
      const projected = `${error.name} ${error.code} ${error.message}`;
      for (const sentinel of [...SENTINELS, safeConfigPath, failureText]) {
        assert.equal(projected.includes(sentinel), false);
      }
      return true;
    },
  );

  assert.equal(runnerRequests.length, 1, "group planner must fail at the first isolated runner call");
  const request = runnerRequests[0];
  assert.deepEqual(request.history, []);
  assert.equal(request.permission, "read");
  assert.equal(request.untrustedNoTools, true);
  assert.equal(request.cwd, undefined);
  assert.equal(request.images, undefined);
  assert.equal(request.mcpConfigPath, safeConfigPath);
  assert.deepEqual(request.mcpAllowedTools, exactReadOnlyTools);
  assert.equal(request.mcpCodexConfigArgs, undefined);
  assert.deepEqual(request.env, {
    PATH: "/fixture/bin",
    HOME: "/fixture/home",
    [opaqueAlias]: "GROUP_OPAQUE_SECRET",
    AGENTLAS_UNTRUSTED_NO_TOOLS: "1",
    NO_COLOR: "1",
  });
  assert.equal(request.env.OPENAI_API_KEY, undefined);
  assert.equal(request.env.NODE_OPTIONS, undefined);
  assert.match(request.chatId, /^site-agent-app:site-group-isolation-run:borrow-orchestrator:[0-9a-f-]{36}$/);
  const eventProjection = JSON.stringify(events);
  for (const sentinel of [...SENTINELS, safeConfigPath, failureText]) {
    assert.equal(eventProjection.includes(sentinel), false, `group events must not expose ${sentinel}`);
  }
  assert.deepEqual(
    chats.listChatMessages(chat.id).map(({ role, text }) => ({ role, text })),
    beforeMessages,
    "failed Agent App group runs must not persist browser input or runtime errors",
  );

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("site agent app group isolation behavior ok");
  app.quit();
}

main().catch((error) => {
  console.error(error);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  app.exit(1);
});
