#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-cloud-agent-"));
process.env.AGENTLAS_CLOUD_PACKAGE_DIR = path.join(tempDir, "packages");
process.env.AGENTLAS_STORE_PATH = path.join(tempDir, "agentlas.sqlite");

const { initStore } = require("../dist/electron/store/db.js");
const { packageAndReviewCloudAgent } = require("../dist/electron/cloud-agents/package.js");

function writeAgent(root, extra = {}) {
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(root, ".agentlas"), { recursive: true });
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# Test Agent\n\nYou are a test agent.\n", "utf8");
  fs.writeFileSync(path.join(root, "README.md"), "# Test Agent\n\nPortable test package.\n", "utf8");
  fs.writeFileSync(
    path.join(root, ".agentlas", "routing-card.json"),
    JSON.stringify(
      {
        schemaVersion: "routing-card/2.0",
        id: "test-agent",
        type: "agent",
        name: "Test Agent",
        summary: "Routes test package requests to the test agent.",
        capabilities: ["test_package"],
        routing_status: "routing_ready",
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  for (const [name, body] of Object.entries(extra)) {
    fs.writeFileSync(path.join(root, name), body, "utf8");
  }
}

(async () => {
  let exitCode = 0;
  try {
    initStore();

    const cleanRoot = path.join(tempDir, "clean-agent");
    writeAgent(cleanRoot);
    const clean = await packageAndReviewCloudAgent({
      rootPath: cleanRoot,
      dryRun: true,
      reviewMode: "static-only",
    });
    assert.equal(clean.status, "dry-run");
    assert.equal(clean.review.costOwner, "none");
    assert.equal(clean.review.verdict, "pass");
    assert.equal(clean.manifest.includedFileCount, 3);
    assert.equal(clean.manifest.routingCard.schemaVersion, "routing-card/2.0");
    assert.ok(clean.manifest.packageHash.length >= 32);
    assert.ok(fs.existsSync(clean.bundlePath));

    const stableRoot = path.join(tempDir, "stable-agent-folder");
    writeAgent(stableRoot, {
      "agentlas.json": JSON.stringify(
        {
          schemaVersion: "1.0",
          slug: "stable-test-agent",
          name: "Renamed Test Agent",
          summary: "Stable identity should survive display-name changes.",
        },
        null,
        2,
      ) + "\n",
    });
    const stable = await packageAndReviewCloudAgent({
      rootPath: stableRoot,
      dryRun: true,
      reviewMode: "static-only",
    });
    assert.equal(stable.manifest.slug, "stable-test-agent");
    assert.equal(stable.manifest.name, "Renamed Test Agent");
    assert.equal(stable.manifest.includedFileCount, 4);

    const careerRoot = path.join(tempDir, "career-agent");
    writeAgent(careerRoot);
    fs.writeFileSync(
      path.join(careerRoot, ".agentlas", "public-career-card.json"),
      JSON.stringify(
        {
          schemaVersion: "1.0",
          kind: "agentlas-public-career-card",
          generatedAt: "2026-07-09T00:00:00Z",
          projectName: "Career Agent",
          indexStatus: "indexed",
          policy: "redacted_aggregate_projection",
          privacy: {
            rawLocalPathsIncluded: false,
            rawPromptsIncluded: false,
            rawTranscriptsIncluded: false,
            sourceTextIncluded: false,
          },
          counts: { sources: 1, nodes: 2, edges: 3 },
          canonicalSources: 1,
          staleSourceCount: 0,
          nodeTypes: { Project: 1 },
          writtenTo: "/tmp/should-not-leak",
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    const career = await packageAndReviewCloudAgent({
      rootPath: careerRoot,
      dryRun: true,
      reviewMode: "static-only",
    });
    assert.equal(career.status, "dry-run");
    assert.equal(career.manifest.careerGraph.kind, "agentlas-public-career-card");
    assert.equal(career.manifest.careerGraph.counts.nodes, 2);
    assert.equal(career.manifest.careerGraph.writtenTo, undefined);
    const careerBundle = JSON.parse(fs.readFileSync(career.bundlePath, "utf8"));
    assert.equal(careerBundle.careerGraph.kind, "agentlas-public-career-card");
    assert.equal(JSON.stringify(careerBundle).includes("/tmp/should-not-leak"), false);

    const blockedRoot = path.join(tempDir, "blocked-agent");
    writeAgent(blockedRoot, { ".env": "OPENAI_API_KEY=NOT_A_REAL_OPENAI_KEY_FOR_TEST\n" });
    const blocked = await packageAndReviewCloudAgent({
      rootPath: blockedRoot,
      dryRun: true,
      reviewMode: "static-only",
    });
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.review.verdict, "fail");
    assert.ok(blocked.review.findings.some((finding) => finding.category === "secret"));

    console.log("cloud agent package smoke passed");
  } catch (err) {
    exitCode = 1;
    console.error(err);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (app && typeof app.quit === "function") app.quit();
    process.exit(exitCode);
  }
})();
