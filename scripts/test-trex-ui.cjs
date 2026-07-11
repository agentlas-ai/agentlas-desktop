#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");
const { setupMockAgentlasBridge, mockBridgeOptions } = require("./lib/mock-agentlas-bridge.cjs");

const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist", "renderer");
const outDir = path.join(root, "output", "playwright", "trex-ui");

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
    ".svg": "image/svg+xml",
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
  if (!fs.existsSync(path.join(distDir, "trex.html"))) {
    throw new Error("dist/renderer is missing; run npm run build:renderer first");
  }
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const { server, baseUrl } = await startServer();
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript({
      content: `
        (${setupMockAgentlasBridge.toString()})(${JSON.stringify(mockBridgeOptions())});
        window.localStorage.setItem("agentlas.locale", "ko");
        window.agentlas.trex = {
          imageProviders: async () => null,
          contentAvailable: async () => null,
        };
      `,
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" && !/favicon|Failed to load resource/i.test(message.text())) {
        errors.push(message.text());
      }
    });

    await page.goto(`${baseUrl}/trex.html`, { waitUntil: "domcontentloaded" });
    await page.getByText(/T-rex/).first().waitFor({ timeout: 10_000 });
    assert.equal(await page.getByText(/문제가 생겼어요|Something went wrong/).count(), 0);
    assert.deepEqual(errors, [], `T-rex page emitted errors: ${errors.join("\n")}`);
    await page.screenshot({ path: path.join(outDir, "trex-null-capabilities.png"), fullPage: true });
    await context.close();
  } finally {
    await browser.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
  console.log("T-rex null capability UI contract passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
