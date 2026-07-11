#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");
const { setupMockAgentlasBridge, mockBridgeOptions } = require("./lib/mock-agentlas-bridge.cjs");

const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist", "renderer");
const outDir = path.join(root, "output", "playwright", "all-routes-ui");
const viewports = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "compact", width: 900, height: 700 },
];
const routes = [
  ["home", "/index.html"],
  ["dashboard", "/dashboard.html"],
  ["chat", "/chat.html?id=chat-1"],
  ["chat-archived", "/chat/archived.html"],
  ["project-new", "/project/new.html"],
  ["project-detail", "/project/detail.html?id=project-1"],
  ["automation", "/automation.html"],
  ["automation-new", "/automation/new.html"],
  ["automation-detail", "/automation/detail.html?id=automation-1"],
  ["automation-flow", "/automation/flow.html?id=automation-1"],
  ["browser", "/browser.html"],
  ["connect", "/connect.html"],
  ["build", "/build.html"],
  ["agents", "/library/agents.html"],
  ["agent-groups", "/library/agent-groups.html"],
  ["env", "/library/env.html"],
  ["mcps", "/library/mcps.html"],
  ["library", "/library.html"],
  ["cloud", "/cloud.html"],
  ["marketplace", "/marketplace.html"],
  ["apps", "/apps.html"],
  ["document-studio", "/apps/document-studio.html"],
  ["generated-app", "/apps/generated.html?id=generated-1"],
  ["oberon", "/oberon.html"],
  ["trex", "/trex.html"],
  ["site", "/site.html"],
  ["startup-founder-studio", "/startup-founder-studio.html"],
  ["prompts", "/prompts.html"],
  ["settings", "/settings.html"],
  ["firm-detail", "/firm/detail.html?id=firm-1"],
  ["qa-qsheet", "/qa-qsheet.html"],
  ["surface-preview", "/surface-preview.html"],
  ["trex-gallery", "/trex-gallery.html", { expectProductionBlank: true }],
];

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
    ".txt": "text/plain; charset=utf-8",
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

async function inspectRoute(browser, baseUrl, route, viewport) {
  const [name, url, options = {}] = route;
  const context = await browser.newContext({ viewport });
  await context.addInitScript(setupMockAgentlasBridge, mockBridgeOptions({ teamRoster: true, hiredRoster: true }));
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" && !/favicon|Failed to load resource/i.test(message.text())) {
      errors.push(`console: ${message.text()}`);
    }
  });

  let navigationError = null;
  try {
    await page.goto(`${baseUrl}${url}`, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page.waitForTimeout(500);
  } catch (error) {
    navigationError = error instanceof Error ? error.message : String(error);
  }

  const metrics = await page.evaluate(() => {
    const bodyText = (document.body?.innerText || "").trim();
    const doc = document.documentElement;
    const visible = [...document.querySelectorAll("body *")].filter((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    });
    const escaped = visible
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.right > doc.clientWidth + 2 || rect.left < -2;
      })
      .slice(0, 8)
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        className: String(element.className || "").slice(0, 100),
        text: String(element.textContent || "").trim().replace(/\s+/g, " ").slice(0, 100),
      }));
    return {
      bodyLength: bodyText.length,
      bodyStart: bodyText.slice(0, 200),
      documentWidth: doc.scrollWidth,
      viewportWidth: doc.clientWidth,
      escaped,
      errorBoundaryVisible: /문제가 생겼어요|Something went wrong/.test(bodyText),
    };
  });

  if (name === "oberon" && !navigationError) {
    const contract = await page.evaluate(() => {
      const text = document.body?.innerText || "";
      const appsLinks = [...document.querySelectorAll("a")]
        .filter((anchor) => (anchor.textContent || "").trim() === "Apps")
        .length;
      return {
        hasProductionHome: /프로덕션 홈|PRODUCTION HOME/.test(text),
        hasPipeline: /실제 제작 게이트|Production gates/.test(text),
        hasFirstStage: /소스 · 모델|Source · models/.test(text),
        hasLastStage: /편집 · 납품|Edit · delivery/.test(text),
        hasStart: /새 제작 시작|New production/.test(text),
        hasRetiredHero: /MAKE VIDEOS PROGRAMMATICALLY|오베론 제작 스튜디오/.test(text),
        appsLinks,
      };
    });
    if (!contract.hasProductionHome || !contract.hasPipeline || !contract.hasFirstStage || !contract.hasLastStage || !contract.hasStart) {
      errors.push(`contract: Oberon production home is missing real workflow controls ${JSON.stringify(contract)}`);
    }
    if (contract.hasRetiredHero) errors.push("contract: retired marketing hero is still visible");
    if (contract.appsLinks > 1) errors.push(`contract: duplicate Apps navigation (${contract.appsLinks})`);
  }

  const uniqueErrors = [...new Set(errors)];
  const result = {
    name,
    url,
    viewport: viewport.name,
    navigationError,
    errors: uniqueErrors,
    metrics,
  };
  const bodyContractFailed = options.expectProductionBlank ? metrics.bodyLength !== 0 : metrics.bodyLength < 20;
  const failed = Boolean(
    navigationError ||
      uniqueErrors.length ||
      bodyContractFailed ||
      metrics.documentWidth > metrics.viewportWidth + 2 ||
      metrics.errorBoundaryVisible,
  );
  if (failed || viewport.name === "desktop") {
    await page.screenshot({
      path: path.join(outDir, `${name}-${viewport.name}${failed ? "-failed" : ""}.png`),
      fullPage: true,
    });
  }
  await context.close();
  return { ...result, status: failed ? "failed" : "pass" };
}

async function main() {
  if (!fs.existsSync(path.join(distDir, "dashboard.html"))) {
    throw new Error("dist/renderer is missing; run npm run build:renderer first");
  }
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const { server, baseUrl } = await startServer();
  const browser = await chromium.launch();
  const results = [];
  try {
    for (const viewport of viewports) {
      for (const route of routes) {
        const result = await inspectRoute(browser, baseUrl, route, viewport);
        results.push(result);
        console.log(`[all-routes-ui] ${viewport.name} ${route[0]} ${result.status}`);
      }
    }
  } finally {
    await browser.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }

  const failures = results.filter((result) => result.status === "failed");
  fs.writeFileSync(
    path.join(outDir, "proof-summary.json"),
    `${JSON.stringify({ recordedAt: new Date().toISOString(), results, failures }, null, 2)}\n`,
  );
  assert.deepEqual(failures, [], `All-route UI failures:\n${JSON.stringify(failures, null, 2)}`);
  console.log(`all-route UI contract passed (${routes.length} routes × ${viewports.length} viewports)`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
