#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist", "renderer");
const outDir = path.join(root, "output", "playwright", "browser-ui");

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
  if (!fs.existsSync(path.join(distDir, "browser.html"))) {
    throw new Error("dist/renderer is missing; run npm run build:renderer first");
  }

  const { chromium } = require("playwright");
  const { setupMockAgentlasBridge, mockBridgeOptions } = require("./lib/mock-agentlas-bridge.cjs");
  const now = new Date().toISOString();
  const sites = ["threads.net", "x.com", "instagram.com", "linkedin.com", "reddit.com", "youtube.com"].map(
    (site, index) => ({
      id: `browser-site-${index + 1}`,
      site,
      label: site,
      username: null,
      session: { status: index < 3 ? "valid" : "none", capturedAt: index < 3 ? now : null },
      createdAt: now,
      updatedAt: now,
    }),
  );

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const { server, baseUrl } = await startServer();
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 900, height: 600 } });
    const setupSource = setupMockAgentlasBridge.toString();
    const options = mockBridgeOptions();
    await context.addInitScript({
      content: `
        (${setupSource})(${JSON.stringify(options)});
        window.agentlas.browser = {
          status: async () => ({ chromeFound: true, chromePath: "/Applications/Google Chrome.app", profilePath: "/tmp/agentlas-browser-profile", cdpPort: 9222 }),
          listSites: async () => ${JSON.stringify(sites)},
          saveSite: async (input) => input,
          deleteSite: async () => ({ ok: true }),
          openLogin: async () => ({ ok: false, error: "CDP ownership fixture detail" }),
          markSession: async () => ({ ok: true }),
          listPermissions: async () => [],
          revokePermission: async () => ({ ok: true }),
          resolveApproval: async () => ({ ok: true }),
          listLogs: async () => [],
        };
      `,
    });

    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" && !/favicon|Failed to load resource/i.test(message.text())) errors.push(message.text());
    });
    await page.goto(`${baseUrl}/browser.html`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /Sites \(6\)|사이트 \(6\)/ }).waitFor({ timeout: 10000 });

    const scroll = page.locator(".browser-scroll");
    const before = await scroll.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
      overflowY: getComputedStyle(element).overflowY,
    }));
    assert.equal(before.overflowY, "auto", "Browser page must expose one vertical scroll container");
    assert.ok(before.scrollHeight > before.clientHeight, "six sites at 900x600 must overflow the Browser viewport");

    await scroll.hover();
    await page.mouse.wheel(0, 900);
    await page.waitForFunction(() => document.querySelector(".browser-scroll")?.scrollTop > 0);
    const after = await scroll.evaluate((element) => element.scrollTop);
    assert.ok(after > before.scrollTop, "mouse wheel must move the Browser page scroll position");
    const lastSignIn = page.getByRole("button", { name: /Sign in|로그인 창/ }).last();
    await lastSignIn.scrollIntoViewIfNeeded();
    await lastSignIn.click();
    await page.getByText("CDP ownership fixture detail", { exact: true }).waitFor();
    await page.screenshot({ path: path.join(outDir, "browser-scroll-after-wheel.png") });

    assert.deepEqual(errors, [], `Browser page emitted errors: ${errors.join("\n")}`);
    await context.close();
  } finally {
    await browser.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }

  console.log("browser UI scroll contract passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
