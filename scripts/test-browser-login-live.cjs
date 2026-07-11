#!/usr/bin/env node
// Opt-in live proof for the real Agentlas dedicated Chrome profile. It uses a
// temporary Desktop DB, opens four loopback-only test pages through the actual
// browserOpenLogin IPC implementation, then closes only the targets it created.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const liveProofEnabled = process.env.AGENTLAS_TEST_LIVE_BROWSER === "1";

function cdpJson(port, pathname) {
  return new Promise((resolve, reject) => {
    const request = http.get(
      { host: "127.0.0.1", port, path: pathname, timeout: 2_000 },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { body += chunk; });
        response.on("end", () => {
          if ((response.statusCode ?? 500) >= 400) {
            reject(new Error(`CDP ${pathname} returned ${response.statusCode}`));
            return;
          }
          try { resolve(body ? JSON.parse(body) : null); } catch { resolve(body); }
        });
      },
    );
    request.on("error", reject);
    request.on("timeout", () => request.destroy(new Error(`CDP ${pathname} timed out`)));
  });
}

async function pageTargets(port) {
  const targets = await cdpJson(port, "/json/list");
  return targets
    .filter((target) => target.type === "page")
    .map((target) => ({ id: target.id, url: target.url }));
}

async function waitForExpectedPage(port, beforeIds, expectedUrl, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const after = await pageTargets(port);
    const created = after.find((target) => (
      !beforeIds.has(target.id) && target.url === expectedUrl
    ));
    if (created) return created;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Chrome did not expose the expected login target: ${expectedUrl}`);
}

async function waitForTargetGone(port, targetId, timeoutMs = 1_200) {
  const deadline = Date.now() + timeoutMs;
  let absentSince = null;
  while (Date.now() < deadline) {
    const targets = await pageTargets(port);
    if (!targets.some((target) => target.id === targetId)) {
      absentSince ??= Date.now();
      // Chrome can briefly omit a closing target and then surface it again.
      // Require a stable absence before claiming cleanup completed.
      if (Date.now() - absentSince >= 350) return;
    } else {
      absentSince = null;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Chrome did not close captured target: ${targetId}`);
}

function startLoopbackServer() {
  return new Promise((resolve, reject) => {
    let listening = false;
    const server = http.createServer((request, response) => {
      if (request.url !== "/") {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("agentlas-browser-live");
    });
    // browserOpenLogin intentionally opens https:// provider URLs. The local
    // HTTP listener still reserves a unique loopback port for this test; reject
    // any TLS bytes without keeping a socket alive.
    server.on("clientError", (_error, socket) => socket.destroy());
    server.on("error", (error) => {
      if (!listening) reject(error);
    });
    server.listen(0, "127.0.0.1", () => {
      listening = true;
      const address = server.address();
      assert(address && typeof address === "object", "loopback server address is unavailable");
      const site = `127.0.0.1:${address.port}`;
      resolve({
        server,
        site,
        expectedUrl: new URL(`https://${site}`).href,
      });
    });
  });
}

function closeLoopbackServer(server) {
  return new Promise((resolve) => {
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

async function closeCapturedTargets(port, createdTargets) {
  const closed = [];
  for (const captured of createdTargets) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const liveTargets = await pageTargets(port).catch(() => []);
      const live = liveTargets.find((target) => target.id === captured.id);
      if (!live) {
        try {
          await waitForTargetGone(port, captured.id);
          closed.push(captured);
          break;
        } catch (error) {
          if (attempt === 2) throw error;
          continue;
        }
      }
      // Never close an ID that Chrome has since reused or navigated elsewhere.
      if (live.url !== captured.url) break;
      await cdpJson(port, `/json/close/${encodeURIComponent(captured.id)}`);
      try {
        await waitForTargetGone(port, captured.id);
        closed.push(captured);
        break;
      } catch (error) {
        if (attempt === 2) throw error;
      }
    }
  }
  return closed;
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-browser-live-four-"));
  const port = Number(process.env.AGENTLAS_CDP_PORT || 9222);
  process.env.AGENTLAS_STORE_PATH = path.join(tmp, "agentlas.sqlite");
  app.setPath("userData", tmp);
  const store = require("../dist/electron/store/db.js");
  const vault = require("../dist/electron/store/browser-vault.js");
  const browser = require("../dist/electron/browser/connect.js");
  const launcher = require("../dist/electron/mcp-tools/browser-cdp-launcher.js");
  const createdTargets = [];
  const testCases = [];
  const loopbackServers = [];
  try {
    store.initStore();
    assert.equal(await launcher.browserCdpPortReady(), true, `CDP port ${port} is not ready`);
    const ownership = await launcher.reconcileBrowserCdpOwnerWithRetry();
    assert.equal(ownership.state, "owned", `live Browser is ${ownership.state}:${ownership.reason}`);

    for (let index = 0; index < 4; index += 1) {
      const loopback = await startLoopbackServer();
      loopbackServers.push(loopback.server);
      await vault.upsertBrowserSite({ site: loopback.site });
      const beforeIds = new Set((await pageTargets(port)).map((target) => target.id));
      const testCase = { ...loopback, beforeIds };
      testCases.push(testCase);
      const result = await browser.browserOpenLogin(loopback.site);
      assert.equal(result.ok, true, `${loopback.site}: ${result.error || "login window failed"}`);
      createdTargets.push(await waitForExpectedPage(
        port,
        beforeIds,
        loopback.expectedUrl,
      ));
    }

    const opened = store.getDb()
      .prepare("SELECT COUNT(*) AS count FROM browser_action_logs WHERE action = 'session.login_window' AND result = 'opened'")
      .get().count;
    assert.equal(opened, 4, "all four sequential login windows must be recorded as opened");
    console.log(JSON.stringify({
      ok: true,
      port,
      ownership,
      opened,
      expectedUrls: testCases.map((testCase) => testCase.expectedUrl),
      createdTargets,
    }, null, 2));
  } finally {
    // Close only IDs already captured by waitForExpectedPage. If a failure
    // happens before capture, leave the page open rather than risk touching a
    // user tab that happens to share a URL.
    let targetCleanupError = null;
    try {
      await closeCapturedTargets(port, createdTargets);
    } catch (error) {
      targetCleanupError = error;
    }
    for (const server of loopbackServers) {
      await closeLoopbackServer(server);
    }
    try { store.getDb().close(); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
    if (targetCleanupError) throw targetCleanupError;
  }
}

if (!liveProofEnabled) {
  console.error("Refusing live Browser proof without AGENTLAS_TEST_LIVE_BROWSER=1");
  app.exit(2);
} else {
  main().then(
    () => app.exit(0),
    (error) => {
      console.error(error);
      app.exit(1);
    },
  );
}
