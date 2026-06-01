#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawn, spawnSync } = require("node:child_process");

const PROOF_ROOT =
  process.env.AGENTLAS_CREATIVE_PROOF_DIR ||
  path.join("/Volumes/X31/temp", `agentlas-creative-os-proof-${stampForPath(new Date())}`);
const DB_PATH = path.join(PROOF_ROOT, "agentlas-proof.sqlite");
const SCREENSHOT_DIR = path.join(PROOF_ROOT, "screenshots");
const PORT = Number(process.env.AGENTLAS_CREATIVE_PROOF_PORT || 4337);
const NODE_BIN = process.env.npm_node_execpath || process.env.NODE || "node";

process.env.AGENTLAS_STORE_PATH = DB_PATH;

const { initStore, getDb } = require("../dist/electron/store/db.js");
const { appendChatMessage, createChat, setChatWorkingFolder } = require("../dist/electron/store/chats.js");
const {
  getAgentSurface,
  patchAgentSurfaceState,
  recordAgentSurface,
} = require("../dist/electron/store/agent-surfaces.js");
const {
  approveAgentSurface,
  hasAgentSurfaceApproval,
} = require("../dist/electron/store/agent-surface-approvals.js");
const {
  getSurfaceAssetPackBySurface,
  recordMaterializedSurfaceAssetPack,
} = require("../dist/electron/store/agent-surface-assets.js");
const { recordAgentAppOperation, recordScaffoldedApp } = require("../dist/electron/store/agent-apps.js");
const { parseSurfaces } = require("../dist/electron/surface-emitter.js");
const { prepareCreativeAdPackManifest } = require("../dist/electron/creative-pack/surface.js");
const {
  archiveSurfaceAssetPack,
  materializeSurfaceAssetPack,
  restoreSurfaceAssetPack,
} = require("../dist/electron/surface-assets/materialize.js");
const { scaffoldServiceApp } = require("../dist/electron/app-factory/scaffold.js");
const {
  archiveAppPackage,
  installMcpPlan,
  preparePreviewDeploy,
  prepareProviderBrowserOpen,
  publishAppAsTool,
  resolveProviderCredentials,
  restoreAppPackage,
  runAppFactorySmoke,
  runProviderTasks,
} = require("../dist/electron/app-factory/operations.js");

const productSvg = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900" viewBox="0 0 1200 900">
  <rect width="1200" height="900" fill="#f7f3ee"/>
  <rect x="120" y="100" width="960" height="700" rx="36" fill="#fff" stroke="#dfd8cc"/>
  <path d="M475 220c45 34 205 34 250 0l76 106-74 54v278H473V380l-74-54 76-106Z" fill="#d8c7b4" stroke="#5d5147" stroke-width="12"/>
  <path d="M530 220c20 45 120 45 140 0" fill="none" stroke="#5d5147" stroke-width="12" stroke-linecap="round"/>
  <text x="600" y="720" text-anchor="middle" font-family="Inter, Arial" font-size="58" font-weight="800" fill="#2a2926">Linen Jacket</text>
  <text x="600" y="770" text-anchor="middle" font-family="Inter, Arial" font-size="28" fill="#6f6a62">Agentlas product fixture</text>
</svg>`);
const productImageBase64 = productSvg.toString("base64");

function seedCreativeAgent() {
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
      "agent-creative-proof",
      "creative-proof",
      "Creative OS Proof Agent",
      "Creative OS Proof Agent",
      "Turns product inputs into Agentlas creative surfaces, asset packs, apps, and reusable tools.",
      "Turns product inputs into Agentlas creative surfaces, asset packs, apps, and reusable tools.",
      [
        "Turn product URL/image input into a declarative creative surface, materialized assets, provider delegation, budget gates, launch proof, and reusable tools.",
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

function startProductServer() {
  const server = http.createServer((req, res) => {
    if (req.url === "/products/linen-jacket") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
        <html>
          <head>
            <meta property="og:title" content="Linen Jacket | Sample Atelier" />
            <meta property="og:description" content="A lightweight linen jacket styled for everyday summer city wear." />
            <meta property="og:image" content="/media/linen-jacket.svg" />
            <meta property="og:site_name" content="Sample Atelier" />
          </head>
          <body>Linen Jacket product page fixture</body>
        </html>`);
      return;
    }
    if (req.url === "/media/linen-jacket.svg") {
      res.writeHead(200, {
        "content-type": "image/svg+xml; charset=utf-8",
        "content-length": productSvg.byteLength,
      });
      res.end(productSvg);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

(async () => {
  fs.rmSync(PROOF_ROOT, { recursive: true, force: true });
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const productServer = await startProductServer();
  const address = productServer.address();
  assert.equal(typeof address, "object");
  const productUrl = process.env.AGENTLAS_CREATIVE_PRODUCT_URL || `http://127.0.0.1:${address.port}/products/linen-jacket`;
  const prompt =
    process.env.AGENTLAS_CREATIVE_PROOF_PROMPT ||
    `이 제품 URL과 이미지로 릴스/틱톡/메타 광고팩을 실제 에셋 포함 앱으로 만들어줘: ${productUrl}`;

  try {
    initStore();
    seedCreativeAgent();

    const chat = createChat({ agentId: "agent-creative-proof", title: "Creative Agent OS proof" });
    setChatWorkingFolder(chat.id, PROOF_ROOT);
    appendChatMessage(chat.id, "user", prompt);

    const manifest = await prepareCreativeAdPackManifest({
      prompt,
      images: [{ mediaType: "image/svg+xml", data: productImageBase64 }],
      now: new Date().toISOString(),
    });
    assert.ok(manifest, "product input should produce a creative surface manifest");
    const parsed = parseSurfaces(`<<agentlas-surface>>\n${JSON.stringify(manifest)}\n<</agentlas-surface>>`);
    assert.equal(parsed.errors.length, 0, parsed.errors.join("\n"));
    assert.equal(parsed.surfaces.length, 1);
    assert.equal(manifest.layout, "creative-studio");
    assert.ok(manifest.widgets.some((widget) => widget.type === "model-router"));
    assert.ok(manifest.capabilities.some((capability) => capability.type === "model-generation"));
    assert.ok(manifest.budget?.limit);
    assert.ok(manifest.jobs?.some((job) => job.resumable));

    const surfaceId = "surface-creative-os-proof";
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
      "Created a declarative creative-studio surface with product metadata, storyboard, model routing, budget gates, and export pack.",
    );

    patchAgentSurfaceState({
      surfaceId,
      path: "/data/shots/rows/0/status",
      value: "approved",
      actor: "user",
      label: "approve hook shot",
    });
    const reEmitted = recordAgentSurface({
      id: surfaceId,
      chatId: chat.id,
      projectId: null,
      agentId: chat.agentId,
      manifest,
    });
    assert.equal(reEmitted.state.data?.shots?.rows?.[0]?.status, "approved");
    assert.equal(getAgentSurface(surfaceId)?.state.data?.shots?.rows?.[0]?.status, "approved");

    const scopeKey = `surface-action:${surfaceId}:asset-pack:materialize-asset-pack:asset_pack_filesystem:${manifest.budget.limit}:${manifest.budget.approvalThreshold}:`;
    approveAgentSurface({
      surfaceId,
      actionId: "asset-pack",
      actionType: "materialize-asset-pack",
      kind: "capability",
      scopeKey,
      title: "Materialize creative asset pack",
      summary: "Approve writing a reusable creative asset pack with source labels and budget ledger.",
      metadata: { capabilities: [{ id: "asset_pack_filesystem", type: "filesystem" }] },
    });
    assert.equal(hasAgentSurfaceApproval({ surfaceId, scopeKey }), true);

    const materialized = await materializeSurfaceAssetPack(
      {
        chatId: chat.id,
        surfaceId,
        actionId: "asset-pack",
        manifest,
      },
      { baseDir: PROOF_ROOT, now: new Date().toISOString(), downloadRemoteAssets: true },
    );
    assert.ok(fs.existsSync(materialized.indexPath));
    assert.ok(fs.existsSync(path.join(materialized.rootPath, "assets", "01-product-image-1.svg")));
    const remote = materialized.remoteAssets.find((asset) => asset.id === "product_hero_remote");
    assert.equal(remote?.status, "downloaded");
    assert.ok(remote.downloadedPath);
    assert.ok(fs.existsSync(path.join(materialized.rootPath, remote.downloadedPath)));
    const pack = recordMaterializedSurfaceAssetPack({
      chatId: chat.id,
      projectId: null,
      agentId: chat.agentId,
      surfaceId,
      actionId: "asset-pack",
      manifest,
      snapshot: materialized,
    });
    assert.equal(getSurfaceAssetPackBySurface(chat.id, surfaceId)?.id, pack.id);
    const assetPackArchive = await archiveSurfaceAssetPack({ rootPath: materialized.rootPath });
    assert.equal(assetPackArchive.reversible, true);
    assert.equal(fs.existsSync(materialized.rootPath), false);
    const assetPackRestore = await restoreSurfaceAssetPack({ rootPath: materialized.rootPath });
    assert.equal(assetPackRestore.restored, true);
    assert.ok(fs.existsSync(materialized.rootPath));

    const scaffold = await scaffoldServiceApp(
      {
        chatId: chat.id,
        surfaceId,
        actionId: "scaffold",
        manifest,
      },
      { baseDir: PROOF_ROOT, now: new Date().toISOString() },
    );
    const appRecord = recordScaffoldedApp({
      chatId: chat.id,
      projectId: null,
      agentId: chat.agentId,
      surfaceId,
      actionId: "scaffold",
      manifest,
      scaffold,
    });

    const providerRun = await runProviderTasks({ rootPath: scaffold.rootPath });
    recordAgentAppOperation(appRecord.id, "run-provider-tasks", true, providerRun, "operations-ready");
    assert.ok(providerRun.providerRecipes.some((recipe) => recipe.connectorName === "Adobe Firefly"));
    assert.ok(providerRun.providerRecipes.some((recipe) => recipe.connectorName === "Higgsfield"));
    assert.ok(providerRun.providerRecipes.some((recipe) => recipe.connectorName === "OpenAI Images"));
    assert.ok(providerRun.browserPlans.some((plan) => plan.startUrl === "https://firefly.adobe.com/"));
    assert.ok(providerRun.browserPlans.some((plan) => plan.startUrl === "https://higgsfield.ai/"));
    assert.ok(providerRun.browserPlans.every((plan) => plan.connectorId !== "product-page"));

    const credentialKeys = providerRun.credentialGates.map((gate) => gate.envKey);
    const previousCredentialEnv = Object.fromEntries(credentialKeys.map((key) => [key, process.env[key]]));
    for (const key of credentialKeys) process.env[key] = `proof-${key.toLowerCase()}-${appRecord.id}`;
    const credentialResolution = await resolveProviderCredentials({ rootPath: scaffold.rootPath, source: "env" });
    for (const key of credentialKeys) {
      if (previousCredentialEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousCredentialEnv[key];
    }
    recordAgentAppOperation(appRecord.id, "resolve-provider-credentials", true, credentialResolution, "operations-ready");
    assert.equal(credentialResolution.missingCount, 0);
    assert.ok(credentialResolution.credentials.every((item) => item.fingerprint?.startsWith("sha256:")));

    const mcp = await installMcpPlan({ rootPath: scaffold.rootPath });
    recordAgentAppOperation(appRecord.id, "install-mcp", true, mcp, "mcp-ready");
    const smoke = await runAppFactorySmoke({ rootPath: scaffold.rootPath });
    recordAgentAppOperation(appRecord.id, "run-smoke-test", smoke.ok, smoke, smoke.ok ? "smoke-passed" : "smoke-failed");
    assert.equal(smoke.ok, true, smoke.stderr || smoke.stdout);
    const preview = await preparePreviewDeploy({ rootPath: scaffold.rootPath });
    recordAgentAppOperation(appRecord.id, "deploy-preview", true, preview, "preview-ready");
    const appTool = await publishAppAsTool({ rootPath: scaffold.rootPath });
    recordAgentAppOperation(appRecord.id, "publish-as-tool", true, appTool, "tool-published");
    const toolCall = spawnSync(NODE_BIN, [appTool.mcpPath], {
      input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { arguments: { view: "providers" } } })}\n`,
      cwd: scaffold.rootPath,
      encoding: "utf8",
    });
    assert.equal(toolCall.status, 0, toolCall.stderr || toolCall.stdout);
    assert.match(toolCall.stdout, /Adobe Firefly/);
    assert.match(toolCall.stdout, /Higgsfield/);

    const operations = JSON.parse(fs.readFileSync(path.join(scaffold.rootPath, "data", "operations.json"), "utf8"));
    assert.equal(operations.reuse.status, "published-as-tool");
    assert.equal(operations.reuse.mcpServerId, appTool.server.id);
    assert.ok(operations.trust.budget.limit >= 1);
    assert.ok(operations.trust.jobs.length >= 1);
    assertSecretSafe(scaffold.rootPath);

    const routeFiles = ["/claims", "/exports"].map((route) => {
      const routePart = route.slice(1);
      const file = path.join(scaffold.rootPath, "src", routePart, "index.html");
      const deployFile = path.join(preview.deployPath, routePart, "index.html");
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

    const server = await startPreviewServer(scaffold.rootPath, PORT);
    let screenshots = [];
    try {
      screenshots = await captureScreenshots(PORT, SCREENSHOT_DIR, [
        { name: "studio-app", path: "/" },
        { name: "claims", path: "/claims" },
        { name: "exports", path: "/exports" },
      ]);
      screenshots.push(await captureStandaloneScreenshot("asset-pack", materialized.fileUrl, path.join(SCREENSHOT_DIR, "asset-pack.png")));
    } finally {
      await stopServer(server);
    }

    const archiveResult = await archiveAppPackage({ rootPath: scaffold.rootPath });
    recordAgentAppOperation(appRecord.id, "archive", true, archiveResult, "archived");
    assert.equal(archiveResult.reversible, true);
    assert.equal(fs.existsSync(scaffold.rootPath), false);
    const restoreResult = await restoreAppPackage({ rootPath: scaffold.rootPath });
    recordAgentAppOperation(appRecord.id, "restore", true, restoreResult, "restored");
    assert.equal(restoreResult.restored, true);
    assert.ok(fs.existsSync(scaffold.rootPath));
    assertSecretSafe(scaffold.rootPath);

    const restoredOperations = JSON.parse(fs.readFileSync(path.join(scaffold.rootPath, "data", "operations.json"), "utf8"));
    assert.equal(restoredOperations.lifecycle.status, "restored");
    assert.equal(restoredOperations.lifecycle.reversible, true);

    const report = {
      proofVersion: "0.1",
      prompt,
      productUrl,
      proofRoot: PROOF_ROOT,
      dbPath: DB_PATH,
      createdAt: new Date().toISOString(),
      chat: { id: chat.id },
      surface: {
        id: surfaceId,
        title: manifest.title,
        layout: manifest.layout,
        jobCount: manifest.jobs?.length ?? 0,
        budget: manifest.budget,
        userStatePreserved: reEmitted.state.data?.shots?.rows?.[0]?.status === "approved",
      },
      assetPack: {
        registryId: pack.id,
        rootPath: materialized.rootPath,
        indexPath: materialized.indexPath,
        fileUrl: materialized.fileUrl,
        localAssetCount: materialized.files.filter((file) => file.kind === "media").length,
        remoteAssets: materialized.remoteAssets,
        lifecycle: {
          archivePath: assetPackArchive.archivePath,
          restoreSummary: assetPackRestore.summary,
          reversible: assetPackArchive.reversible,
          restored: assetPackRestore.restored,
        },
      },
      app: {
        registryId: appRecord.id,
        rootPath: scaffold.rootPath,
        previewPath: scaffold.previewPath,
        deployPath: preview.deployPath,
        routes: routeFiles,
        reusableTool: {
          toolName: appTool.toolName,
          toolDir: appTool.toolDir,
          configPath: appTool.configPath,
          mcpPath: appTool.mcpPath,
          mcpServerId: appTool.server.id,
          summary: appTool.summary,
        },
      },
      providerDelegation: {
        browserStarts: providerRun.browserPlans,
        credentialResolution: credentialResolution.credentials,
        credentialResolutionPath: credentialResolution.resolutionPath,
        providerRecipes: providerRun.providerRecipes,
        providerRecipesPath: providerRun.recipesPath,
        runbookPath: providerRun.runbookPath,
      },
      lifecycle: {
        archivePath: archiveResult.archivePath,
        restoreSummary: restoreResult.summary,
        reversible: archiveResult.reversible,
        statusAfterRestore: restoredOperations.lifecycle.status,
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
      checks: [
        "product URL/image produced a declarative creative-studio surface",
        "surface manifest passed trust validation without renderer code execution",
        "user-owned shot approval survived surface re-emit",
        "asset pack materialized inline and remote product images with provenance",
        "asset pack archive is reversible and restore was verified",
        "budget and resumable generation job were declared before media generation",
        "OpenAI Images, Adobe Firefly, and Higgsfield provider routes were compiled into browser/action recipes",
        "provider credentials resolved to fingerprints only",
        "generated creative app scaffolded routes and provider ledgers",
        "generated creative app published as a reusable MCP tool for later agents",
        "generated creative app archive is reversible and restore was verified",
        "promotional screenshots were saved under /Volumes/X31/temp",
        "secret/card/token leak scan found no raw secret values",
      ],
    };

    fs.writeFileSync(path.join(PROOF_ROOT, "proof-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    fs.writeFileSync(path.join(PROOF_ROOT, "PROOF.md"), proofMarkdown(report), "utf8");
    removeAppleDoubleFiles(PROOF_ROOT);
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  } finally {
    await new Promise((resolve) => productServer.close(resolve));
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

async function captureScreenshots(port, screenshotDir, routes) {
  const { chromium } = require("playwright");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
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

async function captureStandaloneScreenshot(name, url, screenshotPath) {
  const { chromium } = require("playwright");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  try {
    await page.goto(url, { waitUntil: "networkidle" });
    await page.screenshot({ path: screenshotPath, fullPage: true });
    return { name, route: null, url, title: await page.title(), routePath: null, path: screenshotPath };
  } finally {
    await browser.close();
  }
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
      for (const name of fs.readdirSync(current)) {
        stack.push(path.join(current, name));
      }
    } else {
      out.push(current);
    }
  }
  return out;
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

function proofMarkdown(report) {
  return [
    "# Agentlas Creative OS Proof",
    "",
    `Prompt: ${report.prompt}`,
    `Product URL: ${report.productUrl}`,
    `Created: ${report.createdAt}`,
    `Proof root: \`${report.proofRoot}\``,
    "",
    "## Result",
    "",
    "- Product URL/image created a declarative creative-studio surface.",
    "- Asset pack materialized local and remote product imagery with trust metadata.",
    "- Generated app contains Studio, Claims, and Exports routes.",
    "- OpenAI Images, Adobe Firefly, and Higgsfield provider paths are represented as resumable Agentlas OS recipes.",
    "- Generated creative app was published as a reusable MCP tool for later agents.",
    "- Smoke, preview, archive, restore, and secret-safety checks passed.",
    "",
    "## Screenshots",
    "",
    ...report.screenshots.map((shot) => `- ${shot.name}: \`${shot.path}\``),
    "",
    "## Asset Pack",
    "",
    `- Root: \`${report.assetPack.rootPath}\``,
    `- Preview: \`${report.assetPack.indexPath}\``,
    `- Local media files: ${report.assetPack.localAssetCount}`,
    "",
    "## Reusable App Tool",
    "",
    `- Tool: ${report.app.reusableTool.toolName}`,
    `- MCP server id: \`${report.app.reusableTool.mcpServerId}\``,
    `- MCP adapter: \`${report.app.reusableTool.mcpPath}\``,
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
