#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-hephaestus-settings-"));
const modulePath = require.resolve("../dist/electron/hephaestus/supervisor.js");

function fixture(name, value) {
  const userData = path.join(root, name);
  fs.mkdirSync(userData, { recursive: true });
  const file = path.join(userData, "hephaestus-settings.json");
  if (value !== undefined) {
    fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value, null, 2), "utf8");
  }
  app.setPath("userData", userData);
  delete require.cache[modulePath];
  return { api: require(modulePath), file };
}

function reload(file) {
  app.setPath("userData", path.dirname(file));
  delete require.cache[modulePath];
  return require(modulePath);
}

app.whenReady().then(() => {
  let exitCode = 0;
  try {
    const fresh = fixture("fresh");
    assert.deepEqual(fresh.api.getEngineToggles(), { stormbreakerAuto: false, networkAuto: true });
    assert.equal(fs.existsSync(fresh.file), false, "reading a fresh default must not fabricate a user choice");
    fresh.api.setEngineToggle("network", false);
    assert.equal(JSON.parse(fs.readFileSync(fresh.file, "utf8")).networkAuto, false, "explicit opt-out must persist");
    assert.equal(reload(fresh.file).isNetworkAutoEnabled(), false, "explicit opt-out must survive restart");

    const storedFalse = fixture("stored-false", {
      supervisorEnabled: true,
      stormbreakerAuto: false,
      networkAuto: false,
    });
    assert.equal(storedFalse.api.isNetworkAutoEnabled(), false, "existing stored false must remain authoritative");
    storedFalse.api.setEngineToggle("stormbreaker", true);
    assert.equal(JSON.parse(fs.readFileSync(storedFalse.file, "utf8")).networkAuto, false, "unrelated writes must preserve opt-out");
    assert.equal(reload(storedFalse.file).isNetworkAutoEnabled(), false);

    const storedTrue = fixture("stored-true", {
      supervisorEnabled: true,
      stormbreakerAuto: false,
      networkAuto: true,
    });
    assert.equal(storedTrue.api.isNetworkAutoEnabled(), true, "existing stored true must remain authoritative");
    storedTrue.api.setSupervisorEnabled(false);
    assert.equal(JSON.parse(fs.readFileSync(storedTrue.file, "utf8")).networkAuto, true, "unrelated supervisor writes must preserve opt-in");
    assert.equal(reload(storedTrue.file).isNetworkAutoEnabled(), true);

    const legacy = fixture("legacy-missing-network", {
      supervisorEnabled: false,
      stormbreakerAuto: true,
    });
    assert.deepEqual(legacy.api.getEngineToggles(), { stormbreakerAuto: true, networkAuto: true });
    legacy.api.setSupervisorEnabled(true);
    assert.equal(JSON.parse(fs.readFileSync(legacy.file, "utf8")).networkAuto, true, "next settings write must canonicalize the new default");

    const corrupt = fixture("corrupt", "{not-json");
    assert.equal(corrupt.api.isNetworkAutoEnabled(), false, "a present corrupt settings file must fail closed");

    const invalidStoredChoice = fixture("invalid-network-value", {
      supervisorEnabled: true,
      stormbreakerAuto: false,
      networkAuto: "false",
    });
    assert.equal(invalidStoredChoice.api.isNetworkAutoEnabled(), false, "an invalid stored network value must fail closed");

    console.log("hephaestus settings migration contract: PASS");
  } catch (error) {
    exitCode = 1;
    console.error(error);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    app.exit(exitCode);
  }
}).catch((error) => {
  console.error(error);
  fs.rmSync(root, { recursive: true, force: true });
  app.exit(1);
});
