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
const releaseAssetVerifier = fs.readFileSync(path.join(root, "scripts/verify-release-assets.mjs"), "utf8");
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");

assert.match(
  packageMac,
  /electron-builder[\s\S]*?--publish never[\s\S]*?--config\.directories\.output=/,
  "mac build must never auto-publish pre-notarization artifacts",
);
assert.match(
  releaseWorkflow,
  /workflow_call:[\s\S]*?build-cross-platform:[\s\S]*?Package verified Actions artifacts only[\s\S]*?--publish never[\s\S]*?stamp-update-feeds\.mjs[\s\S]*?Upload Windows\/Linux package set for the release barrier/,
  "Windows/Linux workflow must be reusable, build-only, and emit barrier artifacts rather than publish",
);
assert.doesNotMatch(
  releaseWorkflow,
  /--publish\s+always/,
  "Windows/Linux release workers must never publish directly to the public releases repository",
);
assert.match(
  signedWorkflow,
  /release-artifact-barrier:[\s\S]*?cross-platform-release-build[\s\S]*?mac-release-preflight[\s\S]*?test "\$CROSS_PLATFORM_RESULT" = "success"[\s\S]*?test "\$MAC_PREFLIGHT_RESULT" = "success"/,
  "the all-OS barrier must block signed artifacts and the public writer until Windows, Linux, and macOS gates pass",
);
assert.match(
  signedWorkflow,
  /build-signed-mac-artifacts:[\s\S]*?needs: release-artifact-barrier[\s\S]*?Build, sign, notarize, and verify Mac artifacts[\s\S]*?Upload signed Mac package set for the release barrier[\s\S]*?publish-all-platforms:[\s\S]*?needs:[\s\S]*?release-artifact-barrier[\s\S]*?build-signed-mac-artifacts/,
  "the signed Mac artifacts must be produced after the all-OS barrier and consumed by the sole public writer",
);
assert.match(
  signedWorkflow,
  /Download every barrier-approved OS artifact[\s\S]*?pattern: agentlas-release-\*[\s\S]*?merge-multiple: true[\s\S]*?Verify local required manifest and hashes before first public write[\s\S]*?release:assets:verify[\s\S]*?Single releases-repository writer and stable promotion/,
  "the sole writer must download every OS artifact and locally verify the full manifest before it has a release token",
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
  publishMac,
  /readLatestStableTag\(repo\)[\s\S]*?latestTag !== tag/,
  "the final receipt must verify that GitHub latest resolves to the promoted tag",
);
assert.match(
  publishMac,
  /const files = requiredReleaseAssetNames\(version\)\.map\(\(name\) => requireFile\(join\(releaseDir, name\)\)\);/,
  "the single writer must upload the exact full barrier contract, not a Mac-only subset",
);
assert.match(
  releaseAssetVerifier,
  /for \(const expected of manifest\.assets\)[\s\S]*?"release",\s*"download"[\s\S]*?compareRemoteAsset\(\{ expected, actual \}\)/,
  "remote verification must fetch and byte-compare every manifest asset rather than inspect names only",
);
const localVerificationIndex = publishMac.indexOf('"scripts/verify-release-assets.mjs"');
const uploadIndex = publishMac.indexOf('run("gh", ["release", "upload"');
const remoteVerificationIndex = publishMac.indexOf('"--verify-remote"');
const lineageVerificationIndex = publishMac.indexOf('"scripts/verify-mac-update-lineage.mjs"');
const completenessIndex = publishMac.lastIndexOf("waitForRequiredReleaseAssets({");
const promotionIndex = publishMac.lastIndexOf('"--prerelease=false"');
assert.ok(
  localVerificationIndex >= 0 &&
    uploadIndex > localVerificationIndex &&
    remoteVerificationIndex > uploadIndex &&
    lineageVerificationIndex > remoteVerificationIndex &&
    completenessIndex > lineageVerificationIndex &&
    promotionIndex > completenessIndex,
  "the publisher must locally verify all assets, upload them once, remotely byte-verify them, then verify lineage/completeness before stable/latest promotion",
);
assert.doesNotMatch(
  readme,
  /github\/v\/release\/agentlas-ai\/agentlas-desktop-releases\?include_prereleases/,
  "the stable download badge must not display withdrawn prereleases",
);

(async () => {
  const moduleUrl = `${pathToFileURL(path.join(root, "scripts/publish-mac-release.mjs")).href}?boundary-test=${Date.now()}`;
  const {
    assertStableReleaseIdentity,
    boundedMilliseconds,
    inspectReleaseState,
    requiredReleaseAssetNames,
    waitForRequiredReleaseAssets,
  } = await import(moduleUrl);

  const version = "9.8.7";
  assert.doesNotThrow(() => assertStableReleaseIdentity(version, `v${version}`));
  for (const [badVersion, badTag] of [
    ["9.8.7-beta.1", "v9.8.7-beta.1"],
    ["9.8.7", "v9.8.7-rc.1"],
    ["09.8.7", "v09.8.7"],
    ["9.8.7", "v9.8.8"],
  ]) {
    assert.throws(
      () => assertStableReleaseIdentity(badVersion, badTag),
      /Stable publisher requires an exact/,
      `stable publisher must reject version=${badVersion} tag=${badTag}`,
    );
  }
  const required = requiredReleaseAssetNames(version);
  assert.equal(required.length, 18, "stable promotion must require the full 18-file platform contract");
  assert.equal(new Set(required).size, required.length, "required release assets must be unique");
  const expectedRequiredAssets = [
    `Agentlas-${version}-Windows-x64-Setup.exe`,
    `Agentlas-${version}-Windows-x64-Setup.exe.blockmap`,
    `Agentlas-${version}-Windows-x64-Portable.exe`,
    `Agentlas-${version}-Linux-x64.AppImage`,
    `Agentlas-${version}-Linux-x64.deb`,
    `Agentlas-${version}-arm64.dmg`,
    `Agentlas-${version}-arm64.dmg.blockmap`,
    `Agentlas-${version}-arm64.zip`,
    `Agentlas-${version}-arm64.zip.blockmap`,
    `Agentlas-${version}-x64.dmg`,
    `Agentlas-${version}-x64.dmg.blockmap`,
    `Agentlas-${version}-x64.zip`,
    `Agentlas-${version}-x64.zip.blockmap`,
    "latest.yml",
    "latest-linux.yml",
    "latest-mac.yml",
    "desktop-release-verification.json",
    "desktop-release.production.env",
  ];
  assert.deepEqual(required, expectedRequiredAssets, "stable promotion must require exactly every Windows/Linux/Mac installer, updater feed, and evidence asset");

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
