#!/usr/bin/env node
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const afterPack = require("../build-resources/after-pack-clean.cjs").default;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-after-pack-runtime-"));
const previousRef = process.env.HEPHAESTUS_REF;
const canonicalModelRoot = path.join(
  __dirname,
  "..",
  "Hephaestus",
  "assets",
  "model2vec",
  "potion-multilingual-128M-int8",
);
const canonicalMacDriver = path.join(
  __dirname,
  "..",
  "build-resources",
  "native",
  "macos",
  "agentlas-input-driver",
);

function sha256(payload) {
  return createHash("sha256").update(payload).digest("hex");
}

function writePythonRuntime(root, platform, triple = platform === "darwin" ? "x86_64-apple-darwin" : platform === "win32" ? "x86_64-pc-windows-msvc" : "x86_64-unknown-linux-gnu") {
  const lock = {
    "x86_64-apple-darwin": [
      "cpython-3.12.13+20260510-x86_64-apple-darwin-install_only.tar.gz",
      "cd369e76973c3179bc578230d8615ab621968ed758c5e32f636eecef4ad79894",
    ],
    "aarch64-apple-darwin": [
      "cpython-3.12.13+20260510-aarch64-apple-darwin-install_only.tar.gz",
      "5a30271f8d345a5b02b0c9e4e31e0f1e1455a8e4a04fba95cd9762472abc3b17",
    ],
    "x86_64-pc-windows-msvc": [
      "cpython-3.12.13+20260510-x86_64-pc-windows-msvc-install_only.tar.gz",
      "346dfbcb95171dd6d1275e6f8cb2e656cc15cb054c399ae54db57bfad4b1a60f",
    ],
    "x86_64-unknown-linux-gnu": [
      "cpython-3.12.13+20260510-x86_64-unknown-linux-gnu-install_only.tar.gz",
      "e7332b4b4bb85006deb48d251c786a04c14de104c9b3a006b33457a4a604b8bc",
    ],
  }[triple];
  const executableRelativePath = platform === "win32" ? "python.exe" : "bin/python3";
  const executable = Buffer.from(`private-python-fixture:${triple}\n`);
  const executablePath = path.join(root, ...executableRelativePath.split("/"));
  fs.mkdirSync(path.dirname(executablePath), { recursive: true });
  fs.writeFileSync(executablePath, executable, { mode: 0o755 });
  const executableSha256 = sha256(executable);
  const tree = createHash("sha256")
    .update("F\0").update(executableRelativePath).update("\0")
    .update(String(executable.length)).update("\0").update(executableSha256).update("\n")
    .digest("hex");
  const manifest = {
    schemaVersion: "agentlas.python-runtime.v1",
    pythonVersion: "3.12.13",
    releaseTag: "20260510",
    triple,
    archiveName: lock[0],
    archiveSha256: lock[1],
    executableRelativePath,
    executableSha256,
    runtimeTreeSha256: tree,
  };
  fs.writeFileSync(path.join(root, "agentlas-python-runtime.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { root, executablePath, manifestPath: path.join(root, "agentlas-python-runtime.json"), manifest };
}

function modelContentIdentity(files, names) {
  const digest = createHash("sha256");
  for (const name of [...names].sort()) {
    const record = files[name];
    digest.update(name).update("\0").update(record.sha256).update("\0")
      .update(String(record.size)).update("\n");
  }
  return digest.digest("hex");
}

function writeModelAsset(runtimeRoot) {
  const modelRoot = path.join(runtimeRoot, "assets", "model2vec", "potion-multilingual-128M-int8");
  fs.cpSync(canonicalModelRoot, modelRoot, {
    recursive: true,
    mode: fs.constants.COPYFILE_FICLONE,
  });
  return modelRoot;
}

function fixture(platform, suffix, compatibilityVersion = "1.1.14") {
  const projectDir = path.join(temp, `project-${suffix}`);
  const appOutDir = path.join(temp, `output-${suffix}`);
  const resourcesDir = platform === "darwin"
    ? path.join(appOutDir, "Agentlas.app", "Contents", "Resources")
    : path.join(appOutDir, "resources");
  const sourceRoot = path.join(projectDir, "Hephaestus");
  const packagedRoot = path.join(resourcesDir, "Hephaestus");
  const sourcePython = writePythonRuntime(path.join(projectDir, "build-resources", "python-runtime"), platform);
  const packagedPython = writePythonRuntime(path.join(resourcesDir, "python-runtime"), platform);
  fs.mkdirSync(path.join(sourceRoot, "agentlas_cloud"), { recursive: true });
  fs.mkdirSync(path.join(packagedRoot, "agentlas_cloud"), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, "manifest.json"), JSON.stringify({ version: "1.1.14" }));
  fs.writeFileSync(path.join(packagedRoot, "manifest.json"), JSON.stringify({ version: "1.1.14" }));
  fs.writeFileSync(path.join(packagedRoot, "agentlas_cloud", "__main__.py"), "# fixture\n");
  writeModelAsset(sourceRoot);
  const packagedModelRoot = writeModelAsset(packagedRoot);
  if (platform === "darwin") {
    const sourceDriver = path.join(projectDir, "build-resources", "native", "macos", "agentlas-input-driver");
    const packagedDriver = path.join(resourcesDir, "native", "macos", "agentlas-input-driver");
    fs.mkdirSync(path.dirname(sourceDriver), { recursive: true });
    fs.mkdirSync(path.dirname(packagedDriver), { recursive: true });
    fs.copyFileSync(canonicalMacDriver, sourceDriver, fs.constants.COPYFILE_FICLONE);
    fs.copyFileSync(canonicalMacDriver, packagedDriver, fs.constants.COPYFILE_FICLONE);
    fs.chmodSync(sourceDriver, 0o755);
    fs.chmodSync(packagedDriver, 0o755);
  }
  fs.mkdirSync(path.join(packagedRoot, ".agentlas"), { recursive: true });
  fs.writeFileSync(path.join(packagedRoot, ".agentlas", "routing-card.json"), "{}\n");
  fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({
    agentlasUpdateCompatibility: { bundledRuntimeVersion: compatibilityVersion },
  }));
  return {
    appOutDir,
    arch: 1,
    electronPlatformName: platform,
    packager: { projectDir, appInfo: { productFilename: "Agentlas" } },
    packagedModelRoot,
    packagedRoot,
    sourcePython,
    packagedPython,
  };
}

(async () => {
  try {
    process.env.HEPHAESTUS_REF = "v1.1.14";
    for (const platform of ["darwin", "win32", "linux"]) {
      await afterPack(fixture(platform, platform));
    }

    const missingPythonManifest = fixture("linux", "missing-python-manifest");
    fs.rmSync(missingPythonManifest.packagedPython.manifestPath);
    await assert.rejects(afterPack(missingPythonManifest), /python-runtime.*agentlas-python-runtime\.json|Python runtime manifest/i);

    const wrongPythonArch = fixture("darwin", "wrong-python-arch");
    const armManifest = writePythonRuntime(wrongPythonArch.sourcePython.root, "darwin", "aarch64-apple-darwin").manifest;
    writePythonRuntime(wrongPythonArch.packagedPython.root, "darwin", "aarch64-apple-darwin");
    assert.equal(armManifest.triple, "aarch64-apple-darwin");
    await assert.rejects(afterPack(wrongPythonArch), /pinned platform asset/);

    const tamperedPythonExecutable = fixture("linux", "tampered-python-executable");
    fs.appendFileSync(tamperedPythonExecutable.packagedPython.executablePath, "tampered\n");
    await assert.rejects(afterPack(tamperedPythonExecutable), /Python executable checksum mismatch/);

    const tamperedPythonTree = fixture("linux", "tampered-python-tree");
    fs.writeFileSync(path.join(tamperedPythonTree.packagedPython.root, "lib-extra.py"), "unexpected\n");
    await assert.rejects(afterPack(tamperedPythonTree), /Python runtime tree checksum mismatch/);

    const extendedPythonManifest = fixture("linux", "extended-python-manifest");
    for (const runtime of [extendedPythonManifest.sourcePython, extendedPythonManifest.packagedPython]) {
      const manifest = JSON.parse(fs.readFileSync(runtime.manifestPath, "utf8"));
      manifest.unexpected = true;
      fs.writeFileSync(runtime.manifestPath, `${JSON.stringify(manifest)}\n`);
    }
    await assert.rejects(afterPack(extendedPythonManifest), /manifest shape is invalid/);

    await assert.rejects(
      afterPack(fixture("linux", "bad-compat", "1.1.13")),
      /update compatibility runtime mismatch/,
    );

    process.env.HEPHAESTUS_REF = "v9.9.9";
    await assert.rejects(
      afterPack(fixture("linux", "bad-ref")),
      /HEPHAESTUS_REF mismatch/,
    );

    process.env.HEPHAESTUS_REF = "v1.1.14";
    const ignoredSecret = fixture("linux", "ignored-secret");
    fs.writeFileSync(path.join(ignoredSecret.packagedRoot, ".env"), "SECRET=must-not-ship\n");
    fs.mkdirSync(path.join(ignoredSecret.packagedRoot, ".agentlas"), { recursive: true });
    fs.writeFileSync(path.join(ignoredSecret.packagedRoot, ".agentlas", "ontology-runtime.sqlite"), "must-not-ship\n");
    await assert.rejects(
      afterPack(ignoredSecret),
      /forbidden mutable Agentlas OS resources reached the package:.*\.agentlas\/ontology-runtime\.sqlite.*\.env/,
    );

    const missingModel = fixture("linux", "missing-model");
    fs.rmSync(path.join(missingModel.packagedModelRoot, "embeddings.i8.part-000"));
    await assert.rejects(
      afterPack(missingModel),
      /packaged Model2Vec asset missing: embeddings\.i8\.part-000/,
    );

    const tamperedPayload = fixture("linux", "tampered-model-payload");
    const tamperedEmbeddingPath = path.join(tamperedPayload.packagedModelRoot, "embeddings.i8.part-000");
    const tamperedEmbedding = fs.readFileSync(tamperedEmbeddingPath);
    tamperedEmbedding[0] ^= 0xff;
    fs.writeFileSync(tamperedEmbeddingPath, tamperedEmbedding);
    await assert.rejects(
      afterPack(tamperedPayload),
      /packaged Model2Vec asset checksum mismatch: embeddings\.i8\.part-000/,
    );

    const tamperedManifest = fixture("linux", "tampered-model-manifest");
    const tamperedManifestPath = path.join(tamperedManifest.packagedModelRoot, "manifest.json");
    const modelManifest = JSON.parse(fs.readFileSync(tamperedManifestPath, "utf8"));
    modelManifest.contentSha256 = "0".repeat(64);
    fs.writeFileSync(tamperedManifestPath, `${JSON.stringify(modelManifest, null, 2)}\n`);
    await assert.rejects(
      afterPack(tamperedManifest),
      /packaged Model2Vec contentSha256 mismatch/,
    );

    const tamperedMetadata = fixture("linux", "tampered-model-metadata");
    const tamperedMetadataPath = path.join(tamperedMetadata.packagedModelRoot, "manifest.json");
    const metadataManifest = JSON.parse(fs.readFileSync(tamperedMetadataPath, "utf8"));
    metadataManifest.dimensions += 1;
    fs.writeFileSync(tamperedMetadataPath, `${JSON.stringify(metadataManifest)}\n`);
    await assert.rejects(
      afterPack(tamperedMetadata),
      /packaged Model2Vec split embedding shape mismatch/,
    );

    const repackedPayload = fixture("linux", "repacked-model-payload");
    const repackedEmbeddingPath = path.join(repackedPayload.packagedModelRoot, "embeddings.i8.part-000");
    const repackedEmbedding = fs.readFileSync(repackedEmbeddingPath);
    repackedEmbedding[0] ^= 0xff;
    fs.writeFileSync(repackedEmbeddingPath, repackedEmbedding);
    const repackedManifestPath = path.join(repackedPayload.packagedModelRoot, "manifest.json");
    const repackedManifest = JSON.parse(fs.readFileSync(repackedManifestPath, "utf8"));
    repackedManifest.files["embeddings.i8.part-000"].sha256 = sha256(repackedEmbedding);
    repackedManifest.contentSha256 = modelContentIdentity(
      repackedManifest.files,
      [...repackedManifest.embeddingParts, "scales.f32le", "tokenizer.json", "LICENSE.model.txt"],
    );
    fs.writeFileSync(repackedManifestPath, `${JSON.stringify(repackedManifest, null, 2)}\n`);
    await assert.rejects(
      afterPack(repackedPayload),
      /packaged Model2Vec ordered embedding part record mismatch/,
    );
    console.log(
      "test-after-pack-runtime-contract: PASS "
        + "(platform parity + version/ref + secret/model integrity fail-closed)",
    );
  } finally {
    if (previousRef === undefined) delete process.env.HEPHAESTUS_REF;
    else process.env.HEPHAESTUS_REF = previousRef;
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
