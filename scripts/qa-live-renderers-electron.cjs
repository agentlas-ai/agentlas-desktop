#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { _electron: electron } = require("playwright");
const sharp = require("sharp");

const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist", "renderer");
const outDir = path.join(root, "output", "playwright", "live-renderers-electron");

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

function startRendererServer() {
  return new Promise((resolve) => {
    const server = http.createServer((request, response) => {
      const file = resolveAsset(request.url);
      const mime = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".png": "image/png",
        ".svg": "image/svg+xml",
      };
      response.writeHead(file.endsWith("404.html") ? 404 : 200, {
        "content-type": mime[path.extname(file)] || "application/octet-stream",
      });
      fs.createReadStream(file).pipe(response);
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function nativeViewState(desktop) {
  return desktop.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) return [];
    return window.contentView.children.map((view) => ({
      type: view.constructor.name,
      bounds: view.getBounds(),
      url: view.webContents?.getURL() || "",
      title: view.webContents?.getTitle() || "",
      loading: view.webContents?.isLoading() || false,
    }));
  });
}

async function waitForNativeView(desktop, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let rows = [];
  while (Date.now() < deadline) {
    rows = await nativeViewState(desktop);
    const match = rows.find(predicate);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`native live view did not become ready: ${JSON.stringify(rows)}`);
}

async function main() {
  if (!fs.existsSync(path.join(distDir, "surface-preview.html"))) {
    throw new Error("dist/renderer is missing; run npm run build:renderer first");
  }
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-live-renderers-electron-"));
  const { server, baseUrl } = await startRendererServer();
  const manifest = {
    version: "0.1",
    kind: "surface",
    title: "Smooth Live Output",
    domain: "live-output-qa",
    layout: "service-app",
    app: {
      name: "Smooth Live Output",
      tagline: "Actual generated app runtime",
      routes: [{ path: "/", label: "Live stage", purpose: "Run real interactive output" }],
      deployment: { readiness: "local-live" },
    },
    data: { metrics: { type: "metrics", rows: [{ label: "Frames", value: "live" }] } },
    widgets: [{ type: "app-shell", data: "metrics" }],
    actions: [{ id: "scaffold", label: "Build app", type: "scaffold-app", permission: "write", enabled: true }],
  };
  const oneMapManifest = {
    contractVersion: "1.0.0",
    manifestId: "manifest-live-map-qa",
    taskId: "task-live-map-qa",
    title: "실시간 이동 지도",
    summary: "확인된 위치를 실제 지도로 탐색합니다.",
    layoutProfile: "itinerary",
    surfaceState: { value: "ready", summary: "지도 준비 완료", readOnly: true, lastSyncedAt: new Date().toISOString() },
    blocks: [{
      blockId: "block-live-map",
      type: "Map",
      title: "서울 이동 경로",
      locations: [
        { locationRef: "gangnam-station", label: "강남역", latitude: 37.49794, longitude: 127.02762, sequence: 1 },
        { locationRef: "seoul-forest", label: "서울숲", latitude: 37.54439, longitude: 127.03744, sequence: 2 },
        { locationRef: "gwanghwamun", label: "광화문", latitude: 37.57163, longitude: 126.97685, sequence: 3 },
      ],
    }],
    primaryAction: null,
    secondaryActions: [],
    evidence: [],
    fallback: { markdown: "실시간 지도 연결이 필요합니다.", artifacts: [] },
    recomposition: {
      desktop: { blockOrder: ["block-live-map"], tableStrategy: "full_table", comparisonStrategy: "matrix", timelineStrategy: "adaptive" },
      mobile: { blockOrder: ["block-live-map"], tableStrategy: "stacked_rows", comparisonStrategy: "recommended_then_alternatives", timelineStrategy: "vertical" },
    },
  };
  const workMapManifest = {
    version: "0.1",
    kind: "surface",
    title: "여행 검색 결과",
    domain: "travel",
    layout: "report",
    data: {
      routes: {
        type: "routes",
        summary: "검증된 숙소와 이동 지점",
        items: oneMapManifest.blocks[0].locations,
      },
    },
    widgets: [{ type: "map", data: "routes", title: "숙소 주변 지도" }],
    actions: [],
  };

  let desktop;
  try {
    desktop = await electron.launch({
      args: [root, `--user-data-dir=${userData}`],
      cwd: root,
      env: {
        ...process.env,
        AGENTLAS_E2E: "1",
        AGENTLAS_E2E_AUTH: "1",
        NODE_ENV: "development",
        ELECTRON_START_URL: `${baseUrl}/surface-preview`,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      },
      timeout: 30_000,
    });
    const page = await desktop.firstWindow({ timeout: 30_000 });
    const rendererErrors = [];
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" && !/favicon|Failed to load resource/i.test(message.text())) {
        rendererErrors.push(message.text());
      }
    });
    // Main first paints a startup placeholder and then loads ELECTRON_START_URL.
    // Wait for that authoritative load so it cannot abort this QA navigation.
    await page.waitForURL(
      (url) => url.origin === new URL(baseUrl).origin && url.pathname === "/surface-preview",
      { timeout: 60_000 },
    );

    const scaffold = await page.evaluate(async (surfaceManifest) => {
      const chat = await window.agentlas.chats.create({
        title: "Live renderer QA",
        taskMode: "conversation",
        originSurface: "work",
      });
      return window.agentlas.appFactory.scaffold({
        chatId: chat.id,
        surfaceId: "surface-live-renderer-qa",
        actionId: "scaffold",
        manifest: surfaceManifest,
      });
    }, manifest);
    assert.ok(scaffold.record?.id, "App Factory must create a durable app record through the real preload API");
    assert.ok(fs.existsSync(path.join(scaffold.rootPath, "src", "index.html")), "the generated app UI must exist on disk");

    const sampleVideo = path.join(scaffold.rootPath, "src", "sample.webm");
    const ffmpeg = spawnSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
      "-t", "2", "-c:v", "libvpx-vp9", "-b:v", "240k", "-c:a", "libopus", sampleVideo,
    ], { encoding: "utf8" });
    assert.equal(ffmpeg.status, 0, `video fixture generation failed: ${ffmpeg.stderr}`);

    const query = new URLSearchParams({
      appId: scaffold.record.id,
      manifest: JSON.stringify(manifest),
    });
    await page.goto(`${baseUrl}/surface-preview?${query.toString()}`, { waitUntil: "commit" });
    await page.getByText("LIVE", { exact: true }).waitFor({ timeout: 20_000 });
    const firstView = await waitForNativeView(desktop, (row) => row.url.startsWith("http://127.0.0.1:") && !row.loading);
    assert.ok(firstView.bounds.width > 300 && firstView.bounds.height > 300, `native app bounds are not usable: ${JSON.stringify(firstView.bounds)}`);

    const isolation = await desktop.evaluate(async ({ BrowserWindow }) => {
      const view = BrowserWindow.getAllWindows()[0].contentView.children.find((candidate) => candidate.webContents?.getURL().startsWith("http://127.0.0.1:"));
      return view.webContents.executeJavaScript("({ agentlas: typeof window.agentlas, nodeRequire: typeof window.require, process: typeof window.process })");
    });
    assert.deepEqual(isolation, { agentlas: "undefined", nodeRequire: "undefined", process: "undefined" }, "live app must receive no Desktop or Node bridge");

    const liveHtml = `<!doctype html><html><head><meta charset="utf-8"><title>Realtime Media B</title><style>body{margin:0;background:#101713;color:white;font:16px system-ui;display:grid;place-items:center;min-height:100vh}main{display:grid;gap:14px;text-align:center}video{width:320px;border-radius:14px}button{padding:10px 16px}</style></head><body><main><strong>Realtime B</strong><video id="sample" src="/sample.webm" muted loop autoplay playsinline controls></video><button id="counter" onclick="this.textContent=String(Number(this.textContent)+1)">0</button><output id="frames">0</output></main><script>let frames=0;const out=document.querySelector('#frames');function tick(){frames+=1;out.value=String(frames);requestAnimationFrame(tick)}requestAnimationFrame(tick)</script></body></html>`;
    fs.writeFileSync(path.join(scaffold.rootPath, "src", "index.html"), liveHtml);
    await waitForNativeView(desktop, (row) => row.title === "Realtime Media B" && !row.loading);

    const interaction = await desktop.evaluate(async ({ BrowserWindow }) => {
      const view = BrowserWindow.getAllWindows()[0].contentView.children.find((candidate) => candidate.webContents?.getTitle() === "Realtime Media B");
      return view.webContents.executeJavaScript(`(async () => {
        const button = document.querySelector('#counter');
        const video = document.querySelector('#sample');
        button.click();
        await video.play();
        await new Promise((resolve) => setTimeout(resolve, 700));
        return {
          count: button.textContent,
          frames: Number(document.querySelector('#frames').value),
          readyState: video.readyState,
          currentTime: video.currentTime,
          paused: video.paused,
        };
      })()`);
    });
    assert.equal(interaction.count, "1", "pointer/click interaction must execute inside the real app");
    assert.ok(interaction.frames >= 10, `requestAnimationFrame must remain smooth in-app: ${JSON.stringify(interaction)}`);
    assert.ok(interaction.readyState >= 3 && interaction.currentTime > 0 && interaction.paused === false,
      `native video playback must advance: ${JSON.stringify(interaction)}`);

    const liveCapture = await desktop.evaluate(async ({ BrowserWindow }) => {
      const view = BrowserWindow.getAllWindows()[0].contentView.children.find((candidate) => candidate.webContents?.getTitle() === "Realtime Media B");
      const image = await view.webContents.capturePage();
      return image.toPNG().toString("base64");
    });
    fs.writeFileSync(path.join(outDir, "native-live-app.png"), Buffer.from(liveCapture, "base64"));
    await page.screenshot({ path: path.join(outDir, "work-live-runtime-shell.png"), fullPage: true });

    const mapResponses = [];
    page.on("response", (response) => {
      if (/openfreemap\.org/.test(response.url())) mapResponses.push({
        url: response.url(),
        status: response.status(),
        contentType: response.headers()["content-type"] || "",
      });
    });
    const mapQuery = new URLSearchParams({ manifest: JSON.stringify(oneMapManifest) });
    await page.goto(`${baseUrl}/surface-preview?${mapQuery.toString()}`, { waitUntil: "commit" });
    const mapRoot = page.locator('[data-map-state="ready"]');
    try {
      await mapRoot.waitFor({ timeout: 30_000 });
    } catch (error) {
      await page.screenshot({ path: path.join(outDir, "one-live-map-diagnostic.png"), fullPage: true }).catch(() => undefined);
      const diagnostic = await page.evaluate(() => ({
        url: location.href,
        mapStates: [...document.querySelectorAll("[data-map-state]")].map((element) => element.getAttribute("data-map-state")),
        alerts: [...document.querySelectorAll('[role="alert"]')].map((element) => element.textContent?.trim()),
        text: document.body.innerText.slice(0, 2_000),
      })).catch(() => null);
      throw new Error(`One live map did not become ready: ${JSON.stringify({ diagnostic, rendererErrors, cause: String(error) })}`);
    }
    const canvas = mapRoot.locator("canvas").first();
    const mapBounds = await canvas.boundingBox();
    assert.ok(mapBounds && mapBounds.width > 500 && mapBounds.height > 260,
      `One map canvas is not usable: ${JSON.stringify(mapBounds)}`);
    const coordinateSvgElements = await mapRoot.locator("svg, path, polyline").count();
    assert.equal(coordinateSvgElements, 0, "One map must render coordinates through WebGL canvas, never an SVG path");
    assert.ok(mapResponses.some((response) => response.status >= 200 && response.status < 400),
      `the live basemap did not return a successful response: ${JSON.stringify(mapResponses.slice(0, 5))}`);
    await page.waitForTimeout(3_000);
    const lastMapErrorBeforeTiles = await mapRoot.locator('[role="application"]').getAttribute("data-map-last-error");
    assert.ok(mapResponses.some((response) => /\/planet\/.+\.pbf(?:$|\?)/.test(response.url) && response.status === 200),
      `the live vector tiles did not load: ${JSON.stringify({ lastMapErrorBeforeTiles, responses: mapResponses.slice(-20) })}`);
    const beforeMap = await canvas.screenshot();
    await page.getByRole("button", { name: /광화문/ }).click();
    await page.waitForTimeout(900);
    const afterMap = await canvas.screenshot();
    const beforeMapHash = crypto.createHash("sha256").update(beforeMap).digest("hex");
    const afterMapHash = crypto.createHash("sha256").update(afterMap).digest("hex");
    assert.notEqual(afterMapHash, beforeMapHash, "selecting a location must visibly move the real map");
    const mapPixelStats = await sharp(afterMap).stats();
    assert.ok(mapPixelStats.entropy > 1,
      `the WebGL canvas is visually blank: ${JSON.stringify({ entropy: mapPixelStats.entropy, mapResponses: mapResponses.slice(-20) })}`);
    await mapRoot.screenshot({ path: path.join(outDir, "one-live-map.png") });

    const workMapQuery = new URLSearchParams({ manifest: JSON.stringify(workMapManifest) });
    await page.goto(`${baseUrl}/surface-preview?${workMapQuery.toString()}`, { waitUntil: "commit" });
    const sidebarMapRoot = page.locator('[data-surface-renderer="live-map"] [data-map-state="ready"]');
    await sidebarMapRoot.waitFor({ timeout: 30_000 });
    const sidebarCanvas = sidebarMapRoot.locator("canvas").first();
    const sidebarMapBounds = await sidebarCanvas.boundingBox();
    assert.ok(sidebarMapBounds && sidebarMapBounds.width > 300 && sidebarMapBounds.height > 250,
      `Work sidebar map canvas is not usable: ${JSON.stringify(sidebarMapBounds)}`);
    const sidebarCoordinateSvgElements = await sidebarMapRoot.locator("svg, path, polyline").count();
    assert.equal(sidebarCoordinateSvgElements, 0, "Work sidebar coordinates must also use WebGL canvas, never SVG paths");
    await page.waitForTimeout(2_000);
    const sidebarBeforeMap = await sidebarCanvas.screenshot();
    await page.getByRole("button", { name: /광화문/ }).click();
    await page.waitForTimeout(900);
    const sidebarAfterMap = await sidebarCanvas.screenshot();
    const sidebarBeforeMapHash = crypto.createHash("sha256").update(sidebarBeforeMap).digest("hex");
    const sidebarAfterMapHash = crypto.createHash("sha256").update(sidebarAfterMap).digest("hex");
    assert.notEqual(sidebarAfterMapHash, sidebarBeforeMapHash,
      "selecting a Work sidebar location must visibly move its real map");
    const sidebarPixelStats = await sharp(sidebarAfterMap).stats();
    assert.ok(sidebarPixelStats.entropy > 1,
      `the Work sidebar WebGL canvas is visually blank: ${JSON.stringify({ entropy: sidebarPixelStats.entropy })}`);
    await sidebarMapRoot.screenshot({ path: path.join(outDir, "work-sidebar-live-map.png") });
    assert.deepEqual(rendererErrors, [], `renderer errors: ${rendererErrors.join("\n")}`);

    fs.writeFileSync(path.join(outDir, "proof.json"), `${JSON.stringify({
      appId: scaffold.record.id,
      nativeView: firstView,
      isolation,
      interaction,
      liveMap: {
        bounds: mapBounds,
        coordinateSvgElements,
        successfulBasemapResponses: mapResponses.filter((response) => response.status >= 200 && response.status < 400).length,
        vectorTileResponses: mapResponses.filter((response) => /\/planet\/.+\.pbf(?:$|\?)/.test(response.url) && response.status === 200).length,
        pixelEntropy: mapPixelStats.entropy,
        lastMapError: await page.locator('[role="application"]').first().getAttribute("data-map-last-error"),
        beforeMapHash,
        afterMapHash,
      },
      sidebarMap: {
        bounds: sidebarMapBounds,
        coordinateSvgElements: sidebarCoordinateSvgElements,
        pixelEntropy: sidebarPixelStats.entropy,
        beforeMapHash: sidebarBeforeMapHash,
        afterMapHash: sidebarAfterMapHash,
      },
      artifacts: ["native-live-app.png", "work-live-runtime-shell.png", "one-live-map.png", "work-sidebar-live-map.png"],
    }, null, 2)}\n`);
    console.log(JSON.stringify({
      ok: true,
      durableAppRecord: true,
      nativeInAppRuntime: true,
      isolated: true,
      realtimeReload: true,
      interactive: true,
      smoothFrames: interaction.frames,
      videoTime: interaction.currentTime,
      interactiveWebglMap: true,
      coordinateSvgElements,
      workSidebarWebglMap: true,
    }));
  } finally {
    if (desktop) {
      let child = null;
      try { child = desktop.process(); } catch {}
      let closed = false;
      await Promise.race([
        desktop.close().then(() => { closed = true; }).catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 12_000)),
      ]);
      if (!closed && child?.exitCode === null) child.kill("SIGTERM");
    }
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(userData, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
