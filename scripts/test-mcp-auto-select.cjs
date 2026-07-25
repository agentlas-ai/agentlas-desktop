#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

// Headless Linux CI: this gate runs a mock HTTP server + Hub resolve, so electron
// stays alive long enough for its GPU process to race the xvfb X server and abort
// with XIO/D-Bus errors. The test does no rendering, so drop hardware acceleration
// (must be called before the app is ready).
app.disableHardwareAcceleration();

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
    // The resident judge is the ONLY thing that selects an optional tool, so the test pins
    // its verdict instead of relying on a connected model. `seenCandidates` captures the
    // inventory it was offered.
    let seenCandidates = [];
    const judgeSays = (ids) => async ({ candidates }) => {
      seenCandidates = candidates;
      return { needed: ids, decided: true, reason: "pinned by test", omitted: [] };
    };
    // No model reachable: nothing optional may be attached and nothing may be asked for.
    const judgeUnavailable = async ({ candidates }) => {
      seenCandidates = candidates;
      return { needed: [], decided: false, reason: "no connected model answered", omitted: [] };
    };
    const healthyProbe = {
      // Catalog/routing behavior is the subject of this smoke. Runtime probe
      // failure isolation has a separate deterministic test.
      testServerConnection: async () => ({ connected: true, missingEnv: [] }),
      resolveNeeds: judgeSays(["cua-driver", "reddit"]),
    };

    const selected = await autoSelectMcpTools({
      userPrompt: "Search Reddit, log in if needed, and post helpful comments",
      systemPrompt: "You are a no-slop community seeding automation.",
      agentName: "No Slop Seeder",
      toolMode: "auto",
      hubMode: "hub-allowed",
    }, healthyProbe);

    assert.ok(selected.localPluginCount >= 13, "local MCP/plugin inventory should include catalog entries");
    assert.equal(selected.hubPluginCount, 4, "Hub plugin catalog should be counted");
    assert.equal(selected.needsDecided, true, "a judged run should report a decided tool set");
    assert.ok(selected.tools.some((tool) => tool.id === "cua-driver" && tool.installed), "CUA should be installed when the judge names it");
    assert.ok(selected.tools.some((tool) => tool.id === "hephaestus-network" && tool.installed), "Hub resolver should be installed when Hub is allowed");
    assert.ok(selected.hubPlugins.some((plugin) => plugin.slug === "reddit"), "Reddit Hub plugin should be a candidate");
    // Hub inventory is offered to the judge FIRST, and every candidate carries a description.
    assert.equal(seenCandidates[0].origin, "hub", "Hub entries must be offered before local ones");
    assert.ok(
      seenCandidates.some((candidate) => candidate.id === "brave-search" && candidate.needsCredential === true),
      "credential-requiring tools must be flagged to the judge",
    );
    assert.ok(
      !selected.hubPlugins.some((plugin) => plugin.slug === "notion"),
      "an unnamed Hub plugin must not be surfaced as a candidate",
    );

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
    }, healthyProbe);
    const browserCatalogIds = browserSelected.tools.filter((tool) => tool.installed).map((tool) => tool.id);
    const browserCfg = await buildMcpConfigFile({ catalogIds: browserCatalogIds });
    assert.ok(browserCfg, "browser mode should produce a scoped config");
    const browserMcpJson = JSON.parse(fs.readFileSync(browserCfg.configPath, "utf8"));
    assert.ok(browserMcpJson.mcpServers["agentlas-browser"], "Browser automation should expose the exact real-login Agentlas Browser host");
    assert.equal(browserMcpJson.mcpServers.playwright, undefined, "Browser automation must not create a fresh Playwright-profile fallback");
    assert.equal(browserMcpJson.mcpServers["cua-driver"], undefined, "Browser automation should not expose CUA by default");
    assert.ok(browserCfg.allowedTools.some((tool) => tool.includes("agentlas-browser")), "browser allowed tools should include Agentlas Browser only");
    assert.ok(!browserCfg.allowedTools.some((tool) => tool.includes("playwright")), "browser allowed tools must exclude fresh Playwright fallback");
    assert.ok(!browserCfg.allowedTools.some((tool) => tool.includes("cua-driver")), "browser allowed tools should not include CUA");

    // ── REGRESSION: the incident this selector was rewritten for ────────────────
    // A Reddit posting automation whose text merely said "조사" was scored onto brave-search,
    // came back missing-key, and opened a blocking API-key sheet before the run — every
    // working automation stalled on a Brave Search key nobody had asked for.
    const wordBaitPrompt = "레딧에 올릴 글을 조사해서 정리하고 검색 결과를 댓글로 게시해줘";
    const noModel = await autoSelectMcpTools({
      userPrompt: wordBaitPrompt,
      systemPrompt: "You are a no-slop community seeding automation.",
      agentName: "No Slop Seeder",
      toolMode: "auto",
      hubMode: "hub-allowed",
    }, { ...healthyProbe, resolveNeeds: judgeUnavailable });

    assert.equal(noModel.needsDecided, false, "an unreachable model must report an undecided tool set");
    assert.ok(noModel.needsNote, "an undecided run must say so instead of looking like a full selection");
    assert.ok(
      !noModel.tools.some((tool) => tool.id === "brave-search"),
      'the word "조사"/"검색" must never attach a web-search tool',
    );
    assert.equal(
      noModel.tools.filter((tool) => tool.state === "missing-key").length,
      0,
      "an undecided run must never produce a credential prompt",
    );
    assert.ok(
      noModel.tools.some((tool) => tool.id === "hephaestus-network" && tool.installed),
      "removing the keyword scorer must not remove a capability the user already has",
    );
    assert.ok(
      !noModel.tools.some((tool) => tool.required),
      "no tool may be marked required by selection",
    );

    // The same text in a language no wordlist ever covered must behave identically, and a
    // credential prompt is legitimate ONLY for a tool the judge actually named.
    const arabic = await autoSelectMcpTools({
      userPrompt: "ابحث في الويب عن آخر الأخبار ولخّصها",
      systemPrompt: "Research automation",
      agentName: "Research",
      toolMode: "auto",
      hubMode: "hub-allowed",
    }, { ...healthyProbe, resolveNeeds: judgeSays(["brave-search"]) });
    const brave = arabic.tools.find((tool) => tool.id === "brave-search");
    assert.ok(brave, "a tool the judge names must be selected regardless of the language used");
    assert.ok(
      brave.state === "missing-key" || brave.installed,
      "a judged tool may legitimately ask for its key",
    );
    assert.equal(brave.required, false, "even a judged tool is not a host binding");

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
