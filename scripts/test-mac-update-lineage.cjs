#!/usr/bin/env node
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..");
const lineagePath = path.join(root, "scripts", "verify-mac-update-lineage.mjs");
const workflowPath = path.join(root, ".github", "workflows", "release-signed-mac.yml");
const publisherPath = path.join(root, "scripts", "publish-mac-release.mjs");
const packagePath = path.join(root, "package.json");

function digest(buffer) {
  return createHash("sha512").update(buffer).digest("base64");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

(async () => {
  const lineageSource = fs.readFileSync(lineagePath, "utf8");
  const workflowSource = fs.readFileSync(workflowPath, "utf8");
  const publisherSource = fs.readFileSync(publisherPath, "utf8");
  const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  const moduleUrl = `${pathToFileURL(lineagePath).href}?test=${Date.now()}`;
  const {
    LineageVerificationError,
    buildValueFreeEvidence,
    compareStableVersions,
    historyVerificationPlan,
    normalizeDesignatedRequirement,
    parseHistoryCount,
    parseStableVersion,
    selectPreviousStableRelease,
    selectPreviousStableReleases,
    validateMacUpdateFeed,
    validateRemoteCandidateMatchesLocal,
  } = await import(moduleUrl);
  const candidateVersion = "9.8.7";

  assert.deepEqual(parseStableVersion(`v${candidateVersion}`), {
    major: 9,
    minor: 8,
    patch: 7,
    version: candidateVersion,
  });
  for (const invalid of ["9.8", "v9.8.7-beta.1", "v09.8.7", " 9.8.7", "9.8.7 "]) {
    assert.equal(parseStableVersion(invalid), null, `must reject non-stable version ${invalid}`);
  }
  assert.equal(compareStableVersions("0.8.30", "0.8.31"), -1);
  assert.equal(compareStableVersions("v1.0.0", "0.99.99"), 1);
  assert.equal(compareStableVersions("0.8.31", "v0.8.31"), 0);

  assert.equal(parseHistoryCount(undefined), 2);
  assert.equal(parseHistoryCount("5"), 5);
  assert.throws(() => parseHistoryCount("0"), (error) => error.code === "history-count-invalid");

  const releases = [
    { tagName: "v9.8.7", isDraft: false, isPrerelease: true },
    { tagName: "v9.8.6", isDraft: true, isPrerelease: false },
    { tagName: "v9.8.4", isDraft: false, isPrerelease: false },
    { tagName: "v9.8.5", isDraft: false, isPrerelease: false },
  ];
  const previous = selectPreviousStableRelease(releases, candidateVersion);
  assert.deepEqual(previous, { tag: "v9.8.5", version: "9.8.5" });
  const history = selectPreviousStableReleases(releases, candidateVersion, 2);
  assert.deepEqual(history, [
    { tag: "v9.8.5", version: "9.8.5" },
    { tag: "v9.8.4", version: "9.8.4" },
  ]);
  const plan = historyVerificationPlan(history);
  assert.equal(plan.length, 4, "both architectures of every selected historical release must be iterated");
  assert.deepEqual(
    plan.map(({ release, architecture }) => `${release.tag}:${architecture}`),
    ["v9.8.5:arm64", "v9.8.5:x64", "v9.8.4:arm64", "v9.8.4:x64"],
    "the verification plan must not silently drop a selected release or architecture",
  );
  assert.throws(
    () => selectPreviousStableRelease([{ tagName: "v9.8.7", isDraft: false, isPrerelease: false }], candidateVersion),
    (error) => error instanceof LineageVerificationError && error.code === "candidate-already-stable",
  );
  assert.throws(
    () => selectPreviousStableReleases([{ tagName: "v9.9.0", isDraft: false, isPrerelease: false }], candidateVersion, 1),
    (error) => error.code === "candidate-not-newer-than-current-stable",
    "candidate promotion must be strictly newer than the current stable release",
  );

  const compatibility = {
    minimumSourceAppVersion: "0.7.0",
    minimumRuntimeVersion: "1.0.4",
    minimumSchemaVersion: 35,
    targetSchemaVersion: 65,
    bundledRuntimeVersion: "9.9.9",
  };
  const buffers = {
    arm64: Buffer.from("candidate-arm64-zip"),
    x64: Buffer.from("candidate-x64-zip"),
  };
  const zipArtifacts = Object.fromEntries(
    Object.entries(buffers).map(([architecture, buffer]) => [architecture, {
      fileName: `Agentlas-${candidateVersion}-${architecture}.zip`,
      size: buffer.length,
      sha512: digest(buffer),
    }]),
  );
  const feed = {
    version: candidateVersion,
    files: [
      { url: zipArtifacts.arm64.fileName, sha512: zipArtifacts.arm64.sha512, size: zipArtifacts.arm64.size },
      { url: zipArtifacts.x64.fileName, sha512: zipArtifacts.x64.sha512, size: zipArtifacts.x64.size },
    ],
    path: zipArtifacts.arm64.fileName,
    sha512: zipArtifacts.arm64.sha512,
    releaseDate: "2026-07-15T00:00:00.000Z",
    minimumSystemVersion: "21.0.0",
    agentlasCompatibility: compatibility,
  };
  assert.deepEqual(
    validateMacUpdateFeed({ feed, candidateVersion, compatibility, zipArtifacts }),
    {
      version: true,
      compatibility: true,
      zipSet: true,
      zipSizes: true,
      zipDigests: true,
      primaryZip: true,
      remoteFeedBytes: false,
      remoteZipSizes: false,
      remoteZipDigests: false,
    },
  );

  for (const [mutate, code] of [
    [(value) => { value.version = "9.8.6"; }, "feed-version-mismatch"],
    [(value) => { value.minimumSystemVersion = "12.0"; }, "feed-system-compatibility-mismatch"],
    [(value) => { value.agentlasCompatibility.minimumSchemaVersion = 34; }, "feed-agentlas-compatibility-mismatch"],
    [(value) => { value.files[0].url = `Agentlas-${candidateVersion}-arm64.dmg`; }, "feed-zip-set-invalid"],
    [(value) => { value.files[0].size += 1; }, "feed-zip-size-mismatch"],
    [(value) => { value.files[0].sha512 = "wrong"; }, "feed-zip-sha512-mismatch"],
    [(value) => { value.path = `Agentlas-${candidateVersion}-arm64.dmg`; }, "feed-primary-zip-invalid"],
    [(value) => { value.releaseDate = "not-a-date"; }, "feed-release-date-invalid"],
  ]) {
    const mutated = clone(feed);
    mutate(mutated);
    assert.throws(
      () => validateMacUpdateFeed({ feed: mutated, candidateVersion, compatibility, zipArtifacts }),
      (error) => error instanceof LineageVerificationError && error.code === code,
      `feed mutation must fail with ${code}`,
    );
  }

  const localFeedBytes = Buffer.from("version: 9.8.7\n");
  assert.deepEqual(
    validateRemoteCandidateMatchesLocal({
      localFeedBytes,
      remoteFeedBytes: Buffer.from(localFeedBytes),
      localZipArtifacts: zipArtifacts,
      remoteZipArtifacts: clone(zipArtifacts),
    }),
    { remoteFeedBytes: true, remoteZipSizes: true, remoteZipDigests: true },
  );
  assert.throws(
    () => validateRemoteCandidateMatchesLocal({
      localFeedBytes,
      remoteFeedBytes: Buffer.from("version: 9.8.7\r\n"),
      localZipArtifacts: zipArtifacts,
      remoteZipArtifacts: clone(zipArtifacts),
    }),
    (error) => error.code === "remote-feed-bytes-mismatch",
    "remote feed must match local bytes, not merely parsed fields",
  );
  const wrongRemoteZip = clone(zipArtifacts);
  wrongRemoteZip.x64.size += 1;
  assert.throws(
    () => validateRemoteCandidateMatchesLocal({
      localFeedBytes,
      remoteFeedBytes: Buffer.from(localFeedBytes),
      localZipArtifacts: zipArtifacts,
      remoteZipArtifacts: wrongRemoteZip,
    }),
    (error) => error.code === "remote-zip-size-mismatch",
  );

  assert.equal(
    normalizeDesignatedRequirement(" designated => identifier \"com.agentlas.desktop\"   and anchor apple generic "),
    "identifier \"com.agentlas.desktop\" and anchor apple generic",
  );
  const evidence = buildValueFreeEvidence({
    ready: true,
    repo: "agentlas-ai/agentlas-desktop-releases",
    previous: { tag: "v9.8.6", version: "9.8.6" },
    candidate: { tag: "v9.8.7", version: "9.8.7" },
    candidateDesignatedRequirementConsistent: true,
    historicalRequirementTextEqual: false,
    artifacts: [{
      source: "candidate",
      container: "zip",
      architecture: "arm64",
      officialBundleIdentity: true,
      developerId: true,
      pinnedDesignatedRequirement: true,
      gatekeeper: true,
      notarization: true,
      previousDesignatedRequirements: true,
      updaterTrustPolicyResource: true,
      bundleVersion: true,
      containerIntegrity: true,
      appPath: "/private/secret/Agentlas.app",
      teamIdentifier: "SECRETTEAM",
      rawOutput: "secret codesign output",
      designatedRequirement: "secret requirement",
      sha512: "secret digest",
    }],
    feed: {
      version: true,
      compatibility: true,
      zipSet: true,
      zipSizes: true,
      zipDigests: true,
      primaryZip: true,
      remoteFeedBytes: true,
      remoteZipSizes: true,
      remoteZipDigests: true,
    },
    generatedAt: "2026-07-15T00:00:00.000Z",
  });
  const serializedEvidence = JSON.stringify(evidence);
  for (const forbidden of ["/private/secret", "SECRETTEAM", "secret codesign", "secret requirement", "secret digest"]) {
    assert.doesNotMatch(serializedEvidence, new RegExp(forbidden), `evidence must not disclose ${forbidden}`);
  }
  assert.equal(evidence.lineage.strictlyIncreasing, true);
  assert.equal(evidence.verificationKind, "signed-artifact-lineage");
  assert.equal(evidence.actualShipItReplacement, false, "artifact lineage must not claim a real ShipIt replacement run");
  assert.equal(evidence.trust.candidateDesignatedRequirementConsistent, true);
  assert.equal(evidence.trust.historicalRequirementTextEqual, false, "historical text equality is evidence, not a gate");
  assert.equal(evidence.trust.artifacts[0].previousDesignatedRequirements, true);
  assert.equal(evidence.trust.artifacts[0].updaterTrustPolicyResource, true, "candidate evidence must record the packaged updater trust-policy gate without leaking its contents");
  assert.equal(evidence.feed.remoteFeedBytes, true);

  assert.match(lineageSource, /gh[\s\S]*?release[\s\S]*?list[\s\S]*?isDraft,isPrerelease/);
  assert.match(lineageSource, /release", "download"[\s\S]*?previous\.tag/);
  assert.match(lineageSource, /historyVerificationPlan\(history\)[\s\S]*?for \(const \{ release, releaseIndex, architecture \} of historyPlan\)/);
  assert.match(
    lineageSource,
    /extension: "zip"[\s\S]*?extension: "dmg"[\s\S]*?verifyOuterDmg\(dmgPath/,
    "every selected historical release must verify ZIP and DMG inner apps",
  );
  assert.match(lineageSource, /verifyMacAppBundle/);
  assert.match(lineageSource, /xcrun[\s\S]*?stapler[\s\S]*?validate/);
  assert.match(lineageSource, /spctl[\s\S]*?context:primary-signature/);
  assert.match(lineageSource, /CFBundleIdentifier/);
  assert.match(lineageSource, /CFBundleShortVersionString/);
  assert.match(
    lineageSource,
    /previousRequirements[\s\S]*?codesign[\s\S]*?--deep[\s\S]*?-R=\$\{requirement\}/,
    "every candidate app must actively verify against the previous official app requirement",
  );
  assert.match(lineageSource, /localFeedBytes\.equals\(remoteFeedBytes\)/);
  assert.match(lineageSource, /remote-zip-sha512-mismatch/);
  assert.match(
    lineageSource,
    /source === "candidate"[\s\S]*?inspectPackagedMacSigningPolicy[\s\S]*?candidate-updater-trust-policy-mismatch/,
    "each candidate inner app must carry the exact regular updater trust policy before public promotion",
  );
  assert.match(lineageSource, /process\.platform !== "darwin"/);
  assert.doesNotMatch(
    lineageSource,
    /new Set\(previousRequirements\)\.size === 1[\s\S]{0,120}fail/,
    "historical requirement text equality must not block certificate rotation when active -R compatibility passes",
  );

  assert.equal(pkg.scripts["release:mac:lineage"], "node scripts/verify-mac-update-lineage.mjs");
  assert.equal(pkg.scripts["test:mac-update-lineage"], "node scripts/test-mac-update-lineage.cjs");
  assert.match(
    workflowSource,
    /Verify local signed-artifact update lineage[\s\S]*?release:mac:lineage[\s\S]*?--skip-remote-candidate/,
  );
  assert.match(workflowSource, /release:mac:lineage[\s\S]*?--history-count=2[\s\S]*?--skip-remote-candidate/);
  assert.match(
    workflowSource,
    /Upload signed Mac package set for the release barrier[\s\S]*?update-lineage-verification\.json/,
  );
  assert.match(
    publisherSource,
    /release",\s*"upload"[\s\S]*?verify-mac-update-lineage\.mjs[\s\S]*?waitForRequiredReleaseAssets/,
    "remote byte/digest lineage must run after staging upload and before stable promotion",
  );
  assert.match(publisherSource, /verify-mac-update-lineage\.mjs[\s\S]*?--history-count=2/);

  console.log("test-mac-update-lineage: PASS (last official -> candidate trust, feed, remote bytes, value-free evidence)");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
