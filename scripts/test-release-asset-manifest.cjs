#!/usr/bin/env node
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const yaml = require("js-yaml");

const root = path.resolve(__dirname, "..");
const publisherPath = path.join(root, "scripts", "publish-mac-release.mjs");
const verifierPath = path.join(root, "scripts", "verify-release-assets.mjs");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha512(value) {
  return createHash("sha512").update(value).digest("base64");
}

(async () => {
  const publisher = await import(pathToFileURL(publisherPath).href + "?publish-test=" + Date.now());
  const verifier = await import(pathToFileURL(verifierPath).href + "?verify-test=" + Date.now());
  const version = "9.8.7";
  const tag = "v" + version;
  const sourceCommit = "a".repeat(40);
  const releaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-release-assets-"));
  const required = publisher.requiredReleaseAssetNames(version);
  const compatibility = require(path.join(root, "build-resources", "update-compatibility.cjs"))
    .loadUpdateCompatibility(path.join(root, "package.json"));
  try {
    for (const name of required) {
      fs.writeFileSync(path.join(releaseDir, name), "fixture:" + name + "\n");
    }
    const feedEntry = (name) => {
      const content = fs.readFileSync(path.join(releaseDir, name));
      return { url: name, sha512: sha512(content), size: content.length };
    };
    const windowsSetup = `Agentlas-${version}-Windows-x64-Setup.exe`;
    const linuxAppImage = `Agentlas-${version}-Linux-x64.AppImage`;
    const linuxDeb = `Agentlas-${version}-Linux-x64.deb`;
    const windowsEntry = feedEntry(windowsSetup);
    const linuxEntries = [feedEntry(linuxAppImage), feedEntry(linuxDeb)];
    fs.writeFileSync(path.join(releaseDir, "latest.yml"), yaml.dump({
      version,
      files: [windowsEntry],
      path: windowsSetup,
      sha512: windowsEntry.sha512,
      releaseDate: "2026-07-15T00:00:00.000Z",
      agentlasCompatibility: compatibility,
    }, { lineWidth: -1 }));
    fs.writeFileSync(path.join(releaseDir, "latest-linux.yml"), yaml.dump({
      version,
      files: linuxEntries,
      path: linuxAppImage,
      sha512: linuxEntries[0].sha512,
      releaseDate: "2026-07-15T00:00:00.000Z",
      agentlasCompatibility: compatibility,
    }, { lineWidth: -1 }));
    fs.writeFileSync(
      path.join(releaseDir, "latest-mac.yml"),
      [
        "version: " + version,
        "files:",
        "  - url: Agentlas-" + version + "-arm64.zip",
        "  - url: Agentlas-" + version + "-x64.zip",
        "",
      ].join("\n"),
    );
    const macArtifact = (arch) => {
      const fileName = `Agentlas-${version}-${arch}.dmg`;
      const bytes = fs.readFileSync(path.join(releaseDir, fileName));
      return {
        arch,
        fileName,
        sizeBytes: bytes.length,
        sha256: sha256(bytes),
        sha512: sha512(bytes),
        notarized: true,
        gatekeeperAccepted: true,
        innerApp: { notarized: true, gatekeeperAccepted: true },
        url: `https://github.com/agentlas-ai/agentlas-desktop-releases/releases/download/${tag}/${fileName}`,
      };
    };
    const releaseVerification = {
      schemaVersion: "agentlas.desktop-release-verification.v2",
      generatedAt: "2026-07-17T00:00:00.000Z",
      ready: true,
      allowUnnotarized: false,
      version,
      tag,
      sourceCommit,
      repo: "agentlas-ai/agentlas-desktop-releases",
      artifacts: [macArtifact("arm64"), macArtifact("x64")],
    };
    const verificationPath = path.join(releaseDir, "desktop-release-verification.json");
    fs.writeFileSync(verificationPath, JSON.stringify(releaseVerification));

    const runWebEnvDry = (metadata, suffix, extra = []) => {
      const file = path.join(releaseDir, `web-env-${suffix}.json`);
      fs.writeFileSync(file, JSON.stringify(metadata));
      return spawnSync(process.execPath, [
        path.join(root, "scripts", "apply-web-release-env.mjs"),
        `--verification-file=${file}`,
        `--expected-version=${version}`,
        `--expected-tag=${tag}`,
        ...extra,
      ], { cwd: root, encoding: "utf8" });
    };
    const webEnvDryRun = runWebEnvDry(releaseVerification, "valid");
    assert.equal(webEnvDryRun.status, 0, webEnvDryRun.stderr);
    assert.match(webEnvDryRun.stdout, new RegExp(`AGENTLAS_DESKTOP_VERSION=${version}`));
    assert.match(webEnvDryRun.stdout, /AGENTLAS_DESKTOP_RELEASE_NOTARIZED=true/);
    assert.equal(
      fs.existsSync(path.join(releaseDir, "desktop-release.production.env")),
      false,
      "web metadata recovery must derive variables in memory without materializing a production env file",
    );
    for (const [label, metadata, extra, expectedError] of [
      ["wrong-repo", {
        ...releaseVerification,
        repo: "attacker/releases",
        artifacts: releaseVerification.artifacts.map((artifact) => ({
          ...artifact,
          url: `https://github.com/attacker/releases/releases/download/${tag}/${artifact.fileName}`,
        })),
      }, [], /expected release repository/],
      ["wrong-version", releaseVerification, ["--expected-version=9.8.8"], /expected-version/],
      ["not-ready", { ...releaseVerification, ready: false }, [], /does not prove an exact ready stable release/],
      ["missing-arch", { ...releaseVerification, artifacts: [releaseVerification.artifacts[0]] }, [], /exactly one arm64 and one x64/],
      ["unnotarized-inner", {
        ...releaseVerification,
        artifacts: [
          { ...releaseVerification.artifacts[0], innerApp: { notarized: false, gatekeeperAccepted: true } },
          releaseVerification.artifacts[1],
        ],
      }, [], /artifact contract failed/],
    ]) {
      const rejected = runWebEnvDry(metadata, label, extra);
      assert.notEqual(rejected.status, 0, `${label} must fail closed`);
      assert.match(rejected.stderr, expectedError, `${label} must report the exact rejected boundary`);
    }
    const manifest = verifier.validateLocalReleaseDirectory({ releaseDir, version, tag, sourceCommit });
    assert.equal(manifest.assets.length, 17);
    assert.equal(
      manifest.assets.some((asset) => asset.name === "desktop-release.production.env"),
      false,
      "the public manifest must never contain the private production env handoff",
    );
    assert.equal(manifest.sourceCommit, sourceCommit);
    assert.equal(
      manifest.assets.find((asset) => asset.name === "latest-mac.yml").sha256,
      sha256(fs.readFileSync(path.join(releaseDir, "latest-mac.yml"))),
    );
    assert.equal(
      manifest.assets.find((asset) => asset.name === windowsSetup).sha512,
      windowsEntry.sha512,
      "Windows update feed digest must be computed from the exact setup bytes",
    );

    const remote = {
      tagName: tag,
      targetCommitish: sourceCommit,
      isDraft: false,
      isPrerelease: true,
      assets: manifest.assets.map(({ name }) => ({ name })),
    };
    assert.doesNotThrow(() => verifier.assertRemoteReleaseHeader({ remote, manifest }));
    assert.throws(
      () => verifier.assertRemoteReleaseHeader({
        remote: { ...remote, tagName: "v9.8.8" },
        manifest,
      }),
      /exact release tag/,
    );
    assert.throws(
      () => verifier.assertRemoteReleaseHeader({
        remote: {
          ...remote,
          assets: [...remote.assets, { name: "desktop-release.production.env" }],
        },
        manifest,
      }),
      /outside the explicit allowlist/,
      "a stale private env asset must block public promotion even when all required assets exist",
    );
    assert.throws(
      () => verifier.assertRemoteReleaseHeader({
        remote: {
          ...remote,
          assets: [...remote.assets, { name: "test-workforce-regression.json" }],
        },
        manifest,
      }),
      /outside the explicit allowlist/,
      "test and internal evidence assets must block public promotion",
    );
    assert.doesNotThrow(() => verifier.compareRemoteAsset({
      expected: manifest.assets[0],
      actual: manifest.assets[0],
    }));
    assert.throws(
      () => verifier.compareRemoteAsset({
        expected: manifest.assets[0],
        actual: { ...manifest.assets[0], sha256: "0".repeat(64) },
      }),
      /Remote release bytes differ/,
    );

    const publicVerificationRejections = [
      ["absolute releaseDir", { ...releaseVerification, releaseDir: "/Users/build/private/release" }],
      ["env file path", { ...releaseVerification, envFile: "/tmp/desktop-release.production.env" }],
      ["command evidence", {
        ...releaseVerification,
        artifacts: [
          { ...releaseVerification.artifacts[0], checks: { spctl: { output: "private command output" } } },
          releaseVerification.artifacts[1],
        ],
      }],
      ["signing internals", {
        ...releaseVerification,
        artifacts: [
          {
            ...releaseVerification.artifacts[0],
            innerApp: { ...releaseVerification.artifacts[0].innerApp, developerId: "internal evidence" },
          },
          releaseVerification.artifacts[1],
        ],
      }],
      ["absolute latest path", {
        ...releaseVerification,
        latestMac: { fileName: "/private/tmp/latest-mac.yml" },
      }],
    ];
    for (const [label, rejectedVerification] of publicVerificationRejections) {
      fs.writeFileSync(verificationPath, JSON.stringify(rejectedVerification));
      assert.throws(
        () => verifier.validateLocalReleaseDirectory({ releaseDir, version, tag, sourceCommit }),
        /public v2 schema|public artifact shape/,
        `${label} must not reach the public verification asset`,
      );
    }
    fs.writeFileSync(verificationPath, JSON.stringify(releaseVerification));

    const validWindowsFeed = fs.readFileSync(path.join(releaseDir, "latest.yml"), "utf8");
    const tamperedWindowsFeed = yaml.load(validWindowsFeed);
    tamperedWindowsFeed.files[0].sha512 = "invalid";
    fs.writeFileSync(path.join(releaseDir, "latest.yml"), yaml.dump(tamperedWindowsFeed, { lineWidth: -1 }));
    assert.throws(
      () => verifier.validateLocalReleaseDirectory({ releaseDir, version, tag, sourceCommit }),
      /Release feed digest mismatch: latest\.yml/,
      "a feed digest must be tied to the actual Windows artifact bytes",
    );
    fs.writeFileSync(path.join(releaseDir, "latest.yml"), validWindowsFeed);

    const tamperedWindowsSize = yaml.load(validWindowsFeed);
    tamperedWindowsSize.files[0].size += 1;
    fs.writeFileSync(path.join(releaseDir, "latest.yml"), yaml.dump(tamperedWindowsSize, { lineWidth: -1 }));
    assert.throws(
      () => verifier.validateLocalReleaseDirectory({ releaseDir, version, tag, sourceCommit }),
      /Release feed size mismatch: latest\.yml/,
      "a feed size must be tied to the actual Windows artifact bytes",
    );
    fs.writeFileSync(path.join(releaseDir, "latest.yml"), validWindowsFeed);

    const validLinuxFeed = fs.readFileSync(path.join(releaseDir, "latest-linux.yml"), "utf8");
    const missingLinuxArtifact = yaml.load(validLinuxFeed);
    missingLinuxArtifact.files.pop();
    fs.writeFileSync(path.join(releaseDir, "latest-linux.yml"), yaml.dump(missingLinuxArtifact, { lineWidth: -1 }));
    assert.throws(
      () => verifier.validateLocalReleaseDirectory({ releaseDir, version, tag, sourceCommit }),
      /Release feed artifact set mismatch: latest-linux\.yml/,
      "Linux auto-update feeds must declare both the AppImage and DEB artifact set",
    );
    fs.writeFileSync(path.join(releaseDir, "latest-linux.yml"), validLinuxFeed);

    const incompatibleFeed = yaml.load(validWindowsFeed);
    incompatibleFeed.agentlasCompatibility.targetSchemaVersion += 1;
    fs.writeFileSync(path.join(releaseDir, "latest.yml"), yaml.dump(incompatibleFeed, { lineWidth: -1 }));
    assert.throws(
      () => verifier.validateLocalReleaseDirectory({ releaseDir, version, tag, sourceCommit }),
      /Release feed compatibility mismatch: latest\.yml/,
      "a release feed must carry the exact immutable updater compatibility contract",
    );
    fs.writeFileSync(path.join(releaseDir, "latest.yml"), validWindowsFeed);

    fs.rmSync(path.join(releaseDir, required[0]));
    assert.throws(
      () => verifier.validateLocalReleaseDirectory({ releaseDir, version, tag, sourceCommit }),
      /Missing required release artifact/,
    );
  } finally {
    fs.rmSync(releaseDir, { recursive: true, force: true });
  }
  console.log("test-release-asset-manifest: PASS (full artifact barrier, source binding, remote byte comparison)");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
