#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { app } = require("electron");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-cloud-agent-"));
process.env.AGENTLAS_CLOUD_PACKAGE_DIR = path.join(tempDir, "packages");
process.env.AGENTLAS_STORE_PATH = path.join(tempDir, "agentlas.sqlite");

const { initStore } = require("../dist/electron/store/db.js");
const {
  packageAndReviewCloudAgent,
  portableExecutableForHost,
  portablePackagePathProblem,
  validateCloudRegistrationReceipt,
} = require("../dist/electron/cloud-agents/package.js");
const {
  readCanonicalPromptFromPackageFiles,
} = require("../dist/electron/agents/prompt-authority.js");

function promptPackageFile(filePath, content) {
  return {
    path: filePath,
    contentBase64: Buffer.from(content, "utf8").toString("base64"),
  };
}

function writeAgent(root, extra = {}) {
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(root, ".agentlas"), { recursive: true });
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# Test Agent\n\nYou are a test agent.\n", "utf8");
  fs.writeFileSync(path.join(root, "README.md"), "# Test Agent\n\nPortable test package.\n", "utf8");
  fs.writeFileSync(
    path.join(root, ".agentlas", "routing-card.json"),
    JSON.stringify(
      {
        schemaVersion: "routing-card/2.0",
        id: "test-agent",
        type: "agent",
        name: "Test Agent",
        summary: "Routes test package requests to the test agent.",
        capabilities: ["test_package"],
        routing_status: "routing_ready",
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  for (const [name, body] of Object.entries(extra)) {
    fs.writeFileSync(path.join(root, name), body, "utf8");
  }
}

function packageHash(files) {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.sha256);
    hash.update("\0");
    hash.update(file.executable ? "x" : "-");
    hash.update("\0");
  }
  return hash.digest("hex");
}

(async () => {
  let exitCode = 0;
  try {
    initStore();
    assert.equal(portableExecutableForHost("win32", 0o666, true), true);
    assert.equal(portableExecutableForHost("win32", 0o777, false), false);
    assert.equal(portableExecutableForHost("darwin", 0o700, false), true);
    assert.match(portablePackagePathProblem("x".repeat(256)), /component/i);
    assert.equal(portablePackagePathProblem("한".repeat(85)), null, "255 UTF-8 bytes must remain portable");
    assert.match(portablePackagePathProblem("한".repeat(86)), /component/i, "256+ UTF-8 bytes must be rejected");
    assert.equal(portablePackagePathProblem("😀".repeat(63)), null, "valid surrogate pairs under 255 bytes must pass");
    assert.match(portablePackagePathProblem("😀".repeat(64)), /component/i, "multibyte components over 255 bytes must fail");
    assert.match(portablePackagePathProblem("bad-\ud800.md"), /Unicode/i, "unpaired high surrogates must fail");
    assert.match(portablePackagePathProblem("bad-\udc00.md"), /Unicode/i, "unpaired low surrogates must fail");
    assert.match(portablePackagePathProblem("cafe\u0301.md"), /NFC/i);
    assert.match(portablePackagePathProblem("CON.md"), /reserved/i);

    const nestedPrompt = "NESTED_PACKAGE_ENTRY_PROMPT_9A71\n";
    const nestedPromptFiles = [
      promptPackageFile("agentlas.json", JSON.stringify({ entry: "agents/ceo/AGENT.md" })),
      promptPackageFile("agents/ceo/AGENT.md", nestedPrompt),
      promptPackageFile("AGENTS.md", "ROOT_FALLBACK_MUST_NOT_WIN\n"),
    ];
    assert.deepEqual(readCanonicalPromptFromPackageFiles(nestedPromptFiles), {
      relativePath: "agents/ceo/AGENT.md",
      content: nestedPrompt,
    });
    assert.throws(
      () => readCanonicalPromptFromPackageFiles([
        promptPackageFile("agentlas.json", JSON.stringify({ entry: "../outside.md" })),
        promptPackageFile("AGENTS.md", "safe fallback\n"),
      ]),
      /portable package-relative path/,
    );
    assert.throws(
      () => readCanonicalPromptFromPackageFiles([
        promptPackageFile("agentlas.json", JSON.stringify({ entry: "agents/missing/AGENT.md" })),
        promptPackageFile("AGENTS.md", "safe fallback\n"),
      ]),
      /entry is missing/,
    );

    const privateRoot = path.join(tempDir, "private-notes-only");
    fs.mkdirSync(privateRoot, { recursive: true });
    fs.writeFileSync(path.join(privateRoot, "notes.md"), "Owner-private working agent notes.\n", "utf8");
    const privateSave = await packageAndReviewCloudAgent({
      rootPath: privateRoot,
      dryRun: true,
      // Private saves must never invoke the public/local-runtime review path.
      reviewMode: "local-runtime",
    });
    assert.equal(privateSave.status, "dry-run");
    assert.equal(privateSave.manifest.visibility, "private-link");
    assert.equal(privateSave.manifest.billingMode, "static-only");
    assert.equal(privateSave.review.mode, "static-only");
    assert.equal(privateSave.review.costOwner, "none");
    assert.equal(privateSave.review.verdict, "pass");
    assert.equal(privateSave.review.findings.some((finding) => finding.id === "missing-agent-definition"), false);
    assert.equal(privateSave.review.findings.some((finding) => finding.id.startsWith("routing-card")), false);
    assert.equal(privateSave.manifest.routingCard, undefined);
    const privateBundle = JSON.parse(fs.readFileSync(privateSave.bundlePath, "utf8"));
    assert.equal(privateBundle.manifest.visibility, "private-link");
    assert.equal(privateBundle.manifest.packageHash, packageHash(privateBundle.files));
    assert.equal(privateBundle.manifest.packageHashVersion, "path-sha256-executable-v2");
    assert.equal(
      privateBundle.manifest.rootFingerprint,
      createHash("sha256").update(`agentlas-package-root:${privateBundle.manifest.packageHash}`).digest("hex"),
      "Cloud manifests must not fingerprint the owner's absolute local path",
    );
    const validPrivateReceipt = {
      schema: "agentlas.agent_cloud.registration.v1",
      source: "agent-cloud",
      visibility: "owner-private",
      owner: true,
      publicHubPublished: false,
      dryRun: false,
      cloudId: "cloud_test_receipt",
      slug: privateBundle.manifest.slug,
      scope: "owner-private",
      packageHash: privateBundle.manifest.packageHash,
      packageHashVersion: privateBundle.manifest.packageHashVersion,
      revision: `rev_${"a".repeat(32)}`,
      registeredAt: "2026-07-10T00:00:00.000Z",
    };
    assert.equal(
      validateCloudRegistrationReceipt(
        validPrivateReceipt,
        privateBundle.manifest,
        "private-link",
        `"rev_${"a".repeat(32)}"`,
      ).cloudId,
      "cloud_test_receipt",
    );
    assert.throws(
      () => validateCloudRegistrationReceipt({}, privateBundle.manifest, "private-link", null),
      /invalid or mismatched registration receipt/,
    );
    assert.throws(
      () => validateCloudRegistrationReceipt(
        { ...validPrivateReceipt, packageHash: "0".repeat(64) },
        privateBundle.manifest,
        "private-link",
        `"rev_${"a".repeat(32)}"`,
      ),
      /invalid or mismatched registration receipt/,
      "a malformed HTTP 200 must not be converted into a fake Cloud success",
    );

    const roundTripRoot = path.join(tempDir, "restored-evolved-agent");
    writeAgent(roundTripRoot);
    fs.writeFileSync(
      path.join(roundTripRoot, ".agentlas-cloud-package.json"),
      JSON.stringify({ source: "agentlas-cloud", packageHash: "0".repeat(64) }) + "\n",
      "utf8",
    );
    fs.writeFileSync(path.join(roundTripRoot, "icon.bin"), Buffer.from([0, 1, 2, 3, 255]));
    fs.writeFileSync(path.join(roundTripRoot, "run.sh"), "#!/bin/sh\necho portable\n", { mode: 0o755 });
    const roundTrip = await packageAndReviewCloudAgent({ rootPath: roundTripRoot, dryRun: true });
    assert.equal(roundTrip.status, "dry-run");
    const roundTripBundle = JSON.parse(fs.readFileSync(roundTrip.bundlePath, "utf8"));
    assert.equal(roundTripBundle.files.some((file) => file.path === ".agentlas-cloud-package.json"), false);
    assert.deepEqual(
      Buffer.from(roundTripBundle.files.find((file) => file.path === "icon.bin").contentBase64, "base64"),
      Buffer.from([0, 1, 2, 3, 255]),
      "ordinary binary agent assets must round-trip byte-for-byte",
    );
    assert.equal(roundTripBundle.files.find((file) => file.path === "run.sh").executable, true);
    assert.equal(roundTripBundle.files.find((file) => file.path === "AGENTS.md").executable, false);

    const separatedExperienceRoot = path.join(tempDir, "separated-experience-lineage-agent");
    writeAgent(separatedExperienceRoot);
    const separatedBaseline = await packageAndReviewCloudAgent({
      rootPath: separatedExperienceRoot,
      dryRun: true,
    });
    const localLineageMarker = "LOCAL_EXPERIENCE_LINEAGE_NEVER_SHIPS /private/workspace/history";
    fs.writeFileSync(
      path.join(separatedExperienceRoot, ".agentlas", "experience-relations.jsonl"),
      `${JSON.stringify({ kind: "agentlas-experience-relation-lineage", localLineageMarker })}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(separatedExperienceRoot, ".agentlas", "experience-relations.jsonl.previous"),
      localLineageMarker,
      "utf8",
    );
    fs.writeFileSync(
      path.join(separatedExperienceRoot, ".agentlas", ".experience-relations.jsonl.123.tmp"),
      localLineageMarker,
      "utf8",
    );
    const separatedAgain = await packageAndReviewCloudAgent({
      rootPath: separatedExperienceRoot,
      dryRun: true,
    });
    const separatedBundle = JSON.parse(fs.readFileSync(separatedAgain.bundlePath, "utf8"));
    assert.equal(separatedAgain.manifest.packageHash, separatedBaseline.manifest.packageHash);
    assert.equal(
      separatedBundle.files.some((file) => file.path === ".agentlas/experience-relations.jsonl"),
      false,
      "local Experience lineage must be uploaded through the separate Experience asset path, never the base agent bundle",
    );
    assert.equal(JSON.stringify(separatedBundle).includes(localLineageMarker), false);
    assert.equal(
      separatedBundle.files.some((file) => /experience-relations\.jsonl/.test(file.path)),
      false,
      "crash-safe lineage temp and backup siblings must also stay out of the base bundle",
    );
    assert.equal(
      separatedAgain.files.find((file) => file.path === ".agentlas/experience-relations.jsonl")?.reason,
      "experience-lineage-separate-asset",
    );

    const oversizedRoot = path.join(tempDir, "oversized-agent");
    writeAgent(oversizedRoot);
    fs.writeFileSync(path.join(oversizedRoot, "skills.md"), "");
    fs.truncateSync(path.join(oversizedRoot, "skills.md"), 512 * 1024 + 1);
    const oversized = await packageAndReviewCloudAgent({ rootPath: oversizedRoot, dryRun: true });
    assert.equal(oversized.status, "blocked", "an omitted oversized asset must never register as a complete package");
    assert.ok(oversized.review.findings.some((finding) => finding.id.startsWith("large-file-") && finding.severity === "blocker"));

    const symlinkRoot = path.join(tempDir, "private-symlink-agent");
    fs.mkdirSync(symlinkRoot, { recursive: true });
    fs.writeFileSync(path.join(symlinkRoot, "notes.md"), "Private notes.\n", "utf8");
    const outsideFile = path.join(tempDir, "outside-secret.txt");
    fs.writeFileSync(outsideFile, "must not follow this link\n", "utf8");
    fs.symlinkSync(outsideFile, path.join(symlinkRoot, "outside-link.txt"));
    const symlinkBlocked = await packageAndReviewCloudAgent({
      rootPath: symlinkRoot,
      dryRun: true,
    });
    assert.equal(symlinkBlocked.status, "blocked");
    assert.ok(symlinkBlocked.review.findings.some((finding) => finding.id.startsWith("symlink-")));

    const symlinkPackageRoot = path.join(tempDir, "symlink-package-root");
    fs.symlinkSync(privateRoot, symlinkPackageRoot);
    await assert.rejects(
      () => packageAndReviewCloudAgent({ rootPath: symlinkPackageRoot, dryRun: true }),
      /root is not a directory/,
      "the package root itself must not be a symbolic link",
    );

    const raceRoot = path.join(tempDir, "file-swap-agent");
    writeAgent(raceRoot, { "swap.md": "safe package bytes\n" });
    const swapPath = path.join(raceRoot, "swap.md");
    const canonicalSwapPath = fs.realpathSync.native(swapPath);
    const outsideRace = path.join(tempDir, "outside-race-secret.md");
    fs.writeFileSync(outsideRace, "outside bytes must never be uploaded\n", "utf8");
    const originalOpenSync = fs.openSync;
    let swapped = false;
    fs.openSync = function injectFileSwap(file, flags, mode) {
      if (!swapped && path.resolve(String(file)) === canonicalSwapPath) {
        swapped = true;
        fs.unlinkSync(swapPath);
        fs.symlinkSync(outsideRace, swapPath);
      }
      return originalOpenSync.call(fs, file, flags, mode);
    };
    let raceResult;
    try {
      raceResult = await packageAndReviewCloudAgent({ rootPath: raceRoot, dryRun: true });
    } finally {
      fs.openSync = originalOpenSync;
    }
    assert.equal(swapped, true);
    assert.equal(raceResult.status, "blocked");
    const raceBundle = JSON.parse(fs.readFileSync(raceResult.bundlePath, "utf8"));
    assert.equal(raceBundle.files.some((file) => file.path === "swap.md"), false);
    assert.equal(JSON.stringify(raceBundle).includes("outside bytes must never be uploaded"), false);
    assert.ok(raceResult.review.findings.some((finding) => finding.id.startsWith("unstable-file-")));

    if (process.platform !== "win32") {
      const fifoRoot = path.join(tempDir, "fifo-swap-agent");
      writeAgent(fifoRoot, { "fifo.md": "ordinary before swap\n" });
      const fifoPath = path.join(fifoRoot, "fifo.md");
      const canonicalFifoPath = fs.realpathSync.native(fifoPath);
      const originalFifoOpen = fs.openSync;
      let swappedToFifo = false;
      fs.openSync = function injectFifoSwap(file, flags, mode) {
        if (!swappedToFifo && path.resolve(String(file)) === canonicalFifoPath) {
          swappedToFifo = true;
          fs.unlinkSync(fifoPath);
          execFileSync("mkfifo", [fifoPath]);
        }
        return originalFifoOpen.call(fs, file, flags, mode);
      };
      let fifoResult;
      try {
        fifoResult = await packageAndReviewCloudAgent({ rootPath: fifoRoot, dryRun: true });
      } finally {
        fs.openSync = originalFifoOpen;
      }
      assert.equal(swappedToFifo, true);
      assert.equal(fifoResult.status, "blocked", "regular-to-FIFO swaps must fail fast instead of blocking the main process");
      assert.ok(fifoResult.review.findings.some((finding) => finding.id.startsWith("unstable-file-")));
    }

    const growthRoot = path.join(tempDir, "file-growth-agent");
    writeAgent(growthRoot, { "grow.md": "initial bytes\n" });
    const growthPath = path.join(growthRoot, "grow.md");
    const canonicalGrowthPath = fs.realpathSync.native(growthPath);
    const originalGrowthOpen = fs.openSync;
    const originalReadSync = fs.readSync;
    let growthFd = null;
    let grewDuringRead = false;
    fs.openSync = function captureGrowthFd(file, flags, mode) {
      const fd = originalGrowthOpen.call(fs, file, flags, mode);
      if (path.resolve(String(file)) === canonicalGrowthPath) growthFd = fd;
      return fd;
    };
    fs.readSync = function injectGrowth(fd, buffer, offset, length, position) {
      if (!grewDuringRead && fd === growthFd) {
        grewDuringRead = true;
        fs.appendFileSync(growthPath, "changed while packaging\n", "utf8");
      }
      return originalReadSync.call(fs, fd, buffer, offset, length, position);
    };
    let growthResult;
    try {
      growthResult = await packageAndReviewCloudAgent({ rootPath: growthRoot, dryRun: true });
    } finally {
      fs.openSync = originalGrowthOpen;
      fs.readSync = originalReadSync;
    }
    assert.equal(grewDuringRead, true);
    assert.equal(growthResult.status, "blocked");
    assert.ok(growthResult.review.findings.some((finding) => finding.id.startsWith("unstable-file-")));
    const growthBundle = JSON.parse(fs.readFileSync(growthResult.bundlePath, "utf8"));
    assert.equal(growthBundle.files.some((file) => file.path === "grow.md"), false);

    const preOpenResizeRoot = path.join(tempDir, "pre-open-resize-agent");
    writeAgent(preOpenResizeRoot, {
      "grow-before-open.md": "small\n",
      "truncate-before-open.md": "this starts much longer than the final bytes\n",
    });
    const growBeforeOpenPath = path.join(preOpenResizeRoot, "grow-before-open.md");
    const truncateBeforeOpenPath = path.join(preOpenResizeRoot, "truncate-before-open.md");
    const originalResizeOpen = fs.openSync;
    const rewritten = new Set();
    const replaceWithoutPatchedOpen = (file, content) => {
      const fd = originalResizeOpen.call(fs, file, fs.constants.O_WRONLY | fs.constants.O_TRUNC);
      try {
        fs.writeSync(fd, content, 0, content.length, 0);
      } finally {
        fs.closeSync(fd);
      }
    };
    fs.openSync = function injectStablePreOpenResize(file, flags, mode) {
      const absolute = path.resolve(String(file));
      if (absolute === path.resolve(growBeforeOpenPath) && !rewritten.has(absolute)) {
        rewritten.add(absolute);
        replaceWithoutPatchedOpen(growBeforeOpenPath, Buffer.from("grown before the stable fd opens\n", "utf8"));
      }
      if (absolute === path.resolve(truncateBeforeOpenPath) && !rewritten.has(absolute)) {
        rewritten.add(absolute);
        replaceWithoutPatchedOpen(truncateBeforeOpenPath, Buffer.from("short\n", "utf8"));
      }
      return originalResizeOpen.call(fs, file, flags, mode);
    };
    let preOpenResize;
    try {
      preOpenResize = await packageAndReviewCloudAgent({ rootPath: preOpenResizeRoot, dryRun: true });
    } finally {
      fs.openSync = originalResizeOpen;
    }
    assert.equal(preOpenResize.status, "dry-run");
    const preOpenResizeBundle = JSON.parse(fs.readFileSync(preOpenResize.bundlePath, "utf8"));
    for (const file of preOpenResizeBundle.files.filter((row) => /before-open/.test(row.path))) {
      assert.equal(file.bytes, Buffer.from(file.contentBase64, "base64").length);
    }
    assert.equal(
      preOpenResizeBundle.manifest.totalBytes,
      preOpenResizeBundle.files.reduce((sum, file) => sum + file.bytes, 0),
    );

    const directoryRaceRoot = path.join(tempDir, "directory-swap-agent");
    writeAgent(directoryRaceRoot);
    const swappableDirectory = path.join(directoryRaceRoot, "skills");
    const parkedDirectory = path.join(directoryRaceRoot, "skills-original");
    const outsideDirectory = path.join(tempDir, "outside-directory");
    fs.mkdirSync(swappableDirectory);
    fs.mkdirSync(outsideDirectory);
    fs.writeFileSync(path.join(swappableDirectory, "inside.md"), "inside\n", "utf8");
    fs.writeFileSync(path.join(outsideDirectory, "outside.md"), "external directory bytes\n", "utf8");
    const canonicalSwappableDirectory = fs.realpathSync.native(swappableDirectory);
    const originalReaddirSync = fs.readdirSync;
    let swappedDirectory = false;
    fs.readdirSync = function injectDirectorySwap(directory, options) {
      if (!swappedDirectory && path.resolve(String(directory)) === canonicalSwappableDirectory) {
        swappedDirectory = true;
        fs.renameSync(swappableDirectory, parkedDirectory);
        fs.symlinkSync(outsideDirectory, swappableDirectory);
      }
      return originalReaddirSync.call(fs, directory, options);
    };
    let directoryRaceResult;
    try {
      directoryRaceResult = await packageAndReviewCloudAgent({ rootPath: directoryRaceRoot, dryRun: true });
    } finally {
      fs.readdirSync = originalReaddirSync;
    }
    assert.equal(swappedDirectory, true);
    assert.equal(directoryRaceResult.status, "blocked");
    const directoryRaceBundle = JSON.parse(fs.readFileSync(directoryRaceResult.bundlePath, "utf8"));
    assert.equal(JSON.stringify(directoryRaceBundle).includes("external directory bytes"), false);
    assert.ok(directoryRaceResult.review.findings.some((finding) => /unstable-(?:file|directory)-/.test(finding.id)));

    const invalidUtf8Root = path.join(tempDir, "invalid-utf8-agent");
    writeAgent(invalidUtf8Root);
    fs.writeFileSync(path.join(invalidUtf8Root, "broken.md"), Buffer.from([0xc3, 0x28]));
    const invalidUtf8 = await packageAndReviewCloudAgent({ rootPath: invalidUtf8Root, dryRun: true });
    assert.equal(invalidUtf8.status, "blocked");
    assert.ok(invalidUtf8.review.findings.some((finding) => finding.id.startsWith("invalid-utf8-")));
    const invalidUtf8Bundle = JSON.parse(fs.readFileSync(invalidUtf8.bundlePath, "utf8"));
    assert.equal(invalidUtf8Bundle.files.some((file) => file.path === "broken.md"), false);

    const unsafePortableRoot = path.join(tempDir, "unsafe-portable-paths-agent");
    writeAgent(unsafePortableRoot);
    fs.writeFileSync(path.join(unsafePortableRoot, "cafe\u0301.md"), "nfd path\n", "utf8");
    fs.writeFileSync(path.join(unsafePortableRoot, "CON.md"), "reserved path\n", "utf8");
    const longDirectory = path.join(unsafePortableRoot, "a".repeat(125), "b".repeat(125));
    fs.mkdirSync(longDirectory, { recursive: true });
    fs.writeFileSync(path.join(longDirectory, "long-name.md"), "too long across hosts\n", "utf8");
    const unsafePortable = await packageAndReviewCloudAgent({ rootPath: unsafePortableRoot, dryRun: true });
    assert.equal(unsafePortable.status, "blocked");
    assert.ok(
      unsafePortable.review.findings.filter((finding) => finding.id.startsWith("unsafe-path-")).length >= 3,
      `NFD, reserved, and overlong package paths must be rejected before registration: ${JSON.stringify(unsafePortable.review.findings)}`,
    );

    const secretParityRoot = path.join(tempDir, "binary-secret-parity-agent");
    writeAgent(secretParityRoot);
    fs.writeFileSync(
      path.join(secretParityRoot, "opaque.payload"),
      [
        `glpat-${"A".repeat(24)}`,
        `AIza${"B".repeat(35)}`,
        `npm_${"C".repeat(32)}`,
        `sk_live_${"D".repeat(20)}`,
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(path.join(secretParityRoot, "settings.yaml"), "password: hunter2secret\n", "utf8");
    fs.writeFileSync(path.join(secretParityRoot, "settings.json"), JSON.stringify({ client_secret: "jsonSecretValue123" }), "utf8");
    fs.writeFileSync(path.join(secretParityRoot, "connection.conf"), "endpoint=https://user:embeddedSecret99@example.invalid\n", "utf8");
    fs.writeFileSync(
      path.join(secretParityRoot, "windows.ps1"),
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("token: utf16SecretValue123\r\n", "utf16le")]),
    );
    fs.writeFileSync(
      path.join(secretParityRoot, "late-secret.psd1"),
      Buffer.from(`${"A".repeat(5000)}\r\npasswd: lateUtf16Secret123\r\n`, "utf16le"),
    );
    const originalFetch = global.fetch;
    let registrationFetches = 0;
    global.fetch = async () => {
      registrationFetches += 1;
      throw new Error("blocked packages must never reach Agent Cloud");
    };
    let secretParity;
    try {
      secretParity = await packageAndReviewCloudAgent({ rootPath: secretParityRoot, dryRun: false });
    } finally {
      global.fetch = originalFetch;
    }
    assert.equal(secretParity.status, "blocked");
    assert.equal(registrationFetches, 0);
    for (const id of ["gitlab-token", "google-api-key", "npm-token", "stripe-secret"]) {
      assert.ok(secretParity.review.findings.some((finding) => finding.id.startsWith(`${id}-`)));
    }
    assert.ok(secretParity.review.findings.some((finding) => finding.id.startsWith("generic-unquoted-secret-")));
    assert.ok(secretParity.review.findings.some((finding) => finding.id.startsWith("url-credential-")));
    assert.ok(
      secretParity.review.findings.some(
        (finding) => finding.id.startsWith("generic-unquoted-secret-") && finding.file === "windows.ps1",
      ),
      "UTF-16 credential-bearing scripts must be scanned before upload",
    );
    assert.ok(
      secretParity.review.findings.some(
        (finding) => finding.id.startsWith("generic-unquoted-secret-") && finding.file === "late-secret.psd1",
      ),
      "UTF-16 encoding detection may sample bytes, but must scan the bounded full file",
    );
    assert.ok(
      secretParity.review.findings.some(
        (finding) => finding.id.startsWith("generic-unquoted-secret-") && finding.file === "settings.json",
      ),
      "quoted JSON credential property keys must be blocked locally",
    );

    const placeholderRoot = path.join(tempDir, "placeholder-config-agent");
    writeAgent(placeholderRoot, {
      "config.yaml": "api_key: ${OPENAI_API_KEY}\npassword: YOUR_PASSWORD_HERE\ntoken: <YOUR_TOKEN>\n",
      "config.json": JSON.stringify({ client_secret: "${CLIENT_SECRET}" }) + "\n",
    });
    const placeholderPackage = await packageAndReviewCloudAgent({ rootPath: placeholderRoot, dryRun: true });
    assert.equal(placeholderPackage.status, "dry-run", "documented BYOK placeholders must not be treated as real credentials");

    const cleanRoot = path.join(tempDir, "clean-agent");
    writeAgent(cleanRoot);
    const clean = await packageAndReviewCloudAgent({
      rootPath: cleanRoot,
      dryRun: true,
      reviewMode: "static-only",
      visibility: "marketplace",
    });
    assert.equal(clean.status, "dry-run");
    assert.equal(clean.review.costOwner, "none");
    assert.equal(clean.review.verdict, "pass");
    assert.equal(clean.manifest.includedFileCount, 3);
    assert.equal(clean.manifest.routingCard.schemaVersion, "routing-card/2.0");
    assert.ok(clean.manifest.packageHash.length >= 32);
    assert.ok(fs.existsSync(clean.bundlePath));

    const stableRoot = path.join(tempDir, "stable-agent-folder");
    writeAgent(stableRoot, {
      "agentlas.json": JSON.stringify(
        {
          schemaVersion: "1.0",
          slug: "stable-test-agent",
          name: "Renamed Test Agent",
          summary: "Stable identity should survive display-name changes.",
        },
        null,
        2,
      ) + "\n",
    });
    const stable = await packageAndReviewCloudAgent({
      rootPath: stableRoot,
      dryRun: true,
      reviewMode: "static-only",
    });
    assert.equal(stable.manifest.slug, "stable-test-agent");
    assert.equal(stable.manifest.name, "Renamed Test Agent");
    assert.equal(stable.manifest.visibility, "private-link");
    assert.equal(stable.manifest.includedFileCount, 4);

    const metadataSnapshotRoot = path.join(tempDir, "metadata-snapshot-agent");
    writeAgent(metadataSnapshotRoot, {
      "agentlas.json": JSON.stringify({ name: "Captured Metadata", summary: "Captured before a path swap." }) + "\n",
    });
    const metadataPath = path.join(metadataSnapshotRoot, "agentlas.json");
    const originalReadFileSync = fs.readFileSync;
    let unsafeMetadataPathRead = false;
    fs.readFileSync = function rejectPostScanMetadataPathRead(file, options) {
      if (path.resolve(String(file)) === path.resolve(metadataPath)) {
        unsafeMetadataPathRead = true;
        return JSON.stringify({ name: "Outside Metadata", summary: "/tmp/must-not-enter-package-metadata" }) + "\n";
      }
      return originalReadFileSync.call(fs, file, options);
    };
    let metadataSnapshot;
    try {
      metadataSnapshot = await packageAndReviewCloudAgent({ rootPath: metadataSnapshotRoot, dryRun: true });
    } finally {
      fs.readFileSync = originalReadFileSync;
    }
    assert.equal(unsafeMetadataPathRead, false, "post-scan manifest metadata must come from captured package bytes");
    assert.equal(metadataSnapshot.manifest.name, "Captured Metadata");
    assert.equal(metadataSnapshot.manifest.tagline, "Captured before a path swap.");
    const metadataBundle = JSON.parse(fs.readFileSync(metadataSnapshot.bundlePath, "utf8"));
    assert.equal(JSON.stringify(metadataBundle).includes("Outside Metadata"), false);
    assert.equal(JSON.stringify(metadataBundle).includes("/tmp/must-not-enter-package-metadata"), false);

    const publicWithoutRoutingRoot = path.join(tempDir, "public-without-routing");
    writeAgent(publicWithoutRoutingRoot);
    fs.rmSync(path.join(publicWithoutRoutingRoot, ".agentlas", "routing-card.json"));
    const publicWithoutRouting = await packageAndReviewCloudAgent({
      rootPath: publicWithoutRoutingRoot,
      dryRun: true,
      reviewMode: "static-only",
      visibility: "marketplace",
    });
    assert.equal(publicWithoutRouting.status, "blocked");
    assert.ok(publicWithoutRouting.review.findings.some((finding) => finding.id === "routing-card-required"));

    const careerRoot = path.join(tempDir, "career-agent");
    writeAgent(careerRoot);
    fs.writeFileSync(
      path.join(careerRoot, ".agentlas", "public-career-card.json"),
      JSON.stringify(
        {
          schemaVersion: "1.0",
          kind: "agentlas-public-career-card",
          generatedAt: "2026-07-09T00:00:00Z",
          projectName: "Career Agent",
          indexStatus: "indexed",
          policy: "redacted_aggregate_projection",
          privacy: {
            rawLocalPathsIncluded: false,
            rawPromptsIncluded: false,
            rawTranscriptsIncluded: false,
            sourceTextIncluded: false,
          },
          counts: { sources: 1, nodes: 2, edges: 3 },
          canonicalSources: 1,
          staleSourceCount: 0,
          nodeTypes: { Project: 1 },
          writtenTo: "generator-only-field",
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    const career = await packageAndReviewCloudAgent({
      rootPath: careerRoot,
      dryRun: true,
      reviewMode: "static-only",
      visibility: "marketplace",
    });
    assert.equal(career.status, "dry-run");
    assert.equal(career.manifest.careerGraph.kind, "agentlas-public-career-card");
    assert.equal(career.manifest.careerGraph.counts.nodes, 2);
    assert.equal(career.manifest.careerGraph.writtenTo, undefined);
    const careerBundle = JSON.parse(fs.readFileSync(career.bundlePath, "utf8"));
    assert.equal(careerBundle.careerGraph.kind, "agentlas-public-career-card");
    assert.equal(JSON.stringify(careerBundle).includes("generator-only-field"), false);
    const packagedCareerFile = careerBundle.files.find(
      (file) => file.path === ".agentlas/public-career-card.json",
    );
    assert.ok(packagedCareerFile, "the portable package should retain a sanitized public Career Graph card");
    const packagedCareerCard = JSON.parse(Buffer.from(packagedCareerFile.contentBase64, "base64").toString("utf8"));
    assert.equal(packagedCareerCard.writtenTo, undefined);
    assert.equal(packagedCareerCard.counts.nodes, 2);

    const leakingCareerRoot = path.join(tempDir, "career-agent-local-path");
    writeAgent(leakingCareerRoot);
    fs.writeFileSync(
      path.join(leakingCareerRoot, ".agentlas", "public-career-card.json"),
      JSON.stringify({
        kind: "agentlas-public-career-card",
        privacy: {
          rawLocalPathsIncluded: false,
          rawPromptsIncluded: false,
          rawTranscriptsIncluded: false,
          sourceTextIncluded: false,
        },
        counts: { nodes: 1 },
        writtenTo: "/tmp/should-not-leak",
      }) + "\n",
      "utf8",
    );
    const leakingCareer = await packageAndReviewCloudAgent({
      rootPath: leakingCareerRoot,
      dryRun: true,
      reviewMode: "static-only",
      visibility: "marketplace",
    });
    assert.equal(leakingCareer.status, "blocked");
    assert.ok(leakingCareer.review.findings.some((finding) => finding.id.startsWith("career-card-local-path-")));
    const leakingCareerBundle = JSON.parse(fs.readFileSync(leakingCareer.bundlePath, "utf8"));
    assert.equal(JSON.stringify(leakingCareerBundle).includes("/tmp/should-not-leak"), false);
    assert.equal(
      leakingCareerBundle.files.some((file) => file.path === ".agentlas/public-career-card.json"),
      false,
      "a blocked raw Career Graph card must not remain in base64 package files",
    );

    const blockedRoot = path.join(tempDir, "blocked-agent");
    writeAgent(blockedRoot, { ".env": "OPENAI_API_KEY=NOT_A_REAL_OPENAI_KEY_FOR_TEST\n" });
    const blocked = await packageAndReviewCloudAgent({
      rootPath: blockedRoot,
      dryRun: true,
      reviewMode: "static-only",
    });
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.review.verdict, "fail");
    assert.ok(blocked.review.findings.some((finding) => finding.category === "secret"));

    console.log("cloud agent package smoke passed");
  } catch (err) {
    exitCode = 1;
    console.error(err);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (app && typeof app.quit === "function") app.quit();
    process.exit(exitCode);
  }
})();
