#!/usr/bin/env node
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { resolveAgentlasCoreRoot, resolveModel2VecAsset } = require("./lib/agentlas-core-root.cjs");
const { MODEL2VEC_HYBRID_DIMENSIONS } = require("../dist/electron/memory/local-embedding.js");

const coreRoot = resolveAgentlasCoreRoot();
const modelPath = resolveModel2VecAsset();
assert.ok(fs.existsSync(path.join(coreRoot, "ontology", "__main__.py")), "Agentlas Core ontology CLI is required");
assert.ok(fs.existsSync(path.join(modelPath, "manifest.json")), "verified local Model2Vec asset is required");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-core-nest-query-"));
const sandboxHome = path.join(temp, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.AGENTLAS_STORE_PATH = path.join(temp, "desktop.sqlite");
process.env.AGENTLAS_MODEL2VEC_PATH = modelPath;
process.env.AGENTLAS_E2E = "1";

const { app } = require("electron");
// Electron resolves its Windows profile paths while the app is starting. An
// empty test USERPROFILE at module load makes Chromium terminate with exit 3
// before JavaScript can report an assertion. Bind Electron's own userData path
// first, then redirect os.homedir()-based Agentlas nests after readiness.
app.setPath("userData", path.join(temp, "user-data"));

async function main() {
  await app.whenReady();
  process.env.HOME = sandboxHome;
  process.env.USERPROFILE = sandboxHome;
  const desktopStore = require("../dist/electron/store/db.js");
  const { curateEvents } = require("../dist/electron/memory/curator.js");
  desktopStore.initStore();

  const projectPath = path.join(temp, "project");
  fs.mkdirSync(projectPath, { recursive: true });
  const event = (kind, content) => ({
    memory_kind: kind,
    content,
    suggested_scope: "agent_repo",
    confidence: "high",
    sensitivity: "internal",
  });
  const report = curateEvents(
    [
      event("procedure", "database migration rollback checklist"),
      event("risk", "social media image publishing schedule"),
    ],
    {
      projectPath,
      projectId: "project-core-query",
      agentId: "desktop-orchestrator",
      chatId: "chat-core-query",
      cwdAtRequest: projectPath,
      borrowedAgentSlugs: ["semantic_reviewer"],
    },
  );
  assert.equal(report.written, 2);

  const nestDbPath = path.join(
    sandboxHome,
    ".agentlas",
    "networking",
    "hub-agents",
    "semantic-reviewer",
    "memory",
    "experience.sqlite",
  );
  const nestDb = new Database(nestDbPath, { readonly: true });
  const rows = nestDb.prepare(
    `SELECT candidate_text, status, agent_id, embedding_adapter,
            embedding_dimensions, embedding_json
       FROM memory_candidates ORDER BY candidate_text`,
  ).all();
  const registeredAdapter = nestDb.prepare(
    "SELECT name, kind, status, config_json FROM runtime_adapters WHERE kind = 'vector'",
  ).get();
  nestDb.close();
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.status === "active"));
  assert.ok(rows.every((row) => row.agent_id === "hub:semantic-reviewer"));
  assert.ok(rows.every((row) => row.embedding_adapter === "model2vec_potion_base_8m_int8_hybrid"));
  assert.ok(rows.every((row) => row.embedding_dimensions === MODEL2VEC_HYBRID_DIMENSIONS));
  assert.ok(rows.every((row) => JSON.parse(row.embedding_json).length === MODEL2VEC_HYBRID_DIMENSIONS));
  assert.equal(registeredAdapter.name, "model2vec_potion_base_8m_int8_hybrid");
  assert.equal(registeredAdapter.status, "available");
  const adapterConfig = JSON.parse(registeredAdapter.config_json);
  assert.equal(adapterConfig.dimensions, MODEL2VEC_HYBRID_DIMENSIONS);
  assert.equal(adapterConfig.model_sha256, "fe492f69607b750142aa48d47d579b53252b3288547c27d4d0e473d6af485e1e");
  assert.match(adapterConfig.identity, new RegExp(`:semantic-v1:${MODEL2VEC_HYBRID_DIMENSIONS}$`));

  desktopStore.getDb().close();
  const python = process.env.AGENTLAS_PYTHON
    || process.env.HEPHAESTUS_PYTHON
    || (process.platform === "win32" ? "python" : "python3");
  const query = "rollback steps for a database schema migration";
  const result = spawnSync(
    python,
    [
      "-m", "ontology",
      "--db", nestDbPath,
      "--embedding-adapter", "model2vec",
      "--local-model-path", modelPath,
      "experience", "query", query,
      "--agent", "hub:semantic-reviewer",
      "--token-budget", "200",
      "--top-k", "4",
    ],
    {
      cwd: coreRoot,
      env: {
        ...process.env,
        PYTHONPATH: [coreRoot, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
      },
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  assert.equal(result.status, 0, `Core ontology query failed:\n${result.stderr || result.stdout}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.agent_id, "hub:semantic-reviewer");
  assert.equal(payload.fusion, "rrf_lexical_cosine_with_salience_prior");
  assert.equal(payload.eligible_count, 2, "both active Desktop projections must be visible to Core");
  assert.ok(payload.selected_count >= 1);
  const relevant = payload.items.find((item) => item.candidate_text === "database migration rollback checklist");
  assert.ok(relevant, "Core query must return the paraphrased Desktop learning");
  assert.ok(relevant.vector_score > 0.69, `expected compatible semantic vector, got ${relevant.vector_score}`);
  assert.equal(relevant.embedding.adapter, "model2vec_potion_base_8m_int8_hybrid");

  console.log(JSON.stringify({
    ok: true,
    db: "hub-agents/semantic-reviewer/memory/experience.sqlite",
    status: relevant.status,
    adapter: relevant.embedding.adapter,
    dimensions: relevant.embedding.dimensions,
    vectorScore: relevant.vector_score,
    mode: payload.mode,
  }, null, 2));
}

main().then(() => {
  fs.rmSync(temp, { recursive: true, force: true });
  app.quit();
}).catch((error) => {
  console.error(error);
  fs.rmSync(temp, { recursive: true, force: true });
  app.exit(1);
});
