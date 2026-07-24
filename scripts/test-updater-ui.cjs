#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist", "renderer");
const outDir = path.join(root, "output", "playwright", "updater-production");
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
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

function setupUpdaterUiBridge(payload) {
  // The product defaults to English.  These assertions are intentionally
  // Korean, so select Korean before the renderer's I18nProvider boots instead
  // of relying on the host locale or an old persisted preference.
  window.localStorage.setItem("agentlas.locale", payload.locale || "ko");
  const setupBase = (0, eval)(`(${payload.setupSource})`);
  setupBase(payload.baseOptions);
  let state = payload.initialState;
  const handlers = [];
  const calls = [];
  const emit = (next) => {
    state = next;
    for (const handler of handlers.slice()) handler(next);
  };
  window.__updaterUi = { calls, emit, getState: () => state };
  window.agentlasUpdater = {
    onState: (handler) => {
      handlers.push(handler);
      return () => {
        const index = handlers.indexOf(handler);
        if (index >= 0) handlers.splice(index, 1);
      };
    },
  };
  window.agentlas.hephaestus.getSupervisor = async () => ({ enabled: true });
  window.agentlas.hephaestus.setSupervisor = async () => ({ enabled: true });
  window.agentlas.memoryDreaming = {
    status: async () => ({ enabled: false, lastRunAt: null, running: false }),
    setEnabled: async (enabled) => ({ enabled, lastRunAt: null, running: false }),
  };
  window.agentlas.updater = {
    getState: async () => state,
    check: async () => {
      calls.push("check");
      return state;
    },
    install: async () => {
      calls.push("install");
      emit({ status: "installing", version: state.version, progress: 100 });
      return { accepted: true, state };
    },
    openManualDownload: async () => {
      calls.push("openManualDownload");
      return { accepted: true, state };
    },
    revealRecoveryBackup: async () => {
      calls.push("revealRecoveryBackup");
      return { accepted: true, state };
    },
  };
}

async function newUpdaterContext(browser, setupSource, initialState, locale = "ko") {
  const context = await browser.newContext({ viewport: { width: 1440, height: 980 } });
  await context.addInitScript(setupUpdaterUiBridge, {
    setupSource,
    baseOptions: { teamRoster: true },
    locale,
    initialState,
  });
  return context;
}

async function main() {
  if (!fs.existsSync(path.join(distDir, "settings.html"))) {
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
    const manualContext = await newUpdaterContext(browser, setupSource, {
      status: "manual-required",
      version: "0.7.29",
      code: "install-not-owned",
      canRetry: false,
    });
    const manualPage = await manualContext.newPage();
    watch(manualPage);
    await manualPage.goto(`${baseUrl}/dashboard.html`, { waitUntil: "domcontentloaded" });
    const manualAlert = manualPage.locator('.sidenav-update-card[role="alert"]');
    await manualAlert.getByText("자동 업데이트를 안전하게 중단했습니다", { exact: true }).waitFor();
    assert.equal(await manualAlert.getByRole("button").count(), 0, "a blocked update must not force a website reinstall");
    await manualPage.screenshot({ path: path.join(outDir, "manual-required-banner.png"), fullPage: true });
    await manualPage.goto(`${baseUrl}/settings.html`, { waitUntil: "domcontentloaded" });
    await manualPage.waitForTimeout(800);
    const settingsBody = await manualPage.locator("body").innerText();
    if (!settingsBody.includes("자동 설치를 안전하게 완료하지 않아")) {
      throw new Error(`manual settings status missing; renderer errors=${JSON.stringify(errors)}; visible text: ${settingsBody.slice(0, 1200)}`);
    }
    await manualPage.getByText(/자동 설치를 안전하게 완료하지 않아 기존 앱과 로컬 데이터를 그대로 유지했습니다/).waitFor({ timeout: 5000 });
    assert.equal(await manualPage.getByRole("button", { name: "공식 설치 파일" }).count(), 0);
    await manualPage.screenshot({ path: path.join(outDir, "manual-required-settings.png"), fullPage: true });
    await manualContext.close();

    const untrustedContext = await newUpdaterContext(browser, setupSource, {
      status: "manual-required",
      version: "0.8.60",
      code: "install-source-untrusted",
      canRetry: true,
    });
    const untrustedPage = await untrustedContext.newPage();
    watch(untrustedPage);
    await untrustedPage.goto(`${baseUrl}/dashboard.html`, { waitUntil: "domcontentloaded" });
    const untrustedAlert = untrustedPage.locator('.sidenav-update-card[role="alert"]');
    await untrustedAlert.getByText("앱 내부 복구가 필요합니다", { exact: true }).waitFor();
    const visibleUpdateCopies = untrustedAlert.locator(".sidenav-update-copy strong, .sidenav-update-copy span");
    for (let index = 0; index < await visibleUpdateCopies.count(); index += 1) {
      const copy = visibleUpdateCopies.nth(index);
      const layout = await copy.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          whiteSpace: style.whiteSpace,
          textOverflow: style.textOverflow,
          overflow: style.overflow,
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
        };
      });
      assert.notEqual(layout.whiteSpace, "nowrap", `update copy ${index} must wrap instead of truncating`);
      assert.notEqual(layout.textOverflow, "ellipsis", `update copy ${index} must not use ellipsis`);
      assert.ok(layout.scrollWidth <= layout.clientWidth + 1, `update copy ${index} must fit its visible width`);
    }
    await untrustedAlert.getByRole("button", { name: "다시 시도" }).click();
    assert.deepEqual(await untrustedPage.evaluate(() => window.__updaterUi.calls), ["check"]);
    await untrustedPage.screenshot({ path: path.join(outDir, "important-reinstall-banner.png"), fullPage: true });
    await untrustedPage.goto(`${baseUrl}/settings.html`, { waitUntil: "domcontentloaded" });
    await untrustedPage
      .getByRole("main")
      .getByText("앱 내부 복구를 완료하지 못했습니다. 다시 시도하면 안전하게 복구한 뒤 업데이트를 이어갑니다.", { exact: true })
      .waitFor();
    await untrustedPage
      .getByRole("main")
      .getByRole("button", { name: "다시 시도" })
      .waitFor();
    await untrustedPage.screenshot({ path: path.join(outDir, "untrusted-install-source.png"), fullPage: true });
    await untrustedContext.close();

    const untrustedEnglishContext = await newUpdaterContext(browser, setupSource, {
      status: "manual-required",
      version: "0.8.60",
      code: "install-source-untrusted",
      canRetry: true,
    }, "en");
    const untrustedEnglishPage = await untrustedEnglishContext.newPage();
    watch(untrustedEnglishPage);
    await untrustedEnglishPage.goto(`${baseUrl}/dashboard.html`, { waitUntil: "domcontentloaded" });
    const untrustedEnglishAlert = untrustedEnglishPage.locator('.sidenav-update-card[role="alert"]');
    await untrustedEnglishAlert.getByText("In-app repair is required", { exact: true }).waitFor();
    await untrustedEnglishAlert.getByRole("button", { name: "Retry" }).waitFor();
    await untrustedEnglishContext.close();

    const lifecycleContext = await newUpdaterContext(browser, setupSource, {
      status: "downloading",
      version: "0.7.29",
      progress: 42,
    });
    const lifecyclePage = await lifecycleContext.newPage();
    watch(lifecyclePage);
    await lifecyclePage.goto(`${baseUrl}/dashboard.html`, { waitUntil: "domcontentloaded" });
    await lifecyclePage.getByText("업데이트 다운로드 중 · 42%", { exact: true }).waitFor();
    await lifecyclePage.evaluate(() => window.__updaterUi.emit({ status: "downloaded", version: "0.7.29", progress: 100 }));
    // The downloaded update card is intentionally compact: a short CTA with no
    // version string, so the sidebar box never grows tall or breaks.
    await lifecyclePage.getByText("업데이트 준비됨", { exact: true }).waitFor();
    await lifecyclePage.getByRole("button", { name: "재시작" }).click();
    await lifecyclePage.getByText("안전한 업데이트 적용 중 · v0.7.29", { exact: true }).waitFor();
    assert.deepEqual(await lifecyclePage.evaluate(() => window.__updaterUi.calls), ["install"]);
    await lifecyclePage.screenshot({ path: path.join(outDir, "installing-after-explicit-click.png"), fullPage: true });
    await lifecycleContext.close();

    const backupFailureContext = await newUpdaterContext(browser, setupSource, {
      status: "manual-required",
      version: "0.7.29",
      code: "continuity-backup-failed",
      canRetry: true,
    });
    const backupFailurePage = await backupFailureContext.newPage();
    watch(backupFailurePage);
    await backupFailurePage.goto(`${baseUrl}/dashboard.html`, { waitUntil: "domcontentloaded" });
    await backupFailurePage.getByText("복구본을 만들지 못해 업데이트를 적용하지 않았습니다", { exact: true }).waitFor();
    await backupFailurePage.getByRole("button", { name: "다시 시도" }).waitFor();
    await backupFailurePage.screenshot({ path: path.join(outDir, "continuity-backup-failed-action.png"), fullPage: true });
    await backupFailurePage.getByRole("button", { name: "다시 시도" }).click();
    assert.deepEqual(await backupFailurePage.evaluate(() => window.__updaterUi.calls), ["install"]);
    await backupFailureContext.close();

    const schemaContext = await newUpdaterContext(browser, setupSource, {
      status: "incompatible",
      version: "0.7.29",
      code: "minimum-schema-version",
      canRetry: false,
    });
    const schemaPage = await schemaContext.newPage();
    watch(schemaPage);
    await schemaPage.goto(`${baseUrl}/dashboard.html`, { waitUntil: "domcontentloaded" });
    await schemaPage.getByText("현재 데이터에는 브리지 버전 또는 복구 안내가 필요합니다", { exact: true }).waitFor();
    assert.equal(await schemaPage.getByRole("button", { name: "공식 설치" }).count(), 0);
    await schemaPage.screenshot({ path: path.join(outDir, "schema-incompatible-no-installer.png"), fullPage: true });
    await schemaContext.close();

    const metadataContext = await newUpdaterContext(browser, setupSource, {
      status: "incompatible",
      version: "0.7.29",
      code: "compatibility-metadata-missing",
      canRetry: true,
    });
    const metadataPage = await metadataContext.newPage();
    watch(metadataPage);
    await metadataPage.goto(`${baseUrl}/dashboard.html`, { waitUntil: "domcontentloaded" });
    await metadataPage.getByRole("button", { name: "다시 시도" }).click();
    assert.deepEqual(await metadataPage.evaluate(() => window.__updaterUi.calls), ["check"]);
    await metadataContext.close();

    const recoveryContext = await newUpdaterContext(browser, setupSource, {
      status: "recovery-required",
      version: "0.7.29",
      code: "continuity-violation",
      recoveryBackupAvailable: true,
    });
    const recoveryPage = await recoveryContext.newPage();
    watch(recoveryPage);
    await recoveryPage.goto(`${baseUrl}/settings.html`, { waitUntil: "domcontentloaded" });
    await recoveryPage.getByText(/업데이트 후 일부 로컬 상태를 확인하지 못했습니다/).waitFor();
    await recoveryPage.getByRole("button", { name: "복구본 보기" }).click();
    assert.deepEqual(await recoveryPage.evaluate(() => window.__updaterUi.calls), ["revealRecoveryBackup"]);
    await recoveryPage.screenshot({ path: path.join(outDir, "recovery-required-settings.png"), fullPage: true });
    await recoveryContext.close();

    const missingRecoveryContext = await newUpdaterContext(browser, setupSource, {
      status: "recovery-required",
      version: "0.7.29",
      code: "continuity-violation",
      recoveryBackupAvailable: false,
    });
    const missingRecoveryPage = await missingRecoveryContext.newPage();
    watch(missingRecoveryPage);
    await missingRecoveryPage.goto(`${baseUrl}/dashboard.html`, { waitUntil: "domcontentloaded" });
    assert.equal(await missingRecoveryPage.locator('.sidenav-update-card[role="alert"]').getByRole("button").count(), 0, "missing recovery data must not route users to a website reinstall");
    await missingRecoveryPage.screenshot({ path: path.join(outDir, "recovery-missing-fallback.png"), fullPage: true });
    await missingRecoveryContext.close();

    assert.deepEqual(errors, [], "updater status UI must not emit renderer errors");
    console.log(`test-updater-ui: PASS (${outDir})`);
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
