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
const distRoot = path.resolve(distDir);
const notFoundAsset = path.join(distRoot, "404.html");

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
  let pathname;
  try {
    pathname = decodeURIComponent((urlPath || "/").split("?")[0]);
  } catch {
    return notFoundAsset;
  }
  const nestedNext = pathname.match(/^\/.+\/(_next\/.+)$/);
  if (nestedNext) pathname = `/${nestedNext[1]}`;
  if (pathname === "/") pathname = "/index.html";
  const withinDist = (candidate) => candidate.startsWith(`${distRoot}${path.sep}`);
  const safeExistingFile = (candidate) => {
    if (!withinDist(candidate) || !fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) return null;
    try {
      const realRoot = fs.realpathSync(distRoot);
      const realCandidate = fs.realpathSync(candidate);
      if (realCandidate !== realRoot && !realCandidate.startsWith(`${realRoot}${path.sep}`)) return null;
    } catch {
      return null;
    }
    return candidate;
  };
  const direct = path.resolve(distRoot, pathname.replace(/^[/\\]+/, ""));
  const directFile = safeExistingFile(direct);
  if (directFile) return directFile;
  if (!path.extname(pathname)) {
    const html = path.resolve(distRoot, `${pathname.replace(/^[/\\]+/, "")}.html`);
    const htmlFile = safeExistingFile(html);
    if (htmlFile) return htmlFile;
  }
  return notFoundAsset;
}

function verifyStaticServerBoundary() {
  const traversal = `/${Array.from({ length: 12 }, () => "%2e%2e").join("/")}/etc/passwd`;
  assert.equal(resolveAsset(traversal), notFoundAsset, "encoded traversal must never escape dist/renderer");
  assert.equal(resolveAsset("/%E0%A4%A"), notFoundAsset, "malformed URL encoding must fail closed");
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
  const runtimes = [
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
  ].filter((runtime) => !(payload.excludeRuntimeKinds || []).includes(runtime.kind));
  window.__providerHealthQA = {
    calls,
    usageCalls: 0,
    failUsageSnapshots: 0,
    snapshotPlans: [],
    runtimes,
    codexError: payload.codexError === true,
  };
  window.agentlas.app.getLocale = async () => payload.locale || "ko-KR";
  window.agentlas.runtime.detect = async () => window.__providerHealthQA.runtimes.map((runtime) => ({ ...runtime }));
  window.agentlas.usage.snapshot = async () => {
    window.__providerHealthQA.usageCalls += 1;
    const plan = window.__providerHealthQA.snapshotPlans.shift() || {};
    if (plan.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, plan.delayMs));
    if (plan.fail) throw new Error("fixture planned usage snapshot IPC failure");
    if (window.__providerHealthQA.failUsageSnapshots > 0) {
      window.__providerHealthQA.failUsageSnapshots -= 1;
      throw new Error("fixture usage snapshot IPC failure");
    }
    return {
      fetchedAt: Date.now(),
      providers: [
        window.__providerHealthQA.codexError
          ? {
              provider: "codex",
              backend: "oauth",
              label: "Codex",
              status: "error",
              error: "provider_error",
              windows: [],
            }
          : {
              provider: "codex",
              backend: "oauth",
              label: "Codex",
              status: "ok",
              windows: [
                { id: "codex-5h", kind: "5h", label: "5-hour", usedPercent: plan.codexUsedPercent ?? 12, resetAt: null },
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
          windows: [],
        },
      ],
    };
  };
  window.agentlas.usage.retry = async (providerId) => {
    calls.push({ name: "usage.retry", providerId });
    if (providerId === "codex") window.__providerHealthQA.codexError = false;
    return {
      snapshot: await window.agentlas.usage.snapshot(),
      attempted: true,
      retryAfterMs: 10_000,
    };
  };
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

function forceLocale(context, locale) {
  return context.addInitScript((value) => {
    window.localStorage.setItem("agentlas.locale", value);
  }, locale);
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

  assert.equal(
    await grokRow.locator(".dashboard-usage-bar").count(),
    0,
    "Grok 402 receipt must remain status-only without an invented percentage/window",
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

async function verifyUsageSnapshotRecovery(page, options) {
  const panel = page.locator('[data-tour-id="dashboard.llm"]');
  await panel.getByText(options.heading, { exact: true }).waitFor();

  const before = await page.evaluate(() => window.__providerHealthQA.usageCalls);
  await page.evaluate(() => {
    window.__providerHealthQA.failUsageSnapshots = 1;
  });
  await panel.locator(".dashboard-refresh-button").click();

  const alert = panel.getByRole("alert").filter({ hasText: options.failure });
  await alert.waitFor();
  const retry = alert.getByRole("button", { name: options.retry, exact: true });
  assert.equal(await retry.count(), 1, `${options.locale}: usage failure must expose one accessible retry action`);
  assert.equal(
    (await alert.textContent()).replace(/\s+/g, " ").trim(),
    `${options.failure}·${options.retry}`,
    `${options.locale}: usage failure copy must remain explicit and compact`,
  );

  // Snapshot IPC failure must not erase or rewrite the last provider-specific receipts.
  if (options.locale === "ko") {
    await panel.getByText("Antigravity 작동 · 사용량 미제공", { exact: true }).waitFor();
    await panel.getByText("한도 소진(402) · Usage 확인", { exact: true }).waitFor();
  } else {
    await panel.getByText("Antigravity active · usage n/a", { exact: true }).waitFor();
    await panel.getByText("quota exhausted (402) · open usage", { exact: true }).waitFor();
  }

  if (options.screenshotName) {
    await panel.locator(".dashboard-engine-usage").first().screenshot({
      path: path.join(outDir, options.screenshotName),
    });
  }

  await retry.click();
  await alert.waitFor({ state: "detached" });
  const after = await page.evaluate(() => window.__providerHealthQA.usageCalls);
  assert.ok(after >= before + 2, `${options.locale}: retry must issue a fresh usage snapshot call`);
  return { before, after, recovered: true };
}

async function verifyUsageSnapshotOrdering(page) {
  const panel = page.locator('[data-tour-id="dashboard.llm"]');
  const refresh = panel.locator(".dashboard-refresh-button");

  // A stale failure that finishes after a newer success must not resurrect the global error banner.
  await page.evaluate(() => {
    window.__providerHealthQA.snapshotPlans.push(
      { delayMs: 140, fail: true },
      { delayMs: 5, codexUsedPercent: 17 },
    );
  });
  await refresh.click();
  await refresh.click();
  await page.waitForTimeout(190);
  assert.equal(await panel.getByRole("alert").count(), 0, "stale snapshot failure must not replace a newer success");
  await panel.locator(".dashboard-engine-row").filter({ hasText: "Codex" })
    .getByText("17%", { exact: true }).waitFor();

  // A stale success must not overwrite the newest usage values either.
  await page.evaluate(() => {
    window.__providerHealthQA.snapshotPlans.push(
      { delayMs: 140, codexUsedPercent: 88 },
      { delayMs: 5, codexUsedPercent: 23 },
    );
  });
  await refresh.click();
  await refresh.click();
  await page.waitForTimeout(190);
  const codexRow = panel.locator(".dashboard-engine-row").filter({ hasText: "Codex" });
  await codexRow.getByText("23%", { exact: true }).waitFor();
  assert.equal(await codexRow.getByText("88%", { exact: true }).count(), 0, "stale snapshot success must be ignored");

  return { staleFailureIgnored: true, staleSuccessIgnored: true };
}

async function verifyStaleReceiptDoesNotImplyRuntime(page) {
  const panel = page.locator('[data-tour-id="dashboard.llm"]');
  await panel.getByText("LLM 연결 · 사용량", { exact: true }).waitFor();
  for (const label of ["Gemini", "Grok"]) {
    const row = panel.locator(".dashboard-engine-row").filter({ hasText: label });
    await row.getByRole("button", { name: "연결", exact: true }).waitFor();
    assert.equal(
      await row.getByRole("button", { name: /Antigravity|Usage 열기/ }).count(),
      0,
      `${label}: a stale receipt must not hide the runtime Connect action`,
    );
  }
  return { geminiConnectVisible: true, grokConnectVisible: true };
}

async function verifyAtomicProviderRetry(page) {
  const panel = page.locator('[data-tour-id="dashboard.llm"]');
  const codexRow = panel.locator(".dashboard-engine-row").filter({ hasText: "Codex" });
  await codexRow.getByText("조회 실패", { exact: true }).waitFor();
  assert.equal(
    await page.evaluate(() => typeof window.agentlas.usage.invalidate),
    "undefined",
    "renderer bridge must not expose raw usage invalidation",
  );
  await codexRow.getByRole("button", { name: "다시 시도", exact: true }).click();
  await codexRow.getByText("12%", { exact: true }).waitFor();
  assert.deepEqual(
    await page.evaluate(() => window.__providerHealthQA.calls.filter((call) => call.name.startsWith("usage."))),
    [{ name: "usage.retry", providerId: "codex" }],
    "Dashboard retry must use the single atomic provider retry method",
  );
  return { rawInvalidateAbsent: true, retryProvider: "codex" };
}

async function main() {
  if (!fs.existsSync(path.join(distDir, "dashboard.html"))) {
    throw new Error("dist/renderer/dashboard.html is missing; this QA does not rebuild production assets");
  }
  verifyStaticServerBoundary();

  const { chromium } = require("playwright");
  const { setupMockAgentlasBridge, mockBridgeOptions } = require("./lib/mock-agentlas-bridge.cjs");
  const setupSource = setupMockAgentlasBridge.toString();

  fs.mkdirSync(outDir, { recursive: true });
  const { server, baseUrl } = await startServer();
  const browser = await chromium.launch();
  const errors = [];

  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    await forceLocale(context, "ko");
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
    const koRecovery = await verifyUsageSnapshotRecovery(page, {
      locale: "ko",
      heading: "LLM 연결 · 사용량",
      failure: "사용량 상태를 읽지 못함",
      retry: "다시 시도",
      screenshotName: "07-provider-usage-ipc-error-ko-1440x1100.png",
    });
    const ordering = await verifyUsageSnapshotOrdering(page);

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

    const enContext = await browser.newContext({ viewport: { width: 960, height: 1100 } });
    await forceLocale(enContext, "en");
    await enContext.addInitScript(setupProviderHealthBridge, {
      setupSource,
      baseOptions: mockBridgeOptions({ teamRoster: true }),
      locale: "en-US",
    });
    const enPage = await enContext.newPage();
    enPage.setDefaultTimeout(10_000);
    watchPage(enPage, errors);
    await enPage.goto(`${baseUrl}/dashboard.html`, { waitUntil: "domcontentloaded" });
    const enRecovery = await verifyUsageSnapshotRecovery(enPage, {
      locale: "en",
      heading: "LLM connections · usage",
      failure: "Could not load usage status",
      retry: "Retry",
    });
    await enContext.close();

    const missingRuntimeContext = await browser.newContext({ viewport: { width: 960, height: 1100 } });
    await forceLocale(missingRuntimeContext, "ko");
    await missingRuntimeContext.addInitScript(setupProviderHealthBridge, {
      setupSource,
      baseOptions: mockBridgeOptions({ teamRoster: true }),
      locale: "ko-KR",
      excludeRuntimeKinds: ["gemini", "grok"],
    });
    const missingRuntimePage = await missingRuntimeContext.newPage();
    missingRuntimePage.setDefaultTimeout(10_000);
    watchPage(missingRuntimePage, errors);
    await missingRuntimePage.goto(`${baseUrl}/dashboard.html`, { waitUntil: "domcontentloaded" });
    const staleReceiptIsolation = await verifyStaleReceiptDoesNotImplyRuntime(missingRuntimePage);
    await missingRuntimeContext.close();

    const retryContext = await browser.newContext({ viewport: { width: 960, height: 1100 } });
    await forceLocale(retryContext, "ko");
    await retryContext.addInitScript(setupProviderHealthBridge, {
      setupSource,
      baseOptions: mockBridgeOptions({ teamRoster: true }),
      locale: "ko-KR",
      codexError: true,
    });
    const retryPage = await retryContext.newPage();
    retryPage.setDefaultTimeout(10_000);
    watchPage(retryPage, errors);
    await retryPage.goto(`${baseUrl}/dashboard.html`, { waitUntil: "domcontentloaded" });
    const atomicProviderRetry = await verifyAtomicProviderRetry(retryPage);
    await retryContext.close();

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
      snapshotIpcRecovery: {
        ko: koRecovery,
        en: enRecovery,
      },
      snapshotOrdering: ordering,
      staleReceiptIsolation,
      atomicProviderRetry,
      staticServerTraversalBlocked: true,
      errors,
      issues,
      screenshots: [
        "04-provider-health-desktop-post-fix-1440x1100.png",
        "05-provider-health-compact-post-fix-960x1100.png",
        "06-dashboard-compact-full-post-fix-960x1100.png",
        "07-provider-usage-ipc-error-ko-1440x1100.png",
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
