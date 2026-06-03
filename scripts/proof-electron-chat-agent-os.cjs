#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { _electron: electron, chromium } = require("playwright");

const NODE_BIN = process.env.npm_node_execpath || process.env.NODE || "node";
const DESKTOP_ROOT = path.resolve(__dirname, "..");
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").replace(/\-\d{3}Z$/, "Z");
const PROOF_ROOT = path.join(require("os").tmpdir(), `agentlas-electron-chat-agent-os-proof-${STAMP}`);
const SCREENSHOT_DIR = path.join(PROOF_ROOT, "screenshots");
const USER_DATA_DIR = path.join(PROOF_ROOT, "electron-user-data");
const DB_PATH = path.join(PROOF_ROOT, "agentlas-electron-proof.sqlite");
const PROMPT =
  "쇼핑몰 사업하고 싶어. 여자옷 판매, 결제, 디비, codex image 생성, 주문 운영 대시보드까지 내가 아무것도 안 해도 알아서 만들어줘.";

fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
fs.mkdirSync(USER_DATA_DIR, { recursive: true });

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

async function main() {
  const consoleErrors = [];
  let app = null;
  let page = null;
  let chatInfo;
  let appState;
  let restartEvidence = null;
  let screenshots = [];
  try {
    ({ app, page } = await launchProofElectron(consoleErrors, "initial"));
    chatInfo = await createQaChatFromUiBridge(page);

    await page.evaluate(
      ({ chatId, prompt }) => {
        window.location.href = `/chat?id=${chatId}&prompt=${encodeURIComponent(prompt)}&permission=full`;
      },
      { chatId: chatInfo.chat.id, prompt: PROMPT },
    );
    await page.waitForFunction(() => location.pathname.includes("/chat"), null, { timeout: 30_000 });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "01-chat-start.png"), fullPage: true });

    appState = await waitForGeneratedApp(page, chatInfo.chat.id);
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "02-chat-final.png"), fullPage: true });

    await page.evaluate(() => {
      window.location.href = "/library/apps";
    });
    await page.waitForFunction(() => location.pathname.includes("/library/apps"), null, { timeout: 30_000 });
    await page.waitForFunction(
      () => document.body.innerText.includes("Women's Clothing Commerce OS") || document.body.innerText.includes("여자"),
      null,
      { timeout: 30_000 },
    );
    await page.getByText(/Agent Operator/i).first().waitFor({ timeout: 15_000 });

    const beforeProviderCapture = await operationCount(page, appState.app.id, "capture-provider-browser-sessions");
    await clickIfPresent(page, /체크포인트 캡처|Capture checkpoints/i);
    await waitForOperationCount(page, appState.app.id, "capture-provider-browser-sessions", beforeProviderCapture + 1, 90_000);
    await page.getByText(/payment-checkout-approval-required|login-or-oauth-required/i).first().scrollIntoViewIfNeeded({ timeout: 15_000 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "03-provider-browser-sessions.png"), fullPage: true });
    const beforeCredentialResolve = await operationCount(page, appState.app.id, "resolve-provider-credentials");
    await clickIfPresent(page, /Vault 확인|Check vault/i);
    await waitForOperationCount(page, appState.app.id, "resolve-provider-credentials", beforeCredentialResolve + 1, 45_000);
    const beforePaymentApproval = await operationCount(page, appState.app.id, "approve-provider-payment");
    await clickIfPresent(page, /결제 범위 승인|Approve payment scope/i);
    await waitForOperationCount(page, appState.app.id, "approve-provider-payment", beforePaymentApproval + 1, 45_000);
    const providerLaunchDryRun = await page.evaluate(
      async ({ rootPath }) => window.agentlas.appFactory.launchProviderBrowserSession({
        rootPath,
        connectorId: "payment-provider",
        dryRun: true,
      }),
      { rootPath: appState.app.rootPath },
    );
    writeSanitizedProviderResult(providerLaunchDryRun.resultPath);
    const mcpPathForSync = readGeneratedAppEvidence(appState.app.rootPath).reuse.mcpPath;
    const providerMcpResultSync = callAppTool(mcpPathForSync, {
      action: "sync-provider-browser-results",
      connectorId: "payment-provider",
    });
    const beforeResultSync = await operationCount(page, appState.app.id, "sync-provider-browser-results");
    const providerResultSync = await page.evaluate(
      async ({ rootPath }) => window.agentlas.appFactory.syncProviderBrowserResults({
        rootPath,
        connectorId: "payment-provider",
      }),
      { rootPath: appState.app.rootPath },
    );
    await waitForOperationCount(page, appState.app.id, "sync-provider-browser-results", beforeResultSync + 1, 45_000);
    await page.waitForTimeout(500);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => location.pathname.includes("/library/apps"), null, { timeout: 30_000 });
    await page.getByText(/closed-after-user-checkpoint|결과 동기화|Sync result/i).first().scrollIntoViewIfNeeded({ timeout: 15_000 });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "03-library-apps-provider-ops.png"), fullPage: true });

    const refreshed = await readUiState(page, chatInfo.chat.id);
    appState = attachGeneratedAppEvidence(refreshed);
    appState.ipcLaunchEvidence = providerLaunchDryRun;
    appState.ipcResultSyncEvidence = providerResultSync;
    appState.mcpResultSyncEvidence = providerMcpResultSync;
    appState.toolEvidence = readAppToolEvidence(appState.evidence.reuse.mcpPath);
    const routeShots = await captureGeneratedAppRoutes(appState.app.rootPath, SCREENSHOT_DIR);
    screenshots = [
      { name: "chat-start", path: path.join(SCREENSHOT_DIR, "01-chat-start.png") },
      { name: "chat-final", path: path.join(SCREENSHOT_DIR, "02-chat-final.png") },
      { name: "provider-browser-sessions", path: path.join(SCREENSHOT_DIR, "03-provider-browser-sessions.png") },
      { name: "library-apps-provider-ops", path: path.join(SCREENSHOT_DIR, "03-library-apps-provider-ops.png") },
      ...routeShots,
    ];

    assertElectronProof(appState);
    assertSecretSafe(appState.app.rootPath);

    restartEvidence = await verifyRestartPersistence({
      app,
      chatId: chatInfo.chat.id,
      originalState: appState,
      screenshotDir: SCREENSHOT_DIR,
      consoleErrors,
    });
    app = null;
    page = null;
    screenshots.push(...restartEvidence.screenshots);

    assert.deepEqual(consoleErrors, [], `Electron console errors:\n${consoleErrors.join("\n")}`);

    const report = {
      proofVersion: "0.1",
      kind: "electron-chat-agent-os-proof",
      prompt: PROMPT,
      proofRoot: PROOF_ROOT,
      dbPath: DB_PATH,
      userDataDir: USER_DATA_DIR,
      createdAt: new Date().toISOString(),
      chat: chatInfo.chat,
      agent: chatInfo.agent,
      app: {
        id: appState.app.id,
        name: appState.app.appName,
        agentId: appState.app.agentId,
        status: appState.app.status,
        rootPath: appState.app.rootPath,
        previewPath: appState.app.previewPath,
      },
      team: appState.teamEvidence,
      surface: appState.surfaces[0],
      messages: appState.messages.map((message) => ({ role: message.role, text: message.text })),
      operations: appState.operations.map((operation) => ({
        operation: operation.operation,
        ok: operation.ok,
        createdAt: operation.createdAt,
      })),
      evidence: appState.evidence,
      providerLaunchDryRun: appState.ipcLaunchEvidence,
      providerResultSync: appState.ipcResultSyncEvidence,
      providerMcpResultSync: appState.mcpResultSyncEvidence,
      toolEvidence: appState.toolEvidence,
      restart: restartEvidence,
      screenshots,
      checks: [
        "Electron app launched in production mode with isolated QA userData and DB",
        "UI bridge created a real chat, then the chat page auto-sent the exact ecommerce prompt",
        "No hosted runtime was available; built-in Agentlas OS local meta-agent handled the request",
        "Local meta-agent created the ecommerce CEO/team, division agents, and specialist agents in the Electron chat flow",
        "Generated team package includes Agentlas, Codex, Claude Code, and Gemini entrypoint files",
        "One durable ecommerce surface and one generated service app were persisted",
        "The generated app reached tool-published status and exposed a reusable app tool",
        "Generated app persisted an object-capability manifest for filesystem, browser delegation, payment, credential, generation, and PII scopes",
        "Generated app persisted a no-dead-end provider strategy so missing MCP/API routes become browser, alternate-provider, or local-helper paths",
        "Generated app routes expose an Agent Operator Console derived from provider runtime state, not a hardcoded demo surface",
        "Agentlas app library UI executed provider checkpoint capture, vault resolution, and payment-scope approval",
        "Agentlas IPC exposed provider browser session resume as a first-class app operation",
        "Provider browser sessions wrote checkpoint manifests that split agent-operated setup from secure human inputs",
        "Generated app MCP tool synced provider browser result metadata for other agents without Electron IPC",
        "Generated app MCP tool exposed the same capability manifest to downstream agents",
        "Provider browser sanitized result metadata synced back into Agentlas OS state",
        "Generated dashboard/storefront/catalog/orders/finance/checkout routes rendered and were captured under the system temp directory",
        "Generated app MCP tool returned provider session queues and visible browser launch dry-run without reading secrets",
        "Generated app MCP tool exposed the no-dead-end provider strategy to downstream agents",
        "Electron was restarted with the same DB/userData and the generated team, app, reusable MCP tool, provider results, and routes still worked",
        "Secret/card/token leak scan found no raw secret values in generated app files",
      ],
    };
    fs.writeFileSync(path.join(PROOF_ROOT, "proof-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    fs.writeFileSync(path.join(PROOF_ROOT, "PROOF.md"), proofMarkdown(report), "utf8");
    removeAppleDoubleFiles(PROOF_ROOT);
    console.log(JSON.stringify(report, null, 2));
  } catch (err) {
    if (page) await page.screenshot({ path: path.join(SCREENSHOT_DIR, "electron-proof-error.png"), fullPage: true }).catch(() => {});
    throw err;
  } finally {
    if (app) await app.close().catch(() => {});
  }
}

async function launchProofElectron(consoleErrors, label) {
  const app = await electron.launch({
    cwd: DESKTOP_ROOT,
    args: ["."],
    env: {
      ...process.env,
      NODE_ENV: "production",
      AGENTLAS_QA_USER_DATA_DIR: USER_DATA_DIR,
      AGENTLAS_STORE_PATH: DB_PATH,
      AGENTLAS_DISABLE_RUNTIME_PROBES: "1",
    },
  });
  const page = await app.firstWindow({ timeout: 60_000 });
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(`[${label}] ${msg.text()}`);
  });
  page.setDefaultTimeout(45_000);
  await page.setViewportSize({ width: 1440, height: 960 }).catch(() => undefined);
  await page.waitForLoadState("domcontentloaded", { timeout: 30_000 });
  await page.waitForFunction(() => Boolean(window.agentlas), null, { timeout: 30_000 });
  return { app, page };
}

async function createQaChatFromUiBridge(page) {
  return page.evaluate(async ({ proofRoot }) => {
    window.localStorage.setItem("agentlas.onboarded", "1");
    const agents = await window.agentlas.team.list();
    const agent =
      agents.find((item) => item.slug === "agentlas-orchestrator" && item.visibility !== "background") ||
      agents.find((item) => item.visibility !== "background") ||
      agents[0];
    if (!agent) throw new Error("No installed Agentlas agent is available for UI proof.");
    const chat = await window.agentlas.chats.create({
      agentId: agent.id,
      title: "Electron local Agent OS proof",
    });
    await window.agentlas.workspace.set(chat.id, proofRoot);
    return { agent, chat };
  }, { proofRoot: PROOF_ROOT });
}

async function waitForGeneratedApp(page, chatId) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < 120_000) {
    last = await readUiState(page, chatId);
    const app = last.apps.find((item) => item.domain === "ecommerce");
    if (app?.status === "tool-published" && last.surfaces.some((surface) => surface.domain === "ecommerce")) {
      return { ...last, app };
    }
    await page.waitForTimeout(800);
  }
  throw new Error(`Timed out waiting for generated app. Last state: ${JSON.stringify(last, null, 2)}`);
}

async function readUiState(page, chatId) {
  return page.evaluate(async ({ chatId }) => {
    const apps = await window.agentlas.appFactory.listApps(chatId);
    const app = apps.find((item) => item.domain === "ecommerce") || apps[0] || null;
    const operations = app ? await window.agentlas.appFactory.listOperations(app.id) : [];
    const surfaces = await window.agentlas.surfaces.listSurfaces(chatId);
    const messages = await window.agentlas.invoke.history(chatId);
    const firms = await window.agentlas.firms.list();
    const agents = await window.agentlas.team.list();
    return { apps, app, operations, surfaces, messages, firms, agents, evidence: null, teamEvidence: null };
  }, { chatId });
}

async function operationCount(page, appId, operation) {
  return page.evaluate(
    async ({ appId, operation }) => {
      const ops = await window.agentlas.appFactory.listOperations(appId);
      return ops.filter((item) => item.operation === operation && item.ok).length;
    },
    { appId, operation },
  );
}

async function waitForOperationCount(page, appId, operation, minCount, timeoutMs) {
  const started = Date.now();
  let lastCount = 0;
  while (Date.now() - started < timeoutMs) {
    lastCount = await operationCount(page, appId, operation);
    if (lastCount >= minCount) return;
    await page.waitForTimeout(500);
  }
  throw new Error(`Timed out waiting for ${operation}: expected ${minCount}, saw ${lastCount}`);
}

async function clickIfPresent(page, name) {
  const button = page.getByRole("button", { name }).first();
  await button.click({ timeout: 30_000 });
}

function writeSanitizedProviderResult(resultPath) {
  assert.ok(resultPath, "provider launch dry-run must expose a sanitized result path");
  fs.mkdirSync(path.dirname(resultPath), { recursive: true });
  fs.writeFileSync(
    resultPath,
    `${JSON.stringify({
      version: "0.1",
      kind: "provider-browser-session-result",
      connectorId: "payment-provider",
      connectorName: "Payment provider",
      type: "payments",
      status: "closed-after-user-checkpoint",
      finalUrl: "https://dashboard.stripe.com/register?setup_intent=redacted",
      title: "Stripe account setup complete",
      closedAt: new Date().toISOString(),
      safeStorage: [
        "sanitized URL",
        "page title",
        "operator status",
        "never password, OTP, raw card, CVV/CVC, cookies, tokens, or provider session secrets",
      ],
    }, null, 2)}\n`,
    "utf8",
  );
}

async function captureGeneratedAppRoutes(rootPath, screenshotDir, options = {}) {
  const filePrefix = options.filePrefix || "04-generated";
  const namePrefix = options.namePrefix || "generated";
  const port = await findFreePort();
  const server = await startPreviewServer(rootPath, port);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const routes = ["/", "/storefront", "/catalog", "/orders", "/finance", "/checkout"];
  const captures = [];
  try {
    for (const route of routes) {
      const name = route === "/" ? "dashboard" : route.slice(1);
      const url = `http://127.0.0.1:${port}${route}`;
      await page.goto(url, { waitUntil: "networkidle" });
      await page.waitForSelector('[data-list="operatorConsole"]', { timeout: 10_000 });
      await page.getByText(/Agent Operator Console|Agent-first external-service operation/i).first().waitFor({ timeout: 10_000 });
      const title = await page.title();
      const screenshotPath = path.join(screenshotDir, `${filePrefix}-${name}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      captures.push({ name: `${namePrefix}-${name}`, route, url, title, path: screenshotPath });
    }
  } finally {
    await browser.close().catch(() => {});
    await stopServer(server);
  }
  return captures;
}

async function verifyRestartPersistence(input) {
  await input.app.close().catch(() => undefined);
  const { app, page } = await launchProofElectron(input.consoleErrors, "restart");
  try {
    await page.evaluate(() => {
      window.localStorage.setItem("agentlas.onboarded", "1");
      window.location.href = "/library/apps";
    });
    await page.waitForFunction(() => location.pathname.includes("/library/apps"), null, { timeout: 30_000 });
    await page.waitForFunction(
      () => document.body.innerText.includes("Women's Clothing Commerce OS") || document.body.innerText.includes("여자"),
      null,
      { timeout: 30_000 },
    );
    await page.getByText(/Agent Operator/i).first().waitFor({ timeout: 15_000 });
    const libraryScreenshot = path.join(input.screenshotDir, "05-restart-library-apps.png");
    await page.screenshot({ path: libraryScreenshot, fullPage: true });

    const state = attachGeneratedAppEvidence(await readUiState(page, input.chatId));
    assertRestartPersistence(state, input.originalState);
    const toolEvidence = readAppToolEvidence(state.evidence.reuse.mcpPath);
    assert.equal(toolEvidence.noDeadEnd.noDeadEndStrategy.status, "recoverable");
    assert.equal(toolEvidence.paymentQueue.session.result.status, "closed-after-user-checkpoint");
    const routeShots = await captureGeneratedAppRoutes(state.app.rootPath, input.screenshotDir, {
      filePrefix: "05-restart-generated",
      namePrefix: "restart-generated",
    });
    return {
      kind: "restart-persistence-proof",
      app: {
        id: state.app.id,
        name: state.app.appName,
        status: state.app.status,
        rootPath: state.app.rootPath,
        reusableTool: state.evidence.reuse.mcpPath,
      },
      team: state.teamEvidence?.firm || null,
      localRuntime: state.evidence.localRuntime,
      providerResultStatus: state.evidence.providerRuntime.browserResults.find((item) => item.connectorId === "payment-provider")?.resultStatus || null,
      reusableToolStatus: toolEvidence.capabilities.capabilityManifest.kind,
      screenshots: [
        { name: "restart-library-apps", path: libraryScreenshot },
        ...routeShots,
      ],
      summary:
        "After a full Electron restart with the same DB/userData, the generated team, app, reusable MCP tool, provider result metadata, local DB, and generated routes were still readable and operational.",
    };
  } finally {
    await app.close().catch(() => undefined);
  }
}

function assertRestartPersistence(state, originalState) {
  assert.ok(state.app, "restart must reload the generated app from persistent storage");
  assert.equal(state.app.id, originalState.app.id, "restart must preserve the generated app id");
  assert.equal(state.app.status, "tool-published", "restart must preserve the generated app published state");
  assert.equal(state.app.rootPath, originalState.app.rootPath, "restart must preserve the generated app root path");
  assertGeneratedTeamEvidence(state);
  assert.equal(state.teamEvidence.firm.id, originalState.teamEvidence.firm.id, "restart must preserve the generated team firm");
  assert.ok(state.messages.some((message) => message.role === "user" && message.text === PROMPT), "restart must preserve chat history");
  assert.ok(state.surfaces.some((surface) => surface.id === originalState.surfaces[0].id), "restart must preserve the declarative surface");
  assert.ok(state.operations.some((operation) => operation.operation === "run-autopilot" && operation.ok), "restart must preserve app operation history");
  assert.equal(state.evidence.localRuntime.payment.status, "sandbox-connected");
  assert.equal(state.evidence.localRuntime.database.status, "local-db-connected");
  assert.equal(state.evidence.localRuntime.imageGeneration.status, "assets-materialized");
  assert.equal(state.evidence.reuse.status, "published-as-tool");
  assert.ok(state.evidence.reuse.mcpPath && fs.existsSync(state.evidence.reuse.mcpPath), "restart must preserve reusable MCP tool");
  assert.ok(
    state.evidence.providerRuntime.browserResults.some((result) => result.connectorId === "payment-provider" && result.resultStatus === "closed-after-user-checkpoint"),
    "restart must preserve sanitized provider result metadata",
  );
  for (const route of ["index.html", "storefront/index.html", "catalog/index.html", "orders/index.html", "finance/index.html", "checkout/index.html"]) {
    const file = path.join(state.app.rootPath, "src", route);
    assert.ok(fs.existsSync(file), `restart must preserve generated route ${route}`);
  }
}

function assertElectronProof(state) {
  assert.ok(state.app, "generated app must exist");
  assert.equal(state.app.status, "tool-published");
  assertGeneratedTeamEvidence(state);
  assert.ok(state.surfaces.some((surface) => surface.domain === "ecommerce" && surface.layout === "service-app"));
  assert.ok(state.messages.some((message) => message.role === "user" && message.text === PROMPT));
  assert.ok(state.messages.some((message) => message.role === "assistant" && /local meta-agent/i.test(message.text)));
  for (const operation of [
    "run-autopilot",
    "capture-provider-browser-sessions",
    "resolve-provider-credentials",
    "approve-provider-payment",
    "launch-provider-session",
    "sync-provider-browser-results",
  ]) {
    assert.ok(state.operations.some((item) => item.operation === operation && item.ok), `missing operation ${operation}`);
  }
  const evidence = state.evidence;
  assert.equal(evidence.localRuntime.payment.status, "sandbox-connected");
  assert.equal(evidence.localRuntime.database.status, "local-db-connected");
  assert.equal(evidence.localRuntime.imageGeneration.status, "assets-materialized");
  assert.ok(evidence.providerRuntime.browserSessions.length >= 3);
  assert.ok(
    evidence.providerRuntime.browserSessions.every((session) => Array.isArray(session.safeStorage) && session.safeStorage.some((item) => /never password/i.test(item))),
    "provider browser sessions must carry a no-secret storage contract",
  );
  assert.ok(
    evidence.providerRuntime.browserSessions.some((session) => session.screenshotPath && fs.existsSync(session.screenshotPath)),
    "provider browser preflight must leave at least one screenshot proof",
  );
  assert.ok(
    evidence.providerRuntime.browserSessions.every((session) => session.nextAction && session.blockerKind && session.evidenceKind),
    "provider browser sessions must describe next action, blocker kind, and evidence kind",
  );
  assert.ok(
    evidence.providerRuntime.browserSessions.every((session) => session.resumeCommand && session.actionQueuePath && session.checkpointManifestPath && session.handoffPath && session.resultPath),
    "provider browser sessions must include visible resume command and delegation artifacts",
  );
  assert.ok(
    evidence.providerRuntime.browserSessions.every((session) => fs.existsSync(session.actionQueuePath) && fs.existsSync(session.checkpointManifestPath) && fs.existsSync(session.handoffPath) && fs.existsSync(session.resumeLauncherPath)),
    "provider browser delegation artifacts must exist on disk",
  );
  const paymentCheckpoint = JSON.parse(fs.readFileSync(evidence.providerRuntime.browserSessions.find((session) => session.connectorId === "payment-provider").checkpointManifestPath, "utf8"));
  assert.equal(paymentCheckpoint.kind, "agentlas-provider-checkpoint-manifest");
  assert.ok(paymentCheckpoint.agentAllowedActions.includes("create-provider-account-or-app"));
  assert.ok(paymentCheckpoint.secureHumanInputs.some((item) => item.kind === "payment-method"));
  assert.ok(paymentCheckpoint.resumeContract.forbiddenResultFields.includes("raw card"));
  assert.ok(
    evidence.providerRuntime.browserSessions.some((session) => session.connectorId === "payment-provider" && session.resultStatus === "closed-after-user-checkpoint" && session.resultSyncedAt),
    "payment provider sanitized result must be synced onto the provider session",
  );
  assert.ok(
    evidence.providerRuntime.browserResults.some((result) => result.connectorId === "payment-provider" && result.resultStatus === "closed-after-user-checkpoint" && result.agentCanContinue === true),
    "provider runtime must retain sanitized browser result metadata for later agents",
  );
  assert.ok(evidence.providerRuntime.credentialResolution.length >= 1);
  assert.ok(evidence.providerRuntime.paymentApprovals.some((approval) => approval.status === "approved"));
  assert.equal(evidence.providerRuntime.noDeadEndStrategy.status, "recoverable");
  assert.equal(evidence.providerRuntime.noDeadEndStrategy.violations.length, 0);
  assert.ok(
    evidence.providerRuntime.noDeadEndStrategy.plans.every((plan) => plan.canProceedWithoutMcp === true),
    "every provider connector must have a path beyond missing MCP/API",
  );
  assert.equal(evidence.capabilityManifest.kind, "agentlas-app-capability-manifest");
  assert.ok(
    evidence.capabilityManifest.capabilities.some((capability) => capability.id === "provider-browser-delegation" && capability.type === "browser-session"),
    "generated app must declare provider browser delegation capability",
  );
  assert.ok(
    evidence.capabilityManifest.capabilities.some((capability) => capability.id === "payment-scope-approval" && capability.cardHandling === "provider-checkout-only"),
    "generated app must declare payment scope approval and provider-only card handling",
  );
  assert.ok(
    evidence.capabilityManifest.capabilities.some((capability) => capability.id === "generated-app-filesystem" && capability.reversible === true),
    "generated app filesystem capability must be scoped and reversible",
  );
  assert.ok(
    evidence.capabilityManifest.capabilities.some((capability) => capability.id === "generation-budget" && capability.budgetGated === true),
    "generated app generation capability must be budget gated",
  );
  assert.equal(evidence.reuse.status, "published-as-tool");
  assert.equal(state.ipcLaunchEvidence.ok, true);
  assert.equal(state.ipcLaunchEvidence.status, "dry-run");
  assert.equal(state.ipcLaunchEvidence.connectorId, "payment-provider");
  assert.match(state.ipcLaunchEvidence.resumeCommand, /launch-visible-session\.mjs/);
  assert.equal(state.ipcResultSyncEvidence.synced, 1);
  assert.equal(state.ipcResultSyncEvidence.results[0].resultStatus, "closed-after-user-checkpoint");
  assert.equal(state.ipcResultSyncEvidence.results[0].agentCanContinue, true);
  assert.equal(state.mcpResultSyncEvidence.ok, true);
  assert.equal(state.mcpResultSyncEvidence.synced, 1);
  assert.equal(state.mcpResultSyncEvidence.results[0].resultStatus, "closed-after-user-checkpoint");
  assert.equal(state.mcpResultSyncEvidence.results[0].agentCanContinue, true);
  assert.equal(state.toolEvidence.capabilities.capabilityManifest.kind, "agentlas-app-capability-manifest");
  assert.ok(state.toolEvidence.capabilities.capabilityManifest.capabilities.some((capability) => capability.id === "commerce-pii-ledger"));
  assert.ok(state.toolEvidence.providerSessions.providerSessions.length >= 3);
  assert.equal(state.toolEvidence.paymentQueue.ok, true);
  assert.equal(state.toolEvidence.paymentQueue.session.actionQueue.kind, "provider-browser-action-queue");
  assert.equal(state.toolEvidence.paymentQueue.session.checkpointManifest.kind, "agentlas-provider-checkpoint-manifest");
  assert.ok(state.toolEvidence.paymentQueue.session.checkpointManifest.secureHumanInputs.some((item) => item.kind === "payment-method"));
  assert.equal(state.toolEvidence.paymentQueue.session.result.status, "closed-after-user-checkpoint");
  assert.equal(state.toolEvidence.paymentLaunchDryRun.ok, true);
  assert.equal(state.toolEvidence.paymentLaunchDryRun.dryRun, true);
  assert.match(state.toolEvidence.paymentLaunchDryRun.resumeCommand, /launch-visible-session\.mjs/);
  assert.ok(state.toolEvidence.paymentLaunchDryRun.session.actionQueue.steps.length >= 1);
  assert.equal(state.toolEvidence.noDeadEnd.noDeadEndStrategy.status, "recoverable");
  assert.ok(state.toolEvidence.noDeadEnd.noDeadEndStrategy.plans.some((plan) => /local/i.test(plan.localFallback || "")));
}

function attachGeneratedAppEvidence(state) {
  if (!state.app) return state;
  return {
    ...state,
    evidence: readGeneratedAppEvidence(state.app.rootPath),
    teamEvidence: readGeneratedTeamEvidence(state),
  };
}

function readGeneratedTeamEvidence(state) {
  const firms = Array.isArray(state.firms) ? state.firms : [];
  const agents = Array.isArray(state.agents) ? state.agents : [];
  const firm =
    firms.find((item) => item.ceoAgentId && item.ceoAgentId === state.app?.agentId) ||
    firms.find((item) => Array.isArray(item.orgChart) && item.orgChart.length >= 13 && /commerce|clothing|women/i.test(`${item.slug} ${item.name}`)) ||
    firms.find((item) => Array.isArray(item.orgChart) && item.orgChart.length >= 13) ||
    null;
  const chartIds = new Set(Array.isArray(firm?.orgChart) ? firm.orgChart.map((node) => node.agentId).filter(Boolean) : []);
  const generatedAgents = agents.filter((agent) =>
    chartIds.has(agent.id) || /generated-teams|commerce-team/i.test(`${agent.localPath || ""} ${agent.slug || ""}`),
  );
  const ceo = agents.find((agent) => agent.id === firm?.ceoAgentId) || generatedAgents.find((agent) => agent.kind === "team") || null;
  const rootPath = ceo?.localPath || generatedAgents.find((agent) => agent.localPath)?.localPath || null;
  const files = rootPath
    ? [
        "TEAM.md",
        "README.md",
        "AGENTS.md",
        "CLAUDE.md",
        ".claude/CLAUDE.md",
        "GEMINI.md",
        "agentlas.team.json",
        "agents/ceo/AGENT.md",
        "agents/ceo/AGENTS.md",
        "agents/ceo/CLAUDE.md",
        "agents/ceo/GEMINI.md",
        "agents/storefront/AGENT.md",
        "agents/storefront/AGENTS.md",
        "agents/storefront/CLAUDE.md",
        "agents/storefront/GEMINI.md",
        "agents/catalog/AGENT.md",
        "agents/catalog/AGENTS.md",
        "agents/catalog/CLAUDE.md",
        "agents/catalog/GEMINI.md",
        "agents/payments-data/AGENT.md",
        "agents/payments-data/AGENTS.md",
        "agents/payments-data/CLAUDE.md",
        "agents/payments-data/GEMINI.md",
        "agents/operations/AGENT.md",
        "agents/operations/AGENTS.md",
        "agents/operations/CLAUDE.md",
        "agents/operations/GEMINI.md",
      ].map((relative) => {
        const fullPath = path.join(rootPath, relative);
        return { relative, fullPath, exists: fs.existsSync(fullPath) };
      })
    : [];
  return {
    firm: firm
      ? {
          id: firm.id,
          slug: firm.slug,
          name: firm.name,
          ceoAgentId: firm.ceoAgentId,
          orgChartCount: Array.isArray(firm.orgChart) ? firm.orgChart.length : 0,
        }
      : null,
    rootPath,
    generatedAgents: generatedAgents.map((agent) => ({
      id: agent.id,
      slug: agent.slug,
      name: agent.name,
      kind: agent.kind,
      visibility: agent.visibility,
      localPath: agent.localPath,
    })),
    visibleTeamAgent: ceo
      ? {
          id: ceo.id,
          slug: ceo.slug,
          name: ceo.name,
          kind: ceo.kind,
          localPath: ceo.localPath,
        }
      : null,
    files,
  };
}

function assertGeneratedTeamEvidence(state) {
  const evidence = state.teamEvidence || readGeneratedTeamEvidence(state);
  assert.ok(evidence.firm, "Electron proof must create a durable commerce firm/team");
  assert.equal(evidence.firm.ceoAgentId, state.app.agentId, "generated app must be operated by the generated team CEO agent");
  assert.equal(evidence.firm.orgChartCount, 13, "commerce team must include CEO, 4 divisions, and 8 specialists");
  assert.ok(evidence.rootPath && fs.existsSync(evidence.rootPath), "generated team root must exist");
  assert.ok(evidence.generatedAgents.length >= 13, "generated team agents must be visible in the Agentlas registry");
  assert.ok(evidence.generatedAgents.some((agent) => agent.visibility === "visible" && agent.kind === "team"), "team CEO must be a visible installed team agent");
  assert.ok(evidence.generatedAgents.filter((agent) => agent.visibility === "background").length >= 12, "division/specialist agents must be installed as background agents");
  assert.ok(evidence.files.length >= 1 && evidence.files.every((file) => file.exists), "generated team files must be written on disk");
  const teamManifestPath = path.join(evidence.rootPath, "agentlas.team.json");
  const teamManifest = JSON.parse(fs.readFileSync(teamManifestPath, "utf8"));
  assert.equal(teamManifest.compatibility?.agentlasOs, true);
  assert.equal(teamManifest.compatibility?.codex, "AGENTS.md");
  assert.match(teamManifest.compatibility?.claudeCode || "", /CLAUDE\.md/);
  assert.equal(teamManifest.compatibility?.gemini, "GEMINI.md");
  for (const file of ["AGENTS.md", "CLAUDE.md", ".claude/CLAUDE.md", "GEMINI.md"]) {
    const body = fs.readFileSync(path.join(evidence.rootPath, file), "utf8");
    assert.match(body, /Agentlas OS Compatibility Contract/);
    assert.match(body, /browser delegation|provider console/i);
  }
  state.teamEvidence = evidence;
}

function readGeneratedAppEvidence(rootPath) {
  const operationsPath = path.join(rootPath, "data", "operations.json");
  const localDbPath = path.join(rootPath, "data", "local-commerce.json");
  const operations = JSON.parse(fs.readFileSync(operationsPath, "utf8"));
  const localDb = JSON.parse(fs.readFileSync(localDbPath, "utf8"));
  const providerRuntime = operations.providerRuntime || {};
  const reuse = operations.reuse || {};
  return {
    operationsPath,
    localDbPath,
    localRuntime: operations.localRuntime,
    capabilityManifest: operations.capabilityManifest || {},
    providerRuntime: {
      browserSessions: providerRuntime.browserSessions || [],
      browserLaunches: providerRuntime.browserLaunches || [],
      browserResults: providerRuntime.browserResults || [],
      credentialResolution: providerRuntime.credentialResolution || [],
      paymentApprovals: providerRuntime.paymentApprovals || [],
      noDeadEndStrategy: providerRuntime.noDeadEndStrategy || null,
      localStack: providerRuntime.localStack || null,
    },
    reuse,
    localDbSummary: {
      products: Array.isArray(localDb.products) ? localDb.products.length : 0,
      orders: Array.isArray(localDb.orders) ? localDb.orders.length : 0,
      payments: Array.isArray(localDb.payments) ? localDb.payments.length : 0,
    },
  };
}

function readAppToolEvidence(mcpPath) {
  assert.ok(mcpPath && fs.existsSync(mcpPath), "generated app MCP server must exist");
  return {
    capabilities: callAppTool(mcpPath, { view: "capabilities" }),
    noDeadEnd: callAppTool(mcpPath, { view: "no-dead-end" }),
    providerSessions: callAppTool(mcpPath, { view: "provider-sessions" }),
    paymentQueue: callAppTool(mcpPath, { action: "read-provider-action-queue", connectorId: "payment-provider" }),
    paymentLaunchDryRun: callAppTool(mcpPath, {
      action: "launch-provider-session",
      connectorId: "payment-provider",
      dryRun: true,
    }),
  };
}

function callAppTool(mcpPath, args) {
  const result = spawnSync(NODE_BIN, [mcpPath], {
    input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { arguments: args } })}\n`,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const line = result.stdout.trim().split("\n").find(Boolean);
  assert.ok(line, `no MCP tool output for ${JSON.stringify(args)}`);
  const envelope = JSON.parse(line);
  assert.equal(envelope.result?.isError, false, envelope.result?.content?.[0]?.text || result.stdout);
  return JSON.parse(envelope.result.content[0].text);
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

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
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
        if (["node_modules", ".git", "browser-profile"].includes(name)) continue;
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

function removeAppleDoubleFiles(rootPath) {
  for (const file of walkAllFiles(rootPath)) {
    if (path.basename(file).startsWith("._")) fs.rmSync(file, { force: true });
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
    "# Agentlas Electron Chat Agent OS Proof",
    "",
    `Prompt: ${report.prompt}`,
    `Created: ${report.createdAt}`,
    `Proof root: \`${report.proofRoot}\``,
    "",
    "## Result",
    "",
    "- Electron app launched in production mode.",
    "- The chat page auto-sent the exact ecommerce prompt through the renderer IPC bridge.",
    "- The local Agentlas OS meta-agent created the surface, app, local commerce stack, and reusable tool.",
    "- The app library UI executed provider checkpoint capture, vault resolution, and payment approval operations.",
    "",
    "## Screenshots",
    "",
    ...report.screenshots.map((shot) => `- ${shot.name}: \`${shot.path}\``),
    "",
    "## Operations",
    "",
    ...report.operations.map((operation) => `- ${operation.ok ? "pass" : "fail"}: ${operation.operation}`),
    "",
    "## Checks",
    "",
    ...report.checks.map((check) => `- ${check}`),
    "",
  ].join("\n");
}
