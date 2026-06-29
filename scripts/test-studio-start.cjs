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

    const pageResp = await fetch(result.url);
    assert.equal(pageResp.status, 200, "studio iframe page should load");
    const cookie = pageResp.headers.get("set-cookie") || "";
    assert.match(cookie, /studio_token=/, "studio page should set the request token cookie");

    const dataResp = await fetch(new URL("/studio-data.json", result.url).toString());
    assert.equal(dataResp.status, 200, "studio-data.json should be served");
    const liveData = await dataResp.json();
    const cleanData = JSON.parse(fs.readFileSync(path.join(root, "clean-studio-data.json"), "utf8"));
    assert.deepEqual(liveData, cleanData, "first launch should serve the clean blank studio seed");
    assert.equal(JSON.stringify(liveData).includes("단골노트"), false, "studio seed should not contain baked sample payloads");

    const requestUrl = new URL("/__studio/request", result.url).toString();
    const forbidden = await fetch(requestUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "note", idea: "no token" }),
    });
    assert.equal(forbidden.status, 403, "studio request bridge should reject missing token");

    const origin = new URL(result.url).origin;
    const authed = await fetch(requestUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: cookie.split(";")[0],
        origin,
      },
      body: JSON.stringify({ kind: "note", idea: "authorized smoke" }),
    });
    assert.equal(authed.status, 200, "studio request bridge should accept same-origin token requests");

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
