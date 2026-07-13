const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..");
const packageMac = fs.readFileSync(path.join(root, "scripts/package-mac.sh"), "utf8");
const publishMac = fs.readFileSync(path.join(root, "scripts/publish-mac-release.mjs"), "utf8");
const releaseWorkflow = fs.readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8");
const signedWorkflow = fs.readFileSync(path.join(root, ".github/workflows/release-signed-mac.yml"), "utf8");
const builder = fs.readFileSync(path.join(root, "electron-builder.yml"), "utf8");
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");

assert.match(
  packageMac,
  /electron-builder[\s\S]*?--publish never[\s\S]*?--config\.directories\.output=/,
  "mac build must never auto-publish pre-notarization artifacts",
);
assert.match(
  signedWorkflow,
  /Build, sign, notarize, and verify DMGs[\s\S]*?Complete staged release and promote verified stable/,
  "workflow must keep signing/notarization before the only stable promotion step",
);
assert.match(
  builder,
  /publish:[\s\S]*?releaseType:\s*prerelease/,
  "Windows/Linux electron-builder publishing must create only prerelease staging",
);
assert.doesNotMatch(
  builder,
  /publish:[\s\S]*?releaseType:\s*release(?:\s|$)/,
  "cross-platform publishing must never create a stable release directly",
);
assert.match(
  releaseWorkflow,
  /OpenCrab security regression gates[\s\S]*?test:v64-automation-permission-migration[\s\S]*?test:automations-store[\s\S]*?test:automation-scheduler-guards[\s\S]*?test:mobile-read-boundary/,
  "shared preflight must block Windows/Linux publishing on automation authority regressions",
);
assert.match(
  releaseWorkflow,
  /Package and stage prerelease assets/,
  "cross-platform workflow must label its output as staging, not stable publishing",
);
assert.match(
  signedWorkflow,
  /AGENTLAS_RELEASE_ASSET_WAIT_MS:\s*"900000"[\s\S]*?AGENTLAS_RELEASE_ASSET_POLL_MS:\s*"10000"/,
  "signed publisher must use an explicit bounded asset wait",
);
assert.match(
  publishMac,
  /release",\s*"upload"[\s\S]*?waitForRequiredReleaseAssets\([\s\S]*?--prerelease=false[\s\S]*?--latest/,
  "Mac assets must upload before completeness verification and stable/latest promotion",
);
assert.match(
  publishMac,
  /readLatestStableTag\(repo\)[\s\S]*?latestTag !== tag/,
  "the final receipt must verify that GitHub latest resolves to the promoted tag",
);
assert.doesNotMatch(
  readme,
  /github\/v\/release\/agentlas-ai\/agentlas-desktop-releases\?include_prereleases/,
  "the stable download badge must not display withdrawn prereleases",
);

(async () => {
  const moduleUrl = `${pathToFileURL(path.join(root, "scripts/publish-mac-release.mjs")).href}?boundary-test=${Date.now()}`;
  const {
    boundedMilliseconds,
    inspectReleaseState,
    requiredReleaseAssetNames,
    waitForRequiredReleaseAssets,
  } = await import(moduleUrl);

  const version = "9.8.7";
  const required = requiredReleaseAssetNames(version);
  assert.equal(required.length, 18, "stable promotion must require the full 18-file platform contract");
  assert.equal(new Set(required).size, required.length, "required release assets must be unique");
  for (const expected of [
    `Agentlas-${version}-Windows-x64-Setup.exe`,
    `Agentlas-${version}-Windows-x64-Portable.exe`,
    `Agentlas-${version}-Linux-x64.AppImage`,
    `Agentlas-${version}-Linux-x64.deb`,
    `Agentlas-${version}-arm64.dmg`,
    `Agentlas-${version}-x64.dmg`,
    "latest.yml",
    "latest-linux.yml",
    "latest-mac.yml",
    "desktop-release-verification.json",
  ]) {
    assert.ok(required.includes(expected), `missing mandatory release asset contract: ${expected}`);
  }

  const stagedPartial = inspectReleaseState(version, {
    isDraft: false,
    isPrerelease: true,
    assets: required.slice(0, -1).map((name) => ({ name })),
  });
  assert.equal(stagedPartial.isStable, false);
  assert.equal(stagedPartial.complete, false);
  assert.deepEqual(stagedPartial.missingAssets, ["desktop-release.production.env"]);

  const stagedComplete = inspectReleaseState(version, {
    isDraft: false,
    isPrerelease: true,
    assets: required.map((name) => ({ name })),
  });
  assert.equal(stagedComplete.complete, true);
  assert.equal(stagedComplete.isStable, false);

  const stablePartial = inspectReleaseState(version, {
    isDraft: false,
    isPrerelease: false,
    assets: required.slice(0, -1).map((name) => ({ name })),
  });
  await assert.rejects(
    waitForRequiredReleaseAssets({
      version,
      readState: () => stablePartial,
      waitMs: 100,
      pollMs: 10,
      sleep: async () => {},
      now: () => 0,
    }),
    /Refusing partial stable release/,
    "a partial stable release must fail immediately",
  );

  const sequence = [stagedPartial, stagedComplete];
  const completed = await waitForRequiredReleaseAssets({
    version,
    readState: () => sequence.shift(),
    waitMs: 100,
    pollMs: 10,
    sleep: async () => {},
    now: () => 0,
  });
  assert.equal(completed.complete, true, "bounded polling must accept the complete staged release");

  let clock = 0;
  await assert.rejects(
    waitForRequiredReleaseAssets({
      version,
      readState: () => stagedPartial,
      waitMs: 10,
      pollMs: 10,
      sleep: async (delay) => { clock += delay; },
      now: () => clock,
    }),
    /Timed out waiting[\s\S]*stable promotion is blocked/,
    "missing assets must time out without stable promotion",
  );

  assert.equal(
    boundedMilliseconds(undefined, 500, { name: "WAIT", min: 1, max: 1_000 }),
    500,
  );
  assert.throws(
    () => boundedMilliseconds("0", 500, { name: "WAIT", min: 1, max: 1_000 }),
    /WAIT must be an integer/,
  );

  console.log("mac/cross-platform atomic release publish boundary ok");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
