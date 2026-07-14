#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-hub-ontology-projection-"));
process.env.AGENTLAS_STORE_PATH = path.join(temp, "agentlas.sqlite");
process.env.AGENTLAS_E2E = "1";

const now = "2026-07-13T08:00:00.000Z";
const exact = {
  agentDefinitionId: "agd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  agentReleaseId: "agr_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
};

function projection(binding = exact) {
  return {
    schemaVersion: 1,
    ...binding,
    state: "live",
    generatedAt: now,
    revision: `rev_${"1".repeat(32)}`,
    operationalChips: [{
      chipId: "chip-operational-safe",
      releaseId: "chip-operational-safe-r1",
      kind: "operational",
      displayName: "Safe recovery",
      summary: "A reusable recovery sequence backed by reproducible outcomes.",
      version: "1.0.0",
      verification: "verified",
      labels: ["recovery"],
      evidenceLabel: "Reproduced outcomes",
      evidenceCount: 8,
    }],
    tasteChips: [{
      chipId: "chip-taste-safe",
      releaseId: "chip-taste-safe-r1",
      kind: "taste",
      displayName: "Editorial restraint",
      summary: "Human pairwise preference evidence with disagreement retained.",
      version: "1.0.0",
      verification: "requested",
      labels: ["pairwise"],
      evidenceLabel: "Human A/B choices",
      evidenceCount: 12,
    }],
    loadout: {
      revision: `rev_${"2".repeat(32)}`,
      state: "ready",
      entries: [{
        chipId: "chip-operational-safe",
        releaseId: "chip-operational-safe-r1",
        kind: "operational",
        state: "attached",
      }],
      changedAt: now,
    },
    scheduledNextSession: {
      revision: `rev_${"3".repeat(32)}`,
      state: "pending-next-session",
      entries: [{
        chipId: "chip-taste-safe",
        releaseId: "chip-taste-safe-r1",
        kind: "taste",
        state: "scheduled-next-session",
      }],
      changedAt: now,
    },
    recommendations: [],
    pendingAttachApprovals: [],
  };
}

function pendingProjection(resolved = false, binding = exact) {
  const current = projection(binding);
  current.loadout = {
    revision: `rev_${"4".repeat(32)}`,
    state: "empty",
    entries: [],
  };
  current.recommendations = resolved ? [] : [{
    recommendationId: "recommendation-safe-recovery",
    source: "Hephaestus Network",
    summary: "Add a safe recovery sequence",
    reasons: ["Matches this agent's work"],
    tradeoffs: ["Starts with new conversations"],
    proposedChips: [{
      chipId: "chip-operational-safe",
      releaseId: "chip-operational-safe-r1",
      kind: "operational",
      state: "pending-approval",
    }],
    requiresApproval: true,
    createdAt: now,
    expiresAt: "2026-07-14T08:00:00.000Z",
  }];
  current.pendingAttachApprovals = resolved ? [] : [{
    approvalId: "approval-safe-recovery",
    recommendationId: "recommendation-safe-recovery",
    expectedLoadoutRevision: current.loadout.revision,
    selectedChips: [{
      chipId: "chip-operational-safe",
      releaseId: "chip-operational-safe-r1",
      kind: "operational",
      state: "pending-approval",
    }],
    createdAt: now,
    expiresAt: "2026-07-14T08:00:00.000Z",
  }];
  if (resolved) {
    current.scheduledNextSession = {
      revision: `rev_${"5".repeat(32)}`,
      state: "pending-next-session",
      entries: [{
        chipId: "chip-operational-safe",
        releaseId: "chip-operational-safe-r1",
        kind: "operational",
        state: "scheduled-next-session",
      }],
      changedAt: now,
    };
  } else {
    delete current.scheduledNextSession;
  }
  return current;
}

function assertRendererSafe(value) {
  const forbiddenKey = /(?:path|prompt|transcript|credential|cookie|secret|workspace|userId|mcpCommand|mcpArgs|mcpEnv)/i;
  const visit = (node) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") {
      if (typeof node === "string") {
        assert.doesNotMatch(node, /(?:\/Users\/|[A-Za-z]:\\|ghp_|sk-(?:proj-)?)/i);
      }
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      assert.doesNotMatch(key, forbiddenKey, `unsafe Renderer key: ${key}`);
      visit(child);
    }
  };
  visit(value);
}

(async () => {
  try {
    await app.whenReady();
    const store = require("../dist/electron/store/db.js");
    store.initStore();
    const db = store.getDb();
    const bindings = require("../dist/electron/ontology/hub-bindings.js");
    const { getAgentOntologyHubProjection, resolveAgentOntologyHubAttach } = require("../dist/electron/ontology/agent-hub-projection.js");
    const { getDefaultOntologyHubClient } = require("../dist/electron/mobile-bridge/ontology-hub-client.js");
    assert.strictEqual(
      getDefaultOntologyHubClient(temp),
      getDefaultOntologyHubClient(temp),
      "Mobile and My Agents must share one cache owner for the same userData root",
    );

    const insertAgent = db.prepare(
      `INSERT INTO installed_agents (
         id, slug, name, name_en, tagline, tagline_en, system_prompt,
         mcp_servers_json, env_requirements_json, preferred_backend,
         trust_grade, installed_at, tone, builtin, role, visibility, entity_kind
       ) VALUES (?, ?, ?, ?, '', '', '', '[]', '[]', NULL, 'A', ?, 'blue', 0, NULL, 'visible', 'agent')`,
    );
    insertAgent.run("agent-bound", "same-visible-slug", "Bound", "Bound", now);
    insertAgent.run("agent-unbound", "same-visible-slug-copy", "Unbound", "Unbound", now);
    bindings.replaceInstalledAgentHubBinding({
      installedAgentId: "agent-bound",
      ...exact,
      source: "hub-install",
      boundAt: now,
    });

    const calls = [];
    const client = {
      query: async (requested, force) => {
        calls.push({ requested: structuredClone(requested), force });
        return { supported: true, status: "live", projections: [projection()] };
      },
    };
    const before = db.prepare("SELECT COUNT(*) AS count FROM installed_agent_hub_bindings").get().count;
    const result = await getAgentOntologyHubProjection("agent-bound", { client, force: true });
    assert.deepEqual(calls, [{ requested: [exact], force: true }], "Main must query only the exact immutable binding");
    assert.equal(result.status, "live");
    assert.deepEqual(result.binding, exact);
    assert.equal(result.projection.operationalChips.length, 1);
    assert.equal(result.projection.tasteChips.length, 1);
    assert.equal(result.projection.scheduledNextSession.state, "pending-next-session");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM installed_agent_hub_bindings").get().count, before, "read projection must not mutate bindings");
    assertRendererSafe(result);

    const unbound = await getAgentOntologyHubProjection("agent-unbound", { client, force: true });
    assert.deepEqual(unbound, {
      schemaVersion: 1,
      status: "unbound",
      supported: false,
      binding: null,
      projection: null,
    });
    assert.equal(calls.length, 1, "an unbound agent must not be inferred from slug or query Hub");
    const unsafe = await getAgentOntologyHubProjection("../../agent-bound", { client, force: true });
    assert.equal(unsafe.status, "unbound");
    assert.equal(calls.length, 1, "an unsafe local id must not reach Hub");

    const mismatched = await getAgentOntologyHubProjection("agent-bound", {
      client: {
        query: async () => ({
          supported: true,
          status: "live",
          projections: [projection({
            agentDefinitionId: "agd_cccccccccccccccccccccccccccccccccccccccccccccccc",
            agentReleaseId: "agr_dddddddddddddddddddddddddddddddddddddddddddddddd",
          })],
        }),
      },
    });
    assert.equal(mismatched.status, "projection-missing");
    assert.equal(mismatched.projection, null, "another exact release must not be displayed");

    const raceClient = {
      query: async () => {
        bindings.replaceInstalledAgentHubBinding({
          installedAgentId: "agent-bound",
          agentDefinitionId: "agd_cccccccccccccccccccccccccccccccccccccccccccccccc",
          agentReleaseId: "agr_dddddddddddddddddddddddddddddddddddddddddddddddd",
          source: "hub-install",
          boundAt: "2026-07-13T08:01:00.000Z",
        });
        return { supported: true, status: "live", projections: [projection()] };
      },
    };
    const raced = await getAgentOntologyHubProjection("agent-bound", { client: raceClient });
    assert.equal(raced.status, "binding-changed");
    assert.equal(raced.binding, null);
    assert.equal(raced.projection, null, "an in-flight old-release result must be discarded");

    bindings.replaceInstalledAgentHubBinding({
      installedAgentId: "agent-bound",
      ...exact,
      source: "hub-install",
      boundAt: "2026-07-13T08:02:00.000Z",
    });
    let resolved = false;
    const resolveCalls = [];
    const attachmentClient = {
      query: async (requested, force) => {
        resolveCalls.push({ kind: "query", requested: structuredClone(requested), force });
        return { supported: true, status: "live", projections: [pendingProjection(resolved)] };
      },
      resolveAttach: async (input, idempotencyKey) => {
        resolveCalls.push({ kind: "resolve", input: structuredClone(input), idempotencyKey });
        resolved = true;
        return {
          schemaVersion: 1,
          approvalId: input.approvalId,
          outcome: "accepted",
          loadoutState: "applying",
          loadoutRevision: `rev_${"5".repeat(32)}`,
          acknowledgedAt: now,
          message: "Scheduled for the next session.",
        };
      },
    };
    const attached = await resolveAgentOntologyHubAttach(
      "agent-bound",
      "approval-safe-recovery",
      "approve",
      { client: attachmentClient },
    );
    assert.equal(attached.outcome, "accepted");
    assert.equal(attached.loadoutState, "applying");
    assert.equal(attached.projection.status, "live");
    assert.equal(attached.projection.projection.pendingAttachApprovals.length, 0);
    assert.equal(attached.projection.projection.scheduledNextSession.entries.length, 1);
    const resolveCall = resolveCalls.find((call) => call.kind === "resolve");
    assert.deepEqual(resolveCall.input, {
      schemaVersion: 1,
      approvalId: "approval-safe-recovery",
      recommendationId: "recommendation-safe-recovery",
      agentDefinitionId: exact.agentDefinitionId,
      agentReleaseId: exact.agentReleaseId,
      expectedProjectionRevision: `rev_${"1".repeat(32)}`,
      expectedLoadoutRevision: `rev_${"4".repeat(32)}`,
      decision: "approve",
      selectedChips: [{
        chipId: "chip-operational-safe",
        releaseId: "chip-operational-safe-r1",
        kind: "operational",
        state: "pending-approval",
      }],
    }, "Main must derive the exact release and revisions from the fresh Hub projection");
    assert.match(resolveCall.idempotencyKey, /^desktop-ontology-attach-[0-9a-f]{48}$/);
    assert.equal(resolveCalls.filter((call) => call.kind === "query").length, 2, "Desktop must refresh before and after the attachment decision");
    assertRendererSafe(attached);

    let denied = false;
    let deniedInput = null;
    const deniedResult = await resolveAgentOntologyHubAttach(
      "agent-bound",
      "approval-safe-recovery",
      "deny",
      {
        client: {
          query: async () => ({ supported: true, status: "live", projections: [denied ? projection() : pendingProjection(false)] }),
          resolveAttach: async (input) => {
            deniedInput = structuredClone(input);
            denied = true;
            return {
              schemaVersion: 1,
              approvalId: input.approvalId,
              outcome: "denied",
              loadoutState: "empty",
              acknowledgedAt: now,
              message: "No loadout mutation was applied.",
            };
          },
        },
      },
    );
    assert.equal(deniedResult.outcome, "denied");
    assert.equal(deniedInput.decision, "deny");
    assert.deepEqual(deniedInput.selectedChips, [], "denial must not send any selected release for attachment");

    let unauthorizedResolveCalled = false;
    await assert.rejects(
      () => resolveAgentOntologyHubAttach("agent-bound", "approval-not-issued", "approve", {
        client: {
          query: async () => ({ supported: true, status: "live", projections: [pendingProjection(false)] }),
          resolveAttach: async () => { unauthorizedResolveCalled = true; throw new Error("must not run"); },
        },
      }),
      /no longer pending/,
    );
    assert.equal(unauthorizedResolveCalled, false, "a renderer-invented approval must never reach Hub");

    db.close();
    console.log("Desktop My Agents exact Hub Ontology projection and attachment approval: PASS");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
    app.quit();
  }
})().catch((error) => {
  console.error(error);
  app.exit(1);
});
