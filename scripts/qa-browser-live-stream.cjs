#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { _electron: electron, chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "output", "playwright", "browser-live-stream");

function startFixtureServer() {
  return new Promise((resolve) => {
    let clickCount = 0;
    const server = http.createServer((request, response) => {
      const pathname = decodeURIComponent((request.url || "/").split("?")[0]);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      if (pathname === "/clicked" && request.method === "POST") {
        clickCount += 1;
        response.end("ok");
        return;
      }
      if (pathname === "/browser-live-fixture") {
        response.end(`<!doctype html><html><head><meta charset="utf-8"><title>Agentlas live browser fixture</title><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#10251d;color:#fff;font:18px system-ui}body{display:grid;place-items:center}#pulse{position:fixed;left:36px;top:36px;width:70px;height:70px;border-radius:18px;background:#62d49a;box-shadow:0 0 36px #62d49a}button{width:180px;height:72px;border:0;border-radius:18px;background:#fff;color:#12472f;font:800 20px system-ui;cursor:pointer}output{position:fixed;right:30px;bottom:24px}</style></head><body><div id="pulse"></div><button id="counter" onclick="this.textContent=String(Number(this.textContent)+1);fetch('/clicked',{method:'POST'})">0</button><output id="frames">0</output><script>let frames=0;const pulse=document.querySelector('#pulse');const out=document.querySelector('#frames');function tick(t){frames+=1;out.value=String(frames);pulse.style.transform='translateX('+((Math.sin(t/260)+1)*90)+'px) rotate('+(t/8)+'deg)';requestAnimationFrame(tick)}requestAnimationFrame(tick)</script></body></html>`);
        return;
      }
      if (pathname === "/browser-live-second") {
        response.end("<!doctype html><html><head><meta charset=\"utf-8\"><title>Second in-app browser page</title><style>html,body{margin:0;width:100%;height:100%;display:grid;place-items:center;background:#f5f6f7;color:#202428;font:700 28px system-ui}</style></head><body>Second page</body></html>");
        return;
      }
      response.end("<!doctype html><html><head><meta charset=\"utf-8\"><title>Agentlas browser stream QA bridge</title></head><body>Browser stream QA bridge</body></html>");
    });
    server.listen(0, "127.0.0.1", () => resolve({
      server,
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      getClickCount: () => clickCount,
    }));
  });
}

function allocateLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForCdp(port, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok && Array.isArray(await response.json())) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`CDP browser did not listen on 127.0.0.1:${port}`);
}

async function boundedClose(promise, timeoutMs) {
  await Promise.race([
    Promise.resolve(promise).catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

async function main() {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const electronUserData = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-browser-stream-electron-"));
  const browserUserData = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-browser-stream-cdp-"));
  const { server, baseUrl, getClickCount } = await startFixtureServer();
  const cdpPort = await allocateLoopbackPort();
  const browserFixtureUrl = `${baseUrl}/browser-live-fixture`;
  const secondPageUrl = `${baseUrl}/browser-live-second`;
  let desktop;
  let browserContext;
  try {
    browserContext = await chromium.launchPersistentContext(browserUserData, {
      headless: true,
      viewport: { width: 800, height: 600 },
      args: [`--remote-debugging-port=${cdpPort}`, "--remote-debugging-address=127.0.0.1"],
    });
    const fixturePage = browserContext.pages()[0] || await browserContext.newPage();
    await fixturePage.goto(browserFixtureUrl, { waitUntil: "domcontentloaded" });
    await waitForCdp(cdpPort);

    desktop = await electron.launch({
      args: [root, `--user-data-dir=${electronUserData}`],
      cwd: root,
      env: {
        ...process.env,
        AGENTLAS_E2E: "1",
        AGENTLAS_E2E_AUTH: "1",
        AGENTLAS_CDP_PORT: String(cdpPort),
        AGENTLAS_CDP_PROFILE: browserUserData,
        NODE_ENV: "development",
        ELECTRON_START_URL: `${baseUrl}/bridge`,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      },
      timeout: 30_000,
    });
    const page = await desktop.firstWindow({ timeout: 30_000 });
    await page.waitForURL((url) => url.origin === new URL(baseUrl).origin && url.pathname === "/bridge", { timeout: 60_000 });
    await page.waitForFunction(() => Boolean(window.agentlas?.browser?.startLiveView), null, { timeout: 20_000 });

    const stream = await page.evaluate(async ({ preferredUrl, secondPageUrl }) => {
      const frames = [];
      const waitForFrameUrl = async (url, afterIndex = 0) => {
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          const index = frames.findIndex((frame, candidateIndex) => candidateIndex >= afterIndex && frame.url === url);
          if (index >= 0) return index;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return -1;
      };
      const unsubscribe = window.agentlas.browser.onLiveFrame((frame) => {
        if (frame.dataUrl) frames.push({
          sequence: frame.sequence,
          capturedAt: frame.capturedAt,
          dataUrl: frame.dataUrl,
          url: frame.url,
        });
      });
      const started = await window.agentlas.browser.startLiveView(preferredUrl, "desktop");
      if (!started.sessionId || !started.interactive || !started.frame.available) {
        unsubscribe();
        return { started, frames, down: null, up: null, stopped: null };
      }
      if (started.frame.dataUrl) frames.unshift({ sequence: 0, capturedAt: started.frame.capturedAt, dataUrl: started.frame.dataUrl });
      await new Promise((resolve) => setTimeout(resolve, 250));
      const down = await window.agentlas.browser.dispatchLiveInput({
        sessionId: started.sessionId,
        kind: "pointer",
        phase: "down",
        x: 0.5,
        y: 0.5,
        button: "left",
        clickCount: 1,
      });
      const up = await window.agentlas.browser.dispatchLiveInput({
        sessionId: started.sessionId,
        kind: "pointer",
        phase: "up",
        x: 0.5,
        y: 0.5,
        button: "left",
        clickCount: 1,
      });
      const navigate = await window.agentlas.browser.dispatchLiveInput({
        sessionId: started.sessionId,
        kind: "navigation",
        action: "navigate",
        url: secondPageUrl,
      });
      const secondFrameIndex = await waitForFrameUrl(secondPageUrl);
      const back = await window.agentlas.browser.dispatchLiveInput({
        sessionId: started.sessionId,
        kind: "navigation",
        action: "back",
      });
      const backFrameIndex = await waitForFrameUrl(preferredUrl, Math.max(0, secondFrameIndex + 1));
      const forward = await window.agentlas.browser.dispatchLiveInput({
        sessionId: started.sessionId,
        kind: "navigation",
        action: "forward",
      });
      const forwardFrameIndex = await waitForFrameUrl(secondPageUrl, Math.max(0, backFrameIndex + 1));
      const reload = await window.agentlas.browser.dispatchLiveInput({
        sessionId: started.sessionId,
        kind: "navigation",
        action: "reload",
      });
      await new Promise((resolve) => setTimeout(resolve, 1_250));
      const stopped = await window.agentlas.browser.stopLiveView(started.sessionId);
      unsubscribe();
      return { started, frames, down, up, navigate, back, forward, reload, stopped, secondFrameIndex, backFrameIndex, forwardFrameIndex };
    }, { preferredUrl: browserFixtureUrl, secondPageUrl });

    assert.ok(stream.started?.sessionId && stream.started.interactive,
      `live CDP stream did not start: ${JSON.stringify(stream.started)}`);
    assert.equal(stream.down?.ok, true, "pointer-down was not delivered to the browser target");
    assert.equal(stream.up?.ok, true, "pointer-up was not delivered to the browser target");
    assert.equal(stream.navigate?.ok, true, "address-bar navigation was not delivered to the in-app target");
    assert.equal(stream.back?.ok, true, "Back was not delivered to the in-app target");
    assert.equal(stream.forward?.ok, true, "Forward was not delivered to the in-app target");
    assert.equal(stream.reload?.ok, true, "Reload was not delivered to the in-app target");
    assert.equal(stream.stopped?.ok, true, "live CDP stream did not close cleanly");
    const frames = [...new Map(stream.frames.map((frame) => [frame.sequence, frame])).values()];
    assert.ok(frames.length >= 12, `expected a smooth live stream, received ${frames.length} unique frames`);
    const firstBytes = Buffer.from(frames[0].dataUrl.split(",")[1], "base64");
    const lastBytes = Buffer.from(frames.at(-1).dataUrl.split(",")[1], "base64");
    const firstHash = crypto.createHash("sha256").update(firstBytes).digest("hex");
    const lastHash = crypto.createHash("sha256").update(lastBytes).digest("hex");
    assert.notEqual(lastHash, firstHash, "the browser stream stayed on one frozen frame");
    assert.ok(stream.secondFrameIndex >= 0, `the live stream never rendered the address-bar destination; urls=${JSON.stringify([...new Set(stream.frames.map((frame) => frame.url))])}`);
    assert.ok(stream.backFrameIndex > stream.secondFrameIndex, "Back did not return the streamed target to the first page");
    assert.ok(stream.forwardFrameIndex > stream.backFrameIndex, "Forward did not return the streamed target to the second page");
    assert.equal(getClickCount(), 1, "the streamed pointer click did not reach the rail-owned browser page");
    const clicked = String(getClickCount());
    fs.writeFileSync(path.join(outDir, "last-frame.jpg"), lastBytes);
    const proof = { interactive: true, frameCount: frames.length, clicked, firstHash, lastHash };
    fs.writeFileSync(path.join(outDir, "proof.json"), `${JSON.stringify(proof, null, 2)}\n`);
    console.log(JSON.stringify({ ok: true, liveBrowserInteractive: true, liveBrowserFrames: frames.length, clicked }));
  } finally {
    if (desktop) await boundedClose(desktop.close(), 8_000);
    if (browserContext) await boundedClose(browserContext.close(), 8_000);
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(electronUserData, { recursive: true, force: true });
    fs.rmSync(browserUserData, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
