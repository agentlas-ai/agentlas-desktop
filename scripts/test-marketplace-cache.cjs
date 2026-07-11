#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-marketplace-cache-"));
process.env.AGENTLAS_STORE_PATH = path.join(tempDir, "agentlas.sqlite");
app.setPath("userData", path.join(tempDir, "user-data"));

const hits = {
  publicAgents: 0,
  searchAgents: 0,
  plugins: 0,
  firms: 0,
  bundles: 0,
  mine: 0,
};
let pluginFailuresRemaining = 1;
let catalogMode = "ok";
let firmFailuresRemaining = 1;

function sendCatalog(res, payload) {
  if (catalogMode === "offline") {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "catalog offline" }));
    return;
  }
  if (catalogMode === "slow") {
    setTimeout(() => sendJson(res, payload), 300);
    return;
  }
  sendJson(res, payload);
}

function sendJson(res, payload) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/api/marketplace/agents") {
    hits.publicAgents += 1;
    sendCatalog(res, {
      agents: [
        {
          slug: "hub-agent-cache-smoke",
          title: "Hub Agent Cache Smoke",
          kind: "agent",
          tagline: "Callable Hub agent",
        },
      ],
    });
    return;
  }
  if (req.method === "GET" && req.url === "/api/plugins") {
    hits.plugins += 1;
    if (catalogMode !== "ok") {
      sendCatalog(res, { plugins: [] });
      return;
    }
    if (pluginFailuresRemaining > 0) {
      pluginFailuresRemaining -= 1;
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "temporary plugin failure" }));
      return;
    }
    sendJson(res, {
      plugins: [
        {
          slug: "hub-plugin-cache-smoke",
          name: "Hub Plugin Cache Smoke",
          tagline: "Installable Hub plugin",
          developer: "Agentlas QA",
        },
      ],
    });
    return;
  }
  if (req.method === "POST" && req.url === "/api/mcp/v1/tools/call") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const method = JSON.parse(body).method;
      if (method === "marketplace.search_agents") {
        hits.searchAgents += 1;
        sendJson(res, {
          result: {
            results: [
              {
                slug: "hub-agent-cache-smoke",
                name: "Hub Agent Cache Smoke",
                nameEn: "Hub Agent Cache Smoke",
                tagline: "Callable Hub agent",
                kind: "cloud-callable",
                callable: true,
                source: "hub-index",
                trustGrade: "A",
                manifestUrl: "mock",
                installCount: 0,
              },
            ],
          },
        });
        return;
      }
      if (method === "marketplace.list_firms") {
        hits.firms += 1;
        if (firmFailuresRemaining > 0) {
          firmFailuresRemaining -= 1;
          setTimeout(() => {
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "temporary firms failure" }));
          }, 80);
          return;
        }
        sendJson(res, { result: { firms: [] } });
        return;
      }
      if (method === "marketplace.list_bundles") {
        hits.bundles += 1;
        sendJson(res, { result: { bundles: [] } });
        return;
      }
      if (method === "cargo.search_agents") {
        hits.mine += 1;
        sendJson(res, {
          result: {
            results: [
              {
                slug: "published-cache-smoke",
                name: "Published Cache Smoke",
                nameEn: "Published Cache Smoke",
                tagline: "Published agent",
                taglineEn: "Published agent",
                kind: "cloud-callable",
                callable: true,
                source: "cloud",
                trustGrade: "A",
                manifestUrl: "mock",
                installCount: 0,
              },
            ],
          },
        });
        return;
      }
      sendJson(res, { result: null });
    });
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

server.listen(0, "127.0.0.1", async () => {
  let exitCode = 0;
  try {
    const port = server.address().port;
    process.env.AGENTLAS_MCP_BASE_URL = `http://127.0.0.1:${port}/api/mcp/v1`;
    process.env.AGENTLAS_HUB_STATUS_TIMEOUT_MS = "100";
    const { getSource, listMyAgentsCached, refreshSourceStatus } = require("../dist/electron/marketplace/index.js");
    const source = getSource();

    const [initialStatus, partial] = await Promise.all([
      refreshSourceStatus(true),
      source.searchAgents(""),
    ]);
    assert.deepEqual(partial.map((item) => item.slug), ["hub-agent-cache-smoke"]);
    assert.equal(hits.publicAgents, 1, "Dashboard status and search must share the agents request");
    assert.equal(hits.plugins, 1, "Dashboard status and search must share the plugins request");
    assert.equal(initialStatus.online, true, "a partial live catalog still proves Hub connectivity");
    assert.ok(initialStatus.lastError, "partial live catalog should retain the failed source detail");

    const recoveredStatus = await refreshSourceStatus(true);
    assert.equal(recoveredStatus.online, true);
    assert.equal(recoveredStatus.lastError, null);
    const liveHits = { publicAgents: hits.publicAgents, plugins: hits.plugins };
    assert.deepEqual(await refreshSourceStatus(), recoveredStatus, "fresh status reads must not duplicate the live probe");
    assert.deepEqual(
      { publicAgents: hits.publicAgents, plugins: hits.plugins },
      liveHits,
      "fresh status reuse must not hit the network",
    );

    const recovered = await source.searchAgents("");
    assert.deepEqual(
      recovered.map((item) => item.slug).sort(),
      ["hub-agent-cache-smoke", "hub-plugin-cache-smoke"].sort(),
    );

    catalogMode = "offline";
    const offline = await refreshSourceStatus(true);
    assert.equal(offline.online, false, "a forced status check must ignore cached catalog data");
    const offlineCheckedAt = offline.lastCheckedAt;
    assert.deepEqual(await source.searchAgents(""), recovered, "cached catalog remains usable while offline");
    const cachedOffline = require("../dist/electron/marketplace/index.js").getSourceStatus();
    assert.equal(cachedOffline.online, false, "cache hits must never manufacture an online state");
    assert.equal(cachedOffline.usingFallback, true);
    assert.equal(cachedOffline.lastCheckedAt, offlineCheckedAt, "cache reads are not live-check evidence");

    catalogMode = "ok";
    const slowFirm = source.listFirms();
    const liveAgain = await refreshSourceStatus(true);
    await slowFirm;
    assert.equal(liveAgain.online, true);
    assert.equal(require("../dist/electron/marketplace/index.js").getSourceStatus().online, true, "non-catalog API failures must not overwrite catalog status");

    catalogMode = "slow";
    const startedAt = Date.now();
    const timedOut = await refreshSourceStatus(true);
    assert.ok(Date.now() - startedAt < 250, "status probe must be bounded independently of the 15s catalog timeout");
    assert.equal(timedOut.online, false);
    assert.match(timedOut.lastError || "", /timed out/);
    catalogMode = "ok";

    await source.listFirms();
    await source.listFirms();
    await source.listBundles();
    await source.listBundles();
    await listMyAgentsCached();
    await listMyAgentsCached();

    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.deepEqual(hits, {
      publicAgents: 5,
      searchAgents: 0,
      plugins: 5,
      firms: 2,
      bundles: 1,
      mine: 1,
    });
    console.log(JSON.stringify({ ok: true, hits }, null, 2));
  } catch (err) {
    exitCode = 1;
    console.error(err);
  } finally {
    server.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (app && typeof app.quit === "function") app.quit();
    process.exit(exitCode);
  }
});
