#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { initStore } = require("../dist/electron/store/db.js");
const { getServer } = require("../dist/electron/mcp-tools/registry.js");
const { scaffoldServiceApp } = require("../dist/electron/app-factory/scaffold.js");
const {
  archiveAppPackage,
  installMcpPlan,
  prepareProviderBrowserOpen,
  preparePreviewDeploy,
  publishAppAsTool,
  restoreAppPackage,
  runAppFactorySmoke,
  runProviderTasks,
} = require("../dist/electron/app-factory/operations.js");

(async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-app-factory-"));
  const nodeBin = process.versions.electron
    ? (process.env.NODE || "node")
    : (process.env.npm_node_execpath || process.env.NODE || process.execPath);
  process.env.AGENTLAS_STORE_PATH = path.join(baseDir, "agentlas-smoke.sqlite");
  initStore();
  const result = await scaffoldServiceApp(
    {
      chatId: "chat-smoke",
      surfaceId: "surface-smoke",
      actionId: "scaffold",
      manifest: {
        version: "0.1",
        kind: "surface",
        title: "Trip Revenue Desk",
        domain: "travel",
        layout: "service-app",
        app: {
          name: "Trip Revenue Desk",
          tagline: "Turn travel research into bookable packages.",
          appType: "saas",
          audience: "Micro travel agencies",
          valueProp: "Build a reusable travel sales console from an agent answer.",
          routes: [
            { path: "/", label: "Deals", purpose: "Compare packages", status: "generated" },
            { path: "/supplier", label: "Supplier Ops", purpose: "Check vendors", status: "planned" },
          ],
          connectors: [
            {
              id: "booking",
              name: "Booking.com MCP",
              type: "mcp",
              purpose: "Hotel proof",
              auth: "user-approval",
              status: "verified",
            },
            {
              id: "flight-search",
              name: "Flight search API",
              type: "api",
              purpose: "Fare checks",
              auth: "api-key",
              status: "missing-credential",
            },
          ],
          tools: [
            {
              id: "margin-normalizer",
              name: "Margin Normalizer",
              description: "Normalize travel package margin inputs before comparison.",
              kind: "normalizer",
              parameters: [
                { name: "revenue", type: "number", required: true },
                { name: "cost", type: "number", required: true },
              ],
            },
          ],
          deployment: { target: "agentlas desktop", readiness: "prototype" },
          business: { pricing: "$49/mo", launchMetric: "3 paid quotes" },
        },
        data: {
          launch: {
            type: "launch-checklist",
            rows: [{ item: "Working app preview", status: "ready" }],
          },
          artifacts: {
            type: "artifacts",
            rows: [{ name: "Smoke test", status: "ready" }],
          },
        },
        widgets: [
          { type: "app-shell", data: "routes" },
          { type: "mcp-builder", data: "connectors" },
          { type: "launch-checklist", data: "launch" },
        ],
        actions: [
          { id: "scaffold", label: "Scaffold this app", type: "scaffold-app" },
          { id: "connect", label: "Connect suppliers", type: "connect-service" },
          { id: "credential", label: "Save flight API key", type: "request-credential" },
        ],
      },
    },
    { baseDir, now: "2026-05-31T00:00:00.000Z" },
  );

  assert.equal(result.appName, "Trip Revenue Desk");
  assert.ok(result.rootPath.startsWith(baseDir));
  assert.ok(fs.existsSync(result.previewPath));
  assert.ok(fs.existsSync(result.setupPath));
  assert.ok(fs.existsSync(result.smokePath));
  assert.ok(result.files.some((f) => f.path === "mcp/required-connectors.json"));
  assert.ok(result.files.some((f) => f.path === "tools/required-tools.json"));
  assert.ok(result.files.some((f) => f.path === "src/index.html"));
  assert.ok(result.files.some((f) => f.path === "src/supplier/index.html"));
  assert.ok(fs.existsSync(path.join(result.rootPath, "src/supplier/index.html")));

  const smoke = spawnSync(nodeBin, [result.smokePath], {
    cwd: result.rootPath,
    encoding: "utf8",
  });
  assert.equal(smoke.status, 0, smoke.stderr || smoke.stdout);
  assert.match(smoke.stdout, /Trip Revenue Desk smoke passed/);

  const mcp = await installMcpPlan({ rootPath: result.rootPath });
  assert.ok(fs.existsSync(mcp.configPath));
  assert.ok(fs.existsSync(mcp.envPath));
  assert.equal(mcp.adapters.length, 2);
  assert.ok(mcp.adapters.some((a) => a.path === "mcp/servers/booking.mjs"));
  assert.ok(mcp.missingCredentials.includes("BOOKING_USER_APPROVAL"));

  const providerTasks = await runProviderTasks({ rootPath: result.rootPath });
  assert.equal(providerTasks.tasks.length, 2);
  assert.equal(providerTasks.secureInputRequiredCount, 1);
  assert.ok(providerTasks.browserPlans.some((plan) => plan.startUrl.includes("dashboard.stripe.com") || plan.startUrl.includes("google.com") || plan.startUrl.includes("vercel.com") || plan.startUrl.includes("supabase.com")));
  assert.ok(providerTasks.credentialGates.some((gate) => gate.envKey === "FLIGHT_SEARCH_API_KEY"));
  assert.ok(fs.existsSync(providerTasks.resultsPath));
  assert.ok(fs.existsSync(providerTasks.runbookPath));

  const providerBrowser = await prepareProviderBrowserOpen({ rootPath: result.rootPath });
  assert.ok(providerBrowser.opened.length >= 1);

  const smokeViaFactory = await runAppFactorySmoke({ rootPath: result.rootPath });
  assert.equal(smokeViaFactory.ok, true, smokeViaFactory.stderr);
  assert.match(smokeViaFactory.stdout, /Trip Revenue Desk smoke passed/);

  const preview = await preparePreviewDeploy({ rootPath: result.rootPath });
  assert.ok(fs.existsSync(preview.previewPath));
  assert.ok(fs.existsSync(preview.manifestPath));
  assert.ok(fs.existsSync(path.join(preview.deployPath, "supplier", "index.html")));
  assert.ok(preview.fileUrl.startsWith("file://"));
  assert.ok(fs.existsSync(path.join(result.rootPath, "DEPLOY.md")));

  const published = await publishAppAsTool({ rootPath: result.rootPath });
  assert.ok(fs.existsSync(published.configPath));
  assert.ok(fs.existsSync(published.mcpPath));
  assert.ok(published.server.id);
  assert.ok(!/Electron/i.test(published.server.command || ""), "reusable app MCP command must be a Node runtime, not Electron");
  assert.ok(getServer(published.server.id), "published app MCP server must be registered");
  const publishedOperations = JSON.parse(fs.readFileSync(path.join(result.rootPath, "data", "operations.json"), "utf8"));
  assert.equal(publishedOperations.reuse.status, "published-as-tool");
  assert.equal(publishedOperations.reuse.mcpServerId, published.server.id);
  const toolList = spawnSync(
    nodeBin,
    [published.mcpPath],
    {
      input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`,
      cwd: result.rootPath,
      encoding: "utf8",
    },
  );
  assert.equal(toolList.status, 0, toolList.stderr || toolList.stdout);
  assert.match(toolList.stdout, new RegExp(published.toolName));
  const toolCall = spawnSync(
    nodeBin,
    [published.mcpPath],
    {
      input: `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { arguments: { view: "reuse" } } })}\n`,
      cwd: result.rootPath,
      encoding: "utf8",
    },
  );
  assert.equal(toolCall.status, 0, toolCall.stderr || toolCall.stdout);
  assert.match(toolCall.stdout, /published-as-tool/);

  const archived = await archiveAppPackage({ rootPath: result.rootPath });
  assert.equal(archived.removed, true);
  assert.equal(archived.reversible, true);
  assert.equal(archived.reuseWasPublished, true);
  assert.equal(archived.removedMcpServerId, published.server.id);
  assert.equal(getServer(published.server.id), null, "archiving must unregister the reusable app MCP server");
  assert.ok(fs.existsSync(archived.archivePath));
  assert.ok(fs.existsSync(archived.manifestPath));
  assert.equal(fs.existsSync(result.rootPath), false);
  const archivedOperations = JSON.parse(fs.readFileSync(path.join(archived.archivePath, "data", "operations.json"), "utf8"));
  assert.equal(archivedOperations.reuse.status, "archived");
  assert.equal(archivedOperations.reuse.mcpServerId, null);
  assert.equal(archivedOperations.reuse.removedMcpServerId, published.server.id);
  const archiveManifest = JSON.parse(fs.readFileSync(archived.manifestPath, "utf8"));
  assert.equal(archiveManifest.restore.operation, "appFactory.restore");
  assert.equal(archiveManifest.gc.policy, "manual-confirmation-required");

  const restored = await restoreAppPackage({ rootPath: result.rootPath });
  assert.equal(restored.restored, true);
  assert.ok(restored.restoredMcpServerId, "restore must re-register the reusable app MCP server");
  const restoredServer = getServer(restored.restoredMcpServerId);
  assert.ok(restoredServer, "restored app MCP server must be registered");
  assert.ok(!/Electron/i.test(restoredServer.command || ""), "restored app MCP command must be a Node runtime, not Electron");
  assert.ok(fs.existsSync(result.rootPath));
  assert.ok(fs.existsSync(path.join(result.rootPath, "agentlas.app.json")));
  const restoredOperations = JSON.parse(fs.readFileSync(path.join(result.rootPath, "data", "operations.json"), "utf8"));
  assert.equal(restoredOperations.lifecycle.status, "restored");
  assert.equal(restoredOperations.lifecycle.reversible, true);
  assert.equal(restoredOperations.reuse.status, "published-as-tool");
  assert.equal(restoredOperations.reuse.mcpServerId, restored.restoredMcpServerId);

  console.log("app-factory smoke passed");
})()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
