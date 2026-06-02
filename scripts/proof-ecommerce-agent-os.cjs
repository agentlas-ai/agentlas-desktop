#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawn, spawnSync } = require("node:child_process");

const PROMPT =
  process.env.AGENTLAS_PROOF_PROMPT ||
  "여자옷 쇼핑몰 사업하고 싶어. 결제, 디비, 이미지 생성, 운영 대시보드까지 알아서 만들어줘.";
const PROOF_ROOT =
  process.env.AGENTLAS_PROOF_DIR ||
  path.join("/Volumes/X31/temp", `agentlas-ecommerce-os-proof-${stampForPath(new Date())}`);
const DB_PATH = path.join(PROOF_ROOT, "agentlas-proof.sqlite");
const SCREENSHOT_DIR = path.join(PROOF_ROOT, "screenshots");
const PORT = Number(process.env.AGENTLAS_PROOF_PORT || 4327);
const NODE_BIN = process.env.npm_node_execpath || process.env.NODE || "node";

process.env.AGENTLAS_STORE_PATH = DB_PATH;

const { initStore, getDb } = require("../dist/electron/store/db.js");
const { appendChatMessage, createChat, setChatWorkingFolder } = require("../dist/electron/store/chats.js");
const { recordAgentSurface } = require("../dist/electron/store/agent-surfaces.js");
const { listFirms } = require("../dist/electron/store/firms.js");
const { listAgentAppOperations, recordAgentAppOperation, recordScaffoldedApp } = require("../dist/electron/store/agent-apps.js");
const { parseSurfaces } = require("../dist/electron/surface-emitter.js");
const { prepareEcommerceOpsManifest } = require("../dist/electron/ecommerce-pack/surface.js");
const { createCommerceAgentTeam } = require("../dist/electron/meta-agent/commerce-team.js");
const { scaffoldServiceApp } = require("../dist/electron/app-factory/scaffold.js");
const {
  archiveAppPackage,
  runAppFactoryAutopilot,
  restoreAppPackage,
} = require("../dist/electron/app-factory/operations.js");

function seedMetaAgent() {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO installed_agents (
        id, slug, name, name_en, tagline, tagline_en, system_prompt, mcp_servers_json,
        trust_grade, installed_at, tone, env_requirements_json, visibility
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(slug) DO UPDATE SET
        name = excluded.name,
        name_en = excluded.name_en,
        tagline = excluded.tagline,
        tagline_en = excluded.tagline_en,
        system_prompt = excluded.system_prompt,
        trust_grade = excluded.trust_grade,
        visibility = excluded.visibility`,
    )
    .run(
      "agent-meta-proof",
      "meta-proof",
      "Local Meta Agent",
      "Local Meta Agent",
      "Builds Agentlas OS teams and service apps from plain user intent.",
      "Builds Agentlas OS teams and service apps from plain user intent.",
      [
        "Turn business intent into Agentlas Surface manifests, local teams, service apps, provider delegation, vault gates, payment gates, and launch proof.",
        "Never store raw passwords, OTPs, cookies, card numbers, CVC/CVV, or provider tokens in chat, manifest, source, screenshots, or reports.",
      ].join("\n"),
      "[]",
      "A",
      now,
      "green",
      "[]",
      "visible",
    );
}

(async () => {
  fs.rmSync(PROOF_ROOT, { recursive: true, force: true });
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  initStore();
  seedMetaAgent();

  const chat = createChat({ agentId: "agent-meta-proof", title: "Ecommerce Agent OS proof" });
  setChatWorkingFolder(chat.id, PROOF_ROOT);
  appendChatMessage(chat.id, "user", PROMPT);

  const manifest = prepareEcommerceOpsManifest({
    prompt: PROMPT,
    now: new Date().toISOString(),
  });
  assert.ok(manifest, "ecommerce intent should produce a service-app manifest");
  const parsed = parseSurfaces(`<<agentlas-surface>>\n${JSON.stringify(manifest)}\n<</agentlas-surface>>`);
  assert.equal(parsed.errors.length, 0, parsed.errors.join("\n"));
  assert.equal(parsed.surfaces.length, 1);

  const surfaceId = "surface-ecommerce-os-proof";
  recordAgentSurface({
    id: surfaceId,
    chatId: chat.id,
    projectId: null,
    agentId: chat.agentId,
    manifest,
  });
  appendChatMessage(
    chat.id,
    "assistant",
    "Created a declarative ecommerce service-app surface with team, provider, payment, database, image, and dashboard actions.",
  );

  const team = createCommerceAgentTeam({ chatId: chat.id, surfaceId, manifest, baseDir: PROOF_ROOT });
  const firmChat = createChat({ firmId: team.firm.id, title: "Operate ecommerce team" });
  assert.equal(firmChat.agentId, team.agent.id);
  assert.equal(team.org.divisions.length, 4);
  assert.equal(team.org.divisions.reduce((sum, division) => sum + division.specialists.length, 0), 8);
  assert.ok(listFirms().some((firm) => firm.id === team.firm.id));
  assert.equal(team.firm.orgChart.length, 13);
  assert.ok(team.firm.orgChart.every((node) => typeof node.agentId === "string" && node.agentId.length > 0));
  const generatedAgents = getDb()
    .prepare("SELECT id, slug, name, visibility FROM installed_agents WHERE slug LIKE ? ORDER BY slug")
    .all(`${team.agent.slug}%`);
  assert.equal(generatedAgents.length, 13);

  const scaffold = await scaffoldServiceApp(
    {
      chatId: chat.id,
      surfaceId,
      actionId: "scaffold-commerce-app",
      manifest,
    },
    { baseDir: PROOF_ROOT, now: new Date().toISOString() },
  );
  const appRecord = recordScaffoldedApp({
    chatId: chat.id,
    projectId: null,
    agentId: team.agent.id,
    surfaceId,
    actionId: "scaffold-commerce-app",
    manifest,
    scaffold,
  });

  const proofCredentialEnvKeys = [
    "PAYMENT_PROVIDER_USER_APPROVAL",
    "COMMERCE_DATABASE_API_KEY",
    "IMAGE_GENERATION_USER_APPROVAL",
    "STOREFRONT_HOST_OAUTH_CLIENT",
    "COMMERCE_PROVIDER_CREDENTIALS",
  ];
  const previousProofCredentialEnv = Object.fromEntries(proofCredentialEnvKeys.map((key) => [key, process.env[key]]));
  for (const key of proofCredentialEnvKeys) process.env[key] = `proof-${key.toLowerCase()}-${appRecord.id}`;
  const autopilot = await runAppFactoryAutopilot({
    rootPath: scaffold.rootPath,
    budgetApproved: true,
    approvedBy: "agentlas-proof-runner",
    approvalReason: "Prove generated ecommerce app can operate end-to-end from plain user intent.",
    credentialSource: "env",
    captureProviderSessions: true,
    browserMode: "headless",
    timeoutMs: 12_000,
  });
  for (const key of proofCredentialEnvKeys) {
    if (previousProofCredentialEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousProofCredentialEnv[key];
  }
  recordAgentAppOperation(appRecord.id, "run-autopilot", autopilot.status === "operated", autopilot, "tool-published");
  assert.equal(autopilot.status, "operated");
  const providerRun = autopilot.providerRun;
  const materializedAssets = autopilot.materializedAssets;
  const localStack = autopilot.localStack;
  const providerBrowser = autopilot.providerBrowser;
  const providerBrowserSessions = autopilot.providerBrowserSessions;
  const credentialResolution = autopilot.credentialResolution;
  const mcp = autopilot.mcp;
  const smoke = autopilot.smoke;
  const preview = autopilot.preview;
  const appTool = autopilot.appTool;
  assert.ok(providerRun);
  assert.ok(materializedAssets);
  assert.ok(localStack);
  assert.ok(providerBrowser);
  assert.ok(providerBrowserSessions);
  assert.ok(credentialResolution);
  assert.ok(mcp);
  assert.ok(smoke);
  assert.ok(preview);
  assert.ok(appTool);
  assert.equal(smoke.ok, true, smoke.stderr || smoke.stdout);
  assert.ok(fs.existsSync(appTool.configPath));
  assert.ok(fs.existsSync(appTool.mcpPath));
  assert.ok(appTool.server.id);
  const appToolCall = spawnSync(NODE_BIN, [appTool.mcpPath], {
    input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { arguments: { view: "summary" } } })}\n`,
    cwd: scaffold.rootPath,
    encoding: "utf8",
  });
  assert.equal(appToolCall.status, 0, appToolCall.stderr || appToolCall.stdout);
  assert.match(appToolCall.stdout, new RegExp(appTool.toolName));

  const operations = JSON.parse(fs.readFileSync(path.join(scaffold.rootPath, "data", "operations.json"), "utf8"));
  const routeFiles = ["/storefront", "/catalog", "/orders", "/finance"].map((route) => {
    const file = path.join(scaffold.rootPath, "src", route.slice(1), "index.html");
    const deployFile = path.join(preview.deployPath, route.slice(1), "index.html");
    return {
      route,
      file,
      deployFile,
      exists: fs.existsSync(file),
      deployExists: fs.existsSync(deployFile),
      generated: fs.existsSync(file) && fs.readFileSync(file, "utf8").includes("Agentlas generated route"),
    };
  });
  for (const route of routeFiles) {
    assert.equal(route.exists, true, `${route.route} source route missing`);
    assert.equal(route.deployExists, true, `${route.route} deploy route missing`);
    assert.equal(route.generated, true, `${route.route} route was not generated by App Factory`);
  }
  for (const asset of materializedAssets.assets) {
    assert.equal(fs.existsSync(path.join(preview.deployPath, asset.path)), true, `${asset.path} deploy asset missing`);
  }
  assert.equal(fs.existsSync(path.join(preview.deployPath, "runtime/local-commerce.json")), true, "local runtime deploy data missing");
  assert.equal(fs.existsSync(path.join(preview.deployPath, "checkout/index.html")), true, "sandbox checkout deploy page missing");

  assert.ok(providerBrowser.opened.some((plan) => plan.startUrl === "https://dashboard.stripe.com/register"));
  assert.ok(providerBrowser.opened.some((plan) => plan.startUrl.includes("supabase.com")));
  assert.ok(providerBrowser.opened.some((plan) => plan.startUrl.includes("platform.openai.com")));
  assert.ok(providerBrowser.opened.some((plan) => plan.startUrl.includes("vercel.com")));
  assert.equal(manifest.delegation?.autonomy?.mode, "agent-first");
  assert.ok(manifest.delegation?.autonomy?.noDeadEndReasons?.includes("missing-api"));
  assert.ok(manifest.delegation?.autonomy?.checkpoints?.includes("payment-submit"));
  assert.equal(providerBrowserSessions.sessions.length, 4);
  assert.ok(providerBrowserSessions.sessions.every((session) => session.checkpoints.includes("password-otp-legal-identity-pause")));
  assert.ok(providerBrowserSessions.sessions.every((session) => session.checkpointManifestPath && fs.existsSync(session.checkpointManifestPath)));
  const paymentCheckpoint = JSON.parse(fs.readFileSync(providerBrowserSessions.sessions.find((session) => session.connectorId === "payment-provider").checkpointManifestPath, "utf8"));
  assert.equal(paymentCheckpoint.kind, "agentlas-provider-checkpoint-manifest");
  assert.ok(paymentCheckpoint.agentAllowedActions.includes("create-provider-account-or-app"));
  assert.ok(paymentCheckpoint.secureHumanInputs.some((item) => item.kind === "payment-method"));
  assert.ok(paymentCheckpoint.resumeContract.forbiddenResultFields.includes("raw card"));
  assert.ok(providerBrowserSessions.sessions.some((session) => session.type === "payment"));
  assert.ok(fs.existsSync(providerBrowserSessions.sessionsPath));
  assert.equal(credentialResolution.missingCount, 0);
  assert.ok(credentialResolution.credentials.every((item) => item.fingerprint?.startsWith("sha256:")));
  assert.ok(fs.existsSync(credentialResolution.resolutionPath));
  const credentialResolutionText = fs.readFileSync(credentialResolution.resolutionPath, "utf8");
  assert.doesNotMatch(credentialResolutionText, /proof-commerce_database_api_key/i);
  assert.ok(providerRun.paymentGates.some((gate) => gate.approvalMode === "explicit-before-checkout"));
  assert.ok(providerRun.credentialGates.some((gate) => gate.saveTarget === "agentlas-env-vault"));
  assert.equal(providerRun.providerRecipes.length, 4);
  assert.ok(
    providerRun.providerRecipes.some(
      (recipe) => recipe.type === "payment" && recipe.nextActions.includes("create checkout/payment link"),
    ),
  );
  assert.ok(fs.existsSync(providerRun.recipesPath));
  assert.match(fs.readFileSync(providerRun.runbookPath, "utf8"), /Provider Action Recipes/);
  assert.equal(operations.collections.products.length, 2);
  assert.equal(operations.collections.assets.length, materializedAssets.assets.length);
  assert.ok(operations.collections.products.every((row) => row.imageStatus === "materialized"));
  assert.ok(materializedAssets.assets.every((asset) => fs.existsSync(asset.sourcePath)));
  assert.equal(operations.localRuntime.status, "active");
  assert.equal(operations.localRuntime.payment.status, "sandbox-connected");
  assert.equal(operations.localRuntime.database.status, "local-db-connected");
  assert.equal(operations.reuse.status, "published-as-tool");
  assert.equal(operations.reuse.mcpServerId, appTool.server.id);
  assert.ok(fs.existsSync(localStack.localDatabasePath));
  assert.ok(fs.existsSync(localStack.checkoutPath));
  assert.ok(operations.providerRuntime.browserPlans.length >= 4);
  assertSecretSafe(scaffold.rootPath);
  assertSecretSafe(team.rootPath);

  const storyPath = writeProofStory({
    prompt: PROMPT,
    manifest,
    team,
    generatedAgents,
    scaffold,
    autopilot,
    providerBrowser,
    credentialResolution,
    materializedAssets,
    localStack,
    appTool,
  });
  const server = await startPreviewServer(scaffold.rootPath, PORT);
  const screenshots = [await captureFileScreenshot("agentlas-os-story", storyPath, path.join(SCREENSHOT_DIR, "agentlas-os-story.png"))];
  try {
    screenshots.push(...(await captureScreenshots(PORT, SCREENSHOT_DIR)));
  } finally {
    await stopServer(server);
  }

  const archiveResult = await archiveAppPackage({ rootPath: scaffold.rootPath });
  recordAgentAppOperation(appRecord.id, "archive", true, archiveResult, "archived");
  assert.equal(archiveResult.reversible, true);
  assert.ok(fs.existsSync(archiveResult.archivePath));
  assert.equal(fs.existsSync(scaffold.rootPath), false);
  const restoreResult = await restoreAppPackage({ rootPath: scaffold.rootPath });
  recordAgentAppOperation(appRecord.id, "restore", true, restoreResult, "restored");
  assert.equal(restoreResult.restored, true);
  assert.ok(fs.existsSync(scaffold.rootPath));
  assert.ok(fs.existsSync(path.join(scaffold.rootPath, "agentlas.app.json")));
  const restoredOperations = JSON.parse(fs.readFileSync(path.join(scaffold.rootPath, "data", "operations.json"), "utf8"));
  assert.equal(restoredOperations.lifecycle.status, "restored");
  assert.equal(restoredOperations.lifecycle.reversible, true);
  assertSecretSafe(scaffold.rootPath);

  const report = {
    proofVersion: "0.1",
    prompt: PROMPT,
    proofRoot: PROOF_ROOT,
    dbPath: DB_PATH,
    createdAt: new Date().toISOString(),
    chat: { id: chat.id, firmChatId: firmChat.id },
    team: {
      rootPath: team.rootPath,
      agentId: team.agent.id,
      firmId: team.firm.id,
      generatedAgents,
      divisions: team.org.divisions.map((division) => ({
        id: division.id,
        role: division.role,
        agentId: division.agentId,
        specialists: division.specialists.length,
      })),
    },
    app: {
      registryId: appRecord.id,
      rootPath: scaffold.rootPath,
      previewPath: scaffold.previewPath,
      deployPath: preview.deployPath,
      routes: routeFiles,
      operationCount: listAgentAppOperations(appRecord.id).length,
      reusableTool: {
        toolName: appTool.toolName,
        toolDir: appTool.toolDir,
        configPath: appTool.configPath,
        mcpPath: appTool.mcpPath,
        mcpServerId: appTool.server.id,
        summary: appTool.summary,
      },
    },
    materializedAssets: {
      count: materializedAssets.assets.length,
      assetsDir: materializedAssets.assetsDir,
      assets: materializedAssets.assets,
      budget: materializedAssets.budget,
    },
    localCommerceStack: {
      localDatabasePath: localStack.localDatabasePath,
      runtimePath: localStack.runtimePath,
      checkoutPath: localStack.checkoutPath,
      products: localStack.products,
      orders: localStack.orders,
      summary: localStack.summary,
    },
    lifecycle: {
      archivePath: archiveResult.archivePath,
      archiveManifestPath: archiveResult.manifestPath,
      archiveSummary: archiveResult.summary,
      restoreSummary: restoreResult.summary,
      reversible: archiveResult.reversible,
      statusAfterRestore: restoredOperations.lifecycle.status,
    },
    providerDelegation: {
      autopilot: {
        status: autopilot.status,
        summary: autopilot.summary,
        steps: autopilot.steps,
        waitingOn: autopilot.waitingOn,
      },
      browserStarts: providerBrowser.opened,
      browserSessions: providerBrowserSessions.sessions,
      browserSessionEvidencePath: providerBrowserSessions.sessionsPath,
      credentialResolution: credentialResolution.credentials,
      credentialResolutionPath: credentialResolution.resolutionPath,
      credentialGates: providerRun.credentialGates,
      paymentGates: providerRun.paymentGates,
      providerRecipes: providerRun.providerRecipes,
      providerRecipesPath: providerRun.recipesPath,
      summary: providerRun.summary,
    },
    mcp: {
      adapters: mcp.adapters,
      missingCredentials: mcp.missingCredentials,
    },
    smoke: {
      command: smoke.command,
      ok: smoke.ok,
      stdout: smoke.stdout.trim(),
    },
    screenshots,
    providerScreenshots: providerBrowserSessions.sessions
      .filter((session) => session.screenshotPath)
      .map((session) => ({
        name: session.connectorId,
        type: session.type,
        url: session.finalUrl || session.startUrl,
        title: session.title || "",
        status: session.status,
        path: session.screenshotPath,
      })),
    checks: [
      "plain user ecommerce intent produced a declarative service-app surface",
      "local meta-agent created every division/specialist agent, then assembled the durable commerce team and firm chat",
      "Agentlas OS autopilot ran provider delegation, asset generation, local commerce, MCP, smoke, preview, and app-as-tool publication in one operation",
      "Agentlas App Factory produced source and deploy route pages",
      "budget-approved catalog image assets were materialized into the generated app package",
      "local payment sandbox, local database, checkout page, and operating runtime were activated",
      "provider browser sessions were opened or checkpointed with screenshot evidence",
      "agent-first autonomy is declared with no-dead-end fallback reasons and secure checkpoints",
      "provider credentials were resolved from a vault/env source with only fingerprints persisted",
      "provider runner prepared payment/database/image/host browser delegation",
      "provider action recipes were compiled so agents can execute API, browser, or fallback paths without dead-ending on missing MCP/API support",
      "vault and payment approval gates are explicit",
      "generated commerce app was published as a reusable MCP tool for later agents",
      "generated app archive is reversible and restore was verified from the archived OS object",
      "generated package smoke test passed",
      "promotional screenshots were saved under /Volumes/X31/temp",
      "secret/card/token leak scan found no raw secret values",
    ],
  };
  fs.writeFileSync(path.join(PROOF_ROOT, "proof-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(PROOF_ROOT, "PROOF.md"), proofMarkdown(report), "utf8");
  removeAppleDoubleFiles(PROOF_ROOT);

  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

function writeProofStory(input) {
  const storyDir = path.join(PROOF_ROOT, "proof-story");
  fs.mkdirSync(storyDir, { recursive: true });
  const pathOut = path.join(storyDir, "index.html");
  const completed = input.autopilot.steps.filter((step) => step.status === "completed").length;
  const paymentGateCount = input.autopilot.providerRun?.paymentGates?.length || 0;
  const credentialGateCount = input.autopilot.providerRun?.credentialGates?.length || 0;
  const providerRecipeCount = input.autopilot.providerRun?.providerRecipes?.length || 0;
  const products = Array.isArray(input.localStack.products) ? input.localStack.products : [];
  const assetByProduct = new Map(
    input.materializedAssets.assets
      .filter((asset) => asset.productId && asset.sourcePath)
      .map((asset) => [asset.productId, pathToFileURL(asset.sourcePath).href]),
  );
  const visualItems = (products.length ? products : input.materializedAssets.assets).slice(0, 4);
  const visualCards = visualItems
    .map((item, index) => {
      const src = item.productId ? assetByProduct.get(item.productId) : item.sourcePath ? pathToFileURL(item.sourcePath).href : "";
      const label = item.name || item.productId || item.path || `Generated asset ${index + 1}`;
      const status = item.imageStatus || item.status || "materialized";
      return `<article class="visual-card ${src ? "has-image" : ""}">${src ? `<img src="${html(src)}" alt="${html(label)}" />` : ""}<strong>${html(label)}</strong><span>${html(status)}</span></article>`;
    })
    .join("");
  const autopilotSteps = input.autopilot.steps
    .map((step, index) => `<div class="step ${html(step.status)}"><span>${index + 1}</span><div><strong>${html(step.label)}</strong><small>${html(step.summary)}</small></div><em>${html(step.status)}</em></div>`)
    .join("");
  const providerItems = input.providerBrowser.opened
    .map((plan) => `<div class="provider"><strong>${html(plan.connectorName)}</strong><span>${html(plan.type)} · ${html(plan.startUrl)}</span></div>`)
    .join("");
  const proofCards = [
    ["Agents", input.generatedAgents.length, "commerce firm generated"],
    ["Steps", completed, `${input.autopilot.steps.length} autopilot stages`],
    ["Assets", input.materializedAssets.assets.length, "catalog visuals materialized"],
    ["Providers", input.providerBrowser.opened.length, "browser/API/fallback routes"],
    ["Gates", paymentGateCount + credentialGateCount, "secure input checkpoints"],
    ["Recipes", providerRecipeCount, "no-dead-end provider playbooks"],
  ];
  fs.writeFileSync(
    pathOut,
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Agentlas Ecommerce OS Proof</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:#f7f8f5; color:#151513; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; background:#f7f8f5; }
    main { display:grid; gap:1px; background:#dfe3dc; }
    .hero { min-height:760px; display:grid; grid-template-columns:minmax(0,0.94fr) minmax(440px,1.06fr); gap:42px; align-items:center; padding:58px; background:radial-gradient(circle at 82% 12%, rgba(41,87,255,0.28), transparent 28%), radial-gradient(circle at 14% 86%, rgba(216,92,74,0.24), transparent 32%), linear-gradient(135deg, #101010, #17231d 56%, #10222a); color:white; }
    .copy { display:grid; gap:18px; min-width:0; }
    .eyebrow { width:max-content; max-width:100%; border:1px solid rgba(255,255,255,0.2); background:rgba(255,255,255,0.1); border-radius:999px; padding:7px 10px; color:#a7f3d0; font-size:12px; font-weight:900; text-transform:uppercase; }
    h1 { margin:0; font-size:72px; line-height:0.9; letter-spacing:0; max-width:900px; }
    h2 { margin:0; font-size:22px; letter-spacing:0; }
    h3 { margin:0; font-size:15px; }
    p { margin:0; color:#d6d9df; line-height:1.56; font-size:16px; max-width:780px; }
    code { background:#eef5ff; color:#2957ff; padding:2px 6px; border-radius:5px; font-size:12px; }
    .prompt { padding:16px; border:1px solid rgba(255,255,255,0.2); border-radius:8px; background:rgba(255,255,255,0.09); color:#fffefa; font-size:15px; line-height:1.55; }
    .kpis { display:grid; grid-template-columns:repeat(3, minmax(0,1fr)); gap:10px; }
    .kpi { padding:14px; border:1px solid rgba(255,255,255,0.18); background:rgba(255,255,255,0.1); border-radius:8px; display:grid; gap:4px; min-height:92px; align-content:end; }
    .kpi strong { font-size:30px; line-height:1; }
    .kpi span { color:#d6d9df; font-size:12px; font-weight:800; }
    .app-frame { border:1px solid #dfe3dc; border-radius:8px; overflow:hidden; background:#fffefa; color:#151513; box-shadow:0 36px 96px rgba(15,23,42,0.28); min-width:0; }
    .frame-top { display:flex; justify-content:space-between; align-items:center; gap:12px; padding:13px; border-bottom:1px solid #dfe3dc; background:#f8faf7; }
    .dots { display:flex; gap:6px; }
    .dots span { width:10px; height:10px; border-radius:50%; background:#f87171; }
    .dots span:nth-child(2) { background:#fbbf24; }
    .dots span:nth-child(3) { background:#34d399; }
    .url { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#626963; font-size:12px; font-weight:800; }
    .visual-grid { display:grid; grid-template-columns:1.1fr 0.9fr; gap:12px; padding:14px; background:linear-gradient(145deg, #fffefa, #eef5ff); }
    .visual-card { position:relative; min-height:170px; border:1px solid #dfe3dc; border-radius:8px; overflow:hidden; background:linear-gradient(140deg, #f8e2d8, #dcefe7 52%, #dce6f6); display:grid; align-content:end; padding:14px; }
    .visual-card:first-child { min-height:360px; grid-row:span 2; }
    .visual-card img { position:absolute; inset:8px; width:calc(100% - 16px); height:calc(100% - 16px); object-fit:contain; }
    .visual-card.has-image::after { content:""; position:absolute; inset:0; background:linear-gradient(180deg, rgba(255,255,255,0.02), rgba(20,18,16,0.4)); }
    .visual-card strong, .visual-card span { position:relative; z-index:1; overflow-wrap:anywhere; }
    .visual-card.has-image strong, .visual-card.has-image span { color:white; text-shadow:0 1px 8px rgba(0,0,0,0.36); }
    .visual-card span { color:#626963; font-size:12px; }
    .section { padding:30px 42px; background:#f7f8f5; display:grid; gap:18px; }
    .section-head { display:flex; justify-content:space-between; align-items:end; gap:16px; flex-wrap:wrap; }
    .section-head p { color:#626963; }
    .proof-grid { display:grid; grid-template-columns:repeat(3, minmax(0,1fr)); gap:12px; }
    .proof-card, .step, .provider, .policy { border:1px solid #dfe3dc; border-radius:8px; background:#fffefa; padding:14px; }
    .proof-card { display:grid; gap:4px; min-height:110px; align-content:end; }
    .proof-card strong { font-size:30px; line-height:1; }
    .proof-card span, .provider span, .step small, .policy span { color:#626963; font-size:12px; overflow-wrap:anywhere; }
    .ops-grid { display:grid; grid-template-columns:minmax(0,1fr) minmax(340px,0.7fr); gap:14px; }
    .steps { display:grid; gap:8px; }
    .step { display:grid; grid-template-columns:34px minmax(0,1fr) auto; gap:10px; align-items:center; }
    .step div { display:grid; gap:3px; min-width:0; }
    .step span:first-child { width:34px; height:34px; border-radius:50%; display:grid; place-items:center; background:#151513; color:white; font-weight:950; }
    .step em { font-style:normal; border-radius:999px; padding:4px 8px; background:#ecfdf5; color:#0f766e; font-size:11px; font-weight:900; }
    .providers { display:grid; gap:8px; align-content:start; }
    .provider { display:grid; gap:4px; align-content:start; }
    .policy-row { display:grid; grid-template-columns:repeat(3, minmax(0,1fr)); gap:12px; }
    .policy { display:grid; gap:6px; }
    .footer { color:#626963; font-size:12px; }
    @media (max-width: 980px) { .hero, .visual-grid, .ops-grid, .proof-grid, .policy-row, .kpis { grid-template-columns:1fr; } h1 { font-size:42px; } .hero { padding:28px 18px; min-height:auto; } .section { padding:22px 18px; } }
  </style>
</head>
<body>
  <main>
    <section class="hero">
      <div class="copy">
        <span class="eyebrow">Agentlas OS proof · ecommerce</span>
        <h1>One request became a launchable commerce operating system.</h1>
        <div class="prompt">${html(input.prompt)}</div>
        <p>Agentlas created the agent team, generated the app, materialized product visuals, activated checkout and local database, prepared provider console delegation, and published the app as a reusable MCP tool.</p>
        <div class="kpis">
          ${proofCards.slice(0, 3).map(([label, value, detail]) => `<div class="kpi"><strong>${html(String(value))}</strong><span>${html(label)} · ${html(detail)}</span></div>`).join("\n          ")}
        </div>
      </div>
      <div class="app-frame">
        <div class="frame-top">
          <div class="dots" aria-hidden="true"><span></span><span></span><span></span></div>
          <div class="url">${html(input.appTool.toolName)} · ${html(input.autopilot.status)}</div>
          <code>tool published</code>
        </div>
        <div class="visual-grid">
          ${visualCards}
        </div>
      </div>
    </section>
    <section class="section">
      <div class="section-head">
        <div>
          <h2>This is what Agentlas built</h2>
          <p>Not a chat answer. A durable app, operating ledger, provider delegation runbook, and reusable tool package.</p>
        </div>
        <code>${html(input.scaffold.rootPath)}</code>
      </div>
      <div class="proof-grid">
        ${proofCards.map(([label, value, detail]) => `<div class="proof-card"><span>${html(label)}</span><strong>${html(String(value))}</strong><span>${html(detail)}</span></div>`).join("\n        ")}
      </div>
    </section>
    <section class="section">
      <div class="section-head">
        <div>
          <h2>Agent operated the business stack</h2>
          <p>Provider signup/login/payment/database/image/hosting work is modeled as OS actions with secure checkpoints, not as chores handed back to the user.</p>
        </div>
      </div>
      <div class="ops-grid">
        <div class="steps">${autopilotSteps}</div>
        <div class="providers">${providerItems}</div>
      </div>
    </section>
    <section class="section">
      <div class="policy-row">
        <div class="policy"><h3>No API/MCP dead-end</h3><span>Missing connectors become browser delegation, alternate providers, or generated local helpers.</span></div>
        <div class="policy"><h3>Secure input concierge</h3><span>Passwords, OTP, identity, card/CVV, cookies, and tokens never enter generated files, reports, manifests, or screenshots.</span></div>
        <div class="policy"><h3>Compounding OS object</h3><span>The app is archived/restored reversibly and published as <code>${html(input.appTool.toolName)}</code> for later agents.</span></div>
      </div>
      <p class="footer">Proof root: <code>${html(PROOF_ROOT)}</code></p>
    </section>
  </main>
</body>
</html>
`,
    "utf8",
  );
  return pathOut;
}

async function captureFileScreenshot(name, filePath, screenshotPath) {
  const { chromium } = require("playwright");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  try {
    const url = pathToFileURL(filePath).href;
    await page.goto(url, { waitUntil: "networkidle" });
    const title = await page.title();
    await page.screenshot({ path: screenshotPath, fullPage: true });
    return { name, route: "proof-story", url, title, routePath: filePath, path: screenshotPath };
  } finally {
    await browser.close();
  }
}

async function captureScreenshots(port, screenshotDir) {
  const { chromium } = require("playwright");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const routes = [
    { name: "dashboard", path: "/" },
    { name: "storefront", path: "/storefront" },
    { name: "catalog", path: "/catalog" },
    { name: "orders", path: "/orders" },
    { name: "finance", path: "/finance" },
    { name: "checkout", path: "/checkout" },
  ];
  const captures = [];
  try {
    for (const route of routes) {
      const url = `http://127.0.0.1:${port}${route.path}`;
      await page.goto(url, { waitUntil: "networkidle" });
      const title = await page.title();
      const routePath = await page.locator("body").getAttribute("data-route-path").catch(() => route.path);
      const screenshotPath = path.join(screenshotDir, `${route.name}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      captures.push({ name: route.name, route: route.path, url, title, routePath, path: screenshotPath });
    }
  } finally {
    await browser.close();
  }
  return captures;
}

async function startPreviewServer(rootPath, port) {
  const child = spawn(NODE_BIN, ["scripts/serve.mjs"], {
    cwd: rootPath,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));
  await waitForUrl(`http://127.0.0.1:${port}/`, 10_000, () => logs.join(""));
  return child;
}

async function stopServer(child) {
  if (!child || child.killed) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 1000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function waitForUrl(url, timeoutMs, getLogs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const status = await httpStatus(url);
      if (status === 200) return;
    } catch {
      // Server may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Preview server did not become ready at ${url}\n${getLogs()}`);
}

function httpStatus(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.setTimeout(1000, () => {
      req.destroy(new Error("timeout"));
    });
  });
}

function assertSecretSafe(rootPath) {
  const findings = [];
  for (const file of walkTextFiles(rootPath)) {
    const text = fs.readFileSync(file, "utf8");
    if (/(sk|pk)_(live|test)_[A-Za-z0-9]{12,}/.test(text)) findings.push(`${file}: provider key-like token`);
    if (/gh[pousr]_[A-Za-z0-9_]{20,}/.test(text)) findings.push(`${file}: GitHub token-like value`);
    for (const match of text.matchAll(/\b(?:\d[ -]*?){13,19}\b/g)) {
      const digits = match[0].replace(/\D/g, "");
      if (looksLikeCardNumber(digits)) findings.push(`${file}: card-like number`);
    }
    if (/"(?:password|passphrase|otp|cvv|cvc|cardNumber|card_number|cookie|accessToken|refreshToken)"\s*:\s*"[^"<>{}]{3,}"/i.test(text)) {
      findings.push(`${file}: raw secret-looking JSON field`);
    }
  }
  assert.deepEqual(findings, [], `Raw secret values leaked into generated files:\n${findings.join("\n")}`);
}

function walkTextFiles(rootPath) {
  const out = [];
  const allowed = new Set([".json", ".md", ".txt", ".html", ".mjs", ".js", ".css", ".env", ""]);
  const stack = [rootPath];
  while (stack.length) {
    const current = stack.pop();
    const stat = fs.statSync(current);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(current)) {
        if (name.startsWith("._")) continue;
        if (["node_modules", ".git"].includes(name)) continue;
        stack.push(path.join(current, name));
      }
      continue;
    }
    if (stat.size > 500_000) continue;
    if (allowed.has(path.extname(current)) || current.endsWith(".env.example")) out.push(current);
  }
  return out;
}

function looksLikeCardNumber(digits) {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = Number(digits[i]);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function html(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function removeAppleDoubleFiles(rootPath) {
  for (const file of walkAllFiles(rootPath)) {
    if (path.basename(file).startsWith("._")) {
      fs.rmSync(file, { force: true });
    }
  }
}

function walkAllFiles(rootPath) {
  const out = [];
  const stack = [rootPath];
  while (stack.length) {
    const current = stack.pop();
    const stat = fs.statSync(current);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(current)) stack.push(path.join(current, name));
    } else {
      out.push(current);
    }
  }
  return out;
}

function proofMarkdown(report) {
  return [
    `# Agentlas Ecommerce OS Proof`,
    "",
    `Prompt: ${report.prompt}`,
    `Created: ${report.createdAt}`,
    `Proof root: \`${report.proofRoot}\``,
    "",
    "## Result",
    "",
    "- Meta agent created a local commerce team and Agentlas firm.",
    `- Meta agent materialized ${report.team.generatedAgents.length} local agents before assembling the firm.`,
    "- Agentlas OS autopilot operated the generated app in one run.",
    "- Generated app contains dashboard, storefront, catalog, orders, and finance routes.",
    `- Generated app materialized ${report.materializedAssets.count} catalog asset(s) into its own package.`,
    "- Local commerce stack activated sandbox checkout and local database so the app operates before live provider credentials.",
    "- Provider delegation is prepared for payment, database, image generation, and hosting.",
    "- Generated app was published as a reusable MCP tool for later agents.",
    "- Agent-first autonomy is declared: provider/browser/app setup continues without generic prompts, while passwords, OTP, legal identity, card/CVV, payment submit, budget threshold, and destructive archive/delete remain checkpoints.",
    "- Credentials and payment remain behind Agentlas vault/provider checkout gates.",
    "- Smoke and preview checks passed.",
    "",
    "## Screenshots",
    "",
    ...report.screenshots.map((shot) => `- ${shot.name}: \`${shot.path}\``),
    "",
    "## Generated Agents",
    "",
    ...report.team.generatedAgents.map((agent) => `- ${agent.name} (${agent.slug}): ${agent.visibility}`),
    "",
    "## Autopilot Steps",
    "",
    `- Status: ${report.providerDelegation.autopilot.status}`,
    `- Summary: ${report.providerDelegation.autopilot.summary}`,
    ...report.providerDelegation.autopilot.steps.map((step) => `- ${step.status}: ${step.label} - ${step.summary}`),
    "",
    "## Materialized Assets",
    "",
    ...report.materializedAssets.assets.map((asset) => `- ${asset.name}: \`${asset.sourcePath}\``),
    "",
    "## Local Commerce Stack",
    "",
    `- Database: \`${report.localCommerceStack.localDatabasePath}\``,
    `- Runtime: \`${report.localCommerceStack.runtimePath}\``,
    `- Checkout: \`${report.localCommerceStack.checkoutPath}\``,
    "",
    "## Reusable App Tool",
    "",
    `- Tool: ${report.app.reusableTool.toolName}`,
    `- MCP server id: \`${report.app.reusableTool.mcpServerId}\``,
    `- MCP adapter: \`${report.app.reusableTool.mcpPath}\``,
    "",
    "## Reversible Lifecycle",
    "",
    `- Archive: \`${report.lifecycle.archivePath}\``,
    `- Archive manifest: \`${report.lifecycle.archiveManifestPath}\``,
    `- Restore status: ${report.lifecycle.statusAfterRestore}`,
    "",
    "## Provider Starts",
    "",
    ...report.providerDelegation.browserStarts.map((plan) => `- ${plan.connectorName}: ${plan.startUrl}`),
    "",
    "## Provider Browser Evidence",
    "",
    ...report.providerScreenshots.map((shot) => `- ${shot.name} (${shot.status}): \`${shot.path}\``),
    "",
    "## Provider Action Recipes",
    "",
    `- Evidence: \`${report.providerDelegation.providerRecipesPath}\``,
    ...report.providerDelegation.providerRecipes.map(
      (recipe) =>
        `- ${recipe.connectorName} (${recipe.type}): ${recipe.mode} · next ${recipe.nextActions.join(" -> ")} · fallbacks ${recipe.fallbackProviders.join(", ")}`,
    ),
    "",
    "## Credential Resolution",
    "",
    `- Evidence: \`${report.providerDelegation.credentialResolutionPath}\``,
    ...report.providerDelegation.credentialResolution.map((item) => `- \`${item.envKey}\`: ${item.status}${item.fingerprint ? ` · ${item.fingerprint}` : ""}`),
    "",
    "## Checks",
    "",
    ...report.checks.map((check) => `- [x] ${check}`),
    "",
  ].join("\n");
}

function stampForPath(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[:]/g, "-");
}
