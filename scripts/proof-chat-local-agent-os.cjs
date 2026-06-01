#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const NODE_BIN = process.env.npm_node_execpath || process.env.NODE || "node";
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").replace(/\-\d{3}Z$/, "Z");
const PROOF_ROOT = path.join("/Volumes/X31/temp", `agentlas-chat-local-agent-os-proof-${STAMP}`);
const SCREENSHOT_DIR = path.join(PROOF_ROOT, "screenshots");
const DB_PATH = path.join(PROOF_ROOT, "agentlas-proof.sqlite");
const PROMPT =
  "쇼핑몰 사업하고 싶어. 여자옷 판매, 결제, 디비, codex image 생성, 주문 운영 대시보드까지 내가 아무것도 안 해도 알아서 만들어줘.";

fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
process.env.AGENTLAS_STORE_PATH = DB_PATH;
process.env.AGENTLAS_DISABLE_RUNTIME_PROBES = "1";

const { initStore, getDb } = require("../dist/electron/store/db.js");
const {
  createChat,
  listChatMessages,
  setChatWorkingFolder,
} = require("../dist/electron/store/chats.js");
const { listAgentSurfaces } = require("../dist/electron/store/agent-surfaces.js");
const {
  listAgentApps,
  listAgentAppOperations,
  recordAgentAppOperation,
} = require("../dist/electron/store/agent-apps.js");
const { listFirms } = require("../dist/electron/store/firms.js");
const { runMcpInvocation } = require("../dist/electron/mcp/client.js");
const {
  approveProviderPayment,
  captureProviderBrowserSessions,
  resolveProviderCredentials,
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
      "agent-chat-proof-local-os",
      "chat-proof-local-os",
      "Chat Proof Local Agent OS",
      "Runs Agentlas OS from plain chat intent without a hosted runtime",
      "Create agent-first commerce surfaces, teams, apps, dashboards, local fallbacks, and reusable tools.",
      "[]",
      "A",
      now,
      "green",
      "[]",
    );
}

(async () => {
  initStore();
  seedAgent();
  const chat = createChat({
    agentId: "agent-chat-proof-local-os",
    title: "Chat local Agent OS proof",
  });
  setChatWorkingFolder(chat.id, PROOF_ROOT);

  const events = [];
  await runMcpInvocation(
    {
      chatId: chat.id,
      userPrompt: PROMPT,
      locale: "ko",
      permissions: "full",
    },
    (event) => events.push(event),
  );

  assert.equal(events.some((event) => event.kind === "error"), false);
  const surfaces = listAgentSurfaces(chat.id);
  const apps = listAgentApps(chat.id);
  const firms = listFirms();
  const messages = listChatMessages(chat.id);
  assert.equal(surfaces.length, 1);
  assert.equal(surfaces[0].domain, "ecommerce");
  assert.equal(apps.length, 1);
  assert.equal(apps[0].status, "tool-published");
  assert.equal(firms.length, 1);
  assert.equal(firms[0].orgChart.length, 13);
  assert.equal(messages.some((message) => message.role === "assistant" && /local meta-agent/i.test(message.text)), true);

  const app = apps[0];
  const operations = listAgentAppOperations(app.id);
  const autopilotOp = operations.find((op) => op.operation === "run-autopilot");
  assert.ok(autopilotOp, "expected run-autopilot operation");
  const autopilot = autopilotOp.result;
  assert.equal(autopilot.status, "operated");
  assert.equal(autopilot.waitingOn.includes("secure-provider-input"), false);
  assert.ok(autopilot.appTool?.mcpPath);
  assert.ok(fs.existsSync(autopilot.appTool.mcpPath));
  const resumeEvidence = await exerciseProviderResumeActions(app, autopilot);
  const runtimeEvidence = readCommerceRuntimeEvidence(app, autopilot, resumeEvidence);
  assertSecretSafe(app.rootPath);

  const storyPath = writeStory({
    prompt: PROMPT,
    chat,
    surface: surfaces[0],
    app,
    firm: firms[0],
    messages,
    autopilot,
    operations,
    runtimeEvidence,
    resumeEvidence,
  });
  const screenshots = [
    await captureFileScreenshot(
      "chat-local-agent-os-story",
      storyPath,
      path.join(SCREENSHOT_DIR, "chat-local-agent-os-story.png"),
    ),
  ];
  const port = await findFreePort();
  const server = await startPreviewServer(app.rootPath, port);
  try {
    screenshots.push(...(await captureRouteScreenshots(port, SCREENSHOT_DIR)));
  } finally {
    await stopServer(server);
  }

  const report = {
    proofVersion: "0.1",
    kind: "chat-local-agent-os-proof",
    prompt: PROMPT,
    proofRoot: PROOF_ROOT,
    dbPath: DB_PATH,
    createdAt: new Date().toISOString(),
    chat: { id: chat.id },
    surface: {
      id: surfaces[0].id,
      title: surfaces[0].title,
      domain: surfaces[0].domain,
      layout: surfaces[0].layout,
    },
    firm: {
      id: firms[0].id,
      name: firms[0].name,
      agentCount: firms[0].orgChart.length,
    },
    app: {
      id: app.id,
      name: app.appName,
      status: app.status,
      rootPath: app.rootPath,
      previewPath: app.previewPath,
      reusableTool: autopilot.appTool,
    },
    autopilot: {
      status: autopilot.status,
      summary: autopilot.summary,
      steps: autopilot.steps,
      waitingOn: autopilot.waitingOn,
    },
    commerceRuntime: runtimeEvidence,
    providerResume: resumeEvidence,
    screenshots,
    checks: [
      "actual chat runner path was used",
      "runtime probes were disabled, proving local Agentlas OS fallback works without hosted model/API runtime",
      "plain ecommerce prompt produced one durable service-app surface",
      "local meta-agent created 13 commerce team agents through the firm registry",
      "local payment sandbox, local database, and generated catalog images were activated and marked verified-local",
      "provider browser checkpoints, vault credential resolution, and scoped payment approval were exercised through the same operation backends exposed to the app UI",
      "reusable app MCP tool returned summary, providers, ledger, and reuse views from persisted app files",
      "hands-free app operation published a reusable MCP tool",
      "dashboard/storefront/catalog/orders/finance/checkout screenshots were saved under /Volumes/X31/temp",
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

function writeStory(input) {
  const storyDir = path.join(PROOF_ROOT, "proof-story");
  fs.mkdirSync(storyDir, { recursive: true });
  const out = path.join(storyDir, "index.html");
  const completed = input.autopilot.steps.filter((step) => step.status === "completed").length;
  const steps = input.autopilot.steps
    .map((step) => `<li><strong>${html(step.label)}</strong><span>${html(step.status)} · ${html(step.summary)}</span></li>`)
    .join("");
  const chatMessages = input.messages
    .map((message) => `<li><strong>${html(message.role)}</strong><span>${html(message.text)}</span></li>`)
    .join("");
  const localStack = input.runtimeEvidence.localRuntime;
  const resumeRows = [
    ["Browser checkpoints", input.resumeEvidence.browserSessions.sessions.length, input.resumeEvidence.browserSessions.sessionsPath],
    ["Vault resolution", `${input.resumeEvidence.credentialResolution.resolvedCount} ready / ${input.resumeEvidence.credentialResolution.missingCount} missing`, input.resumeEvidence.credentialResolution.resolutionPath],
    ["Payment approval", input.resumeEvidence.paymentApproval.approval.status, input.resumeEvidence.paymentApproval.approvalPath],
  ]
    .map(([label, status, detail]) => `<li><strong>${html(label)}</strong><span>${html(status)} · ${html(detail)}</span></li>`)
    .join("");
  const ledgerRows = [
    ["Payment", localStack.payment.status, localStack.payment.provider],
    ["Database", localStack.database.status, localStack.database.path],
    ["Images", localStack.imageGeneration.status, `${localStack.imageGeneration.assetCount} materialized assets`],
    ["Reusable MCP", input.runtimeEvidence.toolViews.summary.status.reuse.status, input.runtimeEvidence.toolViews.summary.toolName],
  ]
    .map(([label, status, detail]) => `<li><strong>${html(label)}</strong><span>${html(status)} · ${html(detail)}</span></li>`)
    .join("");
  fs.writeFileSync(
    out,
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Agentlas Chat Local OS Proof</title>
  <style>
    :root { font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #171717; background: #f5f1ea; }
    body { margin: 0; min-height: 100vh; background: #f5f1ea; }
    main { max-width: 1180px; margin: 0 auto; padding: 48px 36px 64px; display: grid; gap: 22px; }
    .grid { display: grid; grid-template-columns: 1.1fr .9fr; gap: 22px; align-items: stretch; }
    .lower { display: grid; grid-template-columns: .85fr 1.15fr; gap: 22px; }
    section { background: #fffdf8; border: 1px solid #d8cec1; border-radius: 8px; box-shadow: 0 20px 50px rgba(47, 38, 25, .12); padding: 28px; }
    h1 { margin: 0; font-size: 46px; line-height: 1.04; letter-spacing: 0; }
    h2 { margin: 0 0 14px; font-size: 18px; }
    p { margin: 0; color: #5f574c; line-height: 1.55; }
    .prompt { margin-top: 18px; padding: 15px; border-radius: 8px; background: #171717; color: #faf5ed; }
    .kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-top: 18px; }
    .kpi { border: 1px solid #e3d9cd; background: #faf6ef; border-radius: 8px; padding: 15px; display: grid; gap: 4px; }
    .kpi strong { font-size: 25px; }
    .kpi span { font-size: 12px; color: #665c51; font-weight: 700; }
    ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; }
    li { border-bottom: 1px solid #ece4da; padding: 10px 0; display: grid; gap: 4px; min-width: 0; }
    li:last-child { border-bottom: 0; }
    li strong { font-size: 13px; color: #126146; }
    li span { color: #62584e; font-size: 12px; overflow-wrap: anywhere; white-space: pre-wrap; }
    code { background: #eee5da; padding: 2px 6px; border-radius: 5px; overflow-wrap: anywhere; }
    footer { color: #655d53; font-size: 12px; }
    @media (max-width: 900px) { .grid, .lower, .kpis { grid-template-columns: 1fr; } h1 { font-size: 34px; } main { padding: 24px 16px; } }
  </style>
</head>
<body>
  <main>
    <div class="grid">
      <section>
        <p><strong>Agentlas OS proof</strong> · actual chat runner · no hosted runtime</p>
        <h1>One chat message became an operated commerce app.</h1>
        <div class="prompt">${html(input.prompt)}</div>
        <p style="margin-top:18px">The chat runner disabled runtime probes, then the built-in Agentlas OS meta-agent produced a declarative surface, created the commerce team, scaffolded the app, operated local fallbacks, ran smoke, packaged previews, and published a reusable MCP tool.</p>
      </section>
      <section>
        <h2>Result</h2>
        <div class="kpis">
          <div class="kpi"><strong>${html(input.firm.orgChart.length)}</strong><span>agents</span></div>
          <div class="kpi"><strong>${html(String(completed))}</strong><span>steps</span></div>
          <div class="kpi"><strong>app</strong><span>service surface</span></div>
          <div class="kpi"><strong>tool</strong><span>published app</span></div>
        </div>
        <p style="margin-top:16px">Tool: <code>${html(input.autopilot.appTool.toolName)}</code></p>
        <p style="margin-top:10px">Root: <code>${html(input.app.rootPath)}</code></p>
      </section>
    </div>
    <div class="lower">
      <section><h2>Chat Evidence</h2><ul>${chatMessages}</ul></section>
      <section><h2>Autopilot Steps</h2><ul>${steps}</ul><h2 style="margin-top:22px">Runtime Evidence</h2><ul>${ledgerRows}</ul><h2 style="margin-top:22px">Provider Resume Actions</h2><ul>${resumeRows}</ul></section>
    </div>
    <footer>Secrets policy: passwords, OTPs, raw cards, CVV/CVC, cookies, and tokens are not written to chat/files/logs/manifests. Paid checkout stays behind explicit approval.</footer>
  </main>
</body>
</html>
`,
    "utf8",
  );
  return out;
}

async function exerciseProviderResumeActions(app, autopilot) {
  const browserSessions = await captureProviderBrowserSessions({
    rootPath: app.rootPath,
    mode: "plan-only",
    screenshot: false,
  });
  recordAgentAppOperation(app.id, "capture-provider-browser-sessions", true, browserSessions, "operations-ready");
  assert.ok(fs.existsSync(browserSessions.sessionsPath), "provider browser sessions file must exist");
  assert.ok(browserSessions.sessions.length >= 3, "expected provider browser plans");
  assert.ok(browserSessions.sessions.every((session) => session.status === "planned-secure-checkpoint"));
  assert.ok(
    browserSessions.sessions.every((session) => session.checkpointManifestPath && fs.existsSync(session.checkpointManifestPath)),
    "provider browser sessions must write checkpoint manifests",
  );

  const credentialResolution = await resolveProviderCredentials({
    rootPath: app.rootPath,
    source: "agentlas-env-vault",
  });
  recordAgentAppOperation(app.id, "resolve-provider-credentials", true, credentialResolution, "operations-ready");
  assert.ok(fs.existsSync(credentialResolution.resolutionPath), "credential resolution file must exist");
  assert.ok(credentialResolution.missingCount >= 1, "proof should keep live provider credentials behind secure input");
  assert.ok(
    credentialResolution.credentials.every((credential) => !credential.fingerprint || credential.fingerprint.startsWith("sha256:")),
    "credentials may expose only fingerprints",
  );

  const paymentGate = autopilot.providerRun?.paymentGates?.[0];
  assert.ok(paymentGate, "expected a provider payment gate");
  const paymentApproval = await approveProviderPayment({
    rootPath: app.rootPath,
    merchant: paymentGate.merchant,
    quoteRequired: paymentGate.quoteRequired,
    amount: paymentGate.amount ?? null,
    currency: paymentGate.currency ?? null,
    recurrence: paymentGate.recurrence,
    approvalMode: paymentGate.approvalMode,
    cardHandling: paymentGate.cardHandling,
    actionId: paymentGate.actionId,
    scopeKey: "proof:commerce-provider-payment",
    approvedBy: "agentlas-proof-user",
    purpose: "Proof exercised scoped provider payment approval without storing card details.",
  });
  recordAgentAppOperation(app.id, "approve-provider-payment", true, paymentApproval, "operations-ready");
  assert.ok(fs.existsSync(paymentApproval.approvalPath), "payment approval file must exist");
  assert.equal(paymentApproval.approval.status, "approved");
  assert.equal(paymentApproval.approval.cardHandling, "provider-checkout");

  const operations = listAgentAppOperations(app.id);
  for (const operation of ["capture-provider-browser-sessions", "resolve-provider-credentials", "approve-provider-payment"]) {
    assert.ok(operations.some((op) => op.operation === operation), `expected operation ${operation}`);
  }

  return {
    browserSessions,
    credentialResolution,
    paymentApproval,
  };
}

function readCommerceRuntimeEvidence(app, autopilot, resumeEvidence) {
  const operationsPath = path.join(app.rootPath, "data", "operations.json");
  const localDbPath = path.join(app.rootPath, "data", "local-commerce.json");
  const checkoutPath = path.join(app.rootPath, "src", "checkout", "index.html");
  const operations = JSON.parse(fs.readFileSync(operationsPath, "utf8"));
  const localDb = JSON.parse(fs.readFileSync(localDbPath, "utf8"));
  assert.ok(fs.existsSync(checkoutPath), "checkout route must exist");

  const localRuntime = operations.localRuntime;
  assert.equal(localRuntime?.payment?.status, "sandbox-connected");
  assert.equal(localRuntime?.payment?.provider, "Agentlas checkout sandbox");
  assert.equal(localRuntime?.payment?.liveCheckoutRequiresApproval, true);
  assert.equal(localRuntime?.database?.status, "local-db-connected");
  assert.ok(localRuntime?.database?.tables?.includes("orders"));
  assert.ok(localRuntime?.database?.tables?.includes("payments"));
  assert.equal(localRuntime?.imageGeneration?.status, "assets-materialized");
  assert.ok(localRuntime?.imageGeneration?.assetCount >= 1);
  assert.equal(operations.providerRuntime?.localStack?.payment?.status, "sandbox-connected");
  assert.equal(localDb.runtime?.payment?.status, "sandbox-connected");
  assert.ok(localDb.products?.length >= 1);
  assert.ok(localDb.orders?.some((order) => order.paymentStatus === "sandbox-ready"));
  assert.ok(localDb.payments?.some((payment) => payment.liveCheckoutRequiresApproval === true));

  const ledgers = operations.ledgers || {};
  assert.ok(
    (ledgers.payments || []).some((item) =>
      (item.status === "sandbox-connected" && item.evidenceKind === "verified-local") ||
      (item.status === "payment-scope-approved" && item.approvalScopeKey === resumeEvidence.paymentApproval.approval.scopeKey),
    ),
  );
  assert.ok((ledgers.payments || []).some((item) => item.status === "payment-scope-approved"));
  assert.ok((ledgers.databases || []).some((item) => item.status === "local-db-connected" && item.evidenceKind === "verified-local"));
  assert.ok((ledgers.imageGeneration || []).some((item) => item.status === "assets-materialized" && item.evidenceKind === "verified-local"));
  assert.ok((operations.collections?.products || []).some((item) => item.assetPath && item.imageStatus === "materialized"));

  const toolViews = {
    summary: callAppTool(autopilot.appTool.mcpPath, "summary"),
    providers: callAppTool(autopilot.appTool.mcpPath, "providers"),
    ledger: callAppTool(autopilot.appTool.mcpPath, "ledger"),
    reuse: callAppTool(autopilot.appTool.mcpPath, "reuse"),
  };
  assert.equal(toolViews.summary.ok, true);
  assert.equal(toolViews.summary.status.localRuntime.payment.status, "sandbox-connected");
  assert.ok(toolViews.providers.providerRuntime.browserPlans.length >= 3);
  assert.ok(toolViews.ledger.ledgers.payments.some((item) => item.status === "sandbox-connected" || item.status === "payment-scope-approved"));
  assert.equal(toolViews.reuse.reuse.status, "published-as-tool");

  return {
    operationsPath,
    localDbPath,
    checkoutPath,
    localRuntime,
    localDbSummary: {
      products: localDb.products.length,
      orders: localDb.orders.length,
      payments: localDb.payments.length,
    },
    toolViews,
  };
}

function callAppTool(mcpPath, view) {
  const result = spawnSync(NODE_BIN, [mcpPath], {
    input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { arguments: { view } } })}\n`,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const line = result.stdout.trim().split("\n").find(Boolean);
  assert.ok(line, `no MCP tool output for ${view}`);
  const envelope = JSON.parse(line);
  assert.equal(envelope.result?.isError, false, envelope.result?.content?.[0]?.text || result.stdout);
  return JSON.parse(envelope.result.content[0].text);
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

async function captureRouteScreenshots(port, screenshotDir) {
  const { chromium } = require("playwright");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const routes = ["/", "/storefront", "/catalog", "/orders", "/finance", "/checkout"];
  const captures = [];
  try {
    for (const route of routes) {
      const name = route === "/" ? "dashboard" : route.slice(1);
      const url = `http://127.0.0.1:${port}${route}`;
      await page.goto(url, { waitUntil: "networkidle" });
      const title = await page.title();
      const routePath = await page.locator("body").getAttribute("data-route-path").catch(() => route);
      const screenshotPath = path.join(screenshotDir, `${name}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      captures.push({ name, route, url, title, routePath, path: screenshotPath });
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
    "# Agentlas Chat Local Agent OS Proof",
    "",
    `Prompt: ${report.prompt}`,
    `Created: ${report.createdAt}`,
    `Proof root: \`${report.proofRoot}\``,
    "",
    "## Result",
    "",
    "- Actual chat runner path was used.",
    "- Runtime probes were disabled, so the proof does not depend on hosted model/API availability.",
    "- One plain ecommerce prompt created a durable service-app surface.",
    `- Local meta-agent created ${report.firm.agentCount} commerce agents through the firm registry.`,
    "- Generated commerce app was operated hands-free and published as a reusable MCP tool.",
    "- Dashboard/storefront/catalog/orders/finance/checkout screenshots were captured.",
    "",
    "## Screenshots",
    "",
    ...report.screenshots.map((shot) => `- ${shot.name}: \`${shot.path}\``),
    "",
    "## Autopilot",
    "",
    `- Status: ${report.autopilot.status}`,
    `- Summary: ${report.autopilot.summary}`,
    ...report.autopilot.steps.map((step) => `- ${step.status}: ${step.label} - ${step.summary}`),
    "",
    "## Reusable Tool",
    "",
    `- Tool: ${report.app.reusableTool.toolName}`,
    `- MCP adapter: \`${report.app.reusableTool.mcpPath}\``,
    "",
    "## Checks",
    "",
    ...report.checks.map((check) => `- ${check}`),
    "",
  ].join("\n");
}
