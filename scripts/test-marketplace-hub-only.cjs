#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const mode = process.argv.includes("--live") ? "live" : "offline";
const forbiddenSeedSlugs = new Set([
  "shop-product-writer",
  "shop-cs-responder",
  "shop-review-monitor",
  "shop-pricing-scout",
  "shop-keyword-finder",
  "marketer-content-writer",
  "marketer-seo-researcher",
  "marketer-schedule-secretary",
  "marketer-ad-copywriter",
  "marketer-analytics-reader",
  "firm-ceo-shop",
  "firm-ceo-marketer",
]);
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `agentlas-marketplace-hub-only-${mode}-`));
process.env.AGENTLAS_STORE_PATH = path.join(tempDir, "agentlas.sqlite");
if (mode === "offline") {
  process.env.AGENTLAS_MCP_BASE_URL = "http://127.0.0.1:9/mcp";
}
app.setPath("userData", path.join(tempDir, "user-data"));

(async () => {
  let exitCode = 0;
  try {
    const { getSource, refreshSourceStatus } = require("../dist/electron/marketplace/index.js");
    const source = getSource();
    const [firms, bundles, agents, status] = await Promise.all([
      source.listFirms(),
      source.listBundles(),
      source.searchAgents(""),
      refreshSourceStatus(true),
    ]);

    if (mode === "offline") {
      assert.equal(status.online, false, "offline mode must mark the live Hub source offline");
      assert.equal(status.usingFallback, false, "offline mode must not switch to the hardcoded fallback catalog");
      assert.ok(status.lastError, "offline mode should keep the connection error visible");
      assert.equal(
        firms.length + bundles.length + agents.length,
        0,
        "offline mode should not expose hardcoded firms, bundles, or agents",
      );
    } else {
      assert.equal(status.usingFallback, false, "live mode should not use fallback when Hub responds");
      assert.equal(status.online, true, "live mode should mark the Hub source online");
      assert.ok(
        agents.length >= 100,
        `live mode should load the public Hub catalog, not the limited MCP seed result; got ${agents.length}`,
      );
      assert.ok(
        agents.every((agent) => agent.kind === "cloud-callable" || agent.callable === true || agent.source === "hub-index" || agent.source === "hub-profile" || agent.source === "hub-plugin"),
        "live mode should include only real Hub API items, not the built-in seed catalog",
      );
      assert.ok(
        agents.every((agent) => !forbiddenSeedSlugs.has(agent.slug)),
        "live mode should not include removed built-in seed agents",
      );
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
