#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const yaml = require("js-yaml");

const root = path.resolve(__dirname, "..");
const pkg = require(path.join(root, "package.json"));
const manifest = require(path.join(root, "Hephaestus", "manifest.json"));
const { parseUpdaterCompatibility } = require("../dist/electron/updater/controller.js");
const { stampUpdateCompatibilityFile } = require("../build-resources/update-compatibility.cjs");

const compatibility = pkg.agentlasUpdateCompatibility;
assert.deepEqual(parseUpdaterCompatibility(compatibility), compatibility, "runtime parser must accept the release manifest exactly");
assert.equal(compatibility.minimumSourceAppVersion, "0.7.0", "known embedded-runtime update floor is desktop v0.7.0");
assert.equal(compatibility.minimumRuntimeVersion, "1.0.4", "v0.7.0 shipped Hephaestus v1.0.4");
assert.equal(compatibility.minimumSchemaVersion, 35, "v0.7.0 shipped SQLite schema 35");
assert.equal(compatibility.bundledRuntimeVersion, manifest.version, "feed runtime must match the bundled Hephaestus manifest");

const dbSource = fs.readFileSync(path.join(root, "electron", "store", "db.ts"), "utf8");
const schemaMatch = dbSource.match(/const SCHEMA_VERSION = (\d+);/);
assert.ok(schemaMatch, "desktop database schema constant must remain discoverable by the release gate");
assert.equal(Number(schemaMatch[1]), compatibility.targetSchemaVersion, "release target schema must match the app migration target");

for (const configName of ["electron-builder.yml", "electron-builder.mac-stable.yml"]) {
  const config = fs.readFileSync(path.join(root, configName), "utf8");
  assert.doesNotMatch(
    config,
    /afterAllArtifactBuild/,
    `${configName} must not rely on afterAllArtifactBuild because latest*.yml is written later`,
  );
}
const crossPlatformWorkflow = fs.readFileSync(path.join(root, ".github", "workflows", "release.yml"), "utf8");
const publishStep = crossPlatformWorkflow.slice(crossPlatformWorkflow.indexOf("- name: Package and publish"));
const builderIndex = publishStep.indexOf("electron-builder ${{ matrix.builder_args }} --publish always");
const stampIndex = publishStep.indexOf("node scripts/stamp-update-feeds.mjs --release-dir=release --require");
const uploadIndex = publishStep.indexOf('gh release upload "$tag"');
assert.ok(builderIndex >= 0 && stampIndex > builderIndex && uploadIndex > stampIndex, "cross-platform feeds must be stamped and clobber-uploaded after electron-builder writes them");
assert.match(publishStep, /gh release upload[\s\S]*?--clobber[\s\S]*?"\$\{update_feeds\[@\]\}"/);
const mainSource = fs.readFileSync(path.join(root, "electron", "main.ts"), "utf8");
const readyBlock = mainSource.slice(mainSource.indexOf("app.whenReady().then"));
const preflightIndex = readyBlock.indexOf("preflightUpdaterStartup()");
const migrationIndex = readyBlock.indexOf("initStore();");
const fullCheckIndex = readyBlock.indexOf("await initAutoUpdater();");
const materializeIndex = readyBlock.indexOf("materializeAllAgents();");
const backgroundIndex = readyBlock.indexOf("startAutomationScheduler();");
assert.ok(
  preflightIndex >= 0 &&
    migrationIndex > preflightIndex &&
    fullCheckIndex > migrationIndex &&
    materializeIndex > fullCheckIndex &&
    backgroundIndex > fullCheckIndex,
  "startup must gate recovery before migration, then verify continuity before materialization/background writers",
);
const headlessBlock = readyBlock.slice(
  readyBlock.indexOf('if (process.argv.includes("--headless-automations"))'),
  readyBlock.indexOf("registerRendererProtocol();"),
);
assert.match(
  headlessBlock,
  /if \(updatePreflight\.pendingInstall\)[\s\S]*?app\.quit\(\);[\s\S]*?return;[\s\S]*?initStore\(\);/,
  "a pending update must stop the headless runner before it can migrate or run background automations",
);
for (const scriptName of ["stamp-update-feeds.mjs", "fix-mac-latest-zip.mjs"]) {
  const source = fs.readFileSync(path.join(root, "scripts", scriptName), "utf8");
  assert.match(source, /fileURLToPath\(new URL\(/, `${scriptName} must convert file URLs portably on Windows`);
  assert.doesNotMatch(source, /new URL\([^\n]+\.pathname/, `${scriptName} must not treat URL pathnames as filesystem paths`);
}

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-update-feed-"));
  try {
    const releaseDir = path.join(temp, "release");
    fs.mkdirSync(releaseDir, { recursive: true });
    fs.writeFileSync(path.join(releaseDir, `Agentlas-${pkg.version}-arm64.zip`), "arm64-zip");
    fs.writeFileSync(path.join(releaseDir, `Agentlas-${pkg.version}-x64.zip`), "x64-zip");
    const fixed = spawnSync(
      process.execPath,
      [path.join(root, "scripts", "fix-mac-latest-zip.mjs"), `--release-dir=${releaseDir}`],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(fixed.status, 0, fixed.stderr || fixed.stdout);
    const latestMacPath = path.join(releaseDir, "latest-mac.yml");
    const latestMacSource = fs.readFileSync(latestMacPath, "utf8");
    const latestMac = yaml.load(latestMacSource);
    assert.deepEqual(latestMac.agentlasCompatibility, compatibility);
    assert.ok(latestMac.files.every((file) => file.url.endsWith(".zip")), "mac update feed must use Squirrel-compatible zip files");
    assert.equal((latestMacSource.match(/^agentlasCompatibility:/gm) || []).length, 1);
    stampUpdateCompatibilityFile(latestMacPath, path.join(root, "package.json"));
    assert.equal(
      (fs.readFileSync(latestMacPath, "utf8").match(/^agentlasCompatibility:/gm) || []).length,
      1,
      "compatibility stamping must be idempotent",
    );

    const crossDir = path.join(temp, "cross-platform");
    fs.mkdirSync(crossDir, { recursive: true });
    const latest = path.join(crossDir, "latest.yml");
    const latestLinux = path.join(crossDir, "latest-linux.yml");
    fs.writeFileSync(latest, `version: ${pkg.version}\npath: Agentlas.exe\nsha512: abc\n`);
    fs.writeFileSync(latestLinux, `version: ${pkg.version}\npath: Agentlas.AppImage\nsha512: def\n`);
    const stamped = spawnSync(
      process.execPath,
      [path.join(root, "scripts", "stamp-update-feeds.mjs"), `--release-dir=${crossDir}`, "--require"],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(stamped.status, 0, stamped.stderr || stamped.stdout);
    for (const file of [latest, latestLinux]) {
      assert.deepEqual(yaml.load(fs.readFileSync(file, "utf8")).agentlasCompatibility, compatibility);
    }

    console.log("test-update-release-contract: PASS (mac zip + cross-platform compatibility feeds)");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
