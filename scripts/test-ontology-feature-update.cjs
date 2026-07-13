#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");
const { setupMockAgentlasBridge, mockBridgeOptions } = require("./lib/mock-agentlas-bridge.cjs");

const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist", "renderer");
const outDir = path.join(root, "output", "playwright", "ontology-feature-update");
const ackKey = "agentlas.featureUpdate.desktop-v0.8.13-ontology-chips.ack";

function srgbChannel(value) {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance([red, green, blue]) {
  return 0.2126 * srgbChannel(red) + 0.7152 * srgbChannel(green) + 0.0722 * srgbChannel(blue);
}

function contrastRatio(foreground, background) {
  const fg = relativeLuminance(foreground);
  const bg = relativeLuminance(background);
  return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
}

function parseRgb(cssColor) {
  const channels = cssColor.match(/[\d.]+/g)?.slice(0, 3).map(Number);
  assert.equal(channels?.length, 3, `expected an rgb color, got ${cssColor}`);
  return channels;
}

async function primaryButtonContrast(page) {
  const colors = await page.getByRole("button", { name: "새 기능 살펴보기" }).evaluate((button) => {
    const style = getComputedStyle(button);
    return { foreground: style.color, background: style.backgroundColor };
  });
  return contrastRatio(parseRgb(colors.foreground), parseRgb(colors.background));
}

function resolveAsset(rawUrl) {
  let pathname = decodeURIComponent((rawUrl || "/").split("?")[0]);
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
  const mime = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".png": "image/png",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
  };
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

async function main() {
  if (!fs.existsSync(path.join(distDir, "dashboard.html"))) {
    throw new Error("dist/renderer is missing; run npm run build:renderer first");
  }
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const { server, baseUrl } = await startServer();
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript({
      content: `
        (${setupMockAgentlasBridge.toString()})(${JSON.stringify({ ...mockBridgeOptions(), appVersion: "0.8.13", showFeatureUpdate: true })});
        window.localStorage.setItem("agentlas.locale", "ko");
        if (!window.sessionStorage.getItem("agentlas.qa.ontologyFeatureInitialized")) {
          window.localStorage.removeItem(${JSON.stringify(ackKey)});
          window.sessionStorage.setItem("agentlas.qa.ontologyFeatureInitialized", "1");
        }
      `,
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" && !/favicon|Failed to load resource/i.test(message.text())) errors.push(message.text());
    });

    await page.goto(`${baseUrl}/dashboard.html`, { waitUntil: "domcontentloaded" });
    const dialog = page.getByRole("dialog", { name: "좋은 경험을, 에이전트의 판단으로" });
    try {
      await dialog.waitFor({ timeout: 8_000 });
    } catch (error) {
      await page.screenshot({ path: path.join(outDir, "ontology-chip-update-modal-timeout.png"), fullPage: true }).catch(() => undefined);
      console.error(JSON.stringify({
        url: page.url(),
        pathname: await page.evaluate(() => window.location.pathname),
        onboarded: await page.evaluate(() => window.localStorage.getItem("agentlas.onboarded")),
        ack: await page.evaluate((key) => window.localStorage.getItem(key), ackKey),
        appVersion: await page.evaluate(() => window.agentlas?.app?.getVersion?.()),
        body: (await page.locator("body").innerText()).slice(0, 2000),
        errors,
      }, null, 2));
      throw error;
    }
    assert.equal(await dialog.getAttribute("aria-modal"), "true");
    assert.equal(await dialog.getAttribute("data-feature-release"), "desktop-v0.8.13-ontology-chips");
    assert.equal(await dialog.locator('img[src="/feature-updates/ontology-chip-modal-hero-v2.png"]').count(), 1);
    assert.equal(await page.evaluate(() => document.activeElement?.id), "ontology-chip-feature-title");
    const box = await dialog.boundingBox();
    assert.ok(box && box.width <= 541 && box.width >= 500, `unexpected dialog width: ${box?.width}`);
    const lightPrimaryContrast = await primaryButtonContrast(page);
    assert.ok(lightPrimaryContrast >= 4.5, `light primary contrast ${lightPrimaryContrast.toFixed(2)} is below WCAG AA`);
    await page.screenshot({ path: path.join(outDir, "ontology-chip-update-modal.png"), fullPage: true });

    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    const darkPrimaryContrast = await primaryButtonContrast(page);
    assert.ok(darkPrimaryContrast >= 4.5, `dark primary contrast ${darkPrimaryContrast.toFixed(2)} is below WCAG AA`);
    await page.screenshot({ path: path.join(outDir, "ontology-chip-update-modal-dark.png"), fullPage: true });
    await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });

    await page.keyboard.press("Shift+Tab");
    assert.match(await page.evaluate(() => document.activeElement?.textContent || ""), /새 기능 살펴보기/);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    assert.ok(await page.evaluate((key) => window.localStorage.getItem(key), ackKey));

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1_200);
    assert.equal(await page.getByRole("dialog", { name: "좋은 경험을, 에이전트의 판단으로" }).count(), 0, "viewed release must stay hidden");

    await page.evaluate((key) => window.localStorage.removeItem(key), ackKey);
    await page.reload({ waitUntil: "domcontentloaded" });
    const reopened = page.getByRole("dialog", { name: "좋은 경험을, 에이전트의 판단으로" });
    await reopened.waitFor({ timeout: 8_000 });
    await reopened.getByRole("button", { name: "새 기능 살펴보기" }).click();
    await page.waitForURL(/\/library\/agents(?:\.html)?\?tab=ontology/);
    const ontologyTab = page.getByRole("button", { name: "온톨로지 칩", exact: true });
    await ontologyTab.waitFor({ timeout: 8_000 });
    assert.equal(await ontologyTab.getAttribute("aria-current"), "page");
    await page.locator('[data-testid="experience-ontology-summary"]').waitFor({ timeout: 8_000 });
    await page.screenshot({ path: path.join(outDir, "ontology-chip-update-deeplink.png"), fullPage: true });
    assert.deepEqual(errors, [], `feature update UI emitted errors: ${errors.join("\n")}`);
    await context.close();

    const updateContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await updateContext.addInitScript({
      content: `
        (${setupMockAgentlasBridge.toString()})(${JSON.stringify({ ...mockBridgeOptions(), appVersion: "0.8.13", showFeatureUpdate: true })});
        window.localStorage.removeItem(${JSON.stringify(ackKey)});
        window.agentlas.updater.getState = async () => ({ status: "downloaded", version: "0.8.11" });
      `,
    });
    const updatePage = await updateContext.newPage();
    await updatePage.goto(`${baseUrl}/dashboard.html`, { waitUntil: "domcontentloaded" });
    await updatePage.waitForTimeout(1_500);
    assert.equal(await updatePage.getByRole("dialog", { name: "좋은 경험을, 에이전트의 판단으로" }).count(), 0, "app update must outrank feature news");
    await updateContext.close();

    const approvalContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await approvalContext.addInitScript({
      content: `
        (${setupMockAgentlasBridge.toString()})(${JSON.stringify({ ...mockBridgeOptions(), appVersion: "0.8.13", pendingConfirmations: 1, showFeatureUpdate: true })});
        window.localStorage.removeItem(${JSON.stringify(ackKey)});
      `,
    });
    const approvalPage = await approvalContext.newPage();
    await approvalPage.goto(`${baseUrl}/dashboard.html`, { waitUntil: "domcontentloaded" });
    await approvalPage.waitForTimeout(1_500);
    assert.equal(await approvalPage.getByRole("dialog", { name: "좋은 경험을, 에이전트의 판단으로" }).count(), 0, "pending approval must outrank feature news");
    await approvalContext.close();

    console.log(JSON.stringify({
      ok: true,
      release: "desktop-v0.8.13-ontology-chips",
      acknowledgedOnce: true,
      escapeAndFocusTrap: true,
      ontologyDeepLink: true,
      updaterPriority: true,
      approvalPriority: true,
      primaryButtonContrast: {
        light: Number(lightPrimaryContrast.toFixed(2)),
        dark: Number(darkPrimaryContrast.toFixed(2)),
      },
      screenshots: outDir,
    }, null, 2));
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
