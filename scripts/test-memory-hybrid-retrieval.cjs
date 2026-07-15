#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { app } = require("electron");

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-memory-hybrid-"));
  process.env.AGENTLAS_STORE_PATH = path.join(temp, "agentlas.sqlite");
  process.env.AGENTLAS_E2E = "1";
  app.setPath("userData", path.join(temp, "user-data"));
  await app.whenReady();
  const store = require("../dist/electron/store/db.js");
  const memory = require("../dist/electron/memory/store.js");
  const context = require("../dist/electron/memory/context.js");
  const embedding = require("../dist/electron/memory/local-embedding.js");
  store.initStore();
  try {
    const query = "check browser account badge before publishing";
    const jsVector = embedding.localHashingEmbedding(query).vector;
    const python = spawnSync("python3", ["-c", [
      "import json,sys",
      `sys.path.insert(0, ${JSON.stringify(path.join(__dirname, "..", "Hephaestus"))})`,
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

    const stored = store.getDb().prepare(
      `SELECT COUNT(*) AS count FROM memory_entries
        WHERE embedding_model = 'local_hashing' AND embedding_dimensions = 96
          AND json_array_length(embedding_json) = 96`,
    ).get().count;
    assert.equal(stored, 55, "every write must persist its local embedding");

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
    console.log(JSON.stringify({
      ok: true,
      pythonParity: true,
      allFitItems: 14,
      topKItems: selectedLines.length,
      storedEmbeddings: stored,
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
