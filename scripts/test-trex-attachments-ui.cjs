#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");
const { setupMockAgentlasBridge, mockBridgeOptions } = require("./lib/mock-agentlas-bridge.cjs");

const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist", "renderer");
const outDir = path.join(root, "output", "playwright", "trex-attachments");

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
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
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

function installTrexAttachmentFixture(payload) {
  const setupBase = (0, eval)(`(${payload.setupSource})`);
  setupBase(payload.baseOptions);
  window.localStorage.setItem("agentlas.locale", "ko");

  const state = { granted: [], read: [], generatePayload: null };
  window.__trexAttachmentQa = state;
  window.agentlasFiles.grantForFile = async (file) => {
    state.granted.push(file.name);
    return {
      path: `/qa/${file.name}`,
      kind: "file",
      durable: false,
      scope: { kind: "capability", token: "00000000-0000-4000-8000-000000000099" },
    };
  };
  window.agentlas.fs.readTextFile = async (absPath) => {
    state.read.push(absPath);
    return {
      path: absPath,
      content: "Verified source body for the quarterly roadmap.",
      truncated: false,
      size: 48,
    };
  };
  window.agentlas.trex.imageProviders = async () => ({ codex: false, gemini: false });
  window.agentlas.trex.contentAvailable = async () => ({ agy: true, codex: false });
  window.agentlas.trex.generateImage = async () => ({ ok: false, reason: "disabled-in-qa" });
  window.agentlas.trex.generateContent = async (input) => {
    state.generatePayload = input;
    return { ok: false, reason: "use-local-scaffold-in-qa" };
  };
}

async function main() {
  if (!fs.existsSync(path.join(distDir, "trex.html"))) {
    throw new Error("dist/renderer is missing; run npm run build:renderer first");
  }
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const { server, baseUrl } = await startServer();
  const browser = await chromium.launch();
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(installTrexAttachmentFixture, {
      setupSource: setupMockAgentlasBridge.toString(),
      baseOptions: mockBridgeOptions(),
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" && !/favicon|Failed to load resource/i.test(message.text())) errors.push(message.text());
    });

    await page.goto(`${baseUrl}/trex.html`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "무엇을 발표할까요?" }).waitFor();
    const input = page.locator('input[type="file"]');
    const accepted = new Set(String(await input.getAttribute("accept")).split(","));
    for (const ext of [".pdf", ".doc", ".docx", ".png", ".jpg", ".svg"]) {
      assert.equal(accepted.has(ext), false, `${ext} must not be advertised as a readable source`);
    }
    for (const ext of [".txt", ".md", ".csv", ".json"]) {
      assert.equal(accepted.has(ext), true, `${ext} must remain selectable`);
    }

    await input.setInputFiles([
      { name: "strategy.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF fake") },
      { name: "brief.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: Buffer.from("PK fake") },
      { name: "chart.png", mimeType: "image/png", buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
    ]);
    const rejection = page.getByTestId("trex-attachment-error");
    await rejection.waitFor();
    assert.match(await rejection.innerText(), /PDF·Word·이미지/);
    assert.match(await rejection.innerText(), /strategy\.pdf, brief\.docx, chart\.png/);
    assert.equal(await page.getByTestId("trex-source-chip").count(), 0, "Unsupported files must not become source chips");
    assert.deepEqual(
      await page.evaluate(() => ({ granted: window.__trexAttachmentQa.granted, read: window.__trexAttachmentQa.read })),
      { granted: [], read: [] },
      "Unsupported files must be rejected before path grants or text reads",
    );

    await input.setInputFiles({ name: "roadmap.md", mimeType: "text/markdown", buffer: Buffer.from("# Roadmap") });
    const sourceChip = page.getByTestId("trex-source-chip");
    await sourceChip.getByText("roadmap.md", { exact: true }).waitFor();
    await rejection.waitFor({ state: "detached" });
    await page.getByRole("button", { name: "생성", exact: true }).click();
    await page.waitForFunction(() => Boolean(window.__trexAttachmentQa.generatePayload));

    const state = await page.evaluate(() => window.__trexAttachmentQa);
    assert.deepEqual(state.granted, ["roadmap.md"]);
    assert.deepEqual(state.read, ["/qa/roadmap.md"]);
    assert.match(state.generatePayload.sources, /^### roadmap\.md\nVerified source body for the quarterly roadmap\.$/);
    for (const rejectedName of ["strategy.pdf", "brief.docx", "chart.png"]) {
      assert.equal(state.generatePayload.sources.includes(rejectedName), false, `${rejectedName} leaked into model sources`);
    }
    assert.deepEqual(errors, [], `T-rex attachment UI emitted errors: ${errors.join("\n")}`);
    await page.screenshot({ path: path.join(outDir, "text-source-only.png"), fullPage: true });
    await context.close();
  } finally {
    await browser.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
  console.log(`test-trex-attachments-ui: PASS (${outDir})`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
