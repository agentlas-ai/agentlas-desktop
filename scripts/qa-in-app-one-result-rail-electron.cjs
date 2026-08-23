#!/usr/bin/env node
"use strict";

// Production-route proof for One's integrated result rail. This deliberately
// opens `/one?task=...`, seeds the same Main-owned Task/receipt/surface records
// used by the live product, and asserts one BrowserWindow plus a real MapLibre
// canvas in the right-hand rail.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { _electron: electron } = require("playwright");

const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist", "renderer");
const outDir = path.join(root, "output", "playwright", "in-app-one-result-rail");

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
      response.writeHead(file.endsWith("404.html") ? 404 : 200, {
        "content-type": mime[path.extname(file)] || "application/octet-stream",
        "cache-control": "no-store",
      });
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
  if (result.status !== 0) throw new Error(`QA One seed failed: ${result.stderr || result.stdout}`);
  const line = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!line) throw new Error(`QA One seed produced no result: ${result.stderr}`);
  return JSON.parse(line);
}

async function nativeWindowState(desktop) {
  return desktop.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows().filter((candidate) => !candidate.isDestroyed());
    return {
      windowCount: windows.length,
      children: windows.flatMap((window) => window.contentView.children.map((view) => ({
        url: view.webContents?.getURL() || "",
        bounds: view.getBounds(),
      }))),
    };
  });
}

async function waitFor(page, predicate, timeout = 30_000) {
  await page.waitForFunction(predicate, null, { timeout });
}

async function findLiveRendererPage(desktop, baseUrl, timeout = 60_000) {
  // Prefer Playwright's first stable page just like the Work rail proof. The
  // startup placeholder can be replaced in-place, so this fast path avoids
  // missing the Main bridge while repeatedly scanning transient handles.
  try {
    const first = await desktop.firstWindow({ timeout });
    await first.waitForURL((url) => url.origin === new URL(baseUrl).origin && url.pathname === "/one", { timeout });
    await first.waitForFunction(() => Boolean(window.agentlas), null, { timeout });
    return first;
  } catch {
    // Fall through to the rescan below when the placeholder page was closed or
    // the renderer restarted during startup.
  }
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const candidate of desktop.windows()) {
      if (candidate.isClosed()) continue;
      try {
        if (!candidate.url().startsWith(baseUrl)) {
          await candidate.waitForURL((url) => url.origin === new URL(baseUrl).origin && url.pathname === "/one", { timeout: 1_000 });
        }
        if (!candidate.url().startsWith(baseUrl)) continue;
        await candidate.waitForFunction(() => Boolean(window.agentlas), null, { timeout: 1_000 });
        return candidate;
      } catch {
        // Startup placeholder and an occasional renderer restart can close a
        // Page handle. Re-scan BrowserWindow children instead of pinning QA to
        // that transient handle.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("One QA did not receive a stable renderer page with the Main bridge");
}

async function main() {
  assert.ok(fs.existsSync(path.join(distDir, "one.html")), "Build renderer first");
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const { server, baseUrl } = await startServer();
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-in-app-one-rail-"));
  let desktop;
  try {
    desktop = await electron.launch({
      args: [root, `--user-data-dir=${userData}`],
      cwd: root,
      env: {
        ...process.env,
        AGENTLAS_E2E: "1",
        AGENTLAS_E2E_AUTH: "1",
        AGENTLAS_ALLOW_MULTI_INSTANCE: "1",
        NODE_ENV: "development",
        ELECTRON_START_URL: `${baseUrl}/one`,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
        AGENTLAS_QA_USER_DATA_DIR: userData,
        AGENTLAS_STORE_PATH: path.join(userData, "agentlas.sqlite"),
      },
      timeout: 60_000,
    });
    // The app paints a short-lived startup placeholder before navigating the
    // same BrowserWindow to the renderer. Select a stable live page after the
    // bridge is present rather than pinning QA to that transient handle.
    const page = await findLiveRendererPage(desktop, baseUrl);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" && !/favicon|Failed to load resource/i.test(message.text())) errors.push(message.text());
    });
    await desktop.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window?.setSize(1800, 900);
      window?.show();
      window?.focus();
    });

    const chat = await page.evaluate(() => window.agentlas.chats.create({
      title: "In-app One result rail QA",
      taskMode: "task",
      originSurface: "one",
    }));
    const oneSurfaceManifest = {
      contractVersion: "1.0.0",
      manifestId: "manifest-in-app-one-map",
      taskId: "placeholder-task-id",
      title: "실시간 이동 지도",
      summary: "확인된 위치를 실제 지도에서 탐색합니다.",
      layoutProfile: "itinerary",
      surfaceState: { value: "ready", summary: "지도 준비 완료", readOnly: true, lastSyncedAt: new Date().toISOString() },
      blocks: [{
        blockId: "block-in-app-one-map",
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
        desktop: { blockOrder: ["block-in-app-one-map"], tableStrategy: "full_table", comparisonStrategy: "matrix", timelineStrategy: "adaptive" },
        mobile: { blockOrder: ["block-in-app-one-map"], tableStrategy: "stacked_rows", comparisonStrategy: "recommended_then_alternatives", timelineStrategy: "vertical" },
      },
    };
    const artifactDir = path.join(userData, "generated-assets", "qa-code");
    fs.mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
    const codeArtifactPath = path.join(artifactDir, "App.tsx");
    fs.writeFileSync(codeArtifactPath, `export function App() {\n  return <main data-live=\"true\">Agentlas live output</main>;\n}\n`, { mode: 0o600 });
    // macOS exposes the temporary directory through /var while fs.realpath
    // returns its canonical /private/var spelling. Bind the canonical path
    // that Main will reopen so this QA matches production path authority.
    const canonicalCodeArtifactPath = fs.realpathSync(codeArtifactPath);
    const seeded = seedStore(userData, {
      chatId: chat.id,
      ensureTask: true,
      oneSurface: { runId: "qa-one-map-run", manifest: oneSurfaceManifest, artifactPaths: [canonicalCodeArtifactPath] },
      messages: [
        { role: "user", text: "서울 이동 지점을 실제 지도에서 보여줘." },
        { role: "assistant", text: "확인된 위치를 실시간 지도 결과로 정리했습니다. 오른쪽 출력 패널에서 바로 탐색할 수 있습니다." },
      ],
    });
    assert.ok(seeded.task?.id, "One QA must seed a canonical task");
    assert.equal(seeded.artifactCount, 1, `One QA must bind the code artifact: ${JSON.stringify(seeded)}`);
    await page.goto(`${baseUrl}/one?task=${encodeURIComponent(seeded.task.id)}`, { waitUntil: "domcontentloaded" });
    await waitFor(page, () => document.querySelector('[data-one-runtime-artifacts="true"]') !== null, 60_000);
    await waitFor(page, () => document.querySelector('[data-map-state="ready"]') !== null, 60_000);
    await page.waitForTimeout(2_500);

    const betaNotice = page.locator('[role="dialog"][aria-label*="Hub Network"], [role="dialog"][aria-label*="허브 네트워크"]');
    if (await betaNotice.count()) {
      await betaNotice.getByRole("button").first().click().catch(() => undefined);
      await betaNotice.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => undefined);
    }

    const rail = page.locator('[data-one-runtime-artifacts="true"]');
    const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    const railBox = await rail.boundingBox();
    assert.ok(railBox, "One output rail must be visible in the app window");
    const designTokens = await rail.evaluate((node) => {
      const root = getComputedStyle(document.documentElement);
      return {
        source: node.getAttribute("data-design-token-source"),
        contract: node.getAttribute("data-design-token-contract"),
        surface: node.getAttribute("data-design-surface"),
        bg: root.getPropertyValue("--design-bg").trim(),
        accent: root.getPropertyValue("--design-accent").trim(),
      };
    });
    assert.equal(designTokens.source, "builtin:design@0.1.0", "One output rail must declare the built-in design token source");
    assert.equal(designTokens.contract, "output-surface.v1", "One output rail must use the output token contract");
    assert.equal(designTokens.surface, "map", "One map rail must expose the map token surface");
    assert.ok(designTokens.bg && designTokens.accent, "One output rail must resolve semantic design tokens");
    const railPresentation = await rail.evaluate((node) => ({
      kind: node.getAttribute("data-output-kind"),
      wide: node.getAttribute("data-output-wide"),
      autoWidth: node.getAttribute("data-output-auto-width"),
    }));
    const expectedAutoWidth = Math.round(viewport.width * 0.432);
    assert.equal(railPresentation.kind, "map", "One map result must be classified as a map output");
    assert.equal(railPresentation.wide, "true", "One map result must mark the output as wide");
    assert.equal(railPresentation.autoWidth, "true", "One map result must trigger automatic rail width");
    assert.ok(Math.abs(railBox.width - expectedAutoWidth) <= 2, `One rich output rail must open at the reference width: ${railBox.width} vs ${expectedAutoWidth}`);
    assert.ok(await page.getByText("실시간 이동 지도", { exact: true }).count() >= 1, "One result title must remain in the output rail");
    assert.ok(await page.getByText("실시간 지도 결과로 정리했습니다", { exact: false }).count() >= 1, "One transcript must retain the result message");
    assert.ok(await page.locator('[data-map-state="ready"] canvas').count() > 0, "One map must be a real MapLibre canvas");
    assert.equal(await page.locator('[data-map-state="ready"] svg, [data-map-state="ready"] path, [data-map-state="ready"] polyline').count(), 0, "One map must not use coordinate SVG fallback");
    assert.equal((await nativeWindowState(desktop)).windowCount, 1, "One output must stay in the same BrowserWindow");
    await page.screenshot({ path: path.join(outDir, "one-right-panel-map.png"), animations: "disabled" });

    await page.getByRole("tab", { name: /Activity/ }).click();
    try {
      await waitFor(page, () => document.querySelector('[data-one-runtime-artifacts="true"] [data-preview-kind]') !== null, 60_000);
    } catch (error) {
      const debug = await page.evaluate(() => ({
        runtimeAttr: document.querySelector('[data-one-runtime-artifacts]')?.getAttribute('data-one-runtime-artifacts') ?? null,
        railText: document.querySelector('[data-one-runtime-artifacts]')?.textContent?.slice(0, 2_000) ?? null,
        artifactCards: document.querySelectorAll('[data-preview-kind]').length,
        bodyText: document.body?.innerText?.slice(-4_000) ?? null,
      })).catch(() => null);
      await page.screenshot({ path: path.join(outDir, 'one-artifact-timeout.png'), animations: 'disabled' }).catch(() => undefined);
      throw new Error(`One artifact card did not render: ${JSON.stringify(debug)}; ${error?.message || error}`);
    }
    const codeCard = rail.locator('[data-preview-kind="file"], [data-preview-kind="data"]').filter({ hasText: "App.tsx" }).first();
    await codeCard.getByRole("button", { name: /열기|Open/ }).click();
    await page.waitForSelector('[data-code-ide="true"]', { timeout: 30_000 });
    assert.ok(await page.locator('[data-code-ide="true"] strong').count() > 0, "code artifact must open in the in-app IDE viewer");
    assert.ok(await page.getByText("export function App", { exact: false }).count() > 0, "the IDE must render the artifact bytes");
    await page.screenshot({ path: path.join(outDir, "one-right-panel-code-ide.png"), animations: "disabled" });

    const resize = page.locator('[data-one-rail-resize="true"]');
    const resizeBox = await resize.boundingBox();
    assert.ok(resizeBox, "One output rail resize handle must be visible");
    const widthBefore = railBox.width;
    await page.mouse.move(resizeBox.x + 2, resizeBox.y + 180);
    await page.mouse.down();
    await page.mouse.move(resizeBox.x - 120, resizeBox.y + 180, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(250);
    const railAfterResize = await rail.boundingBox();
    assert.ok(railAfterResize.width > widthBefore + 60, `One output rail must resize by dragging: ${widthBefore} -> ${railAfterResize.width}`);
    await page.getByRole("button", { name: /출력 패널 접기|Collapse output panel/ }).click();
    await rail.waitFor({ state: "hidden", timeout: 10_000 });
    await page.locator('[data-one-output-toggle="true"]').click();
    await rail.waitFor({ state: "visible", timeout: 10_000 });
    await page.waitForTimeout(250);
    const railAfterReopen = await rail.boundingBox();
    assert.ok(railAfterReopen, "One output rail must be measurable after collapse/reopen");
    if (railAfterReopen.width < railAfterResize.width - 4) {
      const railDebug = await page.evaluate(() => {
        const body = document.querySelector('[data-rail-open]');
        const rail = document.querySelector('[data-one-runtime-artifacts="true"]');
        if (!(body instanceof HTMLElement) || !(rail instanceof HTMLElement)) return null;
        const style = getComputedStyle(rail);
        const priorGrid = body.style.gridTemplateColumns;
        body.style.gridTemplateColumns = "252px minmax(0, 1fr) 900px";
        const forcedRailRect = rail.getBoundingClientRect().toJSON();
        body.style.gridTemplateColumns = priorGrid;
        return {
          innerWidth: window.innerWidth,
          bodyColumns: getComputedStyle(body).gridTemplateColumns,
          railVariable: getComputedStyle(body).getPropertyValue("--one-rail-width"),
          bodyInlineStyle: body.getAttribute("style"),
          bodyRect: body.getBoundingClientRect().toJSON(),
          railRect: rail.getBoundingClientRect().toJSON(),
          inlineWidth: rail.style.width,
          computedWidth: style.width,
          position: style.position,
          media1080: window.matchMedia("(max-width: 1080px)").matches,
          forcedRailRect,
        };
      });
      throw new Error(`One output rail width must survive collapse/reopen: ${railAfterResize.width} -> ${railAfterReopen.width}; ${JSON.stringify(railDebug)}`);
    }

    const output = {
      ok: true,
      sameBrowserWindow: true,
      one: { initialPanelWidth: railBox.width, panelWidth: railAfterResize.width, viewportWidth: viewport.width, ratio: railAfterResize.width / viewport.width, mapCanvasCount: await page.locator('[data-map-state="ready"] canvas').count() },
      designTokens,
      screenshots: ["one-right-panel-map.png", "one-right-panel-code-ide.png"],
      codeIde: true,
      rendererErrors: errors,
    };
    assert.equal(errors.length, 0, `renderer errors: ${errors.join(" | ")}`);
    fs.writeFileSync(path.join(outDir, "proof.json"), `${JSON.stringify(output, null, 2)}\n`);
    console.log(JSON.stringify(output));
  } finally {
    await desktop?.close().catch(() => undefined);
    server.close();
    try {
      fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (error) {
      process.stderr.write(`[qa-one] temporary profile cleanup deferred: ${error?.message || error}\n`);
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
