#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist", "renderer");
const outDir = path.join(root, "output", "playwright", "runtime-recovery-ui");
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

async function main() {
  if (!fs.existsSync(path.join(distDir, "chat.html"))) {
    throw new Error("dist/renderer is missing; run npm run build:renderer first");
  }
  const { chromium } = require("playwright");
  const { setupMockAgentlasBridge, mockBridgeOptions } = require("./lib/mock-agentlas-bridge.cjs");
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const { server, baseUrl } = await startServer();
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 920 } });
    await context.addInitScript(setupMockAgentlasBridge, mockBridgeOptions({ slowInvoke: true }));
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" && !/favicon|Failed to load resource/i.test(message.text())) errors.push(message.text());
    });
    await page.goto(`${baseUrl}/chat.html?id=chat-1`, { waitUntil: "domcontentloaded" });
    await page.locator('[data-tour-id="workspace.workflow-toggle"]').click();

    const composer = page.locator("textarea").first();
    await composer.fill("오래 실행되는 작업의 취소 경계를 검증해줘");
    await composer.press("Enter");
    await page.getByText(/실행 영수증|Run receipt/).waitFor({ timeout: 8000 });
    await page.getByText(/실행 중|Running/, { exact: true }).last().waitFor();

    const runCall = await page.evaluate(() => window.__qa.calls.find((call) => call.name === "invoke.run"));
    assert.match(runCall.payload.runId, /^[0-9a-f-]{36}$/i, "renderer must own a stable idempotency runId");

    await page.getByRole("button", { name: /중지|Stop/i }).click();
    const receiptCard = page.locator('section[aria-label="실행 영수증"], section[aria-label="Run receipt"]');
    await receiptCard.getByText(/취소됨|Cancelled/, { exact: true }).waitFor({ timeout: 8000 });
    await page.getByText(/실행이 취소되었습니다\.|The run was cancelled\./, { exact: true }).waitFor();
    assert.equal(
      await page.getByText(/⚠️\s*(Cancelled|취소됨)/).count(),
      0,
      "an operator-requested stop must not be rendered as a runtime failure warning",
    );
    const calls = await page.evaluate(() => window.__qa.calls);
    assert.ok(
      calls.some((call) => call.name === "invoke.cancel" && call.payload === runCall.payload.runId),
      "Stop must cancel the exact renderer-owned runId",
    );

    await page.getByRole("button", { name: /결과 폴더 열기|Open result folder/ }).click();
    await page.waitForFunction(() => window.__qa.calls.some((call) => call.name === "fs.openPath"));
    const openCall = await page.evaluate(() => window.__qa.calls.find((call) => call.name === "fs.openPath"));
    assert.equal(openCall.payload, "/tmp/agentlas-qa-runs");

    await page.screenshot({ path: path.join(outDir, "cancelled-run-receipt.png"), fullPage: true });
    assert.deepEqual(errors, [], "runtime recovery UI must not emit renderer errors");
    console.log("test-runtime-recovery-ui: PASS");
    await context.close();
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
