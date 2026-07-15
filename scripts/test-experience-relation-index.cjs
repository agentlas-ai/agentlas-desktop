#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");

process.env.AGENTLAS_E2E = "1";
const { app } = require("electron");

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-experience-relations-"));
  process.env.HOME = temp;
  process.env.USERPROFILE = temp;
  app.setPath("userData", temp);
  await app.whenReady();
  const dbModule = require("../dist/electron/store/db.js");
  const memory = require("../dist/electron/memory/store.js");
  const experience = require("../dist/electron/experience/store.js");
  const relations = require("../dist/electron/experience/relation-index.js");
  const context = require("../dist/electron/experience/context.js");
  const embedding = require("../dist/electron/memory/local-embedding.js");
  const projectFiles = require("../dist/electron/memory/project-files.js");
  const routes = require("../dist/electron/agents/routes.js");
  dbModule.initStore();
  const db = dbModule.getDb();

  try {
    assert.equal(db.pragma("user_version", { simple: true }), 65);
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    for (const table of [
      "experience_lineage_events",
      "experience_relation_nodes",
      "experience_relation_edges",
      "experience_relation_index_state",
    ]) assert.ok(tables.has(table), `${table} must exist in shared SQLite`);

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO installed_agents (
         id, slug, name, name_en, tagline, tagline_en, system_prompt,
         mcp_servers_json, env_requirements_json, preferred_backend,
         trust_grade, installed_at, tone, builtin, visibility, entity_kind
       ) VALUES ('agent-rel', 'agent-rel', 'Relation Agent', 'Relation Agent', 'R', 'R',
                 '', '["github"]', '[]', NULL, 'A', ?, 'blue', 0, 'visible', 'agent')`,
    ).run(now);
    const baseHash = "a".repeat(64);
    routes.setRoute({
      agentId: "agent-rel",
      path: path.join(temp, "agent-rel"),
      runtime: "codex",
      labels: ["codex"],
      kind: "agent",
      importedAt: now,
      source: "local-import",
      packageHash: baseHash,
    });
    const canonicalTemp = fs.realpathSync.native(temp);
    const projectPath = path.join(canonicalTemp, "workspace-a");
    fs.mkdirSync(projectPath, { recursive: true });
    const environment = { platform: process.platform, arch: process.arch, runtimeKind: "codex" };
    const browserTask = "agentlas.task.v1/browser-automation";
    const socialTask = "agentlas.task.v1/social-publishing";
    const researchTask = "agentlas.task.v1/research";
    const codingTask = "agentlas.task.v1/coding";
    const pack = experience.createExperiencePack({
      agentId: "agent-rel",
      name: "Browser relation pack",
      projectPath,
      environment,
      mcpRequirements: [{ catalogId: "github", required: true, alternatives: ["filesystem"] }],
    });
    assert.deepEqual(pack.mcpRequirements, [
      { catalogId: "github", required: true, alternatives: ["filesystem"] },
    ]);

    function promote(summary, triggerTerms, confidence = "medium", targetPack = pack) {
      const row = memory.insertMemoryEntry({
        scope: "agent_repo",
        kind: "procedure",
        content: summary,
        projectPath,
        agentId: "agent-rel",
        confidence,
        sensitivity: "internal",
        requestContext: { triggerTerms },
      });
      const candidate = experience.captureExperienceCandidate({ packId: targetPack.id, sourceMemoryId: row.id });
      const receipt = experience.promoteExperienceCandidate({
        candidateId: candidate.id,
        explicitConsent: true,
        verification: {
          status: "attested",
          method: "user-attested",
          evidenceRefs: [`attestation:${candidate.id}`],
        },
        publicSafe: false,
      });
      return { row, candidate, receipt };
    }

    const first = promote(
      "Use the visible browser account before publishing. Keep environment-specific source material in private memory only.",
      [browserTask, socialTask, researchTask],
      "high",
    );
    const second = promote(
      "Use the visible browser account and check its account badge before retrying publishing.",
      [browserTask, socialTask],
      "medium",
    );
    const nestItems = [
      {
        id: first.row.id,
        kind: first.row.kind,
        content: first.row.content,
        confidence: first.row.confidence,
        sensitivity: first.row.sensitivity,
        updatedAt: first.row.createdAt,
      },
      {
        id: second.row.id,
        kind: second.row.kind,
        content: second.row.content,
        confidence: second.row.confidence,
        sensitivity: second.row.sensitivity,
        updatedAt: second.row.createdAt,
      },
    ];
    assert.equal(projectFiles.appendAgentNestExperienceMemory(
      "borrowed_relation_agent",
      nestItems,
    ), true);
    const nestDbPath = path.join(
      temp,
      ".agentlas/networking/hub-agents/borrowed-relation-agent/memory/experience.sqlite",
    );
    const contradictionId = relations.recordExperienceGovernanceRelation({
      fromCandidateId: second.candidate.id,
      toCandidateId: first.candidate.id,
      relationType: "contradicts",
      reason: "Owner review found mutually exclusive retry conditions.",
    });
    assert.match(contradictionId, /^experience-governance-relation:/);
    let nestDb = new Database(nestDbPath, { readonly: true });
    assert.equal(nestDb.prepare(
      "SELECT count(*) AS count FROM memory_links WHERE link_type = 'contradicts'",
    ).get().count, 1, "reviewed contradiction must bridge into next-borrow Core memory");
    nestDb.close();

    // Regression: governance is authoritative Desktop state, so a relation
    // recorded before a particular nest exists must appear when that nest is
    // projected later instead of depending on the one-time bridge call.
    const lateNestRoot = path.join(
      temp,
      ".agentlas/networking/hub-agents/late-relation-agent",
    );
    const lateNestDbPath = path.join(lateNestRoot, "memory/experience.sqlite");
    assert.equal(fs.existsSync(lateNestDbPath), false);
    assert.equal(projectFiles.appendAgentNestExperienceMemory(
      "late_relation_agent",
      nestItems,
    ), true);
    let lateNestDb = new Database(lateNestDbPath, { readonly: true });
    assert.equal(lateNestDb.prepare(
      "SELECT count(*) AS count FROM memory_links WHERE link_type = 'contradicts'",
    ).get().count, 1, "a later nest build must replay the reviewed contradiction");
    lateNestDb.close();

    let status = relations.getExperienceRelationIndexStatus();
    assert.equal(status.stale, false);
    assert.ok(status.nodeCount >= 10);
    assert.ok(status.edgeCount >= 10);
    const nodeTypes = new Set(db.prepare("SELECT DISTINCT node_type FROM experience_relation_nodes").all().map((row) => row.node_type));
    for (const type of ["Pack", "Release", "Item", "TaskTag", "Environment", "MCPRequirement", "EvidenceReceipt"]) {
      assert.ok(nodeTypes.has(type), `${type} node must exist`);
    }
    const edgeTypes = new Set(db.prepare("SELECT DISTINCT edge_type FROM experience_relation_edges WHERE pack_id = ?").all(pack.id).map((row) => row.edge_type));
    for (const type of [
      "has_release", "exact_base_binding", "contains", "applies_to_task",
      "applies_in_environment", "requires_mcp", "alternative_mcp",
      "supported_by", "supersedes", "contradicts", "similar_to",
    ]) assert.ok(edgeTypes.has(type), `${type} edge must exist`);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM experience_governance_relations").get().count,
      1,
      "explicit governance must persist outside the rebuildable relation index",
    );

    const scopeKey = db.prepare("SELECT project_scope_key, environment_key FROM experience_packs WHERE id = ?").get(pack.id);
    const relationScores = relations.rankExperienceCandidatesByRelations({
      projectScopeKey: scopeKey.project_scope_key,
      environmentKey: scopeKey.environment_key,
      basePackageHash: baseHash,
      taskTerms: [researchTask],
    });
    assert.ok((relationScores.get(first.candidate.id) ?? 0) >= 10, "direct tag relation must rank");
    assert.equal(relationScores.get(second.candidate.id), 8, "local-vector similarity may conservatively propagate relevance");
    const selected = context.buildExperienceContext({
      agentId: "agent-rel",
      projectPath,
      environment,
      basePackageHash: baseHash,
      task: researchTask,
    });
    assert.ok(selected.selectedCandidateIds.includes(first.candidate.id));
    assert.equal(
      selected.selectedCandidateIds.includes(second.candidate.id),
      true,
      "hybrid retrieval may activate a semantically relevant reviewed Experience without exact tag overlap",
    );
    assert.ok(selected.selectedCandidateIds.length <= 8);
    assert.ok(selected.approximateTokens <= 800);

    const supersedesId = relations.recordExperienceGovernanceRelation({
      fromCandidateId: second.candidate.id,
      toCandidateId: first.candidate.id,
      relationType: "supersedes",
      reason: "Owner review replaced the earlier browser publishing procedure.",
    });
    assert.match(supersedesId, /^experience-governance-relation:/);
    nestDb = new Database(nestDbPath, { readonly: true });
    assert.equal(nestDb.prepare(
      "SELECT count(*) AS count FROM memory_links WHERE link_type = 'supersedes'",
    ).get().count, 1, "reviewed supersession must bridge into next-borrow Core memory");
    nestDb.close();

    // Deleting a rebuildable nest must not delete governance. Re-projection
    // restores every applicable authoritative edge after both endpoints land.
    fs.rmSync(lateNestRoot, { recursive: true, force: true });
    assert.equal(fs.existsSync(lateNestDbPath), false);
    assert.equal(projectFiles.appendAgentNestExperienceMemory(
      "late_relation_agent",
      nestItems,
    ), true);
    lateNestDb = new Database(lateNestDbPath, { readonly: true });
    const rebuiltGovernance = Object.fromEntries(lateNestDb.prepare(
      `SELECT link_type, count(*) AS count FROM memory_links
        WHERE link_type IN ('contradicts', 'supersedes') GROUP BY link_type`,
    ).all().map((row) => [row.link_type, row.count]));
    assert.equal(rebuiltGovernance.contradicts, 1);
    assert.equal(rebuiltGovernance.supersedes, 1);
    lateNestDb.close();
    const afterSupersedes = context.buildExperienceContext({
      agentId: "agent-rel",
      projectPath,
      environment,
      basePackageHash: baseHash,
      task: researchTask,
    });
    assert.equal(
      afterSupersedes.selectedCandidateIds.includes(first.candidate.id),
      false,
      "a valid same-pack supersedes edge must hide its reviewed target from retrieval",
    );
    assert.equal(
      afterSupersedes.selectedCandidateIds.includes(second.candidate.id),
      true,
      "the valid reviewed replacement must remain retrievable",
    );
    assert.equal(
      experience.listPromotedExperienceProjection({
        agentId: "agent-rel",
        projectPath,
        environmentKey: experience.experienceEnvironmentKey(environment),
        basePackageHash: baseHash,
        taskTerms: [researchTask],
      }).some((item) => item.id === first.candidate.id),
      false,
      "superseded targets must be filtered before semantic ranking",
    );

    // Regression: vector/RRF ranking must see an older relevant candidate even
    // after more than 200 newer, irrelevant reviewed rows exist.
    const olderTargetId = "older-relevant-beyond-200";
    const insertProjection = db.prepare(`
      INSERT INTO experience_candidates (
        id, pack_id, agent_id, project_scope_key, environment_key, source_memory_id,
        summary, task_terms_json, sensitivity, confidence, status, outcome_status,
        public_safe, auto_managed, embedding_model, embedding_adapter,
        embedding_model_sha256, embedding_content_hash, embedding_dimensions,
        embedding_json, created_at, updated_at, promoted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', 'internal', 'high', 'promoted', 'attested',
        0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertRankFixture = (id, summary, timestamp) => {
      const vector = embedding.autoLocalEmbedding(summary);
      insertProjection.run(
        id,
        pack.id,
        "agent-rel",
        scopeKey.project_scope_key,
        scopeKey.environment_key,
        `memory-${id}`,
        summary,
        vector.model,
        vector.adapter,
        vector.modelSha256,
        vector.contentHash,
        vector.dimensions,
        JSON.stringify(vector.vector),
        timestamp,
        timestamp,
        timestamp,
      );
    };
    insertRankFixture(olderTargetId, "legacy zebra quantum release sentinel", "2000-01-01T00:00:00.000Z");
    for (let index = 0; index < 205; index += 1) {
      insertRankFixture(
        `newer-irrelevant-${index}`,
        `cafeteria menu calendar unrelated recent experience ${index}`,
        `2100-01-01T00:${String(index % 60).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
      );
    }
    const beyondWindow = context.buildExperienceContext({
      agentId: "agent-rel",
      projectPath,
      environment,
      basePackageHash: baseHash,
      task: "legacy zebra quantum release sentinel",
    });
    assert.ok(
      beyondWindow.selectedCandidateIds.includes(olderTargetId),
      "newer irrelevant Experience rows must not hide an older exact semantic match before ranking",
    );
    const experienceStoreSource = fs.readFileSync(
      path.join(__dirname, "../electron/experience/store.ts"),
      "utf8",
    );
    const projectionQuerySource = experienceStoreSource.match(
      /export function listPromotedExperienceProjection[\s\S]*?return rows\.map/,
    )?.[0] ?? "";
    assert.doesNotMatch(
      projectionQuerySource,
      /ORDER BY c\.updated_at DESC LIMIT\s+\d+/,
      "Experience retrieval must not apply a recency cap before semantic ranking",
    );

    const lineageFile = path.join(projectPath, ".agentlas", "experience-relations.jsonl");
    assert.ok(fs.existsSync(lineageFile), "promotion must materialize the safe project lineage source");
    const lineageText = fs.readFileSync(lineageFile, "utf8");
    assert.doesNotMatch(lineageText, /visible browser account|retry the publishing|\/Users\/example|private\.txt/i);
    assert.doesNotMatch(lineageText, /rawPrompt|transcript|systemPrompt|projectPath/i);
    for (const line of lineageText.trim().split("\n")) {
      const event = JSON.parse(line);
      assert.equal(event.kind, "agentlas-experience-relation-lineage");
      assert.match(event.baseReleaseHash, /^sha256:[0-9a-f]{64}$/);
      assert.match(event.projectScopeKey, /^sha256:[0-9a-f]{64}$/);
      assert.match(event.environmentKey, /^sha256:[0-9a-f]{64}$/);
    }
    if (process.platform !== "win32") {
      const agentlasDir = path.join(projectPath, ".agentlas");
      const outsideDir = path.join(canonicalTemp, "outside-ledger-target");
      fs.mkdirSync(outsideDir, { recursive: true });
      const outsideFile = path.join(outsideDir, "outside.txt");
      fs.writeFileSync(outsideFile, "outside-sentinel", "utf8");

      fs.rmSync(lineageFile, { force: true });
      fs.symlinkSync(outsideFile, lineageFile);
      assert.throws(
        () => relations.writeExperienceLineageLedger(pack.id),
        /target cannot be a symlink/,
        "a forged ledger symlink must not overwrite an outside file",
      );
      assert.equal(fs.readFileSync(outsideFile, "utf8"), "outside-sentinel");
      fs.rmSync(lineageFile, { force: true });

      fs.rmSync(agentlasDir, { recursive: true, force: true });
      fs.symlinkSync(outsideDir, agentlasDir, "dir");
      assert.throws(
        () => relations.writeExperienceLineageLedger(pack.id),
        /\.agentlas directory cannot be a symlink/,
        "a forged .agentlas directory must not receive the ledger",
      );
      assert.equal(fs.existsSync(path.join(outsideDir, "experience-relations.jsonl")), false);
      fs.rmSync(agentlasDir, { force: true });
      fs.mkdirSync(agentlasDir, { mode: 0o700 });

      const symlinkProject = path.join(canonicalTemp, "workspace-symlink");
      fs.symlinkSync(projectPath, symlinkProject, "dir");
      db.prepare("UPDATE experience_packs SET project_path = ? WHERE id = ?").run(symlinkProject, pack.id);
      assert.throws(
        () => relations.writeExperienceLineageLedger(pack.id),
        /real directory, not a symlink|canonical approved directory/,
        "a replaced project root must not become write authority",
      );
      db.prepare("UPDATE experience_packs SET project_path = ? WHERE id = ?").run(projectPath, pack.id);
      fs.rmSync(symlinkProject, { force: true });
      relations.writeExperienceLineageLedger(pack.id);
    }
    const derivedText = JSON.stringify({
      nodes: db.prepare("SELECT * FROM experience_relation_nodes").all(),
      edges: db.prepare("SELECT * FROM experience_relation_edges").all(),
      lineage: db.prepare("SELECT * FROM experience_lineage_events").all(),
    });
    assert.doesNotMatch(derivedText, /visible browser account|retry the publishing|\/Users\/example|private\.txt/i);

    const snapshot = () => ({
      fingerprint: relations.getExperienceRelationIndexStatus().indexedFingerprint,
      nodes: db.prepare("SELECT node_id, node_type, entity_ref, payload_json FROM experience_relation_nodes ORDER BY node_id").all(),
      edges: db.prepare("SELECT edge_id, from_node, to_node, edge_type, payload_json FROM experience_relation_edges ORDER BY edge_id").all(),
    });
    const before = snapshot();
    relations.rebuildExperienceRelationIndex();
    const after = snapshot();
    assert.deepEqual(after, before, "rebuild must be deterministic and idempotent apart from rebuild timestamps");

    db.prepare("UPDATE experience_candidates SET task_terms_json = ? WHERE id = ?")
      .run(JSON.stringify([browserTask, socialTask, codingTask]), second.candidate.id);
    status = relations.getExperienceRelationIndexStatus();
    assert.equal(status.stale, true, "canonical source changes must mark the derived index stale");
    relations.ensureExperienceRelationIndex();
    assert.equal(relations.getExperienceRelationIndexStatus().stale, false);
    assert.ok(db.prepare(
      "SELECT 1 FROM experience_relation_nodes WHERE node_type = 'TaskTag' AND normalized_value = ? AND pack_id = ?",
    ).get(codingTask, pack.id));

    const otherPack = experience.createExperiencePack({
      agentId: "agent-rel",
      name: "Other pack",
      projectPath,
      environment,
    });
    promote("Other pack uses the same workflow tags.", [browserTask, socialTask, researchTask], "high", otherPack);
    relations.ensureExperienceRelationIndex();
    const crossPackSimilar = db.prepare(
      `SELECT count(*) AS count
         FROM experience_relation_edges edge
         JOIN experience_relation_nodes src ON src.node_id = edge.from_node
         JOIN experience_relation_nodes dst ON dst.node_id = edge.to_node
        WHERE edge.edge_type = 'similar_to' AND src.pack_id != dst.pack_id`,
    ).get().count;
    assert.equal(crossPackSimilar, 0, "similarity edges must never cross Experience Packs");

    const wrongBaseScores = relations.rankExperienceCandidatesByRelations({
      projectScopeKey: scopeKey.project_scope_key,
      environmentKey: scopeKey.environment_key,
      basePackageHash: "b".repeat(64),
      taskTerms: [researchTask],
    });
    assert.equal(wrongBaseScores.size, 0, "relation retrieval must bind the exact base release");

    const lineageBeforeArchive = db.prepare("SELECT count(*) AS count FROM experience_lineage_events WHERE pack_id = ?").get(pack.id).count;
    db.prepare("UPDATE experience_packs SET status = 'archived', updated_at = ? WHERE id = ?").run(new Date().toISOString(), pack.id);
    relations.rebuildExperienceRelationIndex();
    assert.equal(db.prepare("SELECT count(*) AS count FROM experience_relation_nodes WHERE pack_id = ?").get(pack.id).count, 0);
    assert.equal(db.prepare("SELECT count(*) AS count FROM experience_lineage_events WHERE pack_id = ?").get(pack.id).count, lineageBeforeArchive);

    const updaterSource = fs.readFileSync(path.join(__dirname, "../electron/updater/controller.ts"), "utf8");
    assert.match(updaterSource, /"experience_lineage_events"/);
    assert.doesNotMatch(
      updaterSource.match(/CONTINUITY_CORE_TABLES\s*=\s*\[([\s\S]*?)\]\s*as const/)?.[1] ?? "",
      /experience_relation_(?:nodes|edges|index_state)/,
      "rebuildable relation tables must not masquerade as protected owned assets",
    );

    console.log(JSON.stringify({
      ok: true,
      schemaVersion: 65,
      nodes: status.nodeCount,
      edges: status.edgeCount,
      lineageEvents: lineageBeforeArchive,
      selectedItems: selected.selectedCandidateIds.length,
      selectedApproxTokens: selected.approximateTokens,
    }, null, 2));
  } finally {
    db.close();
    fs.rmSync(temp, { recursive: true, force: true });
    app.quit();
  }
}

main().catch((error) => {
  console.error(error);
  app.exit(1);
});
