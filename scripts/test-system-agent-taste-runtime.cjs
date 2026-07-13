#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-system-taste-runtime-"));
process.env.AGENTLAS_STORE_PATH = path.join(temp, "agentlas.sqlite");
process.env.AGENTLAS_E2E = "1";

const exactA = {
  agentDefinitionId: "agd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  agentReleaseId: "agr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};
const exactB = {
  agentDefinitionId: "agd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  agentReleaseId: "agr_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
};

(async () => {
  try {
    await app.whenReady();
    const store = require("../dist/electron/store/db.js");
    store.initStore();
    const db = store.getDb();
    const bindings = require("../dist/electron/ontology/hub-bindings.js");
    const contract = require("../dist/electron/ontology/taste-runtime-contract.js");
    const sessions = require("../dist/electron/ontology/taste-runtime-session.js");
    const runtimeContext = require("../dist/electron/ontology/runtime-context.js");
    const registry = require("../dist/electron/mcp/registry.js");

    const insertAgent = db.prepare(
      `INSERT INTO installed_agents (
         id, slug, name, name_en, tagline, tagline_en, system_prompt,
         mcp_servers_json, env_requirements_json, preferred_backend,
         trust_grade, installed_at, tone, builtin, role, visibility, entity_kind
       ) VALUES (?, ?, ?, ?, '', '', ?, '[]', '[]', NULL, 'A', ?, 'blue', 0, NULL, 'visible', 'agent')`,
    );
    const installedAt = "2026-07-13T09:00:00.000Z";
    insertAgent.run("agent-a", "agent-a", "Agent A", "Agent A", "Agent A instructions", installedAt);
    insertAgent.run("agent-b", "agent-b", "Agent B", "Agent B", "Agent B instructions", installedAt);
    insertAgent.run("agent-unbound", "agent-unbound", "Unbound", "Unbound", "Unbound instructions", installedAt);
    bindings.replaceInstalledAgentHubBinding({ installedAgentId: "agent-a", ...exactA, source: "hub-install", boundAt: installedAt });
    bindings.replaceInstalledAgentHubBinding({ installedAgentId: "agent-b", ...exactB, source: "hub-install", boundAt: installedAt });

    const overlay = (exact, label) => {
      const draft = {
        schemaVersion: 2,
        chipId: `chip_taste_${label}`,
        releaseId: `taste_release_${label}`,
        sourceContentHash: `sha256:${(label === "a" ? "a" : "b").repeat(64)}`,
        baseAgentDefinitionId: exact.agentDefinitionId,
        baseAgentReleaseId: exact.agentReleaseId,
        taskSignatures: ["agentlas.task.v1/presentation"],
        rules: [{
          ruleId: `rule_editorial_${label}`,
          axis: "composition",
          polarity: "prefer",
          attribute: "structure",
          value: label === "a" ? "single-dominant" : "modular",
          strength: 3,
        }],
        budgetTokens: 240,
      };
      return {
        ...draft,
        estimatedTokens: contract.estimateTasteRuntimeTokens(contract.renderTasteRuntimeDirective(draft)),
      };
    };
    const overlayA = overlay(exactA, "a");
    const overlayB = overlay(exactB, "b");
    const projection = (exact, taste, state = "live") => ({
      schemaVersion: 1,
      ...exact,
      state,
      generatedAt: installedAt,
      revision: `rev_${(taste.releaseId.includes("_a") ? "1" : "3").repeat(32)}`,
      operationalChips: [],
      tasteChips: [{
        chipId: taste.chipId,
        releaseId: taste.releaseId,
        kind: "taste",
        displayName: "Taste",
        summary: "Verified Taste",
        version: "1.0.0",
        verification: "verified",
        labels: ["Taste: composition"],
        evidenceLabel: "Human A/B",
        evidenceCount: 4,
        runtimeOverlay: taste,
      }],
      loadout: {
        revision: `rev_${(taste.releaseId.includes("_a") ? "2" : "4").repeat(32)}`,
        state: state === "live" ? "ready" : "revoked",
        entries: [{ chipId: taste.chipId, releaseId: taste.releaseId, kind: "taste", state: state === "live" ? "attached" : "revoked" }],
      },
      recommendations: [],
      pendingAttachApprovals: [],
    });

    let currentA = projection(exactA, overlayA);
    const calls = [];
    const client = {
      query: async (requested, force) => {
        calls.push({ requested: structuredClone(requested), force });
        const exact = requested[0];
        if (exact.agentDefinitionId === exactA.agentDefinitionId) return { supported: true, status: "live", projections: [currentA] };
        if (exact.agentDefinitionId === exactB.agentDefinitionId) return { supported: true, status: "live", projections: [projection(exactB, overlayB)] };
        return { supported: false, status: "endpoint-absent", projections: [] };
      },
    };
    const agentA = registry.getAgentById("agent-a");
    const agentB = registry.getAgentById("agent-b");
    const unbound = registry.getAgentById("agent-unbound");
    assert(agentA && agentB && unbound);
    sessions.clearDesktopTasteRuntimeSessionSnapshots();

    const childA = await runtimeContext.buildAgentRuntimeOntologyContext({
      runSessionId: "run-system-taste-1",
      installedAgent: agentA,
      runtimeKind: "codex",
      task: "presentation A",
      client,
      includeOperational: false,
    });
    const childB = await runtimeContext.buildAgentRuntimeOntologyContext({
      runSessionId: "run-system-taste-1",
      installedAgent: agentB,
      runtimeKind: "codex",
      task: "presentation B",
      client,
      includeOperational: false,
    });
    assert.equal(childA.tasteReleaseId, overlayA.releaseId);
    assert.equal(childB.tasteReleaseId, overlayB.releaseId);
    assert.match(childA.prompt, /single-dominant/);
    assert.doesNotMatch(childA.prompt, /modular|taste_release_b/);
    assert.match(childB.prompt, /modular/);
    assert.doesNotMatch(childB.prompt, /single-dominant|taste_release_a/);
    assert(childA.combinedApproxTokens <= 800 && childB.combinedApproxTokens <= 800);

    const taskMismatch = await runtimeContext.buildAgentRuntimeOntologyContext({
      runSessionId: "run-system-taste-1",
      installedAgent: agentA,
      runtimeKind: "codex",
      task: "legal contract review",
      client,
      includeOperational: false,
    });
    const ambiguousTask = await runtimeContext.buildAgentRuntimeOntologyContext({
      runSessionId: "run-system-taste-1",
      installedAgent: agentA,
      runtimeKind: "codex",
      task: "research a presentation",
      client,
      includeOperational: false,
    });
    assert.equal(taskMismatch.tasteReleaseId, null, "team child applied Taste to non-aesthetic task");
    assert.equal(ambiguousTask.tasteReleaseId, null, "team child applied Taste to ambiguous task");

    currentA = projection(exactA, overlayA, "revoked");
    const synthesisA = await runtimeContext.buildAgentRuntimeOntologyContext({
      runSessionId: "run-system-taste-1",
      installedAgent: agentA,
      runtimeKind: "codex",
      task: "presentation synthesis",
      client,
      includeOperational: false,
    });
    assert.equal(synthesisA.tasteReleaseId, overlayA.releaseId, "same run hot-swapped synthesis Taste");
    assert.doesNotMatch(synthesisA.prompt, /taste_release_b|modular/, "synthesis concatenated child Taste overlays");
    assert.equal(calls.filter((call) => call.requested[0].agentDefinitionId === exactA.agentDefinitionId).length, 1);

    const nextRun = await runtimeContext.buildAgentRuntimeOntologyContext({
      runSessionId: "run-system-taste-2",
      installedAgent: agentA,
      runtimeKind: "codex",
      task: "presentation next run",
      client,
      includeOperational: false,
    });
    assert.equal(nextRun.tasteReleaseId, null, "new run used revoked pinned Taste");
    const unboundContext = await runtimeContext.buildAgentRuntimeOntologyContext({
      runSessionId: "run-system-taste-1",
      installedAgent: unbound,
      runtimeKind: "codex",
      task: "unbound",
      client,
      includeOperational: false,
    });
    assert.equal(unboundContext.prompt, "");

    const sources = {
      firm: fs.readFileSync(path.join(__dirname, "../electron/mcp/firm-orchestrator.ts"), "utf8"),
      swarm: fs.readFileSync(path.join(__dirname, "../electron/mcp/swarm-run.ts"), "utf8"),
      borrowed: fs.readFileSync(path.join(__dirname, "../electron/mcp/borrowed-task-force.ts"), "utf8"),
      client: fs.readFileSync(path.join(__dirname, "../electron/mcp/client.ts"), "utf8"),
      groups: fs.readFileSync(path.join(__dirname, "../electron/store/agent-groups.ts"), "utf8"),
    };
    assert.match(sources.firm, /buildAgentRuntimeOntologyContext[\s\S]*node\.agentId/);
    assert((sources.swarm.match(/buildAgentRuntimeOntologyContext\(/g) || []).length >= 2, "Swarm child/synthesis Taste wiring missing");
    assert.match(sources.swarm, /installedAgent:\s*p\.orchestratorAgent/);
    assert.match(sources.borrowed, /spec\.source === "installed"[\s\S]*spec\.source === "firm-node"/);
    assert.match(sources.borrowed, /installedAgent:\s*p\.orchestratorAgent/);
    assert.match(sources.client, /installedAgentId:\s*member\.installedAgentId/);
    assert.match(sources.groups, /installedAgentId:\s*resolved\.agent\.id/);

    db.close();
    console.log("Desktop system-agent Taste runtime: PASS (Firm/Swarm/Borrowed/Agent Group exact child isolation, single synthesis overlay, run stability, 800-token cap)");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
    app.quit();
  }
})().catch((error) => {
  console.error(error);
  app.exit(1);
});
