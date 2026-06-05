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
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# Test Agent\n\nYou are a test agent.\n", "utf8");
  fs.writeFileSync(path.join(root, "README.md"), "# Test Agent\n\nPortable test package.\n", "utf8");
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
    assert.equal(clean.manifest.includedFileCount, 2);
    assert.ok(clean.manifest.packageHash.length >= 32);
    assert.ok(fs.existsSync(clean.bundlePath));

    const blockedRoot = path.join(tempDir, "blocked-agent");
    writeAgent(blockedRoot, { ".env": "OPENAI_API_KEY=sk-testsecretvaluethatshouldblock\n" });
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
