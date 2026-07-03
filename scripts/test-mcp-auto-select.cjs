#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-mcp-auto-select-"));
process.env.AGENTLAS_STORE_PATH = path.join(tempDir, "agentlas.sqlite");
app.setPath("userData", path.join(tempDir, "user-data"));

const hits = {
  publicAgents: 0,
  plugins: 0,
};

function sendJson(res, payload) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/api/marketplace/agents") {
    hits.publicAgents += 1;
    sendJson(res, { agents: [] });
    return;
  }
  if (req.method === "GET" && req.url === "/api/plugins") {
    hits.plugins += 1;
    sendJson(res, {
      plugins: [
        {
          slug: "reddit",
          name: "Reddit",
          tagline: "Search Reddit and create community replies",
          developer: "Agentlas Hub",
          category: "social",
          install: { cli: "npx agentlas@latest plugin add reddit" },
        },
        {
          slug: "computer-use",
          name: "Computer Use",
          tagline: "Control the screen when websites block browser-only automation",
          developer: "OpenAI",
          category: "automation",
          install: { cli: "npx agentlas@latest plugin add computer-use" },
        },
        {
          slug: "browser",
          name: "Browser",
          tagline: "Browser automation for login, click, and web workflows",
          developer: "OpenAI",
          category: "automation",
          install: { cli: "npx agentlas@latest plugin add browser" },
        },
        {
          slug: "notion",
          name: "Notion",
          tagline: "Manage Notion pages",
          developer: "Notion",
          category: "productivity",
        },
      ],
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

    const { initStore } = require("../dist/electron/store/db.js");
    const {
      autoSelectMcpTools,
      buildMcpAutoSelectionPrompt,
    } = require("../dist/electron/mcp-tools/auto-select.js");
    const { buildMcpConfigFile } = require("../dist/electron/mcp-tools/mcp-config.js");

    initStore();

    const selected = await autoSelectMcpTools({
      userPrompt: "Search Reddit, log in if needed, and post helpful comments",
      systemPrompt: "You are a no-slop community seeding automation.",
      agentName: "No Slop Seeder",
      toolMode: "auto",
      hubMode: "hub-allowed",
    });

    assert.ok(selected.localPluginCount >= 13, "local MCP/plugin inventory should include catalog entries");
    assert.equal(selected.hubPluginCount, 4, "Hub plugin catalog should be counted");
    assert.ok(selected.tools.some((tool) => tool.id === "cua-driver" && tool.installed), "CUA should be installed for social/web action automation");
    assert.ok(selected.tools.some((tool) => tool.id === "hephaestus-network" && tool.installed), "Hub resolver should be installed when Hub is allowed");
    assert.ok(selected.hubPlugins.some((plugin) => plugin.slug === "reddit"), "Reddit Hub plugin should be a candidate");
    assert.ok(selected.hubPlugins.some((plugin) => plugin.slug === "computer-use"), "Computer Use Hub plugin should be a candidate");
    assert.ok(selected.hubPlugins.some((plugin) => plugin.slug === "browser"), "Browser Hub plugin should be a candidate");

    const selectedCatalogIds = selected.tools.filter((tool) => tool.installed).map((tool) => tool.id);
    const cfg = await buildMcpConfigFile({ catalogIds: selectedCatalogIds });
    assert.ok(cfg, "selected MCP tools should produce a scoped config");
    const mcpJson = JSON.parse(fs.readFileSync(cfg.configPath, "utf8"));
    assert.ok(mcpJson.mcpServers["cua-driver"], "Computer Use automation should expose CUA");
    assert.ok(mcpJson.mcpServers["hephaestus-network"], "Hub-allowed automation should expose the Hub resolver");
    assert.equal(mcpJson.mcpServers.playwright, undefined, "Computer Use automation must not expose Playwright fallback");
    assert.ok(cfg.allowedTools.some((tool) => tool.includes("cua-driver")), "allowed tools should include CUA");
    assert.ok(!cfg.allowedTools.some((tool) => tool.includes("playwright")), "allowed tools should not include Playwright");

    const browserSelected = await autoSelectMcpTools({
      userPrompt: "Open Chrome in the browser and search Reddit",
      systemPrompt: "Browser smoke",
      agentName: "Browser QA",
      toolMode: "browser",
      hubMode: "hub-allowed",
    });
    const browserCatalogIds = browserSelected.tools.filter((tool) => tool.installed).map((tool) => tool.id);
    const browserCfg = await buildMcpConfigFile({ catalogIds: browserCatalogIds });
    assert.ok(browserCfg, "browser mode should produce a scoped config");
    const browserMcpJson = JSON.parse(fs.readFileSync(browserCfg.configPath, "utf8"));
    assert.ok(browserMcpJson.mcpServers.playwright, "Browser automation should expose Playwright");
    assert.equal(browserMcpJson.mcpServers["cua-driver"], undefined, "Browser automation should not expose CUA by default");
    assert.ok(browserCfg.allowedTools.some((tool) => tool.includes("playwright")), "browser allowed tools should include Playwright");
    assert.ok(!browserCfg.allowedTools.some((tool) => tool.includes("cua-driver")), "browser allowed tools should not include CUA");

    const prompt = buildMcpAutoSelectionPrompt(selected, { toolMode: "auto", hubMode: "hub-allowed" });
    assert.match(prompt, /Agentlas plugin universe is active/);
    assert.match(prompt, /localInventory/);
    assert.match(prompt, /reddit/);
    assert.match(prompt, /agentlas_resolve_plugins/);
    assert.match(prompt, /Hephaestus Network/);

    assert.deepEqual(hits, { publicAgents: 1, plugins: 1 });
    console.log(JSON.stringify({ ok: true, selectedHubPlugins: selected.hubPlugins.map((p) => p.slug), hits }, null, 2));
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
