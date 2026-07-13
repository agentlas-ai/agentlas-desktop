#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist", "renderer");
const outDir = process.env.AGENTLAS_PROVIDER_HEALTH_QA_OUT
  ? path.resolve(process.env.AGENTLAS_PROVIDER_HEALTH_QA_OUT)
  : path.join(root, "output", "playwright", "provider-health");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
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
      const status = file.endsWith("404.html") ? 404 : 200;
      res.writeHead(status, {
        "content-type": MIME[path.extname(file)] || "application/octet-stream",
      });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function setupProviderHealthBridge(payload) {
  const setupBase = (0, eval)(`(${payload.setupSource})`);
  setupBase(payload.baseOptions);

  const calls = [];
  window.__providerHealthQA = { calls };
  window.agentlas.app.getLocale = async () => "ko-KR";
  window.agentlas.runtime.detect = async () => [
    {
      kind: "codex",
      backend: "openai",
      source: "/usr/local/bin/codex",
      version: "mock",
      active: true,
      model: "gpt-5.1-codex",
    },
    {
      kind: "gemini",
      backend: "google",
      source: "/fixture/bin/agy",
      version: "1.1.1",
      active: false,
    },
    {
      kind: "grok",
      backend: "xai",
      source: "/fixture/bin/grok",
      version: "0.2.93",
      active: false,
    },
  ];
  window.agentlas.usage.snapshot = async () => ({
    fetchedAt: Date.now(),
    providers: [
      {
        provider: "codex",
        backend: "oauth",
        label: "Codex",
        status: "ok",
        windows: [
          { id: "codex-5h", kind: "5h", label: "5-hour", usedPercent: 12, resetAt: null },
        ],
      },
      {
        provider: "gemini",
        backend: "oauth",
        label: "Gemini",
        status: "error",
        error: "unsupported_client",
        windows: [],
      },
      {
        provider: "grok",
        backend: "custom",
        label: "Grok",
        status: "error",
        error: "quota_exhausted",
        windows: [
          {
            id: "grok-weekly-exhausted",
            kind: "7d",
            label: "Grok Build",
            usedPercent: 100,
            resetAt: null,
          },
        ],
      },
    ],
  });
  window.agentlas.fs.openPath = async (target) => {
    calls.push({ name: "fs.openPath", target });
    return { ok: true };
  };
}

function watchPage(page, errors) {
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console.error: ${message.text()}`);
  });
}

async function inspectViewport(page, viewport, screenshotName) {
  await page.setViewportSize(viewport);
  await page.goto(page.url().replace(/\/dashboard\.html.*$/, "/dashboard.html"), {
    waitUntil: "domcontentloaded",
  });

  const panel = page.locator('[data-tour-id="dashboard.llm"]');
  await panel.getByText("LLM 연결 · 사용량", { exact: true }).waitFor({ timeout: 12_000 });

  const geminiRow = panel.locator(".dashboard-engine-row").filter({ hasText: "Gemini" });
  const grokRow = panel.locator(".dashboard-engine-row").filter({ hasText: "Grok" });
  await geminiRow.getByText(
    "Antigravity 작동 · 사용량 미제공",
    { exact: true },
  ).waitFor();
  await grokRow.getByText(
    "한도 소진(402) · Usage 확인",
    { exact: true },
  ).waitFor();

  await geminiRow.getByRole("button", { name: "Antigravity", exact: true }).waitFor();
  await grokRow.getByRole("button", { name: "Usage 열기", exact: true }).waitFor();

  assert.equal(
    await geminiRow.getByRole("button", { name: /다시 시도|재로그인/ }).count(),
    0,
    "Gemini unsupported-client row must not show generic retry/re-login",
  );
  assert.equal(
    await grokRow.getByRole("button", { name: /다시 시도|재로그인/ }).count(),
    0,
    "Grok exhausted row must not show generic retry/re-login",
  );

  const grokBar = grokRow.locator(".dashboard-usage-bar");
  await grokBar.getByText("100%", { exact: true }).waitFor();
  assert.equal(await grokBar.getByText("주간(7일)", { exact: true }).count(), 1);
  assert.equal(
    await grokBar.locator('span[data-warn="true"]').textContent(),
    "100%",
    "Grok exhausted bar must use warning state",
  );
  assert.equal(
    await grokBar.locator(":scope > div > div").evaluate((node) => node.style.width),
    "100%",
    "Grok exhausted bar fill must be exactly 100%",
  );

  const fit = await page.evaluate(() => {
    const panelNode = document.querySelector('[data-tour-id="dashboard.llm"]');
    const rows = Array.from(panelNode?.querySelectorAll(".dashboard-engine-row") || []);
    const requiredRows = rows.filter((row) => /Gemini|Grok/.test(row.textContent || ""));
    const root = document.documentElement;
    const panelRect = panelNode?.getBoundingClientRect();
    const rowMetrics = requiredRows.map((row) => {
      const rect = row.getBoundingClientRect();
      const status = row.querySelector(".dashboard-engine-copy > div:last-child");
      return {
        text: (row.textContent || "").replace(/\s+/g, " ").trim(),
        left: rect.left,
        right: rect.right,
        width: rect.width,
        scrollWidth: row.scrollWidth,
        clientWidth: row.clientWidth,
        status: status
          ? {
              text: (status.textContent || "").trim(),
              scrollWidth: status.scrollWidth,
              clientWidth: status.clientWidth,
              clipped: status.scrollWidth > status.clientWidth + 1,
            }
          : null,
      };
    });
    return {
      innerWidth: window.innerWidth,
      clientWidth: root.clientWidth,
      scrollWidth: root.scrollWidth,
      horizontalPageOverflow: root.scrollWidth > root.clientWidth,
      panel: panelRect
        ? { left: panelRect.left, right: panelRect.right, width: panelRect.width }
        : null,
      rowMetrics,
      clippedRows: rowMetrics.filter((row) => (
        !panelRect
        || row.left < panelRect.left - 1
        || row.right > panelRect.right + 1
        || row.scrollWidth > row.clientWidth + 1
      )),
      clippedStatuses: rowMetrics
        .filter((row) => row.status?.clipped)
        .map((row) => row.status),
    };
  });

  assert.equal(fit.horizontalPageOverflow, false, `page must not overflow horizontally at ${viewport.width}px`);
  assert.ok(fit.panel && fit.panel.left >= 0 && fit.panel.right <= viewport.width + 1);
  assert.deepEqual(fit.clippedRows, [], `provider rows must not clip or overflow at ${viewport.width}px`);

  await panel.screenshot({ path: path.join(outDir, screenshotName) });
  return fit;
}

async function main() {
  if (!fs.existsSync(path.join(distDir, "dashboard.html"))) {
    throw new Error("dist/renderer/dashboard.html is missing; this QA does not rebuild production assets");
  }

  const { chromium } = require("playwright");
  const { setupMockAgentlasBridge, mockBridgeOptions } = require("./lib/mock-agentlas-bridge.cjs");
  const setupSource = setupMockAgentlasBridge.toString();

  fs.mkdirSync(outDir, { recursive: true });
  const { server, baseUrl } = await startServer();
  const browser = await chromium.launch();
  const errors = [];

  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    await context.addInitScript(setupProviderHealthBridge, {
      setupSource,
      baseOptions: mockBridgeOptions({ teamRoster: true }),
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    watchPage(page, errors);
    await page.goto(`${baseUrl}/dashboard.html`, { waitUntil: "domcontentloaded" });

    const desktopFit = await inspectViewport(
      page,
      { width: 1440, height: 1100 },
      "04-provider-health-desktop-post-fix-1440x1100.png",
    );

    const panel = page.locator('[data-tour-id="dashboard.llm"]');
    await panel.locator(".dashboard-engine-row").filter({ hasText: "Gemini" })
      .getByRole("button", { name: "Antigravity", exact: true }).click();
    await panel.locator(".dashboard-engine-row").filter({ hasText: "Grok" })
      .getByRole("button", { name: "Usage 열기", exact: true }).click();
    assert.deepEqual(
      await page.evaluate(() => window.__providerHealthQA.calls),
      [
        { name: "fs.openPath", target: "https://antigravity.google" },
        { name: "fs.openPath", target: "https://grok.com" },
      ],
      "provider actions must open the intended official surfaces",
    );

    const compactFit = await inspectViewport(
      page,
      { width: 960, height: 1100 },
      "05-provider-health-compact-post-fix-960x1100.png",
    );
    await page.screenshot({
      path: path.join(outDir, "06-dashboard-compact-full-post-fix-960x1100.png"),
      fullPage: true,
    });

    const issues = [];
    if (desktopFit.clippedStatuses.length > 0) {
      issues.push(`1440px: ${desktopFit.clippedStatuses.length} provider status labels are visually truncated`);
    }
    if (compactFit.clippedStatuses.length > 0) {
      issues.push(`960px: ${compactFit.clippedStatuses.length} provider status labels are visually truncated`);
    }
    if (errors.length > 0) issues.push(`${errors.length} console/page errors`);
    const report = {
      result: issues.length === 0 ? "PASS" : "FAIL",
      builtDashboard: path.join(distDir, "dashboard.html"),
      viewports: {
        desktop: desktopFit,
        compact: compactFit,
      },
      labels: {
        gemini: "Antigravity 작동 · 사용량 미제공",
        grok: "한도 소진(402) · Usage 확인",
      },
      actions: {
        gemini: "https://antigravity.google",
        grok: "https://grok.com",
      },
      errors,
      issues,
      screenshots: [
        "04-provider-health-desktop-post-fix-1440x1100.png",
        "05-provider-health-compact-post-fix-960x1100.png",
        "06-dashboard-compact-full-post-fix-960x1100.png",
      ],
    };
    fs.writeFileSync(path.join(outDir, "qa-report-post-fix.json"), `${JSON.stringify(report, null, 2)}\n`);
    if (issues.length > 0) {
      throw new Error(`provider-health visual QA failed: ${issues.join("; ")}`);
    }
    console.log(`qa-provider-health-dashboard: PASS (${outDir})`);
  } finally {
    await browser.close().catch(() => undefined);
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
