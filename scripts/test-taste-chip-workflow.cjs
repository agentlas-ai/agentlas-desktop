#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-taste-workflow-"));
process.env.AGENTLAS_STORE_PATH = path.join(temp, "agentlas.sqlite");
process.env.AGENTLAS_FS_GRANT_STORE = path.join(temp, "fs-grants.json");
process.env.AGENTLAS_E2E = "1";

function png(seed) {
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from(seed)]);
}

async function main() {
  await app.whenReady();
  const store = require("../dist/electron/store/db.js");
  store.initStore();
  const db = store.getDb();
  const experience = require("../dist/electron/experience/store.js");
  const now = "2026-07-13T00:00:00.000Z";
  assert.equal(db.pragma("user_version", { simple: true }), 65);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='taste_chip_workflows'").get());
  const sourceMemoryContent = "Acme Bluebird uses visual code NX-47-CORAL; prefer the private design at /Users/mason/secret/client-a.";
  const environmentKey = "env:macos-arm64-codex";
  const basePackageHash = "a".repeat(64);
  db.prepare(
    `INSERT INTO installed_agents (
       id, slug, name, name_en, tagline, tagline_en, system_prompt,
       mcp_servers_json, env_requirements_json, preferred_backend,
       trust_grade, installed_at, tone, builtin, role, visibility, entity_kind
     ) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', '[]', NULL, 'A', ?, 'blue', 0, NULL, 'visible', 'agent')`,
  ).run("agent-taste", "agent-taste", "Taste", "Taste", "Taste", "Taste", "Safe", now);
  db.prepare(
    `INSERT INTO memory_entries (
       id, scope, kind, content, project_id, project_path, agent_id, chat_id,
       confidence, sensitivity, evidence_json, superseded_at, created_at
     ) VALUES (?, 'agent_repo', 'preference', ?, NULL, NULL, ?, NULL, 'high', 'internal', '[]', NULL, ?)`,
  ).run("memory-private-taste", sourceMemoryContent, "agent-taste", now);
  const sourceMemoryHash = experience.tasteDraftSourceMemoryHash({
    agentId: "agent-taste",
    memoryId: "memory-private-taste",
    memoryContent: sourceMemoryContent,
    basePackageHash,
    environmentKey,
  });
  db.prepare(
    `INSERT INTO taste_draft_candidates (
       id, agent_id, source_memory_id, source_memory_hash, project_scope_key,
       environment_key, base_package_hash, base_agent_definition_id,
       base_agent_release_id, sensitivity, confidence, axis_candidates_json,
       task_signatures_json, evidence_state, status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'internal', 'high', ?, ?, 'pairwise-required', 'observation', ?, ?)`,
  ).run(
    "taste-draft-1", "agent-taste", "memory-private-taste", sourceMemoryHash,
    "project:private-local-only", environmentKey, basePackageHash,
    "agd_exact_agent", "agr_exact_release", JSON.stringify(["composition", "density"]),
    JSON.stringify(["agentlas.task.v1/design"]), now, now,
  );

  const taste = require("../dist/electron/experience/taste-workflow.js");
  let networkCalls = 0;
  await assert.rejects(
    async () => taste.saveTasteGeneralization({
      draftId: "taste-draft-1", agentId: "agent-taste", title: "Client A style",
      summary: "Read /Users/mason/secret/client-a first", ruleStatement: "Prefer it",
      axis: "composition", taskSignature: "agentlas.task.v1/design", contexts: ["visual-design"],
    }),
    /not public-safe/,
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM taste_chip_workflows").get().n, 0, "unsafe generalization must not persist");
  await assert.rejects(
    async () => taste.saveTasteGeneralization({
      draftId: "taste-draft-1", agentId: "agent-taste", title: "Reusable visual preference",
      summary: "A portable visual preference.", ruleStatement: "Use NX-47-CORAL as the visual code.",
      axis: "composition", taskSignature: "agentlas.task.v1/design", contexts: ["visual-design"],
    }),
    /source-copy-overlap/,
    "a short unique code copied from the exact private Memory must be blocked",
  );
  await assert.rejects(
    async () => taste.saveTasteGeneralization({
      draftId: "taste-draft-1", agentId: "agent-taste", title: "Acme Bluebird visual preference",
      summary: "A portable visual preference.", ruleStatement: "Prefer a restrained composition.",
      axis: "composition", taskSignature: "agentlas.task.v1/design", contexts: ["visual-design"],
    }),
    /source-copy-overlap/,
    "a short customer label copied from the exact private Memory must be blocked",
  );

  const proposal = taste.saveTasteGeneralization({
    draftId: "taste-draft-1", agentId: "agent-taste", title: "Restrained editorial hierarchy",
    summary: "A portable preference for clear hierarchy and restrained visual density.",
    ruleStatement: "Prefer asymmetric composition with a clear reading order and restrained ornament.",
    axis: "composition", taskSignature: "agentlas.task.v1/design", contexts: ["visual-design", "editorial"],
  });
  assert.equal(proposal.agentId, "agent-taste");
  assert.equal(proposal.baseAgentDefinitionId, "agd_exact_agent");
  assert.equal(proposal.baseAgentReleaseId, "agr_exact_release");
  assert.equal(proposal.environmentKey, "env:macos-arm64-codex");
  assert.equal(proposal.status, "proposal");
  assert.equal(networkCalls, 0, "saving a proposal must never call Hub");
  const storedWorkflow = JSON.stringify(db.prepare("SELECT * FROM taste_chip_workflows WHERE workflow_id = ?").get(proposal.workflowId));
  assert.doesNotMatch(storedWorkflow, /Acme Bluebird|NX-47-CORAL|\/Users\/mason/, "workflow storage must contain no private Memory excerpt");

  const left = path.join(temp, "left.png");
  const right = path.join(temp, "right.png");
  fs.writeFileSync(left, png("left"));
  fs.writeFileSync(right, png("right"));
  const access = require("../dist/electron/fs/access.js");
  const leftGrant = access.grantPath(left, { durable: true, exactFile: true });
  const rightGrant = access.grantPath(right, { durable: true, exactFile: true });
  const generation = {
    canonicalTaskInputHash: `sha256:${"4".repeat(64)}`,
    generationCohortRef: "same-provider-model-config-seed-1",
    externalGenerationAttested: true,
  };
  await assert.rejects(
    async () => taste.prepareTastePreviews({ workflowId: proposal.workflowId, previews: [leftGrant, rightGrant], rightsStatus: "owner-authorized", rightsAttested: true, ...generation }),
    /Confirm/,
  );
  await assert.rejects(
    async () => taste.confirmTasteGeneralization({ workflowId: proposal.workflowId, generalizationHash: "sha256:" + "0".repeat(64), explicitConsent: true }),
    /changed/,
  );
  let confirmed = taste.confirmTasteGeneralization({ workflowId: proposal.workflowId, generalizationHash: proposal.generalizationHash, explicitConsent: true });
  assert.equal(confirmed.status, "confirmed");
  await assert.rejects(
    async () => taste.prepareTastePreviews({ workflowId: proposal.workflowId, previews: [leftGrant, rightGrant], rightsStatus: "owner-authorized", rightsAttested: false, ...generation }),
    /rights attestation/,
  );
  assert.equal(taste.listTasteChipWorkflows("agent-taste")[0].previewNames, null, "file selection alone cannot attest preview rights");
  await assert.rejects(
    async () => taste.prepareTastePreviews({ workflowId: proposal.workflowId, previews: [leftGrant, leftGrant], rightsStatus: "owner-authorized", rightsAttested: true, ...generation }),
    /different images/,
  );
  let prepared = taste.prepareTastePreviews({ workflowId: proposal.workflowId, previews: [leftGrant, rightGrant], rightsStatus: "owner-authorized", rightsAttested: true, ...generation });
  assert.deepEqual(prepared.previewNames, ["left.png", "right.png"]);
  assert.deepEqual(prepared.previewTreatments.map((entry) => entry.role), ["chip-on", "control"]);
  assert.equal(prepared.previewTreatments[1].noTasteOverlay, true);
  assert.equal(networkCalls, 0, "review, confirmation, and preview preparation are local-only");

  const changed = taste.saveTasteGeneralization({
    draftId: "taste-draft-1", agentId: "agent-taste", title: "Restrained editorial hierarchy",
    summary: "A portable preference for calm hierarchy and deliberate negative space.",
    ruleStatement: "Prefer deliberate negative space with a clear reading order.",
    axis: "density", taskSignature: "agentlas.task.v1/design", contexts: ["visual-design", "editorial"],
  });
  assert.equal(changed.confirmedAt, null, "changed generalized content must require confirmation again");
  assert.equal(changed.previewNames, null, "changed generalized content must clear stale A/B previews");
  confirmed = taste.confirmTasteGeneralization({ workflowId: changed.workflowId, generalizationHash: changed.generalizationHash, explicitConsent: true });
  prepared = taste.prepareTastePreviews({ workflowId: changed.workflowId, previews: [leftGrant, rightGrant], rightsStatus: "owner-authorized", rightsAttested: true, ...generation });
  await assert.rejects(
    async () => taste.uploadTasteDraft({ workflowId: changed.workflowId, generalizationHash: changed.generalizationHash, explicitUpload: false }),
    /Explicit/,
  );
  assert.equal(networkCalls, 0, "there is no automatic network path");

  const remoteAssets = [];
  let remoteRelease = null;
  const fetchMock = async (url, init = {}) => {
    networkCalls += 1;
    const pathname = new URL(url).pathname;
    if (pathname === "/api/ontology/v1/taste-style-releases" && !init.method) {
      return Response.json({ releases: remoteRelease ? [{ release: remoteRelease.release, revision: remoteRelease.revision }] : [] });
    }
    if (pathname === "/api/ontology/v1/taste-style-releases" && init.method === "POST") {
      const body = JSON.parse(init.body);
      const serialized = JSON.stringify(body);
      assert.equal(body.precondition.kind, "create");
      assert.equal(body.release.baseCompatibility.agentDefinitionId, "agd_exact_agent");
      assert.deepEqual(body.release.baseCompatibility.compatibleBaseReleaseIds, ["agr_exact_release"]);
      assert.doesNotMatch(serialized, /\/Users\/|private design|client-a|project:private|env:macos/);
      assert.deepEqual(body.release.previewAssetRefs, []);
      remoteRelease = { release: body.release, revision: `rev_${"1".repeat(32)}` };
      return Response.json({ state: "created", record: remoteRelease }, { status: 201 });
    }
    if (pathname === "/api/ontology/v1/taste-preview-assets" && init.method === "POST") {
      const assetId = `tap_${String(remoteAssets.length + 1).repeat(48)}`;
      remoteAssets.push({ assetId, moderationState: "pending", storageState: "active" });
      return Response.json({ state: "created", asset: remoteAssets.at(-1) }, { status: 201 });
    }
    if (pathname === "/api/ontology/v1/taste-preview-assets" && !init.method) {
      return Response.json({ assets: remoteAssets });
    }
    if (pathname.endsWith("/preview-selection") && init.method === "PUT") {
      const body = JSON.parse(init.body);
      assert.equal(body.comparisons.length, 2, "Hub A/B selection must contain exactly two treatments");
      assert.deepEqual(body.comparisons.map((entry) => entry.role), ["chip-on", "control"]);
      assert.equal(body.comparisons[0].canonicalTaskInputHash, body.comparisons[1].canonicalTaskInputHash);
      assert.equal(body.comparisons[0].generationCohortHash, body.comparisons[1].generationCohortHash);
      remoteRelease = {
        release: {
          ...remoteRelease.release,
          previewAssetRefs: body.comparisons.map((entry) => ({ assetId: entry.assetId, treatment: entry })),
          contentHash: `sha256:${"9".repeat(64)}`,
        },
        revision: `rev_${"2".repeat(32)}`,
      };
      return Response.json({ state: "updated", record: remoteRelease });
    }
    throw new Error(`unexpected request: ${init.method || "GET"} ${pathname}`);
  };
  const deps = {
    fetch: fetchMock,
    baseUrl: "http://127.0.0.1:3999",
    cookieHeader: "agentlas_session=testing-cookie-value",
    actor: { workspaceId: "workspace-test", userId: "user-test" },
  };
  const uploaded = await taste.uploadTasteDraft({ workflowId: prepared.workflowId, generalizationHash: prepared.generalizationHash, explicitUpload: true }, deps);
  assert.equal(uploaded.status, "moderation-pending");
  assert.equal(uploaded.remotePreviewAssetIds.length, 2);
  assert.equal(networkCalls, 5);
  const replayed = await taste.uploadTasteDraft({ workflowId: prepared.workflowId, generalizationHash: prepared.generalizationHash, explicitUpload: true }, deps);
  assert.equal(replayed.status, "moderation-pending");
  assert.deepEqual(replayed.remotePreviewAssetIds, uploaded.remotePreviewAssetIds);
  assert.equal(networkCalls, 7, "retry must reuse the release and two uploaded assets");
  assert.equal(remoteAssets.length, 2, "retry must not duplicate previews");
  remoteAssets.forEach((asset) => { asset.moderationState = "passed"; });
  const ready = await taste.uploadTasteDraft({ workflowId: prepared.workflowId, generalizationHash: prepared.generalizationHash, explicitUpload: true }, deps);
  assert.equal(ready.status, "ab-ready", "two distinct passed assets must be selected for blinded A/B");
  assert.equal(networkCalls, 11);
  const readyReplay = await taste.uploadTasteDraft({ workflowId: prepared.workflowId, generalizationHash: prepared.generalizationHash, explicitUpload: true }, deps);
  assert.equal(readyReplay.status, "ab-ready");
  assert.equal(networkCalls, 14, "A/B-ready replay must not upload assets or mutate the selection again");
  db.prepare("UPDATE memory_entries SET content = ? WHERE id = ?")
    .run("A replacement private preference captured after the original observation.", "memory-private-taste");
  const invalidated = taste.listTasteChipWorkflows("agent-taste")[0];
  assert.equal(invalidated.status, "proposal", "private source Memory mutation must invalidate confirmation");
  assert.equal(invalidated.confirmedAt, null);
  assert.equal(invalidated.previewNames, null, "source mutation must clear stale A/B previews");
  assert.ok(invalidated.privacyIssueCodes.includes("source-material-changed"));
  await assert.rejects(
    async () => taste.uploadTasteDraft({
      workflowId: readyReplay.workflowId,
      generalizationHash: readyReplay.generalizationHash,
      explicitUpload: true,
    }, deps),
    /changed|blocked/,
    "mutated private Memory must be rejected before another Hub request",
  );
  assert.equal(networkCalls, 14, "source mutation rejection must happen before network access");
  assert.ok(!db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND sql LIKE '%raw_memory%'").get());
  assert.equal(taste.listTasteChipWorkflows("agent-taste").length, 1);
  console.log("Taste chip local generalization, privacy, confirm, A/B, explicit Hub and idempotency gates: PASS");
  db.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(temp, { recursive: true, force: true });
  app.quit();
});
