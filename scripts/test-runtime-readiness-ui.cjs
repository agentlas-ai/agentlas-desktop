#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist", "renderer");
const outDir = path.join(root, "output", "playwright", "runtime-readiness");
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function resolveAsset(urlPath) {
  let pathname = decodeURIComponent((urlPath || "/").split("?")[0]);
  const nestedNext = pathname.match(/^\/.+\/(_next\/.+)$/);
  if (nestedNext) pathname = `/${nestedNext[1]}`;
  if (pathname === "/") pathname = "/index.html";
  const direct = path.join(distDir, pathname);
  if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;
  if (!path.extname(pathname)) {
    const html = path.join(distDir, `${pathname}.html`);
    if (fs.existsSync(html)) return html;
  }
  return path.join(distDir, "404.html");
}

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const file = resolveAsset(req.url);
      res.writeHead(file.endsWith("404.html") ? 404 : 200, {
        "content-type": mime[path.extname(file)] || "application/octet-stream",
      });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function setupReadinessBridge(payload) {
  const setupBase = (0, eval)(`(${payload.setupSource})`);
  setupBase(payload.baseOptions);
  const calls = [];
  const scenario = payload.scenario;
  let authReads = 0;
  window.__runtimeReadiness = { calls };
  window.agentlas.app.getVersion = async () => "0.7.33";
  window.agentlas.auth.getSession = async () => {
    authReads += 1;
    if (scenario === "ready" || authReads === 1) {
      return { signedIn: true, email: "owner@example.com", workspaceId: "workspace-1" };
    }
    // AuthGate admits the shell with the first session read. A later expired
    // session must degrade only the account row instead of hiding the panel.
    return { signedIn: false };
  };
  window.agentlas.runtime.detect = async () => [
    { kind: "codex", backend: "openai", source: "/usr/local/bin/codex", version: "1.2.3", active: true },
  ];
  window.agentlas.hephaestus.status = async () => scenario === "ready"
    ? { available: true, root: "/mock/agentlas-os", python: "/usr/bin/python3", version: "1.1.12" }
    : { available: false, root: null, python: null, version: null, reason: "engine unavailable" };
  window.agentlas.hephaestus.doctor = async () => {
    calls.push("doctor");
    return { ok: scenario === "ready", exitCode: scenario === "ready" ? 0 : 1, json: {}, stdout: "", stderr: "" };
  };
  window.agentlas.marketplace.status = async () => scenario === "ready"
    ? { mode: "mcp", baseUrl: "mock://hub", online: true, usingFallback: false, lastError: null, lastCheckedAt: new Date().toISOString() }
    : { mode: "mcp", baseUrl: "mock://hub", online: false, usingFallback: false, lastError: "offline", lastCheckedAt: new Date().toISOString() };
  window.agentlas.mcpTools.listInstalled = async () => scenario === "ready"
    ? [{ id: "mcp-1", catalogId: "browser", name: "Browser", nameEn: "Browser", transport: "stdio", command: "node", args: [], url: null, envKeys: [], enabled: true, installedAt: new Date().toISOString() }]
    : [{ id: "mcp-1", catalogId: "browser", name: "Browser", nameEn: "Browser", transport: "stdio", command: "node", args: [], url: null, envKeys: [], enabled: true, installedAt: new Date().toISOString() }];
  window.agentlas.mcpTools.status = async () => scenario === "ready"
    ? [{ id: "mcp-1", connected: true, tools: [{ name: "browser" }], error: null, missingEnv: [], checkedAt: new Date().toISOString() }]
    : [{ id: "mcp-1", connected: false, tools: [], error: "credential missing", missingEnv: ["BROWSER_TOKEN"], checkedAt: new Date().toISOString() }];
  const updateState = scenario === "ready"
    ? { status: "not-available", lastCheckedAt: Date.now() }
    : { status: "recovery-required", version: "0.7.33", code: "continuity-violation", recoveryBackupAvailable: true, error: "recovery check needed" };
  window.agentlas.updater.getState = async () => updateState;
  window.agentlas.updater.check = async () => {
    calls.push("updater.check");
    return updateState;
  };
}

async function newScenario(browser, setupSource, scenario) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  await context.addInitScript(setupReadinessBridge, {
    setupSource,
    baseOptions: { teamRoster: true },
    scenario,
  });
  return context;
}

async function main() {
  if (!fs.existsSync(path.join(distDir, "dashboard.html"))) {
    throw new Error("dist/renderer is missing; run npm run build:renderer first");
  }
  const { chromium } = require("playwright");
  const { setupMockAgentlasBridge } = require("./lib/mock-agentlas-bridge.cjs");
  const setupSource = setupMockAgentlasBridge.toString();
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const { server, baseUrl } = await startServer();
  const browser = await chromium.launch();
  const errors = [];
  const watch = (page) => {
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" && !/favicon|Failed to load resource/i.test(message.text())) errors.push(message.text());
    });
  };
  try {
    const readyContext = await newScenario(browser, setupSource, "ready");
    const readyPage = await readyContext.newPage();
    readyPage.setDefaultTimeout(8000);
    watch(readyPage);
    await readyPage.goto(`${baseUrl}/dashboard.html`, { waitUntil: "domcontentloaded" });
    const llmPanel = readyPage.locator('[data-tour-id="dashboard.llm"]');
    await llmPanel.getByText(/전역 오케스트레이터 모델|Global orchestrator model/).waitFor({ timeout: 10000 });
    assert.match(
      await llmPanel.locator("select").first().locator("option:checked").textContent(),
      /Codex/,
      "the detected LLM runtime must be visible in the primary control",
    );
    const readyPanel = readyPage.locator(".dashboard-readiness");
    await readyPanel.locator('[data-readiness-overall="ready"]').waitFor({ timeout: 10000 });
    assert.equal(
      await readyPage.evaluate(() => {
        const llm = document.querySelector('[data-tour-id="dashboard.llm"]');
        const readiness = document.querySelector('[data-tour-id="dashboard.readiness"]');
        if (!llm || !readiness) return false;
        return Boolean(llm.compareDocumentPosition(readiness) & Node.DOCUMENT_POSITION_FOLLOWING);
      }),
      true,
      "the primary LLM connection control must appear before the diagnostic readiness panel",
    );
    const llmBox = await llmPanel.boundingBox();
    assert.ok(llmBox && llmBox.y < 1100, "the LLM connection control must be visible in the initial desktop viewport");
    assert.equal(await readyPanel.locator("[data-readiness-id]").count(), 6);
    assert.equal(await readyPanel.locator('[data-readiness-status="blocked"]').count(), 0);
    await readyPanel.getByRole("button", { name: /런타임 전체 다시 확인|Run all readiness checks again/ }).click();
    await readyPage.waitForFunction(() => window.__runtimeReadiness.calls.includes("doctor") && window.__runtimeReadiness.calls.includes("updater.check"));
    await readyPanel.getByText(/자가진단 통과|Self-check passed/).waitFor();
    await readyPage.screenshot({ path: path.join(outDir, "ready.png"), fullPage: true });
    await readyContext.close();

    const blockedContext = await newScenario(browser, setupSource, "blocked");
    const blockedPage = await blockedContext.newPage();
    blockedPage.setDefaultTimeout(8000);
    watch(blockedPage);
    await blockedPage.goto(`${baseUrl}/dashboard.html`, { waitUntil: "domcontentloaded" });
    const blockedPanel = blockedPage.locator(".dashboard-readiness");
    try {
      await blockedPanel.locator('[data-readiness-overall="blocked"]').waitFor({ timeout: 10000 });
    } catch (error) {
      const diagnostics = await blockedPanel.evaluate((panel) => ({
        text: panel.textContent,
        overall: panel.querySelector("[data-readiness-overall]")?.getAttribute("data-readiness-overall"),
        rows: Array.from(panel.querySelectorAll("[data-readiness-id]")).map((row) => ({
          id: row.getAttribute("data-readiness-id"),
          status: row.getAttribute("data-readiness-status"),
        })),
      })).catch(() => null);
      console.error("blocked readiness diagnostics", JSON.stringify(diagnostics));
      throw error;
    }
    for (const id of ["agentlas-os", "update"]) {
      await blockedPanel.locator(`[data-readiness-id="${id}"][data-readiness-status="blocked"]`).waitFor();
    }
    await blockedPanel.locator('[data-readiness-id="runtime"][data-readiness-status="ready"]').waitFor();
    for (const id of ["account", "hub", "plugins"]) {
      await blockedPanel.locator(`[data-readiness-id="${id}"][data-readiness-status="attention"]`).waitFor();
    }
    await blockedPanel.getByText(/정상인 로컬 자산과 파일은 변경하지 않습니다|do not modify healthy local assets or files/).waitFor();
    await blockedPage.screenshot({ path: path.join(outDir, "blocked.png"), fullPage: true });
    await blockedContext.close();

    assert.deepEqual(errors, [], "runtime readiness UI must not emit renderer errors");
    console.log(`test-runtime-readiness-ui: PASS (${outDir})`);
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
