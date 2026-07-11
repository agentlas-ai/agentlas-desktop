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
  const healthy = scenario !== "blocked";
  let authReads = 0;
  window.__runtimeReadiness = { calls };
  window.agentlas.app.getVersion = async () => "0.7.33";
  window.agentlas.auth.getSession = async () => {
    authReads += 1;
    if (healthy || authReads === 1) {
      return { signedIn: true, email: "owner@example.com", workspaceId: "workspace-1" };
    }
    // AuthGate admits the shell with the first session read. A later expired
    // session must degrade only the account row instead of hiding the panel.
    return { signedIn: false };
  };
  window.agentlas.runtime.detect = async (force) => {
    calls.push(`runtime.detect:${force === true}`);
    return [
      { kind: "codex", backend: "openai", source: "/usr/local/bin/codex", version: "1.2.3", active: true },
    ];
  };
  window.agentlas.hephaestus.status = async () => healthy
    ? { available: true, root: "/mock/agentlas-os", python: "/usr/bin/python3", version: "1.1.14", pythonVersion: "3.14.2" }
    : { available: false, root: null, python: null, version: null, pythonVersion: null, reason: "engine unavailable" };
  window.agentlas.hephaestus.doctor = async () => {
    calls.push("doctor");
    return { ok: healthy, exitCode: healthy ? 0 : 1, json: {}, stdout: "", stderr: "" };
  };
  window.agentlas.marketplace.status = async (force) => {
    calls.push(`marketplace.status:${force === true}`);
    return healthy
      ? scenario === "partial"
        ? { mode: "mcp", baseUrl: "mock://hub", online: true, usingFallback: false, lastError: "plugins unavailable", lastCheckedAt: new Date().toISOString() }
        : { mode: "mcp", baseUrl: "mock://hub", online: true, usingFallback: false, lastError: null, lastCheckedAt: new Date().toISOString() }
      : { mode: "mcp", baseUrl: "mock://hub", online: false, usingFallback: false, lastError: "offline", lastCheckedAt: new Date().toISOString() };
  };
  window.agentlas.mcpTools.listInstalled = async () => healthy
    ? [{ id: "mcp-1", catalogId: "browser", name: "Browser", nameEn: "Browser", transport: "stdio", command: "node", args: [], url: null, envKeys: [], enabled: true, installedAt: new Date().toISOString() }]
    : [{ id: "mcp-1", catalogId: "browser", name: "Browser", nameEn: "Browser", transport: "stdio", command: "node", args: [], url: null, envKeys: [], enabled: true, installedAt: new Date().toISOString() }];
  window.agentlas.mcpTools.status = async () => healthy
    ? [{ id: "mcp-1", connected: true, tools: [{ name: "browser" }], error: null, missingEnv: [], checkedAt: new Date().toISOString() }]
    : [{ id: "mcp-1", connected: false, tools: [], error: "credential missing", missingEnv: ["BROWSER_TOKEN"], checkedAt: new Date().toISOString() }];
  const updateState = healthy
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
  await context.addInitScript(() => {
    // Old releases persisted this bit. The current dashboard must ignore it so
    // connection actions cannot disappear after an update.
    window.localStorage.setItem("agentlas.dash.usageCollapsed", "1");
  });
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
    await readyPanel.locator('[data-readiness-id="agentlas-os"]').getByText(/v1\.1\.14/).waitFor();
    assert.equal(
      await readyPanel.locator('[data-readiness-id="agentlas-os"]').getByText(/v3\.14\.2/).count(),
      0,
      "Python interpreter version must not be presented as the Agentlas OS version",
    );
    assert.equal(
      await readyPage.evaluate(() => {
        const llm = document.querySelector('[data-tour-id="dashboard.llm"]');
        const approvals = document.querySelector('[data-tour-id="dashboard.approvals"]');
        const readiness = document.querySelector('[data-tour-id="dashboard.readiness"]');
        if (!llm || !approvals || !readiness) return false;
        return (
          Boolean(llm.compareDocumentPosition(approvals) & Node.DOCUMENT_POSITION_FOLLOWING)
          && Boolean(llm.compareDocumentPosition(readiness) & Node.DOCUMENT_POSITION_FOLLOWING)
        );
      }),
      true,
      "the primary LLM connection control must appear before approvals and diagnostics",
    );
    await llmPanel.getByText(/LLM 연결 · 사용량|LLM connections · usage/).waitFor();
    assert.equal(
      await llmPanel.locator('[data-dashboard-chevron]').count(),
      0,
      "LLM connection actions must not disappear behind persisted collapse state",
    );
    await llmPanel.getByRole("button", { name: /연결|Connect/ }).first().waitFor();
    const llmBox = await llmPanel.boundingBox();
    assert.ok(llmBox && llmBox.y < 1100, "the LLM connection control must be visible in the initial desktop viewport");
    await readyPage.screenshot({ path: path.join(outDir, "desktop-first-view.png") });

    await readyPage.setViewportSize({ width: 960, height: 640 });
    await readyPage.waitForFunction(() => window.innerWidth === 960);
    const compactLlmBox = await llmPanel.boundingBox();
    const compactOrgBox = await readyPage.locator('[data-tour-id="dashboard.org"]').boundingBox();
    const compactConnectBox = await llmPanel.getByRole("button", { name: /연결|Connect/ }).first().boundingBox();
    assert.ok(
      compactLlmBox && compactOrgBox && compactConnectBox
        && compactLlmBox.y < compactOrgBox.y
        && compactConnectBox.y + compactConnectBox.height <= 640,
      "LLM connection actions must stay above the organization tree and inside the initial compact viewport",
    );
    await readyPage.screenshot({ path: path.join(outDir, "compact-first-view.png") });
    assert.equal(await readyPanel.locator("[data-readiness-id]").count(), 6);
    assert.equal(await readyPanel.locator('[data-readiness-status="blocked"]').count(), 0);
    await readyPanel.getByRole("button", { name: /런타임 전체 다시 확인|Run all readiness checks again/ }).click();
    await readyPage.waitForFunction(() => (
      window.__runtimeReadiness.calls.includes("doctor")
      && window.__runtimeReadiness.calls.includes("updater.check")
      && window.__runtimeReadiness.calls.includes("runtime.detect:true")
      && window.__runtimeReadiness.calls.includes("marketplace.status:true")
    ));
    await readyPanel.getByText(/자가진단 통과|Self-check passed/).waitFor();
    await readyPage.screenshot({ path: path.join(outDir, "ready.png"), fullPage: true });
    await readyContext.close();

    const partialContext = await newScenario(browser, setupSource, "partial");
    const partialPage = await partialContext.newPage();
    partialPage.setDefaultTimeout(8000);
    watch(partialPage);
    await partialPage.goto(`${baseUrl}/dashboard.html`, { waitUntil: "domcontentloaded" });
    const partialPanel = partialPage.locator(".dashboard-readiness");
    await partialPanel.locator('[data-readiness-overall="attention"]').waitFor({ timeout: 10000 });
    await partialPanel.locator('[data-readiness-id="hub"][data-readiness-status="attention"]').waitFor();
    await partialPanel.getByText(/Hub 카탈로그 일부만 확인됐습니다|Only part of the Hub catalog was verified/).waitFor();
    await partialPage.screenshot({ path: path.join(outDir, "partial.png"), fullPage: true });
    await partialContext.close();

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
