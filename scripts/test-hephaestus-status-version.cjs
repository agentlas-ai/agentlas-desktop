#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const root = path.resolve(__dirname, "..", "Hephaestus");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-hephaestus-version-"));
app.setPath("userData", path.join(temp, "user-data"));

app.whenReady().then(async () => {
  let exitCode = 0;
  try {
    const expected = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8")).version;
    const { hephaestusAvailable, readHephaestusVersion } = require("../dist/electron/hephaestus/engine.js");
    const { resetHephaestusRootCache } = require("../dist/electron/hephaestus/root.js");
    assert.equal(readHephaestusVersion(root), expected);

    const installedRoot = path.join(temp, "managed-runtime");
    fs.mkdirSync(path.join(installedRoot, "agentlas_cloud"), { recursive: true });
    fs.writeFileSync(path.join(installedRoot, "agentlas_cloud", "__main__.py"), "# fixture\n");
    fs.writeFileSync(path.join(installedRoot, "RELEASE"), "v9.8.7\n");
    assert.equal(readHephaestusVersion(installedRoot), "9.8.7", "managed installs expose RELEASE without a manifest");

    process.env.HEPHAESTUS_RUNTIME_ROOT = installedRoot;
    resetHephaestusRootCache();
    const status = await hephaestusAvailable("en");
    assert.equal(status.available, true);
    assert.equal(status.version, "9.8.7", "UI engine version must come from the active managed Agentlas OS runtime");
    assert.match(status.pythonVersion || "", /^\d+\.\d+\.\d+$/);
    assert.notEqual(status.version, status.pythonVersion, "Python version must not masquerade as Agentlas OS version");
    console.log(JSON.stringify({ ok: true, bundledVersion: expected, version: status.version, pythonVersion: status.pythonVersion }));
  } catch (error) {
    exitCode = 1;
    console.error(error);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
    app.exit(exitCode);
  }
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
