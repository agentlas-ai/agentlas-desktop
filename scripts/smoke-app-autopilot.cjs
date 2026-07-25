#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-app-autopilot-"));
const nodeBin = process.env.npm_node_execpath || process.env.NODE || "node";
process.env.AGENTLAS_STORE_PATH = path.join(baseDir, "agentlas.sqlite");

const { initStore, getDb } = require("../dist/electron/store/db.js");
const { createChat, setChatWorkingFolder } = require("../dist/electron/store/chats.js");
const { prepareEcommerceOpsManifest } = require("../dist/electron/ecommerce-pack/surface.js");
const { scaffoldServiceApp } = require("../dist/electron/app-factory/scaffold.js");
const { runAppFactoryAutopilot } = require("../dist/electron/app-factory/operations.js");

function seedAgent() {
  const now = "2026-05-31T00:00:00.000Z";
  getDb()
    .prepare(
      `INSERT INTO installed_agents (
        id, slug, name, tagline, system_prompt, mcp_servers_json,
        trust_grade, installed_at, tone, env_requirements_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "agent-autopilot-smoke",
      "autopilot-smoke",
      "Autopilot Smoke Agent",
      "Operates generated Agentlas apps",
      "Create and operate safe Agentlas OS apps.",
      "[]",
      "A",
      now,
      "green",
      "[]",
    );
}

(async () => {
  const envKeys = [
    "PAYMENT_PROVIDER_USER_APPROVAL",
    "COMMERCE_DATABASE_API_KEY",
    "IMAGE_GENERATION_USER_APPROVAL",
    "STOREFRONT_HOST_OAUTH_CLIENT",
    "COMMERCE_PROVIDER_CREDENTIALS",
  ];
  const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  try {
    initStore();
    seedAgent();
    for (const key of envKeys) process.env[key] = `autopilot-${key.toLowerCase()}`;

    const chat = createChat({ agentId: "agent-autopilot-smoke", title: "Autopilot ecommerce smoke" });
    setChatWorkingFolder(chat.id, baseDir);
    const manifest = await prepareEcommerceOpsManifest({
      prompt: "여자옷 쇼핑몰 사업하고 싶어. 결제, 디비, 이미지 생성, 운영 대시보드까지 알아서 만들어줘.",
      now: "2026-05-31T00:00:00.000Z",
    });
    assert.ok(manifest.actions.some((action) => action.type === "operate-app"));

    const app = await scaffoldServiceApp(
      {
        chatId: chat.id,
        surfaceId: "surface-autopilot-smoke",
        actionId: "operate-commerce-os",
        manifest,
      },
      { baseDir, now: "2026-05-31T00:00:00.000Z" },
    );

    const result = await runAppFactoryAutopilot({
      rootPath: app.rootPath,
      budgetApproved: true,
      approvedBy: "autopilot-smoke",
      approvalReason: "Smoke test proves one-shot Agentlas OS operation.",
      credentialSource: "env",
      captureProviderSessions: false,
      browserMode: "plan-only",
    });

    assert.equal(result.status, "operated");
    assert.equal(result.credentialResolution.missingCount, 0);
    assert.equal(result.providerRun.noDeadEndStrategy.status, "recoverable");
    assert.equal(result.providerRun.noDeadEndStrategy.violations.length, 0);
    assert.ok(result.providerRun.noDeadEndStrategy.plans.every((plan) => plan.canProceedWithoutMcp === true));
    assert.equal(result.materializedAssets.assets.length, 2);
    assert.equal(result.localStack.products, 2);
    assert.equal(result.smoke.ok, true, result.smoke.stderr);
    assert.ok(result.preview.fileUrl.startsWith("file://"));
    assert.ok(fs.existsSync(result.appTool.mcpPath));
    assert.ok(result.steps.some((step) => step.id === "publish-tool" && step.status === "completed"));
    assert.ok(result.providerBrowserSessions.sessions.every((session) => session.checkpoints.includes("password-otp-legal-identity-pause")));
    assert.ok(result.providerBrowserSessions.sessions.every((session) => session.checkpointManifestPath && fs.existsSync(session.checkpointManifestPath)));
    const paymentCheckpointPath = result.providerBrowserSessions.sessions.find((session) => session.connectorId === "payment-provider")?.checkpointManifestPath;
    const paymentCheckpoint = JSON.parse(fs.readFileSync(paymentCheckpointPath, "utf8"));
    assert.equal(paymentCheckpoint.kind, "agentlas-provider-checkpoint-manifest");
    assert.ok(paymentCheckpoint.secureHumanInputs.some((item) => item.kind === "payment-method"));
    assert.ok(paymentCheckpoint.agentAllowedActions.includes("switch-to-alternate-provider"));
    assert.doesNotMatch(fs.readFileSync(result.credentialResolution.resolutionPath, "utf8"), /autopilot-commerce_database_api_key/i);

    const operations = JSON.parse(fs.readFileSync(path.join(app.rootPath, "data", "operations.json"), "utf8"));
    assert.equal(operations.autopilot.status, "operated");
    assert.equal(operations.providerRuntime.noDeadEndStrategy.status, "recoverable");
    assert.ok(operations.autopilot.safeBoundaries.some((line) => /no raw passwords/i.test(line)));
    assert.ok(operations.autopilot.safeBoundaries.some((line) => /missing API\/MCP/i.test(line)));
    assert.ok(fs.existsSync(path.join(result.preview.deployPath, "checkout/index.html")));

    const toolCall = spawnSync(nodeBin, [result.appTool.mcpPath], {
      input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { arguments: { view: "reuse" } } })}\n`,
      cwd: app.rootPath,
      encoding: "utf8",
    });
    assert.equal(toolCall.status, 0, toolCall.stderr || toolCall.stdout);
    assert.match(toolCall.stdout, /published-as-tool/);

    console.log("app-autopilot smoke passed");
  } finally {
    for (const key of envKeys) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
})()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
