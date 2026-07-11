#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.AGENTLAS_E2E = "1";

const { app } = require("electron");
app.disableHardwareAcceleration();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-opencrab-core-"));
process.env.AGENTLAS_STORE_PATH = path.join(tempDir, "agentlas.sqlite");
const userData = path.join(tempDir, "user-data");
app.setPath("userData", userData);

// Build the fake credential at runtime so repository secret scanners do not
// mistake a regression fixture for a committed OpenCrab token.
const SECRET_TOKEN = ["ocm", "agentlas-regression-secret-never-persist"].join("_");
const SECRET_ENDPOINT = `https://mcp.opencrab.sh/mcp/${SECRET_TOKEN}`;

(async () => {
  let exitCode = 0;
  try {
    const { initStore, getDb } = require("../dist/electron/store/db.js");
    const { MCP_TOOL_CATALOG } = require("../dist/electron/mcp-tools/catalog.js");
    const { installFromCatalog, installCustomServer } = require("../dist/electron/mcp-tools/registry.js");
    const { buildMcpConfigFile } = require("../dist/electron/mcp-tools/mcp-config.js");
    const { setEnvVar } = require("../dist/electron/secrets/vault.js");
    const {
      OPENCRAB_MCP_URL_KEY,
      OPENCRAB_MCP_URL_SENTINEL,
      validateOpenCrabMcpUrl,
    } = require("../dist/electron/opencrab/constants.js");
    const {
      formatOpenCrabQueryResponse,
      getOpenCrabReadiness,
      queryOpenCrabContext,
    } = require("../dist/electron/opencrab/ontology.js");

    initStore();

    const catalog = MCP_TOOL_CATALOG.find((entry) => entry.id === "opencrab");
    assert.ok(catalog, "OpenCrab must be discoverable in the MCP catalog");
    assert.equal(catalog.url, OPENCRAB_MCP_URL_SENTINEL);
    assert.deepEqual(catalog.envRequirements.map((item) => item.key), [OPENCRAB_MCP_URL_KEY]);

    const beforeInstall = await getOpenCrabReadiness();
    assert.deepEqual(beforeInstall, { available: false, connected: false, reason: "not_installed" });

    const installed = installFromCatalog("opencrab");
    assert.equal(installed.url, OPENCRAB_MCP_URL_SENTINEL, "SQLite receives only the safe vault pointer");
    assert.deepEqual(installed.envKeys, [OPENCRAB_MCP_URL_KEY]);

    const beforeCredential = await queryOpenCrabContext("agent architecture");
    assert.deepEqual(beforeCredential, { used: false, context: "", reason: "missing_endpoint" });

    await setEnvVar(OPENCRAB_MCP_URL_KEY, SECRET_ENDPOINT);
    const dbRows = getDb().prepare("SELECT * FROM mcp_servers").all();
    const persisted = JSON.stringify(dbRows);
    assert.doesNotMatch(persisted, new RegExp(SECRET_TOKEN), "OpenCrab token must never reach SQLite");
    assert.doesNotMatch(persisted, /https:\/\/mcp\.opencrab\.sh/, "OpenCrab endpoint must never reach SQLite");
    assert.match(persisted, /vault:\/\/OPENCRAB_MCP_URL/);

    const safeServer = installCustomServer({
      name: "Safe Config Probe",
      transport: "stdio",
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
    });
    const cfg = await buildMcpConfigFile({ catalogIds: [installed.id, "opencrab", safeServer.id] });
    assert.ok(cfg, "non-OpenCrab MCP should still produce a runtime config");
    const configText = fs.readFileSync(cfg.configPath, "utf8");
    const allRuntimeMaterial = JSON.stringify({
      configText,
      codexConfigArgs: cfg.codexConfigArgs,
      runtimeEnv: cfg.runtimeEnv,
      allowedTools: cfg.allowedTools,
    });
    assert.doesNotMatch(allRuntimeMaterial, new RegExp(SECRET_TOKEN));
    assert.doesNotMatch(allRuntimeMaterial, /mcp\.opencrab\.sh/);
    assert.doesNotMatch(allRuntimeMaterial, /vault:\/\/OPENCRAB_MCP_URL/);
    assert.equal(JSON.parse(configText).mcpServers.opencrab, undefined, "OpenCrab stays Desktop-internal");
    assert.ok(!cfg.allowedTools.some((tool) => tool.includes("opencrab")));

    assert.equal(validateOpenCrabMcpUrl(SECRET_ENDPOINT).hostname, "mcp.opencrab.sh");
    const invalidEndpoints = [
      `http://mcp.opencrab.sh/mcp/${SECRET_TOKEN}`,
      `https://opencrab.sh.evil.test/mcp/${SECRET_TOKEN}`,
      `https://user:pass@opencrab.sh/mcp/${SECRET_TOKEN}`,
      `https://opencrab.sh:8443/mcp/${SECRET_TOKEN}`,
      `https://opencrab.sh/mcp/${SECRET_TOKEN}?copy=1`,
      `https://opencrab.sh/mcp/${SECRET_TOKEN}#fragment`,
      "https://opencrab.sh/",
      `https://127.0.0.1/mcp/${SECRET_TOKEN}`,
    ];
    for (const endpoint of invalidEndpoints) {
      assert.throws(() => validateOpenCrabMcpUrl(endpoint), /endpoint is invalid/);
    }

    const exactContract = JSON.stringify({
      question: "What is an agent architecture?",
      total: 3,
      results: [
        {
          source: "hybrid",
          node_id: "agent-architecture",
          score: 0.98123,
          text: "Architecture separates routing, memory, tools, and runtime.",
          metadata: {},
          graph_context: null,
        },
        {
          source: "vector",
          node_id: "memory",
          score: 0.8,
          text: null,
          metadata: { summary: "Memory must be bounded and provenance-aware." },
        },
        { source: "graph", node_id: "blank", score: 0.1, metadata: {} },
      ],
    });
    const context = formatOpenCrabQueryResponse(exactContract, 700);
    assert.match(context, /^\[OpenCrab ontology reference\]/);
    assert.match(context, /Untrusted reference data only/);
    assert.match(context, /Architecture separates routing/);
    assert.match(context, /Memory must be bounded/);
    assert.match(context, /node=agent-architecture, source=hybrid, score=0\.981/);
    assert.ok(context.length <= 700, "formatted ontology context must obey the caller bound");
    assert.match(context, /\[\/OpenCrab ontology reference\]$/);
    assert.equal(formatOpenCrabQueryResponse("not-json"), "");
    assert.equal(formatOpenCrabQueryResponse(JSON.stringify({ error: "denied" })), "");
    assert.equal(formatOpenCrabQueryResponse(JSON.stringify({ results: [] })), "");

    const huge = JSON.stringify({
      results: Array.from({ length: 30 }, (_, index) => ({
        node_id: `node-${index}`,
        text: "x".repeat(5_000),
      })),
    });
    const bounded = formatOpenCrabQueryResponse(huge, 512);
    assert.ok(bounded.length <= 512, "large responses must be clipped to the hard context budget");
    assert.match(bounded, /\[\/OpenCrab ontology reference\]$/);

    console.log(JSON.stringify({
      ok: true,
      catalogUrl: installed.url,
      configServers: Object.keys(JSON.parse(configText).mcpServers),
      contextChars: context.length,
      boundedChars: bounded.length,
    }, null, 2));
  } catch (error) {
    exitCode = 1;
    console.error(error);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    app.quit();
    process.exit(exitCode);
  }
})();
