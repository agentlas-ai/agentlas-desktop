#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { app, nativeImage } = require("electron");

const rootPath = path.resolve(process.argv[2] || "");

app.whenReady().then(async () => {
  try {
    assert.ok(rootPath && fs.existsSync(rootPath), "pass a generated Agent App root");
    const { buildSiteAgentApp, captureSiteAgentAppThumbnail } = require("../dist/electron/site/agent-app-thumbnail.js");
    const distRoot = process.argv.includes("--build")
      ? await buildSiteAgentApp(rootPath)
      : path.join(rootPath, "astryx-app", "dist");
    assert.ok(fs.existsSync(path.join(distRoot, "index.html")), "Astryx production build must contain dist/index.html");
    const thumbnailPath = await captureSiteAgentAppThumbnail(rootPath, distRoot);
    const image = nativeImage.createFromPath(thumbnailPath);
    assert.equal(image.isEmpty(), false);
    assert.deepEqual(image.getSize(), { width: 1280, height: 720 });
    console.log(`Site Agent App thumbnail captured: ${thumbnailPath}`);
  } finally {
    app.exit(0);
  }
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
