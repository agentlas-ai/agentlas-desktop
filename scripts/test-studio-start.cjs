#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-studio-start-"));
app.setPath("userData", path.join(tempDir, "user-data"));

(async () => {
  let exitCode = 0;
  try {
    const { startStudio, stopStudio, studioRoot } = require("../dist/electron/hephaestus/studio.js");
    const root = studioRoot();
    assert.ok(root, "studio-pack should resolve");
    const result = await startStudio();
    assert.equal(result.ok, true, result.reason || "studio should start");
    assert.ok(result.url, "studio start should return a local URL");

    const manifestUrl = new URL("/__studio/manifest", result.url).toString();
    const resp = await fetch(manifestUrl);
    assert.equal(resp.status, 200, "studio manifest should be served");
    const manifest = await resp.json();
    assert.ok(manifest && typeof manifest === "object", "studio manifest should be JSON");

    const second = await startStudio();
    assert.equal(second.ok, true, second.reason || "second start should reuse running studio");
    assert.equal(second.url, result.url, "second start should reuse the active studio URL");

    console.log(JSON.stringify({ ok: true, root, url: result.url, manifestKeys: Object.keys(manifest).slice(0, 8) }, null, 2));
    stopStudio();
  } catch (err) {
    exitCode = 1;
    console.error(err);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (app && typeof app.quit === "function") app.quit();
    process.exit(exitCode);
  }
})();
