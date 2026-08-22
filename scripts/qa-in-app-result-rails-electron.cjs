#!/usr/bin/env node
"use strict";

// Production-route proof for the user's renderer contract:
// one Electron BrowserWindow, chat transcript + same-window right rail,
// automatic wide presentation, resize/collapse, live web child view, and a
// real WebGL map. This intentionally does not use the surface-preview route.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { _electron: electron } = require("playwright");
const sharp = require("sharp");

const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist", "renderer");
const outDir = path.join(root, "output", "playwright", "in-app-result-rails");

function resolveAsset(rawUrl) {
  let pathname = decodeURIComponent((rawUrl || "/").split("?")[0]);
  const nestedNext = pathname.match(/^\/.+\/(?:_next\/.+)$/);
  if (nestedNext) pathname = `/${pathname.slice(pathname.indexOf("/_next/") + 1)}`;
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
    const server = http.createServer((request, response) => {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (url.pathname === "/live-web") {
        const html = `<!doctype html><meta charset="utf-8"><title>In-app live web</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#101613;color:#f8fafc;font:18px system-ui}main{display:grid;gap:16px;text-align:center}button{padding:12px 18px;border:1px solid #67d49b;border-radius:12px;background:#173b2a;color:#fff;font:inherit}output{color:#8ff0b8}</style><main><strong>Agentlas live web result</strong><button id="counter">0</button><output id="frames">0</output></main><script>let frames=0;const f=document.querySelector('#frames');const b=document.querySelector('#counter');b.onclick=()=>b.textContent=String(Number(b.textContent)+1);function tick(){frames+=1;f.value=String(frames);requestAnimationFrame(tick)}requestAnimationFrame(tick)</script>`;
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(html);
        return;
      }
      const file = resolveAsset(request.url);
      const mime = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".json": "application/json",
        ".png": "image/png",
        ".svg": "image/svg+xml",
        ".woff2": "font/woff2",
      };
      response.writeHead(file.endsWith("404.html") ? 404 : 200, { "content-type": mime[path.extname(file)] || "application/octet-stream" });
      fs.createReadStream(file).on("error", () => response.end()).pipe(response);
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` }));
  });
}

function seedStore(userData, data) {
  const electronBinary = path.join(root, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  const result = spawnSync(electronBinary, [path.join(root, "scripts/qa-seed-result-rails-electron.cjs")], {
    cwd: root,
    env: {
      ...process.env,
      AGENTLAS_QA_SEED_JSON: JSON.stringify({ userData, ...data }),
      AGENTLAS_STORE_PATH: path.join(userData, "agentlas.sqlite"),
      AGENTLAS_E2E: "1",
      AGENTLAS_E2E_AUTH: "1",
      AGENTLAS_ALLOW_MULTI_INSTANCE: "1",
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.status !== 0) throw new Error(`QA store seed failed: ${result.stderr || result.stdout}`);
  const line = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!line) throw new Error(`QA store seed produced no result: ${result.stderr}`);
  return JSON.parse(line);
}

async function nativeChildren(desktop) {
  return desktop.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows().filter((candidate) => !candidate.isDestroyed());
    return {
      windowCount: windows.length,
      windows: windows.map((window) => ({
        url: window.webContents.getURL(),
        bounds: window.getBounds(),
        children: window.contentView.children.map((view) => ({
          type: view.constructor.name,
          url: view.webContents?.getURL() || "",
          title: view.webContents?.getTitle() || "",
          loading: view.webContents?.isLoading() || false,
          bounds: view.getBounds(),
        })),
      })),
    };
  });
}

async function compositeNative(page, desktop, target) {
  const owner = await page.screenshot({ animations: "disabled" });
  const native = await desktop.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
    if (!window) return [];
    const out = [];
    for (const child of window.contentView.children) {
      if (!child.webContents || child.webContents.isDestroyed()) continue;
      const image = await child.webContents.capturePage();
      out.push({ bounds: child.getBounds(), png: image.toPNG().toString("base64") });
    }
    return out;
  });
  const ownerMeta = await sharp(owner).metadata();
  const composites = [];
  for (const item of native) {
    if (!item.bounds.width || !item.bounds.height) continue;
    composites.push({ input: Buffer.from(item.png, "base64"), left: Math.max(0, item.bounds.x), top: Math.max(0, item.bounds.y) });
  }
  await sharp(owner).composite(composites).png().toFile(target);
  return { target, width: ownerMeta.width, height: ownerMeta.height, childCount: native.length };
}

async function waitFor(page, predicate, timeout = 30_000) {
  await page.waitForFunction(predicate, null, { timeout });
}

async function main() {
  if (!fs.existsSync(path.join(distDir, "workspace", "task.html"))) throw new Error("Build renderer first");
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const { server, baseUrl } = await startServer();
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-in-app-rails-"));
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
        ELECTRON_START_URL: `${baseUrl}/one`,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
        AGENTLAS_QA_USER_DATA_DIR: userData,
        AGENTLAS_STORE_PATH: path.join(userData, "agentlas.sqlite"),
        AGENTLAS_ALLOW_MULTI_INSTANCE: "1",
      },
      timeout: 60_000,
    });
    const page = await desktop.firstWindow({ timeout: 60_000 });
    page.on("close", () => console.error(`[in-app-rails] page closed at ${page.url()}`));
    page.on("crash", () => console.error(`[in-app-rails] page crashed at ${page.url()}`));
    desktop.on("close", () => console.error("[in-app-rails] electron application closed"));
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error" && !/favicon|Failed to load resource/i.test(message.text())) errors.push(message.text()); });
    await page.waitForURL((url) => url.origin === new URL(baseUrl).origin && url.pathname === "/one", { timeout: 60_000 });
    await page.waitForFunction(() => Boolean(window.agentlas), null, { timeout: 60_000 });
    await desktop.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window?.setSize(1800, 900);
      window?.show();
      window?.focus();
    });

    const workChat = await page.evaluate(() => window.agentlas.chats.create({ title: "In-app Work result rail QA", taskMode: "task", originSurface: "work" }));
    const workMapManifest = {
      version: "0.1",
      kind: "surface",
      title: "여행 지도 결과",
      domain: "travel",
      layout: "report",
      data: { routes: { type: "routes", summary: "실시간 방문 지점", items: [
        { locationRef: "gangnam", label: "강남역", latitude: 37.49794, longitude: 127.02762, sequence: 1 },
        { locationRef: "forest", label: "서울숲", latitude: 37.54439, longitude: 127.03744, sequence: 2 },
        { locationRef: "gwanghwamun", label: "광화문", latitude: 37.57163, longitude: 126.97685, sequence: 3 },
      ] } },
      widgets: [{ type: "map", data: "routes", title: "실시간 이동 지도" }],
      actions: [],
    };
    const workMap = seedStore(userData, {
      chatId: workChat.id,
      surface: { id: "surface-in-app-work-map", manifest: workMapManifest },
      messages: [
        { role: "user", text: "서울 이동 지점을 지도에서 보여줘." },
        { role: "assistant", text: "확인한 위치를 지도 결과로 정리했습니다. 오른쪽 패널에서 바로 탐색할 수 있습니다." },
      ],
    });
    await page.goto(`${baseUrl}/workspace/task?id=${encodeURIComponent(workChat.id)}&surface=${encodeURIComponent(workMap.surface.id)}`, { waitUntil: "domcontentloaded" });
    await waitFor(page, () => Boolean(document.querySelector(".chat-right-panel[data-active-tab=panel]")));
    await waitFor(page, () => document.querySelector("[data-map-state=ready]") !== null, 60_000);
    // style.load makes the MapLibre canvas interactive before vector tiles
    // finish painting. Let the live OpenFreeMap source fill that same canvas
    // so the screenshot proves a rendered basemap, not only WebGL.
    await page.waitForTimeout(2_500);
    const betaNotice = page.locator('[role="dialog"][aria-label*="Hub Network"], [role="dialog"][aria-label*="허브 네트워크"]');
    if (await betaNotice.count()) {
      await betaNotice.getByRole("button").first().click().catch(() => undefined);
      await betaNotice.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => undefined);
    }
    const workPanel = page.locator("aside.chat-right-panel");
    const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    const workPanelBox = await workPanel.boundingBox();
    assert.ok(workPanelBox, "Work right panel must be visible in the app window");
    assert.ok(workPanelBox.width / viewport.width >= 0.40, `Work rich result panel must open wide: ${workPanelBox.width}/${viewport.width}`);
    assert.equal(await page.locator("[data-tour-id=workspace.chat]").getByText("오른쪽 패널", { exact: false }).count().catch(() => 0), 0);
    assert.ok(await page.getByText("여행 지도 결과", { exact: true }).count() >= 1, "result must remain in the Work conversation/panel");
    const mapCanvasCount = await page.locator("[data-map-state=ready] canvas").count();
    assert.ok(mapCanvasCount > 0, "Work map must be a real MapLibre canvas");
    assert.equal(await page.locator("[data-map-state=ready] svg, [data-map-state=ready] path, [data-map-state=ready] polyline").count(), 0, "no coordinate SVG fallback");
    const workRuntime = await nativeChildren(desktop);
    assert.equal(workRuntime.windowCount, 1, "Work output must stay in the same BrowserWindow");
    await page.screenshot({ path: path.join(outDir, "work-right-panel-map.png"), animations: "disabled" });

    const workWidthBefore = workPanelBox.width;
    const workResize = page.locator('aside.chat-right-panel [role="separator"]');
    const workResizeBox = await workResize.boundingBox();
    assert.ok(workResizeBox, "Work resize handle must be visible");
    await page.mouse.move(workResizeBox.x + 2, workResizeBox.y + 150);
    await page.mouse.down();
    await page.mouse.move(workResizeBox.x - 120, workResizeBox.y + 150, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(250);
    const workPanelAfterResize = await workPanel.boundingBox();
    assert.ok(workPanelAfterResize.width > workWidthBefore + 60, `Work panel must resize by dragging: ${workWidthBefore} -> ${workPanelAfterResize.width}`);
    await page.getByRole("button", { name: /우측 패널 닫기|Close right panel/ }).click();
    await workPanel.waitFor({ state: "hidden", timeout: 10_000 });
    await page.locator('[data-right-panel-trigger="panel"]').click();
    await workPanel.waitFor({ state: "visible", timeout: 10_000 });
    assert.ok((await workPanel.boundingBox()).width >= workPanelAfterResize.width - 4, "Work panel width must survive collapse/reopen");

    const liveManifest = {
      version: "0.1",
      kind: "surface",
      title: "실시간 웹 결과",
      domain: "web",
      layout: "service-app",
      app: { name: "실시간 웹 결과", tagline: "같은 앱 안에서 실행되는 웹 결과", routes: [{ path: "/", label: "Live" }], deployment: { readiness: "local-live", previewUrl: `${baseUrl}/live-web` } },
      data: { metrics: { type: "metrics", rows: [{ label: "상태", value: "LIVE" }] } },
      widgets: [{ type: "app-shell", data: "metrics" }],
      actions: [],
    };
    const liveSurface = seedStore(userData, { chatId: workChat.id, surface: { id: "surface-in-app-work-web", manifest: liveManifest } }).surface;
    await page.goto(`${baseUrl}/workspace/task?id=${encodeURIComponent(workChat.id)}&surface=${encodeURIComponent(liveSurface.id)}`, { waitUntil: "domcontentloaded" });
    await waitFor(page, () => document.querySelector(".chat-right-panel[data-active-tab=panel]") !== null);
    await waitFor(page, () => document.querySelector('[aria-label="실시간 웹 결과 live app"]') !== null, 30_000);
    const liveBetaNotice = page.locator('[role="dialog"][aria-label*="Hub Network"], [role="dialog"][aria-label*="허브 네트워크"]');
    if (await liveBetaNotice.count()) {
      await liveBetaNotice.getByRole("button").first().click().catch(() => undefined);
      await liveBetaNotice.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => undefined);
    }
    const nativeWeb = await (async () => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const state = await nativeChildren(desktop);
        const child = state.windows.flatMap((window) => window.children).find((row) => row.url === `${baseUrl}/live-web` && !row.loading);
        if (child) return { state, child };
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return null;
    })();
    assert.ok(nativeWeb, "live web must be a native child surface in the same BrowserWindow");
    assert.equal(nativeWeb.state.windowCount, 1);
    const webInteraction = await desktop.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const child = window.contentView.children.find((view) => view.webContents?.getURL().includes("/live-web"));
      if (!child) return null;
      return child.webContents.executeJavaScript(`(async()=>{document.querySelector('#counter').click();await new Promise(r=>setTimeout(r,500));return {count:document.querySelector('#counter').textContent,frames:Number(document.querySelector('#frames').value)}})()`);
    });
    assert.ok(webInteraction && webInteraction.count === "1", "web result must remain interactive");
    assert.ok(webInteraction.frames >= 10, `web result must stay live/smooth: ${JSON.stringify(webInteraction)}`);
    await compositeNative(page, desktop, path.join(outDir, "work-right-panel-live-web.png"));

    const output = {
      ok: true,
      sameBrowserWindow: true,
      work: { panelWidth: workPanelAfterResize.width, viewportWidth: viewport.width, ratio: workPanelAfterResize.width / viewport.width, mapCanvasCount },
      liveWeb: { childUrl: nativeWeb.child.url, interaction: webInteraction },
      screenshots: ["work-right-panel-map.png", "work-right-panel-live-web.png"],
      rendererErrors: errors,
    };
    assert.equal(errors.length, 0, `renderer errors: ${errors.join(" | ")}`);
    fs.writeFileSync(path.join(outDir, "proof.json"), `${JSON.stringify(output, null, 2)}\n`);
    console.log(JSON.stringify(output));
  } finally {
    await desktop?.close().catch(() => undefined);
    server.close();
    fs.rmSync(userData, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
