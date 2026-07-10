#!/usr/bin/env node
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const {
  readCloudAgentRestoreMarker,
  restoredModeMatches,
  restoreCloudAgentPackage,
  writeCloudAgentRegistrationMarker,
} = require("../dist/electron/cloud-agents/restore.js");

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function makePackage(entries) {
  const files = Object.entries(entries).map(([filePath, text]) => {
    const content = Buffer.from(text, "utf8");
    return {
      path: filePath,
      bytes: content.length,
      sha256: sha256(content),
      contentBase64: content.toString("base64"),
    };
  });
  const hash = crypto.createHash("sha256");
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.sha256);
    hash.update("\0");
  }
  return {
    packageHash: hash.digest("hex"),
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    agentKind: "agent",
    runtimeLabels: ["codex"],
    files,
  };
}

function makeV2Package(entries) {
  const files = Object.entries(entries).map(([filePath, value]) => {
    const spec = typeof value === "string" ? { text: value, executable: false } : value;
    const content = Buffer.from(spec.text, "utf8");
    return {
      path: filePath,
      bytes: content.length,
      sha256: sha256(content),
      contentBase64: content.toString("base64"),
      executable: spec.executable === true,
    };
  });
  const hash = crypto.createHash("sha256");
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.sha256);
    hash.update("\0");
    hash.update(file.executable ? "x" : "-");
    hash.update("\0");
  }
  return {
    packageHash: hash.digest("hex"),
    packageHashVersion: "path-sha256-executable-v2",
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    agentKind: "agent",
    runtimeLabels: ["codex"],
    files,
  };
}

function treeSnapshot(root) {
  const rows = [];
  function walk(dir, prefix = "") {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile()) rows.push([rel, sha256(fs.readFileSync(abs))]);
      else rows.push([rel, entry.isSymbolicLink() ? "symlink" : "other"]);
    }
  }
  walk(root);
  return rows;
}

function assertNoRestoreDebris(parent, basename) {
  const debris = fs.readdirSync(parent).filter((name) =>
    name.startsWith(`.${basename}.restore-`) || name.startsWith(`.${basename}.backup-`),
  );
  assert.deepEqual(debris, []);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-cloud-restore-"));
const destination = path.join(tempRoot, "owned-agent");

try {
  assert.equal(restoredModeMatches("win32", 0o666, false), true);
  assert.equal(restoredModeMatches("win32", 0o666, true), true, "Windows relies on marker executablePaths, not POSIX bits");
  assert.equal(restoredModeMatches("darwin", 0o600, false), true);
  assert.equal(restoredModeMatches("darwin", 0o700, true), true);
  assert.equal(restoredModeMatches("darwin", 0o666, false), false);
  assert.equal(restoredModeMatches("darwin", 0o777, true), false);
  const v1 = makePackage({
    "AGENTS.md": "# Owned Agent v1\n",
    "skills/legacy.md": "legacy behavior\n",
  });
  const first = restoreCloudAgentPackage({
    destinationDir: destination,
    slug: "owned-agent",
    package: v1,
    restoredAt: "2026-07-10T00:00:00.000Z",
  });
  assert.equal(first.changed, true);
  assert.equal(first.reason, "installed");
  assert.equal(first.packageHash, v1.packageHash);
  assert.equal(fs.readFileSync(path.join(destination, "AGENTS.md"), "utf8"), "# Owned Agent v1\n");
  assert.equal(fs.readFileSync(path.join(destination, "skills/legacy.md"), "utf8"), "legacy behavior\n");
  assert.equal(readCloudAgentRestoreMarker(destination).packageHash, v1.packageHash);

  writeCloudAgentRegistrationMarker({
    rootPath: destination,
    slug: "owned-agent",
    packageHash: v1.packageHash,
    packageHashVersion: "path-sha256-v1",
    fileCount: v1.fileCount,
    totalBytes: v1.totalBytes,
    executablePaths: [],
    registration: {
      cloudId: "cloud_owned_agent",
      slug: "owned-agent",
      scope: "owner-private",
      packageHash: v1.packageHash,
      packageHashVersion: "path-sha256-v1",
      revision: `rev_${"a".repeat(32)}`,
      updatedAt: "2026-07-10T00:00:00.000Z",
    },
    savedAt: "2026-07-10T00:00:00.000Z",
  });
  assert.deepEqual(readCloudAgentRestoreMarker(destination).registrations["owner-private"], {
    cloudId: "cloud_owned_agent",
    slug: "owned-agent",
    scope: "owner-private",
    packageHash: v1.packageHash,
    packageHashVersion: "path-sha256-v1",
    revision: `rev_${"a".repeat(32)}`,
    updatedAt: "2026-07-10T00:00:00.000Z",
  });
  assert.throws(
    () => writeCloudAgentRegistrationMarker({
      rootPath: destination,
      slug: "owned-agent",
      packageHash: v1.packageHash,
      packageHashVersion: "path-sha256-v1",
      fileCount: v1.fileCount,
      totalBytes: v1.totalBytes,
      executablePaths: [],
      registration: {
        cloudId: "cloud_owned_agent",
        slug: "owned-agent",
        scope: "owner-private",
        packageHash: v1.packageHash,
        packageHashVersion: "path-sha256-v1",
        revision: "forged-revision",
      },
    }),
    /does not match the packaged snapshot/,
  );

  const refreshedRevision = restoreCloudAgentPackage({
    destinationDir: destination,
    slug: "owned-agent",
    package: v1,
    restoredAt: "2026-07-10T00:30:00.000Z",
    registration: {
      cloudId: "cloud_owned_agent",
      slug: "owned-agent",
      scope: "owner-private",
      packageHash: v1.packageHash,
      packageHashVersion: "path-sha256-v1",
      revision: `rev_${"b".repeat(32)}`,
      updatedAt: "2026-07-10T00:30:00.000Z",
    },
  });
  assert.equal(refreshedRevision.changed, true);
  assert.equal(refreshedRevision.reason, "repaired");
  assert.equal(
    readCloudAgentRestoreMarker(destination).registrations["owner-private"].revision,
    `rev_${"b".repeat(32)}`,
  );

  const firstSnapshot = treeSnapshot(destination);
  const unchanged = restoreCloudAgentPackage({
    destinationDir: destination,
    slug: "owned-agent",
    package: v1,
  });
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.reason, "unchanged");
  assert.deepEqual(treeSnapshot(destination), firstSnapshot);

  const v2 = makePackage({
    "AGENTS.md": "# Owned Agent v2\n",
    "skills/current.md": "current behavior\n",
  });
  const updated = restoreCloudAgentPackage({
    destinationDir: destination,
    slug: "owned-agent",
    package: v2,
    restoredAt: "2026-07-10T01:00:00.000Z",
  });
  assert.equal(updated.changed, true);
  assert.equal(updated.reason, "updated");
  assert.equal(updated.previousPackageHash, v1.packageHash);
  assert.equal(fs.existsSync(path.join(destination, "skills/legacy.md")), false, "removed version files must not survive restore");
  assert.equal(fs.readFileSync(path.join(destination, "skills/current.md"), "utf8"), "current behavior\n");

  fs.writeFileSync(path.join(destination, "AGENTS.md"), "tampered local copy\n", "utf8");
  fs.writeFileSync(path.join(destination, "stale.txt"), "not in package\n", "utf8");
  const repaired = restoreCloudAgentPackage({
    destinationDir: destination,
    slug: "owned-agent",
    package: v2,
  });
  assert.equal(repaired.changed, true);
  assert.equal(repaired.reason, "repaired");
  assert.equal(fs.readFileSync(path.join(destination, "AGENTS.md"), "utf8"), "# Owned Agent v2\n");
  assert.equal(fs.existsSync(path.join(destination, "stale.txt")), false, "same-hash restore must repair stale files");

  const stableSnapshot = treeSnapshot(destination);
  const corruptFile = structuredClone(v2);
  corruptFile.files[0].contentBase64 = Buffer.from("corrupt payload\n", "utf8").toString("base64");
  assert.throws(
    () => restoreCloudAgentPackage({ destinationDir: destination, slug: "owned-agent", package: corruptFile }),
    /byte count mismatch|file hash mismatch/,
  );
  assert.deepEqual(treeSnapshot(destination), stableSnapshot, "failed restore must preserve the last usable copy");

  const oversizedEncoded = structuredClone(v2);
  oversizedEncoded.files[0].bytes = 1;
  oversizedEncoded.files[0].contentBase64 = "A".repeat(2 * 1024 * 1024);
  assert.throws(
    () => restoreCloudAgentPackage({ destinationDir: destination, slug: "owned-agent", package: oversizedEncoded }),
    /invalid encoded length/,
    "encoded payload length must be bounded before base64 regex/decode",
  );

  const corruptVersion = structuredClone(v2);
  corruptVersion.packageHash = "0".repeat(64);
  assert.throws(
    () => restoreCloudAgentPackage({ destinationDir: destination, slug: "owned-agent", package: corruptVersion }),
    /package hash does not match/,
  );
  assert.deepEqual(treeSnapshot(destination), stableSnapshot);

  const duplicateCase = makePackage({ "AGENTS.md": "one\n", "agents.md": "two\n" });
  assert.throws(
    () => restoreCloudAgentPackage({ destinationDir: destination, slug: "owned-agent", package: duplicateCase }),
    /duplicate cross-platform path/,
  );
  assert.deepEqual(treeSnapshot(destination), stableSnapshot);

  const unsafePath = makePackage({ "../escape.md": "escape\n" });
  assert.throws(
    () => restoreCloudAgentPackage({ destinationDir: destination, slug: "owned-agent", package: unsafePath }),
    /Unsafe Agent Cloud package path/,
  );
  assert.equal(fs.existsSync(path.join(tempRoot, "escape.md")), false);
  assert.deepEqual(treeSnapshot(destination), stableSnapshot);

  const reservedMarker = makePackage({ ".agentlas-cloud-package.json": "forged marker\n" });
  assert.throws(
    () => restoreCloudAgentPackage({ destinationDir: destination, slug: "owned-agent", package: reservedMarker }),
    /reserved by Desktop/,
  );
  assert.deepEqual(treeSnapshot(destination), stableSnapshot);

  const pathCollision = makePackage({ "skills": "not a directory\n", "skills/current.md": "child\n" });
  assert.throws(
    () => restoreCloudAgentPackage({ destinationDir: destination, slug: "owned-agent", package: pathCollision }),
    /file\/directory path collision/,
  );
  assert.deepEqual(treeSnapshot(destination), stableSnapshot);

  const directoryAlias = makePackage({ "Skills/a.md": "one\n", "skills/b.md": "two\n" });
  assert.throws(
    () => restoreCloudAgentPackage({ destinationDir: destination, slug: "owned-agent", package: directoryAlias }),
    /colliding cross-platform directory aliases/,
  );
  const nfdPath = makePackage({ "cafe\u0301.md": "nfd\n" });
  assert.throws(
    () => restoreCloudAgentPackage({ destinationDir: destination, slug: "owned-agent", package: nfdPath }),
    /Unsafe Agent Cloud package path/,
  );
  const oversizedComponent = makePackage({ ["x".repeat(256)]: "component too long\n" });
  assert.throws(
    () => restoreCloudAgentPackage({ destinationDir: destination, slug: "owned-agent", package: oversizedComponent }),
    /component is too long/,
  );
  const oversizedUtf8Component = makePackage({ ["한".repeat(86)]: "component exceeds 255 UTF-8 bytes\n" });
  assert.throws(
    () => restoreCloudAgentPackage({ destinationDir: destination, slug: "owned-agent", package: oversizedUtf8Component }),
    /component is too long/,
  );
  const unpairedSurrogate = makePackage({ ["bad-\ud800.md"]: "invalid Unicode\n" });
  assert.throws(
    () => restoreCloudAgentPackage({ destinationDir: destination, slug: "owned-agent", package: unpairedSurrogate }),
    /invalid Unicode/,
  );
  const utf8BoundaryDestination = path.join(tempRoot, "utf8-boundary-agent");
  const utf8Boundary = makePackage({ ["한".repeat(85)]: "exactly 255 UTF-8 bytes\n" });
  assert.equal(
    restoreCloudAgentPackage({
      destinationDir: utf8BoundaryDestination,
      slug: "utf8-boundary-agent",
      package: utf8Boundary,
    }).changed,
    true,
  );
  assert.equal(fs.existsSync(path.join(utf8BoundaryDestination, "한".repeat(85))), true);

  const executableV2 = makeV2Package({
    "AGENTS.md": "# Executable Agent\n",
    "run.sh": { text: "#!/bin/sh\necho exact\n", executable: true },
  });
  const executableInstall = restoreCloudAgentPackage({
    destinationDir: destination,
    slug: "owned-agent",
    package: executableV2,
  });
  assert.equal(executableInstall.changed, true);
  assert.equal(readCloudAgentRestoreMarker(destination).packageHashVersion, "path-sha256-executable-v2");
  assert.deepEqual(readCloudAgentRestoreMarker(destination).executablePaths, ["run.sh"]);
  assert.notEqual(fs.statSync(path.join(destination, "run.sh")).mode & 0o111, 0);
  assert.equal(fs.statSync(path.join(destination, "AGENTS.md")).mode & 0o111, 0);

  fs.chmodSync(path.join(destination, "run.sh"), 0o600);
  const repairedMode = restoreCloudAgentPackage({
    destinationDir: destination,
    slug: "owned-agent",
    package: executableV2,
  });
  assert.equal(repairedMode.changed, true);
  assert.equal(repairedMode.reason, "repaired");
  assert.notEqual(fs.statSync(path.join(destination, "run.sh")).mode & 0o111, 0);

  const outsideSameBytes = path.join(tempRoot, "outside-run.sh");
  fs.writeFileSync(outsideSameBytes, "#!/bin/sh\necho exact\n", { mode: 0o700 });
  const originalReaddirSync = fs.readdirSync;
  let swappedToExternalLink = false;
  fs.readdirSync = function injectExactVerifierLinkSwap(directory, options) {
    const entries = originalReaddirSync.call(fs, directory, options);
    if (!swappedToExternalLink && path.resolve(String(directory)) === path.resolve(destination)) {
      swappedToExternalLink = true;
      fs.unlinkSync(path.join(destination, "run.sh"));
      fs.symlinkSync(outsideSameBytes, path.join(destination, "run.sh"));
    }
    return entries;
  };
  let repairedLinkRace;
  try {
    repairedLinkRace = restoreCloudAgentPackage({
      destinationDir: destination,
      slug: "owned-agent",
      package: executableV2,
    });
  } finally {
    fs.readdirSync = originalReaddirSync;
  }
  assert.equal(swappedToExternalLink, true);
  assert.equal(repairedLinkRace.changed, true);
  assert.equal(repairedLinkRace.reason, "repaired");
  assert.equal(fs.lstatSync(path.join(destination, "run.sh")).isSymbolicLink(), false);
  assert.notEqual(fs.statSync(path.join(destination, "run.sh")).mode & 0o111, 0);

  if (process.platform !== "win32") {
    const originalFifoReaddir = fs.readdirSync;
    let swappedToFifo = false;
    fs.readdirSync = function injectExactVerifierFifoSwap(directory, options) {
      const entries = originalFifoReaddir.call(fs, directory, options);
      if (!swappedToFifo && path.resolve(String(directory)) === path.resolve(destination)) {
        swappedToFifo = true;
        fs.unlinkSync(path.join(destination, "run.sh"));
        execFileSync("mkfifo", [path.join(destination, "run.sh")]);
      }
      return entries;
    };
    let repairedFifoRace;
    try {
      repairedFifoRace = restoreCloudAgentPackage({
        destinationDir: destination,
        slug: "owned-agent",
        package: executableV2,
      });
    } finally {
      fs.readdirSync = originalFifoReaddir;
    }
    assert.equal(swappedToFifo, true);
    assert.equal(repairedFifoRace.changed, true, "FIFO swaps must fail fast and trigger exact repair, not block on open");
    assert.equal(fs.lstatSync(path.join(destination, "run.sh")).isFile(), true);
  }
  assertNoRestoreDebris(tempRoot, path.basename(destination));

  console.log("cloud agent exact restore passed");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
