#!/usr/bin/env node
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const afterPack = require("../build-resources/after-pack-clean.cjs").default;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-after-pack-runtime-"));
const previousRef = process.env.HEPHAESTUS_REF;
const modelPayloads = {
  "embeddings.i8": Buffer.from([1, 2, 3, 4, 5, 6]),
  "scales.f32le": Buffer.alloc(12, 7),
  "tokenizer.json": Buffer.from('{"model":{"type":"WordPiece","vocab":{}}}\n'),
  "LICENSE.model.txt": Buffer.from("MIT fixture\n"),
};

function sha256(payload) {
  return createHash("sha256").update(payload).digest("hex");
}

function modelContentIdentity(files) {
  const digest = createHash("sha256");
  for (const name of Object.keys(modelPayloads).sort()) {
    const record = files[name];
    digest.update(name).update("\0").update(record.sha256).update("\0")
      .update(String(record.size)).update("\n");
  }
  return digest.digest("hex");
}

function writeModelAsset(runtimeRoot) {
  const modelRoot = path.join(runtimeRoot, "assets", "model2vec", "potion-base-8M-int8");
  fs.mkdirSync(modelRoot, { recursive: true });
  const files = {};
  for (const [name, payload] of Object.entries(modelPayloads)) {
    fs.writeFileSync(path.join(modelRoot, name), payload);
    files[name] = { sha256: sha256(payload), size: payload.length };
  }
  fs.writeFileSync(path.join(modelRoot, "manifest.json"), `${JSON.stringify({
    format: "agentlas-model2vec-int8-v1",
    dimensions: 2,
    vocabSize: 3,
    files,
    contentSha256: modelContentIdentity(files),
  }, null, 2)}\n`);
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
  fs.mkdirSync(path.join(sourceRoot, "agentlas_cloud"), { recursive: true });
  fs.mkdirSync(path.join(packagedRoot, "agentlas_cloud"), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, "manifest.json"), JSON.stringify({ version: "1.1.14" }));
  fs.writeFileSync(path.join(packagedRoot, "manifest.json"), JSON.stringify({ version: "1.1.14" }));
  fs.writeFileSync(path.join(packagedRoot, "agentlas_cloud", "__main__.py"), "# fixture\n");
  writeModelAsset(sourceRoot);
  const packagedModelRoot = writeModelAsset(packagedRoot);
  fs.mkdirSync(path.join(packagedRoot, ".agentlas"), { recursive: true });
  fs.writeFileSync(path.join(packagedRoot, ".agentlas", "routing-card.json"), "{}\n");
  fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({
    agentlasUpdateCompatibility: { bundledRuntimeVersion: compatibilityVersion },
  }));
  return {
    appOutDir,
    electronPlatformName: platform,
    packager: { projectDir, appInfo: { productFilename: "Agentlas" } },
    packagedModelRoot,
    packagedRoot,
  };
}

(async () => {
  try {
    process.env.HEPHAESTUS_REF = "v1.1.14";
    for (const platform of ["darwin", "win32", "linux"]) {
      await afterPack(fixture(platform, platform));
    }

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
    fs.rmSync(path.join(missingModel.packagedModelRoot, "embeddings.i8"));
    await assert.rejects(
      afterPack(missingModel),
      /packaged Model2Vec asset missing: embeddings\.i8/,
    );

    const tamperedPayload = fixture("linux", "tampered-model-payload");
    const tamperedEmbeddingPath = path.join(tamperedPayload.packagedModelRoot, "embeddings.i8");
    const tamperedEmbedding = fs.readFileSync(tamperedEmbeddingPath);
    tamperedEmbedding[0] ^= 0xff;
    fs.writeFileSync(tamperedEmbeddingPath, tamperedEmbedding);
    await assert.rejects(
      afterPack(tamperedPayload),
      /packaged Model2Vec asset checksum mismatch: embeddings\.i8/,
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
      /packaged Model2Vec manifest drift/,
    );

    const repackedPayload = fixture("linux", "repacked-model-payload");
    const repackedEmbeddingPath = path.join(repackedPayload.packagedModelRoot, "embeddings.i8");
    const repackedEmbedding = fs.readFileSync(repackedEmbeddingPath);
    repackedEmbedding[0] ^= 0xff;
    fs.writeFileSync(repackedEmbeddingPath, repackedEmbedding);
    const repackedManifestPath = path.join(repackedPayload.packagedModelRoot, "manifest.json");
    const repackedManifest = JSON.parse(fs.readFileSync(repackedManifestPath, "utf8"));
    repackedManifest.files["embeddings.i8"].sha256 = sha256(repackedEmbedding);
    repackedManifest.contentSha256 = modelContentIdentity(repackedManifest.files);
    fs.writeFileSync(repackedManifestPath, `${JSON.stringify(repackedManifest, null, 2)}\n`);
    await assert.rejects(
      afterPack(repackedPayload),
      /packaged Model2Vec content drift/,
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
