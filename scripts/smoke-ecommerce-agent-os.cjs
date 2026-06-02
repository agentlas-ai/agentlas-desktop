#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-ecommerce-os-"));
const nodeBin = process.env.npm_node_execpath || process.env.NODE || "node";
process.env.AGENTLAS_STORE_PATH = path.join(baseDir, "agentlas.sqlite");

const { initStore, getDb } = require("../dist/electron/store/db.js");
const { createChat, setChatWorkingFolder } = require("../dist/electron/store/chats.js");
const { recordAgentSurface } = require("../dist/electron/store/agent-surfaces.js");
const { listFirms } = require("../dist/electron/store/firms.js");
const { parseSurfaces } = require("../dist/electron/surface-emitter.js");
const { prepareEcommerceOpsManifest } = require("../dist/electron/ecommerce-pack/surface.js");
const { createCommerceAgentTeam } = require("../dist/electron/meta-agent/commerce-team.js");
const { scaffoldServiceApp } = require("../dist/electron/app-factory/scaffold.js");
const { deleteEnvVar, readEnvVar, setEnvVar } = require("../dist/electron/secrets/vault.js");
const {
  activateLocalCommerceStack,
  captureProviderBrowserSessions,
  installMcpPlan,
  materializeCatalogAssets,
  prepareProviderBrowserOpen,
  preparePreviewDeploy,
  publishAppAsTool,
  resolveProviderCredentials,
  runAppFactorySmoke,
  runProviderTasks,
} = require("../dist/electron/app-factory/operations.js");

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
      "agent-meta-smoke",
      "meta-smoke",
      "Meta Smoke Agent",
      "Builds local Agentlas OS teams",
      "Create safe Agentlas surfaces and teams.",
      "[]",
      "A",
      now,
      "green",
      "[]",
    );
}

(async () => {
  try {
    initStore();
    seedAgent();

    const chat = createChat({ agentId: "agent-meta-smoke", title: "Ecommerce OS smoke" });
    setChatWorkingFolder(chat.id, baseDir);

    const manifest = prepareEcommerceOpsManifest({
      prompt: "여자옷 쇼핑몰 사업하고 싶어. 결제, 디비, 이미지 생성, 운영 대시보드까지 알아서 만들어줘.",
      now: "2026-05-31T00:00:00.000Z",
    });
    assert.ok(manifest);
    assert.equal(manifest.domain, "ecommerce");
    assert.equal(manifest.layout, "service-app");
    assert.ok(manifest.actions?.some((action) => action.type === "scaffold-agent-team"));
    assert.ok(manifest.actions?.some((action) => action.type === "request-payment-approval"));
    assert.ok(manifest.capabilities?.some((capability) => capability.type === "payment-method"));
    assert.equal(manifest.delegation?.autonomy?.mode, "agent-first");
    assert.ok(manifest.delegation?.autonomy?.noDeadEndReasons?.includes("missing-mcp"));

    const parsed = parseSurfaces(`ok\n<<agentlas-surface>>\n${JSON.stringify(manifest)}\n<</agentlas-surface>>`);
    assert.equal(parsed.errors.length, 0, parsed.errors.join("\n"));
    assert.equal(parsed.surfaces.length, 1);

    const surfaceId = "surface-ecommerce-os-smoke";
    recordAgentSurface({
      id: surfaceId,
      chatId: chat.id,
      projectId: null,
      agentId: chat.agentId,
      manifest,
    });

    const team = createCommerceAgentTeam({ chatId: chat.id, surfaceId, manifest, baseDir });
    assert.ok(fs.existsSync(path.join(team.rootPath, "TEAM.md")));
    assert.ok(fs.existsSync(path.join(team.rootPath, "AGENTS.md")));
    assert.ok(fs.existsSync(path.join(team.rootPath, "CLAUDE.md")));
    assert.ok(fs.existsSync(path.join(team.rootPath, ".claude/CLAUDE.md")));
    assert.ok(fs.existsSync(path.join(team.rootPath, "GEMINI.md")));
    assert.ok(fs.existsSync(path.join(team.rootPath, "agents/ceo/AGENT.md")));
    assert.ok(fs.existsSync(path.join(team.rootPath, "agents/storefront/CLAUDE.md")));
    assert.ok(fs.existsSync(path.join(team.rootPath, "agents/catalog/GEMINI.md")));
    assert.ok(fs.existsSync(path.join(team.rootPath, "agents/payments-data/AGENTS.md")));
    assert.equal(team.org.divisions.length, 4);
    const teamManifest = JSON.parse(fs.readFileSync(path.join(team.rootPath, "agentlas.team.json"), "utf8"));
    assert.deepEqual(teamManifest.compatibility.importLabels, ["generic", "codex", "claude-code", "gemini"]);
    assert.match(fs.readFileSync(path.join(team.rootPath, "CLAUDE.md"), "utf8"), /Agentlas OS Compatibility Contract/);
    assert.ok(listFirms().some((firm) => firm.id === team.firm.id));

    const firmChat = createChat({ firmId: team.firm.id, title: "Operate ecommerce team" });
    assert.equal(firmChat.agentId, team.agent.id);

    const app = await scaffoldServiceApp(
      {
        chatId: chat.id,
        surfaceId,
        actionId: "scaffold-commerce-app",
        manifest,
      },
      { baseDir, now: "2026-05-31T00:00:00.000Z" },
    );
    assert.equal(app.appName, "Women's Clothing Commerce OS");
    assert.ok(fs.existsSync(app.previewPath));
    assert.ok(fs.existsSync(path.join(app.rootPath, "data/operations.json")));
    assert.ok(fs.existsSync(path.join(app.rootPath, "src/data/operations.json")));
    assert.ok(fs.existsSync(path.join(app.rootPath, "src/runtime/commerce-store.mjs")));
    assert.ok(app.files.some((file) => file.path === "mcp/required-connectors.json"));
    assert.ok(app.files.some((file) => file.path === "tools/required-tools.json"));
    assert.ok(app.files.some((file) => file.path === "src/runtime/provider-tasks.json"));
    for (const routePath of ["storefront", "catalog", "orders", "finance"]) {
      const routeFile = path.join(app.rootPath, "src", routePath, "index.html");
      assert.ok(fs.existsSync(routeFile), `expected generated route page: ${routeFile}`);
      assert.match(fs.readFileSync(routeFile, "utf8"), /Agentlas generated route/);
    }

    const operations = JSON.parse(fs.readFileSync(path.join(app.rootPath, "data/operations.json"), "utf8"));
    assert.ok(operations.providerTasks.some((task) => task.type === "request-payment-approval"));
    assert.equal(operations.collections.products.length, 2);
    assert.equal(operations.ledgers.payments.length, 1);
    assert.equal(operations.ledgers.databases.length, 1);
    assert.equal(operations.ledgers.imageGeneration.length, 1);

    const status = spawnSync(nodeBin, [path.join(app.rootPath, "src/runtime/commerce-store.mjs"), "status"], {
      cwd: app.rootPath,
      encoding: "utf8",
    });
    assert.equal(status.status, 0, status.stderr || status.stdout);
    const statusJson = JSON.parse(status.stdout);
    assert.equal(statusJson.products, 2);
    assert.equal(statusJson.providerTasks, operations.providerTasks.length);

    const providerRun = await runProviderTasks({ rootPath: app.rootPath });
    assert.equal(providerRun.tasks.length, operations.providerTasks.length);
    assert.ok(providerRun.secureInputRequiredCount >= 1);
    assert.equal(providerRun.browserPlans.length, 4);
    assert.ok(providerRun.browserPlans.some((plan) => plan.startUrl.includes("stripe.com")));
    assert.ok(providerRun.credentialGates.some((gate) => gate.envKey === "COMMERCE_PROVIDER_CREDENTIALS"));
    assert.ok(providerRun.paymentGates.some((gate) => gate.approvalMode === "explicit-before-checkout"));
    assert.equal(providerRun.providerRecipes.length, 4);
    assert.ok(providerRun.providerRecipes.some((recipe) => recipe.type === "payment" && recipe.nextActions.includes("create checkout/payment link")));
    assert.equal(providerRun.noDeadEndStrategy.status, "recoverable");
    assert.equal(providerRun.noDeadEndStrategy.violations.length, 0);
    assert.equal(providerRun.noDeadEndStrategy.plans.length, providerRun.browserPlans.length);
    assert.ok(providerRun.noDeadEndStrategy.plans.every((plan) => plan.canProceedWithoutMcp === true));
    assert.ok(providerRun.noDeadEndStrategy.plans.some((plan) => /local checkout sandbox/i.test(plan.localFallback || "")));
    assert.ok(fs.existsSync(providerRun.noDeadEndStrategyPath));
    assert.ok(fs.existsSync(providerRun.resultsPath));
    assert.ok(fs.existsSync(providerRun.recipesPath));
    assert.ok(fs.existsSync(providerRun.runbookPath));
    assert.match(fs.readFileSync(providerRun.runbookPath, "utf8"), /Provider Action Recipes/);
    assert.match(fs.readFileSync(providerRun.runbookPath, "utf8"), /No-Dead-End Strategy/);
    const advancedOperations = JSON.parse(fs.readFileSync(path.join(app.rootPath, "data/operations.json"), "utf8"));
    assert.ok(advancedOperations.providerTasks.some((task) => task.status === "payment-approval-required"));
    assert.ok(advancedOperations.providerTasks.some((task) => task.status === "secure-input-required"));
    assert.ok(advancedOperations.providerRuntime.browserPlans.some((plan) => plan.startUrl.includes("platform.openai.com")));
    assert.equal(advancedOperations.providerRuntime.providerRecipes.length, 4);
    assert.equal(advancedOperations.providerRuntime.noDeadEndStrategy.status, "recoverable");
    assert.ok(advancedOperations.providerRuntime.noDeadEndStrategy.plans.every((plan) => plan.currentBestPath));
    assert.equal(advancedOperations.ledgers.payments[0].status, "payment-approval-required");
    assert.equal(advancedOperations.ledgers.databases[0].status, "vault-input-required");

    const assets = await materializeCatalogAssets({
      rootPath: app.rootPath,
      budgetApproved: true,
      approvedBy: "smoke-runner",
      approvalReason: "verify deterministic ecommerce asset materialization",
    });
    assert.equal(assets.assets.length, operations.collections.products.length);
    for (const asset of assets.assets) {
      assert.ok(fs.existsSync(asset.sourcePath), `expected materialized asset: ${asset.sourcePath}`);
    }
    const assetOperations = JSON.parse(fs.readFileSync(path.join(app.rootPath, "data/operations.json"), "utf8"));
    assert.equal(assetOperations.collections.assets.length, operations.collections.products.length);
    assert.ok(assetOperations.collections.products.every((row) => row.imageStatus === "materialized"));
    assert.equal(assetOperations.providerTasks.find((task) => task.type === "generate").status, "assets-materialized");
    assert.match(fs.readFileSync(path.join(app.rootPath, "src/storefront/index.html"), "utf8"), /<img\b/);
    assert.match(fs.readFileSync(path.join(app.rootPath, "src/catalog/index.html"), "utf8"), /<img\b/);

    const localStack = await activateLocalCommerceStack({
      rootPath: app.rootPath,
      mode: "local-first",
      activatedBy: "smoke-runner",
    });
    assert.equal(localStack.products, operations.collections.products.length);
    assert.ok(fs.existsSync(localStack.localDatabasePath));
    assert.ok(fs.existsSync(localStack.runtimePath));
    assert.ok(fs.existsSync(localStack.checkoutPath));
    const localDb = JSON.parse(fs.readFileSync(localStack.localDatabasePath, "utf8"));
    assert.equal(localDb.runtime.payment.status, "sandbox-connected");
    assert.equal(localDb.runtime.database.status, "local-db-connected");
    assert.equal(localDb.products.length, operations.collections.products.length);
    const activatedOperations = JSON.parse(fs.readFileSync(path.join(app.rootPath, "data/operations.json"), "utf8"));
    assert.equal(activatedOperations.localRuntime.status, "active");
    assert.equal(activatedOperations.ledgers.payments[0].status, "sandbox-connected");
    assert.equal(activatedOperations.ledgers.databases[0].status, "local-db-connected");
    assert.ok(activatedOperations.collections.metrics.some((row) => row.id === "local-stack-status" && row.value === "active"));
    assert.match(fs.readFileSync(path.join(app.rootPath, "src/storefront/index.html"), "utf8"), /Local Commerce Stack/);
    assert.match(fs.readFileSync(path.join(app.rootPath, "src/checkout/index.html"), "utf8"), /Sandbox Checkout/);

    const browserOpen = await prepareProviderBrowserOpen({ rootPath: app.rootPath });
    assert.equal(browserOpen.opened.length, 4);
    assert.ok(browserOpen.opened.some((plan) => plan.startUrl === "https://dashboard.stripe.com/register"));
    const browserSessions = await captureProviderBrowserSessions({ rootPath: app.rootPath, mode: "plan-only" });
    assert.equal(browserSessions.sessions.length, 4);
    assert.ok(fs.existsSync(browserSessions.sessionsPath));
    assert.ok(browserSessions.sessions.every((session) => session.checkpoints.includes("password-otp-legal-identity-pause")));
    assert.ok(browserSessions.sessions.every((session) => session.checkpointManifestPath && fs.existsSync(session.checkpointManifestPath)));
    const paymentCheckpoint = JSON.parse(fs.readFileSync(browserSessions.sessions.find((session) => session.connectorId === "payment-provider").checkpointManifestPath, "utf8"));
    assert.equal(paymentCheckpoint.kind, "agentlas-provider-checkpoint-manifest");
    assert.ok(paymentCheckpoint.agentAllowedActions.includes("create-provider-account-or-app"));
    assert.ok(paymentCheckpoint.secureHumanInputs.some((item) => item.kind === "payment-method"));
    assert.ok(paymentCheckpoint.resumeContract.forbiddenResultFields.includes("raw card"));
    const sessionOperations = JSON.parse(fs.readFileSync(path.join(app.rootPath, "data/operations.json"), "utf8"));
    assert.equal(sessionOperations.providerRuntime.browserSessions.length, 4);
    assert.match(fs.readFileSync(path.join(app.rootPath, "src/index.html"), "utf8"), /Provider Sessions/);
    assert.match(fs.readFileSync(path.join(app.rootPath, "src/index.html"), "utf8"), /No-Dead-End Strategy/);

    const vaultProofKey = "COMMERCE_PROVIDER_CREDENTIALS";
    const previousVaultValue = await readEnvVar(vaultProofKey);
    try {
      await setEnvVar(vaultProofKey, "smoke-vault-commerce-provider-credentials");
      const vaultResolution = await resolveProviderCredentials({ rootPath: app.rootPath, source: "agentlas-env-vault" });
      const commerceCredential = vaultResolution.credentials.find((item) => item.envKey === vaultProofKey);
      assert.equal(commerceCredential?.status, "live-credential-ready");
      assert.equal(commerceCredential?.source, "agentlas-env-vault");
      assert.ok(commerceCredential?.fingerprint?.startsWith("sha256:"));
      const vaultFile = fs.readFileSync(vaultResolution.resolutionPath, "utf8");
      assert.doesNotMatch(vaultFile, /smoke-vault-commerce-provider-credentials/i);
    } finally {
      if (previousVaultValue) await setEnvVar(vaultProofKey, previousVaultValue);
      else await deleteEnvVar(vaultProofKey);
    }

    const envKeys = [
      "PAYMENT_PROVIDER_USER_APPROVAL",
      "COMMERCE_DATABASE_API_KEY",
      "IMAGE_GENERATION_USER_APPROVAL",
      "STOREFRONT_HOST_OAUTH_CLIENT",
      "COMMERCE_PROVIDER_CREDENTIALS",
    ];
    const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    try {
      for (const key of envKeys) process.env[key] = `smoke-${key.toLowerCase()}`;
      const credentialResolution = await resolveProviderCredentials({ rootPath: app.rootPath, source: "env" });
      assert.equal(credentialResolution.missingCount, 0);
      assert.equal(credentialResolution.resolvedCount, envKeys.length);
      assert.ok(fs.existsSync(credentialResolution.resolutionPath));
      assert.ok(credentialResolution.credentials.every((item) => item.fingerprint?.startsWith("sha256:")));
      const credentialFile = fs.readFileSync(credentialResolution.resolutionPath, "utf8");
      assert.doesNotMatch(credentialFile, /smoke-commerce_database_api_key/i);
      const credentialOperations = JSON.parse(fs.readFileSync(path.join(app.rootPath, "data/operations.json"), "utf8"));
      assert.equal(credentialOperations.providerRuntime.credentialResolution.length, envKeys.length);
      assert.ok(credentialOperations.connectors.some((connector) => connector.status === "live-credential-ready"));
      assert.match(fs.readFileSync(path.join(app.rootPath, "src/index.html"), "utf8"), /Credential Resolution/);
    } finally {
      for (const key of envKeys) {
        if (previousEnv[key] === undefined) delete process.env[key];
        else process.env[key] = previousEnv[key];
      }
    }

    const mcp = await installMcpPlan({ rootPath: app.rootPath });
    assert.equal(mcp.adapters.length, 4);
    assert.ok(mcp.missingCredentials.length >= 1);

    const smoke = await runAppFactorySmoke({ rootPath: app.rootPath });
    assert.equal(smoke.ok, true, smoke.stderr);

    const preview = await preparePreviewDeploy({ rootPath: app.rootPath });
    assert.ok(preview.fileUrl.startsWith("file://"));
    assert.ok(fs.existsSync(preview.deployPath));
    for (const routePath of ["storefront", "catalog", "orders", "finance"]) {
      assert.ok(fs.existsSync(path.join(preview.deployPath, routePath, "index.html")));
    }
    for (const asset of assets.assets) {
      assert.ok(fs.existsSync(path.join(preview.deployPath, asset.path)));
    }
    assert.ok(fs.existsSync(path.join(preview.deployPath, "runtime/local-commerce.json")));
    assert.ok(fs.existsSync(path.join(preview.deployPath, "checkout/index.html")));

    const appTool = await publishAppAsTool({ rootPath: app.rootPath });
    assert.ok(fs.existsSync(appTool.configPath));
    assert.ok(fs.existsSync(appTool.mcpPath));
    assert.ok(appTool.server.id);
    const toolCall = spawnSync(nodeBin, [appTool.mcpPath], {
      input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { arguments: { view: "providers" } } })}\n`,
      cwd: app.rootPath,
      encoding: "utf8",
    });
    assert.equal(toolCall.status, 0, toolCall.stderr || toolCall.stdout);
    assert.match(toolCall.stdout, /providerRecipes/);

    console.log("ecommerce-agent-os smoke passed");
  } finally {
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
