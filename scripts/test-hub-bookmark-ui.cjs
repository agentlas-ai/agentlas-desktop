#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist", "renderer");
const outDir = path.join(root, "output", "playwright", "hub-bookmark-ui");
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
  if (!fs.existsSync(path.join(distDir, "dashboard.html"))) {
    throw new Error("dist/renderer is missing; run npm run build:renderer first");
  }
  const { chromium } = require("playwright");
  const { setupMockAgentlasBridge, mockBridgeOptions } = require("./lib/mock-agentlas-bridge.cjs");
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const { server, baseUrl } = await startServer();
  const browser = await chromium.launch();
  try {
    const errors = [];
    const watchErrors = (page) => {
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error" && !/favicon|Failed to load resource/i.test(message.text())) errors.push(message.text());
      });
    };

    // Dashboard: both initial bookmark reads capture an empty snapshot and
    // return after bookmarkAdd. The event/reconcile path must reject them.
    const dashboardContext = await browser.newContext({ viewport: { width: 1440, height: 980 } });
    await dashboardContext.addInitScript(
      setupMockAgentlasBridge,
      mockBridgeOptions({ teamRoster: true, bookmarkEmptyReadDelayMs: 650, filterHubSearch: true }),
    );
    const dashboardPage = await dashboardContext.newPage();
    watchErrors(dashboardPage);
    await dashboardPage.goto(`${baseUrl}/dashboard.html`, { waitUntil: "domcontentloaded" });

    const roomSearch = dashboardPage.getByPlaceholder(/검증된 에이전트 검색|Search verified agents/);
    await roomSearch.fill("hub-agent-002");
    const roomCard = dashboardPage.locator(".hub-borrow-card").filter({ hasText: /허브 에이전트 002|Hub Agent 002/ });
    await roomCard.waitFor({ timeout: 10000 });
    await roomCard.getByRole("button", { name: /북마크|Bookmark/ }).click();
    const orgTree = dashboardPage.locator(".dashboard-org-tree");
    await orgTree.getByText(/허브 에이전트 002|Hub Agent 002/, { exact: true }).waitFor({ timeout: 3000 });
    await dashboardPage.waitForTimeout(800);
    await assert.doesNotReject(() => orgTree.getByText(/허브 에이전트 002|Hub Agent 002/, { exact: true }).waitFor({ timeout: 1000 }));

    // Global search: a new query must hide the previous query's candidates in
    // the debounce window, while normal autocomplete still needs no Enter.
    const globalSearch = dashboardPage.getByPlaceholder(/허브 검색|Search hub/).first();
    await globalSearch.fill("hub-agent-002");
    await dashboardPage.locator("#sidenav-hub-search-suggestions [role='option']").first().waitFor({ timeout: 10000 });
    await globalSearch.fill("no-such-hub-result");
    assert.equal(
      await dashboardPage.locator("#sidenav-hub-search-suggestions [role='option']").count(),
      0,
      "old-query SideNav suggestions must disappear immediately",
    );
    await dashboardPage.screenshot({ path: path.join(outDir, "dashboard-bookmark-immediate.png"), fullPage: true });

    // Hub page: visible combobox suggestions also appear without submit.
    await dashboardPage.goto(`${baseUrl}/marketplace.html`, { waitUntil: "domcontentloaded" });
    const hubSearch = dashboardPage.locator("input.portal-input");
    await hubSearch.fill("hub-agent-002");
    await dashboardPage.locator("#desktop-hub-search-suggestions [role='option']").first().waitFor({ timeout: 10000 });
    await dashboardPage.screenshot({ path: path.join(outDir, "hub-autocomplete.png"), fullPage: true });
    await dashboardContext.close();

    // Chat: its mount-time bookmark request captures an empty snapshot, then a
    // bookmark event lands while that read is delayed. The late empty result
    // must not erase the @ candidate that was added optimistically.
    const chatRaceContext = await browser.newContext({ viewport: { width: 1200, height: 820 } });
    await chatRaceContext.addInitScript(
      setupMockAgentlasBridge,
      mockBridgeOptions({ teamRoster: true, bookmarkEmptyReadDelayMs: 650, filterHubSearch: true }),
    );
    const chatRacePage = await chatRaceContext.newPage();
    watchErrors(chatRacePage);
    await chatRacePage.goto(`${baseUrl}/chat.html?id=chat-1`, { waitUntil: "domcontentloaded" });
    await chatRacePage.waitForFunction(() => Boolean(window.agentlas?.marketplace?.bookmarkAdd));
    await chatRacePage.waitForTimeout(80);
    await chatRacePage.evaluate(async () => {
      const rows = await window.agentlas.marketplace.search("hub-agent-002");
      const listing = rows.find((row) => row.slug === "hub-agent-002");
      if (!listing) throw new Error("race fixture listing missing");
      const bookmark = await window.agentlas.marketplace.bookmarkAdd(listing);
      window.dispatchEvent(new CustomEvent("agentlas:hub-bookmarks-changed", {
        detail: { action: "added", bookmark },
      }));
    });
    const chatRaceComposer = chatRacePage.locator("textarea").first();
    await chatRaceComposer.waitFor({ timeout: 10000 });
    await chatRaceComposer.fill("@hub-agent-002");
    await chatRacePage.getByText(/허브 에이전트 002|Hub Agent 002/, { exact: true }).last().waitFor({ timeout: 3000 });
    await chatRacePage.waitForTimeout(800);
    await chatRaceComposer.fill("");
    await chatRaceComposer.fill("@hub-agent-002");
    await chatRacePage.getByText(/허브 에이전트 002|Hub Agent 002/, { exact: true }).last().waitFor({ timeout: 1000 });
    await chatRaceContext.close();

    // Chat gets callable, install-only, and local-duplicate bookmarks. Context
    // keeps the install-only bookmark visible, but action surfaces fail closed.
    const chatContext = await browser.newContext({ viewport: { width: 1440, height: 980 } });
    await chatContext.addInitScript(
      setupMockAgentlasBridge,
      mockBridgeOptions({
        teamRoster: true,
        hubBookmarkScenario: "mixed-callability",
        hiredPersistenceDelayMs: 350,
      }),
    );
    const chatPage = await chatContext.newPage();
    watchErrors(chatPage);
    await chatPage.goto(`${baseUrl}/chat.html?id=chat-1`, { waitUntil: "domcontentloaded" });
    await chatPage.getByText(/내 현재 도구와 컨텍스트|Your current tools & context/).waitFor({ timeout: 10000 });
    await chatPage.getByText(/@설치 전용 에이전트|@Install-only Agent/, { exact: true }).waitFor();
    const composer = chatPage.locator("textarea").first();

    await composer.fill("@install-only-agent");
    await chatPage.getByText(/일치 없음|No matches/).waitFor();
    await composer.press("Escape");

    await composer.fill("@builder-agent");
    const localFirstPopover = chatPage.locator('[data-popover-kind="autocomplete"]');
    await localFirstPopover.getByText(/빌더 에이전트|Builder Agent/, { exact: true }).waitFor();
    assert.equal(
      await localFirstPopover.locator('[data-autocomplete-option="true"]').count(),
      1,
      "same-slug local agent must suppress the Hub duplicate",
    );
    await composer.press("Escape");

    // Two rapid selections plus an immediate next Enter happen before either
    // delayed SQLite write resolves. invoke.run must still receive both slugs.
    await composer.fill("@hub-agent-002");
    await chatPage.getByText(/허브 에이전트 002|Hub Agent 002/, { exact: true }).last().waitFor();
    await composer.press("Enter");
    await composer.fill("바로 실행해 @hub-agent-003");
    await chatPage.getByText(/허브 에이전트 003|Hub Agent 003/, { exact: true }).last().waitFor();
    await composer.press("Enter");
    await composer.press("Enter");
    await chatPage.waitForFunction(() =>
      window.__qa.calls.some((call) =>
        call.name === "invoke.run" &&
        Array.isArray(call.payload.borrowAgents) &&
        call.payload.borrowAgents.includes("hub-agent-002") &&
        call.payload.borrowAgents.includes("hub-agent-003"),
      ),
    );
    await chatPage.waitForFunction(() => {
      const writes = window.__qa.calls.filter((call) => call.name === "chats.setHiredAgents");
      const last = writes[writes.length - 1];
      return last?.payload.cards?.some((card) => card.slug === "hub-agent-002") &&
        last?.payload.cards?.some((card) => card.slug === "hub-agent-003");
    });
    await chatPage.screenshot({ path: path.join(outDir, "chat-hub-bookmark-call.png"), fullPage: true });
    await chatContext.close();

    // Latest-write failure must not leave a phantom hired badge. Reconcile the
    // optimistic roster from the durable chat after the mock write rejects.
    const failureContext = await browser.newContext({ viewport: { width: 1200, height: 820 } });
    await failureContext.addInitScript(
      setupMockAgentlasBridge,
      mockBridgeOptions({
        hubBookmarkScenario: "mixed-callability",
        hiredPersistenceDelayMs: 250,
        hiredPersistenceFailures: 1,
      }),
    );
    const failurePage = await failureContext.newPage();
    watchErrors(failurePage);
    await failurePage.goto(`${baseUrl}/chat.html?id=chat-1`, { waitUntil: "domcontentloaded" });
    const failureComposer = failurePage.locator("textarea").first();
    await failureComposer.fill("@hub-agent-002");
    await failurePage.getByText(/허브 에이전트 002|Hub Agent 002/, { exact: true }).last().waitFor();
    await failureComposer.press("Enter");
    const failureBadge = failurePage.getByTestId("hired-agents-badge");
    await failureBadge.waitFor({ state: "visible" });
    await failureBadge.waitFor({ state: "detached", timeout: 5000 });
    await failureContext.close();

    assert.deepEqual(errors, [], "Hub bookmark UI flow must not emit renderer errors");
    console.log("test-hub-bookmark-ui: PASS");
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
