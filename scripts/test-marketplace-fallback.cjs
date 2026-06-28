#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const mode = process.argv.includes("--live") ? "live" : "offline";
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `agentlas-marketplace-${mode}-`));
process.env.AGENTLAS_STORE_PATH = path.join(tempDir, "agentlas.sqlite");
if (mode === "offline") {
  process.env.AGENTLAS_MCP_BASE_URL = "http://127.0.0.1:9/mcp";
}
app.setPath("userData", path.join(tempDir, "user-data"));

(async () => {
  let exitCode = 0;
  try {
    const { getSource, getSourceStatus } = require("../dist/electron/marketplace/index.js");
    const source = getSource();
    const firms = await source.listFirms();
    const bundles = await source.listBundles();
    const agents = await source.searchAgents("");
    const status = getSourceStatus();

    if (mode === "offline") {
      assert.equal(status.online, false, "offline mode must mark the live Hub source offline");
      assert.equal(status.usingFallback, true, "offline mode must expose that fallback catalog is being used");
      assert.ok(status.lastError, "offline mode should keep the connection error visible");
      assert.ok(
        firms.length + bundles.length + agents.length > 0,
        "offline mode should still return the built-in catalog so the UI can label it honestly",
      );
    } else {
      assert.equal(status.usingFallback, false, "live mode should not use fallback when Hub responds");
      assert.equal(status.online, true, "live mode should mark the Hub source online");
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          mode,
          status,
          counts: { firms: firms.length, bundles: bundles.length, agents: agents.length },
          sampleAgent: agents[0]?.slug ?? null,
          sampleFirm: firms[0]?.slug ?? null,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    exitCode = 1;
    console.error(err);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (app && typeof app.quit === "function") app.quit();
    process.exit(exitCode);
  }
})();
