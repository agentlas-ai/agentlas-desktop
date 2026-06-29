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

function sendJson(res, payload) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/api/marketplace/agents") {
    hits.publicAgents += 1;
    sendJson(res, {
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
        sendJson(res, { result: { firms: [] } });
        return;
      }
      if (method === "marketplace.list_bundles") {
        hits.bundles += 1;
        sendJson(res, { result: { bundles: [] } });
        return;
      }
      if (method === "cargo.list_agents") {
        hits.mine += 1;
        sendJson(res, {
          result: {
            agents: [
              {
                slug: "published-cache-smoke",
                name: "Published Cache Smoke",
                nameEn: "Published Cache Smoke",
                tagline: "Published agent",
                taglineEn: "Published agent",
                kind: "cloud-callable",
                callable: true,
                source: "hub-profile",
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
    const { getSource, listMyAgentsCached } = require("../dist/electron/marketplace/index.js");
    const source = getSource();

    const partial = await source.searchAgents("");
    assert.deepEqual(partial.map((item) => item.slug), ["hub-agent-cache-smoke"]);
    const recovered = await source.searchAgents("");
    assert.deepEqual(
      recovered.map((item) => item.slug).sort(),
      ["hub-agent-cache-smoke", "hub-plugin-cache-smoke"].sort(),
    );
    await source.searchAgents("");
    await source.listFirms();
    await source.listFirms();
    await source.listBundles();
    await source.listBundles();
    await listMyAgentsCached();
    await listMyAgentsCached();

    assert.deepEqual(hits, {
      publicAgents: 1,
      searchAgents: 0,
      plugins: 2,
      firms: 1,
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
