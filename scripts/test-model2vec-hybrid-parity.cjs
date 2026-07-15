#!/usr/bin/env node
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const siblingAsset = path.resolve(
  __dirname,
  "..",
  "..",
  "Agentlas-OS",
  "assets",
  "model2vec",
  "potion-base-8M-int8",
);
const assetPath = process.env.AGENTLAS_MODEL2VEC_PATH || siblingAsset;
assert.ok(
  fs.existsSync(path.join(assetPath, "manifest.json")),
  `verified local Model2Vec asset is required: ${assetPath}`,
);
process.env.AGENTLAS_MODEL2VEC_PATH = assetPath;

const embeddingRuntime = require("../dist/electron/memory/local-embedding.js");
const {
  MODEL2VEC_HYBRID_DIMENSIONS,
  MODEL2VEC_HYBRID_NAME,
  PINNED_MODEL2VEC_CONTENT_SHA256,
  PINNED_MODEL2VEC_MODEL_ID,
  PINNED_MODEL2VEC_REVISION,
  autoLocalEmbedding,
  cosineSimilarity,
  invalidateLocalEmbeddingModelCache,
  model2VecTokenIds,
  parseLocalEmbedding,
  rankHybridLocal,
  verifyLocalModel2VecAsset,
} = embeddingRuntime;

const ENGLISH = "database migration rollback checklist";
const KOREAN = "한국어 계약서 자동 생성";
const EXPECTED = {
  [ENGLISH]: {
    ids: [6815, 8236, 3903, 4969, 3644, 8869],
    digest: "78fb16e49ce5164015ea9f7a57be5149c24d7870593daf1382df0eef7f46d8b3",
    first8: [0.057741, 0.065825, 0.029536, -0.074953, 0.022142, 0.025752, -0.013242, -0.114698],
  },
  [KOREAN]: {
    ids: [475, 29012, 29027, 28997, 29020, 29026, 29005, 29014, 470, 29012, 28999, 29017, 29031, 467, 29013, 29031, 29003, 29014, 29031],
    digest: "81d40d4b9ed6dd34a63433c3f76062578f3c24e4a4ef90adf33f3710f0d785a3",
    first8: [0.059526, -0.100034, -0.156922, -0.048684, 0.147805, 0.094565, 0.115945, -0.073351],
  },
};

function vectorDigest(vector) {
  const bytes = Buffer.alloc(vector.length * 4);
  vector.forEach((component, index) => {
    bytes.writeInt32LE(Math.round(component * 1_000_000), index * 4);
  });
  return createHash("sha256").update(bytes).digest("hex");
}

for (const [text, expected] of Object.entries(EXPECTED)) {
  assert.deepEqual(model2VecTokenIds(text), expected.ids, `${text}: WordPiece ids must match Core`);
  const embedding = autoLocalEmbedding(text);
  assert.equal(embedding.model, MODEL2VEC_HYBRID_NAME);
  assert.equal(embedding.dimensions, MODEL2VEC_HYBRID_DIMENSIONS);
  assert.equal(embedding.dimensions, 352);
  assert.equal(embedding.vector.length, 352);
  assert.equal(embedding.modelSha256, PINNED_MODEL2VEC_CONTENT_SHA256);
  assert.equal(embedding.degraded, false);
  assert.equal(embedding.degradedReason, null);
  assert.match(embedding.adapter, /^model2vec:minishlab\/potion-base-8M:/);
  assert.match(embedding.adapter, /:agentlas-model2vec-int8-v1:hybrid-hash96-v1:352$/);
  assert.equal(vectorDigest(embedding.vector), expected.digest, `${text}: vector digest must match Core`);
  assert.deepEqual(embedding.vector.slice(0, 8), expected.first8, `${text}: vector head must match Core`);
}

const english = autoLocalEmbedding(ENGLISH).vector;
const englishRelated = cosineSimilarity(
  english,
  autoLocalEmbedding("rollback steps for a database schema migration").vector,
);
const englishUnrelated = cosineSimilarity(
  english,
  autoLocalEmbedding("social media image publishing schedule").vector,
);
assert.ok(englishRelated > englishUnrelated + 0.5, "English semantic paraphrase must outrank an unrelated memory");

const korean = autoLocalEmbedding(KOREAN).vector;
const koreanRelated = cosineSimilarity(korean, autoLocalEmbedding("계약서 생성 자동화").vector);
const koreanUnrelated = cosineSimilarity(korean, autoLocalEmbedding("분기별 세금 감가상각 계산").vector);
assert.ok(Math.abs(koreanRelated - 0.8387192) < 1e-6, "Korean cosine must match Core");
assert.ok(koreanRelated > koreanUnrelated + 0.25, "Korean semantic paraphrase must outrank an unrelated memory");

const koreanRanking = rankHybridLocal(KOREAN, [
  {
    id: "related",
    text: "계약서 생성 자동화",
    embedding: autoLocalEmbedding("계약서 생성 자동화").vector,
  },
  {
    id: "unrelated",
    text: "분기별 세금 감가상각 계산",
    embedding: autoLocalEmbedding("분기별 세금 감가상각 계산").vector,
  },
]);
assert.equal(koreanRanking.find((entry) => entry.item.id === "related")?.semanticEligible, true);
assert.equal(
  koreanRanking.find((entry) => entry.item.id === "unrelated")?.semanticEligible,
  false,
  "Model2Vec must not reuse the hash-96 0.08 relevance floor",
);
const koreanUnrelatedOnly = rankHybridLocal(KOREAN, [
  {
    id: "unrelated-only",
    text: "분기별 세금 감가상각 계산",
    embedding: autoLocalEmbedding("분기별 세금 감가상각 계산").vector,
  },
]);
assert.equal(
  koreanUnrelatedOnly[0]?.semanticEligible,
  false,
  "a lone CJK false-positive must not pass merely because it is its own best vector",
);

const persisted = autoLocalEmbedding(ENGLISH);
const persistedJson = JSON.stringify(persisted.vector);
const persistedMetadata = {
  adapter: persisted.adapter,
  modelSha256: persisted.modelSha256,
  contentHash: persisted.contentHash,
  text: ENGLISH,
};
assert.ok(parseLocalEmbedding(
  persisted.model,
  persisted.dimensions,
  persistedJson,
  persistedMetadata,
), "current persisted vector must parse");
assert.equal(parseLocalEmbedding("local_hashing", persisted.dimensions, persistedJson, persistedMetadata), null);
assert.equal(parseLocalEmbedding(persisted.model, 96, persistedJson, persistedMetadata), null);
assert.equal(parseLocalEmbedding(persisted.model, persisted.dimensions, persistedJson, {
  ...persistedMetadata,
  modelSha256: "0".repeat(64),
}), null);
assert.equal(parseLocalEmbedding(persisted.model, persisted.dimensions, persistedJson, {
  ...persistedMetadata,
  text: `${ENGLISH} changed`,
}), null);

const manifest = JSON.parse(fs.readFileSync(path.join(assetPath, "manifest.json"), "utf8"));
assert.equal(manifest.runtime.networkRequired, false);
assert.deepEqual(manifest.runtime.externalPackages, []);
assert.equal(manifest.contentSha256, PINNED_MODEL2VEC_CONTENT_SHA256);
assert.equal(manifest.source.modelId, PINNED_MODEL2VEC_MODEL_ID);
assert.equal(manifest.source.revision, PINNED_MODEL2VEC_REVISION);
assert.ok(verifyLocalModel2VecAsset(assetPath), "pinned asset must pass direct verification");

// A byte-identical payload with forged provenance must fail closed. Content
// SHA alone is not sufficient because model ID and revision are part of the
// executable retrieval contract.
const tamperRoot = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "agentlas-model2vec-tamper-"));
const tamperAsset = path.join(tamperRoot, "asset");
fs.cpSync(assetPath, tamperAsset, { recursive: true });
try {
  const tamperedManifestPath = path.join(tamperAsset, "manifest.json");
  const tamperedModel = JSON.parse(fs.readFileSync(tamperedManifestPath, "utf8"));
  tamperedModel.source.modelId = "attacker/potion-base-8M";
  fs.writeFileSync(tamperedManifestPath, `${JSON.stringify(tamperedModel, null, 2)}\n`);
  assert.equal(verifyLocalModel2VecAsset(tamperAsset), null, "tampered model ID must fail closed");

  tamperedModel.source.modelId = PINNED_MODEL2VEC_MODEL_ID;
  tamperedModel.source.revision = "0000000000000000000000000000000000000000";
  fs.writeFileSync(tamperedManifestPath, `${JSON.stringify(tamperedModel, null, 2)}\n`);
  assert.equal(verifyLocalModel2VecAsset(tamperAsset), null, "tampered revision must fail closed");

  tamperedModel.source.revision = PINNED_MODEL2VEC_REVISION;
  tamperedModel.source.files["config.json"].sha256 = "0".repeat(64);
  fs.writeFileSync(tamperedManifestPath, `${JSON.stringify(tamperedModel, null, 2)}\n`);
  assert.equal(verifyLocalModel2VecAsset(tamperAsset), null, "tampered upstream provenance must fail closed");
} finally {
  fs.rmSync(tamperRoot, { recursive: true, force: true });
}

// The public invalidation hook complements the bounded negative-cache TTL for
// runtimes that install the model while this Electron process remains alive.
invalidateLocalEmbeddingModelCache();
assert.equal(autoLocalEmbedding(ENGLISH).degraded, false);
const source = fs.readFileSync(
  path.resolve(__dirname, "..", "electron", "memory", "local-embedding.ts"),
  "utf8",
);
assert.doesNotMatch(source, /node:child_process|spawnSync|https?:\/\/|\bfetch\s*\(/);

console.log(JSON.stringify({
  ok: true,
  adapter: autoLocalEmbedding(ENGLISH).adapter,
  dimensions: MODEL2VEC_HYBRID_DIMENSIONS,
  contentSha256: PINNED_MODEL2VEC_CONTENT_SHA256,
  englishRelated,
  englishUnrelated,
  koreanRelated,
  koreanUnrelated,
}, null, 2));
