#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { initStore } = require("../dist/electron/store/db.js");
const { createChat, setChatWorkingFolder } = require("../dist/electron/store/chats.js");
const {
  getAgentTool,
  recordAgentToolOperation,
  recordScaffoldedTool,
} = require("../dist/electron/store/agent-tools.js");
const { getServer } = require("../dist/electron/mcp-tools/registry.js");
const { scaffoldAgentTool, runToolFactorySmoke } = require("../dist/electron/tool-factory/scaffold.js");
const {
  archiveToolPackage,
  installToolMcp,
  restoreToolPackage,
} = require("../dist/electron/tool-factory/operations.js");
const { getDb } = require("../dist/electron/store/db.js");

(async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-tool-factory-"));
  process.env.AGENTLAS_STORE_PATH = path.join(baseDir, "agentlas.sqlite");
  initStore();
  getDb()
    .prepare(
      `INSERT INTO installed_agents (
        id, slug, name, tagline, system_prompt, mcp_servers_json,
        trust_grade, installed_at, tone, env_requirements_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "agent-tool-smoke",
      "tool-smoke-agent",
      "Tool Smoke Agent",
      "Builds reversible local tools",
      "Create safe Agentlas tool packages.",
      "[]",
      "A",
      "2026-05-31T00:00:00.000Z",
      "green",
      "[]",
    );
  const chat = createChat({ agentId: "agent-tool-smoke", title: "Tool Factory smoke" });
  setChatWorkingFolder(chat.id, baseDir);
  const result = await scaffoldAgentTool(
    {
      chatId: "chat-tool-smoke",
      surfaceId: "surface-tool-smoke",
      actionId: "build-margin-tool",
      toolId: "margin-normalizer",
      manifest: {
        version: "0.1",
        kind: "surface",
        title: "Trip Revenue Desk",
        domain: "travel",
        layout: "service-app",
        app: {
          name: "Trip Revenue Desk",
          tools: [
            {
              id: "margin-normalizer",
              name: "Margin Normalizer",
              description: "Normalize package revenue, cost, and channel margin inputs before quote comparison.",
              kind: "normalizer",
              parameters: [
                { name: "revenue", type: "number", required: true },
                { name: "cost", type: "number", required: true },
                { name: "channel", type: "string", required: false },
              ],
              outputs: [{ name: "accepted", type: "boolean" }],
              examples: [{ input: { revenue: 1200, cost: 880, channel: "booking" } }],
            },
          ],
        },
        data: {
          tools: { type: "tools", rows: [] },
        },
        widgets: [{ type: "tool-builder", data: "tools" }],
        actions: [
          {
            id: "build-margin-tool",
            label: "Build Margin Normalizer",
            type: "scaffold-tool",
            toolId: "margin-normalizer",
          },
        ],
      },
    },
    { baseDir, now: "2026-05-31T00:00:00.000Z" },
  );

  assert.equal(result.toolName, "Margin Normalizer");
  assert.equal(result.requestedToolId, "margin-normalizer");
  assert.equal(result.domain, "travel");
  assert.equal(result.kind, "normalizer");
  assert.ok(result.rootPath.startsWith(baseDir));
  assert.ok(fs.existsSync(result.configPath));
  assert.ok(fs.existsSync(result.toolPath));
  assert.ok(fs.existsSync(result.mcpPath));
  assert.ok(fs.existsSync(result.smokePath));
  assert.ok(fs.existsSync(path.join(result.rootPath, "agentlas.tool.json")));
  const record = recordScaffoldedTool({
    chatId: chat.id,
    projectId: null,
    agentId: "agent-tool-smoke",
    surfaceId: "surface-tool-smoke",
    actionId: "build-margin-tool",
    scaffold: result,
  });

  const smoke = await runToolFactorySmoke({ rootPath: result.rootPath });
  assert.equal(smoke.ok, true, smoke.stderr);
  assert.match(smoke.stdout, /Margin Normalizer smoke passed/);
  recordAgentToolOperation(record.id, "run-smoke-test", true, smoke, "smoke-passed");

  const installed = await installToolMcp({ rootPath: result.rootPath });
  recordAgentToolOperation(record.id, "install-mcp", true, installed, "mcp-installed", installed.server.id);
  assert.ok(getServer(installed.server.id), "installed MCP server must be registered");

  const archived = await archiveToolPackage({ rootPath: result.rootPath });
  recordAgentToolOperation(record.id, "archive", true, archived, "archived", null);
  assert.equal(archived.removed, true);
  assert.equal(archived.reversible, true);
  assert.equal(archived.removedServerId, installed.server.id);
  assert.ok(!fs.existsSync(result.rootPath), "archive must move the active tool root away");
  assert.ok(fs.existsSync(archived.archivePath));
  assert.ok(fs.existsSync(archived.manifestPath));
  assert.equal(getServer(installed.server.id), null, "archive must unregister the MCP server");
  assert.equal(getAgentTool(record.id).status, "archived");

  const archiveManifest = JSON.parse(fs.readFileSync(archived.manifestPath, "utf8"));
  assert.equal(archiveManifest.restore.operation, "toolFactory.restore");
  assert.equal(archiveManifest.gc.policy, "manual-confirmation-required");

  const restored = await restoreToolPackage({ rootPath: result.rootPath });
  recordAgentToolOperation(record.id, "restore", true, restored, "restored", restored.restoredServerId);
  assert.equal(restored.restored, true);
  assert.ok(fs.existsSync(result.rootPath), "restore must move the tool back to its original root");
  assert.ok(restored.restoredServerId, "restore must re-register the tool MCP server");
  assert.ok(getServer(restored.restoredServerId), "restored MCP server must be registered");
  assert.equal(getAgentTool(record.id).status, "restored");

  console.log("tool-factory smoke passed");
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
