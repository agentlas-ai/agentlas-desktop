#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { app } = require("electron");
const { resolveAgentlasCoreRoot, resolveModel2VecAsset } = require("./lib/agentlas-core-root.cjs");

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-memory-hybrid-"));
  process.env.AGENTLAS_STORE_PATH = path.join(temp, "agentlas.sqlite");
  process.env.AGENTLAS_E2E = "1";
  const coreRoot = resolveAgentlasCoreRoot();
  const modelAsset = resolveModel2VecAsset();
  assert.ok(fs.existsSync(path.join(modelAsset, "manifest.json")), "hybrid retrieval requires the bundled Model2Vec asset");
  process.env.AGENTLAS_MODEL2VEC_PATH = modelAsset;
  app.setPath("userData", path.join(temp, "user-data"));
  await app.whenReady();
  const store = require("../dist/electron/store/db.js");
  const memory = require("../dist/electron/memory/store.js");
  const context = require("../dist/electron/memory/context.js");
  const embedding = require("../dist/electron/memory/local-embedding.js");
  const { MODEL2VEC_HYBRID_NAME, MODEL2VEC_HYBRID_DIMENSIONS } = embedding;
  store.initStore();
  try {
    const query = "check browser account badge before publishing";
    const jsVector = embedding.localHashingEmbedding(query).vector;
    const python = spawnSync("python3", ["-c", [
      "import json,sys",
      `sys.path.insert(0, ${JSON.stringify(coreRoot)})`,
      "from ontology.embeddings import LocalHashingVectorAdapter",
      `print(json.dumps(LocalHashingVectorAdapter().embed(${JSON.stringify(query)})))`,
    ].join(";")], { encoding: "utf8" });
    assert.equal(python.status, 0, python.stderr);
    assert.deepEqual(jsVector, JSON.parse(python.stdout), "Desktop hash-96 must match public-core Python");

    for (let index = 0; index < 14; index += 1) {
      memory.insertMemoryEntry({
        scope: "agent_repo",
        kind: "procedure",
        content: `browser publishing account badge short-memory-${index}`,
        agentId: "agent-alpha",
        confidence: "high",
      });
    }
    memory.insertMemoryEntry({
      scope: "agent_repo",
      kind: "procedure",
      content: "browser publishing account badge beta-private-memory",
      agentId: "agent-beta",
      confidence: "high",
    });
    const allFit = context.buildMemoryContext(null, "agent-alpha", { taskPrompt: query });
    for (let index = 0; index < 14; index += 1) {
      assert.match(allFit, new RegExp(`short-memory-${index}(?!\\d)`), "all relevant memory must load when it fits");
    }
    assert.doesNotMatch(allFit, /beta-private-memory/, "governance/agent scope must run before ranking");

    for (let index = 0; index < 40; index += 1) {
      memory.insertMemoryEntry({
        scope: "agent_repo",
        kind: "procedure",
        content: `browser publishing account badge oversized-${index} ${"review-details ".repeat(25)}`,
        agentId: "agent-alpha",
        confidence: index % 2 === 0 ? "high" : "medium",
      });
    }
    const topK = context.buildMemoryContext(null, "agent-alpha", { taskPrompt: query });
    const selectedLines = topK.split("\n").filter((line) => line.startsWith("- ["));
    assert.ok(selectedLines.length > 0 && selectedLines.length <= 12, "over-budget recall must use bounded vector/RRF top-k");
    assert.ok(Buffer.byteLength(selectedLines.join("\n"), "utf8") / 3 <= 800);

    // Regression: ranking must see beyond an arbitrary newest-200 window.
    // The exact older target is inserted before 205 irrelevant, newer rows.
    memory.insertMemoryEntry({
      scope: "agent_repo",
      kind: "procedure",
      content: "legacy zebra quantum release sentinel",
      agentId: "agent-window",
      confidence: "high",
    });
    for (let index = 0; index < 205; index += 1) {
      memory.insertMemoryEntry({
        scope: "agent_repo",
        kind: "procedure",
        content: `cafeteria menu calendar unrelated recent row ${index}`,
        agentId: "agent-window",
        confidence: "high",
      });
    }
    const olderRelevant = context.buildMemoryContext(null, "agent-window", {
      taskPrompt: "legacy zebra quantum release sentinel",
    });
    assert.match(
      olderRelevant,
      /legacy zebra quantum release sentinel/,
      "newer irrelevant rows must not hide an older exact semantic match before ranking",
    );

    const stored = store.getDb().prepare(
      `SELECT COUNT(*) AS count FROM memory_entries
        WHERE embedding_model = ?
          AND embedding_dimensions = ?
          AND json_array_length(embedding_json) = ?`,
    ).get(MODEL2VEC_HYBRID_NAME, MODEL2VEC_HYBRID_DIMENSIONS, MODEL2VEC_HYBRID_DIMENSIONS).count;
    assert.equal(stored, 261, "every write must persist its local Model2Vec hybrid embedding");

    const clientSource = fs.readFileSync(path.join(__dirname, "../electron/mcp/client.ts"), "utf8");
    assert.match(
      clientSource,
      /buildMemoryContext\(memoryReadPath, agent\.id,[\s\S]{0,180}taskPrompt:\s*effectiveUserPrompt/,
      "every runMcpInvocation turn must pass the current effective prompt to Memory retrieval",
    );
    assert.match(
      clientSource,
      /buildExperienceContext\(\{[\s\S]{0,500}task:\s*effectiveUserPrompt/,
      "every runMcpInvocation turn must pass the current effective prompt to Experience retrieval",
    );
    // Korean must be ranked on meaning. The shipped multilingual asset
    // (potion-multilingual-128M) has real Hangul in its vocabulary, so unlike
    // the English-only asset it reads Korean instead of shattering it into Jamo.
    // These assertions fail the moment an asset that cannot read Korean is
    // pinned again (a related Korean memory would stop qualifying, or an
    // unrelated one would outrank it).
    const { autoLocalEmbedding, rankHybridLocal } = require("../dist/electron/memory/local-embedding.js");
    const embed = (text) => ({ text, embedding: autoLocalEmbedding(text).vector });
    const koreanRanked = rankHybridLocal("메모리가 저장이 안돼", [
      { id: "related", ...embed("큐레이터가 기억을 기록하지 못함") },
      { id: "unrelated", ...embed("다크모드 토글 추가") },
    ]);
    const koreanRelated = koreanRanked.find((entry) => entry.item.id === "related");
    const koreanUnrelated = koreanRanked.find((entry) => entry.item.id === "unrelated");
    assert.ok(koreanRelated.semanticEligible, "a related Korean memory must qualify semantically");
    assert.ok(!koreanUnrelated.semanticEligible, "unrelated Korean must not qualify");
    assert.ok(
      koreanRelated.vectorScore > koreanUnrelated.vectorScore,
      "related Korean must outscore unrelated Korean",
    );

    // Cross-lingual recall: a Korean prompt must reach an English memory. The
    // English-only asset scored this pair at -0.03 (worse than random); the
    // multilingual asset makes it reachable.
    const crossRanked = rankHybridLocal("배포 실패", [
      { id: "related", ...embed("the deployment failed and the release gate broke") },
      { id: "unrelated", ...embed("change the onboarding button colour") },
    ]);
    const crossRelated = crossRanked.find((entry) => entry.item.id === "related");
    assert.ok(
      crossRelated.semanticEligible && crossRelated.vectorScore > 0.3,
      `a Korean prompt must reach an English memory (scored ${crossRelated.vectorScore})`,
    );

    // English keeps its semantic axis.
    assert.ok(
      rankHybridLocal("update the changelog", [{ id: "related", ...embed("changelog update required") }])
        .some((entry) => entry.semanticEligible),
      "English must still rank semantically",
    );

    // A version is one identifier. The Latin pattern stops at the dot and needs
    // two characters, so "0.9.0" used to tokenize to nothing at all — a prompt
    // naming only a version could not be searched — and "v0.8.46" fractured
    // into "v0" and "46", never matching a prompt that wrote it without the v.
    const { localEmbeddingTokens, lexicalOverlap } = require("../dist/electron/memory/local-embedding.js");
    assert.ok(localEmbeddingTokens("0.9.0").includes("0.9.0"), "a bare version must tokenize");
    assert.ok(localEmbeddingTokens("v0.8.46").includes("0.8.46"), "a v-prefixed version must normalize");
    assert.ok(
      lexicalOverlap("deploy 0.8.46", "shipped v0.8.46 to the feed") > 0,
      "the same version must match whether or not it was written with a v",
    );

    console.log(JSON.stringify({
      ok: true,
      pythonParity: true,
      allFitItems: 14,
      topKItems: selectedLines.length,
      storedEmbeddings: stored,
      olderRelevantBeyond200: true,
    }, null, 2));
  } finally {
    store.getDb().close();
    fs.rmSync(temp, { recursive: true, force: true });
    app.quit();
  }
}

main().catch((error) => {
  console.error(error);
  app.exit(1);
});
