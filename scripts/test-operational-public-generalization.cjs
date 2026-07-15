#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

process.env.AGENTLAS_E2E = "1";
const { app } = require("electron");

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-operational-generalization-"));
  app.setPath("userData", temp);
  await app.whenReady();
  const dbModule = require("../dist/electron/store/db.js");
  const memory = require("../dist/electron/memory/store.js");
  const experience = require("../dist/electron/experience/store.js");
  const generalization = require("../dist/electron/experience/operational-generalization.js");
  const portable = require("../dist/electron/experience/portable.js");
  const routes = require("../dist/electron/agents/routes.js");
  dbModule.initStore();
  const db = dbModule.getDb();

  try {
    assert.equal(db.pragma("user_version", { simple: true }), 65);
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'experience_public_projections'").get());

    const now = "2026-07-13T01:00:00.000Z";
    db.prepare(
      `INSERT INTO installed_agents (
         id, slug, name, name_en, tagline, tagline_en, system_prompt,
         mcp_servers_json, env_requirements_json, preferred_backend,
         trust_grade, installed_at, tone, builtin, visibility, entity_kind
       ) VALUES (?, ?, ?, ?, ?, ?, '', '[]', '[]', NULL, 'A', ?, 'blue', 0, 'visible', 'agent')`,
    ).run("agent-operational", "agent-operational", "Operational Agent", "Operational Agent", "Ops", "Ops", now);
    const basePackageHash = "a".repeat(64);
    const agentRoot = path.join(temp, "agent");
    const projectRoot = path.join(temp, "project");
    fs.mkdirSync(agentRoot, { recursive: true });
    fs.mkdirSync(projectRoot, { recursive: true });
    routes.setRoute({
      agentId: "agent-operational",
      path: agentRoot,
      runtime: "codex",
      labels: ["codex"],
      kind: "agent",
      importedAt: now,
      source: "local-import",
      packageHash: basePackageHash,
    });
    const pack = experience.createExperiencePack({
      agentId: "agent-operational",
      name: "Private operational source",
      projectPath: projectRoot,
      environment: { platform: process.platform, arch: process.arch, runtimeKind: "codex" },
    });
    const sourceText = "After a browser publishing run, check the visible result and retry once when the page state has not changed.";
    const entry = memory.insertMemoryEntry({
      scope: "agent_repo",
      kind: "procedure",
      content: sourceText,
      projectPath: projectRoot,
      agentId: "agent-operational",
      confidence: "high",
      sensitivity: "internal",
      requestContext: { triggerTerms: ["browser", "publish", "verify"] },
    });
    const candidate = experience.captureExperienceCandidate({ packId: pack.id, sourceMemoryId: entry.id });
    experience.promoteExperienceCandidate({
      candidateId: candidate.id,
      explicitConsent: true,
      verification: { status: "attested", method: "user-attested", evidenceRefs: [`ui:${candidate.id}`] },
      publicSafe: false,
    });
    const definitionId = `agd_${"c".repeat(48)}`;
    const releaseId = `agr_${"d".repeat(48)}`;
    db.prepare(
      `UPDATE experience_packs
          SET base_agent_definition_id = ?, base_agent_release_id = ?,
              base_package_hash_version = 'path-sha256-executable-v2'
        WHERE id = ?`,
    ).run(definitionId, releaseId, pack.id);

    const rawCandidate = db.prepare("SELECT public_safe FROM experience_candidates WHERE id = ?").get(candidate.id);
    const rawReceipt = db.prepare("SELECT public_safe FROM experience_promotion_receipts WHERE candidate_id = ?").get(candidate.id);
    assert.equal(rawCandidate.public_safe, 0, "raw candidate must stay private");
    assert.equal(rawReceipt.public_safe, 0, "raw attestation must stay private");
    const privateBundle = portable.materializePortableExperienceBundle(pack.id, "private");
    assert.equal(privateBundle.items[0].privacyScope, "private");
    assert.equal(privateBundle.items[0].instructions.join(""), sourceText);
    assert.throws(
      () => portable.materializePortableExperienceBundle(pack.id, "public"),
      /confirmed generalized public projection/,
      "public upload must fail without a separate confirmed projection",
    );

    const task = candidate.taskSignatures.find((value) => value === "agentlas.task.v1/browser-automation")
      || candidate.taskSignatures[0];
    assert.ok(task);
    const exactEnvironment = pack.environmentProfile.constraints;
    const unsafe = generalization.saveOperationalPublicProjection({
      packId: pack.id,
      sourceCandidateIds: [candidate.id],
      title: "Repeatable browser publication check",
      instructions: ["Open /Users/mason/Desktop/customer.csv and use it as the publication source."],
      taskSignatures: [task],
      environmentConstraints: exactEnvironment,
    });
    assert.ok(unsafe.privacyIssueCodes.includes("local-path-or-url"));
    await assert.rejects(
      async () => generalization.confirmOperationalPublicProjection({
        projectionId: unsafe.projectionId,
        proposalHash: unsafe.proposalHash,
        explicitConsent: true,
      }),
      /privacy\/generalization scan failed/,
    );

    const shortPrivateText = "Acme Bluebird customer pricing matrix";
    const shortEntry = memory.insertMemoryEntry({
      scope: "agent_repo",
      kind: "procedure",
      content: shortPrivateText,
      projectPath: projectRoot,
      agentId: "agent-operational",
      confidence: "high",
      sensitivity: "internal",
      requestContext: { triggerTerms: ["browser", "publish", "verify"] },
    });
    const shortCandidate = experience.captureExperienceCandidate({ packId: pack.id, sourceMemoryId: shortEntry.id });
    experience.promoteExperienceCandidate({
      candidateId: shortCandidate.id,
      explicitConsent: true,
      verification: { status: "attested", method: "user-attested", evidenceRefs: [`ui:${shortCandidate.id}`] },
      publicSafe: false,
    });
    const shortCopy = generalization.saveOperationalPublicProjection({
      packId: pack.id,
      sourceCandidateIds: [shortCandidate.id],
      title: "Portable pricing review",
      instructions: [`Review the ${shortPrivateText} before publishing.`],
      taskSignatures: [shortCandidate.taskSignatures[0]],
      environmentConstraints: exactEnvironment,
    });
    assert.ok(
      shortCopy.privacyIssueCodes.includes("source-copy-overlap"),
      "short private source phrases must not bypass copy detection",
    );

    const proposal = generalization.saveOperationalPublicProjection({
      packId: pack.id,
      sourceCandidateIds: [candidate.id],
      title: "Verify a completed browser publication",
      instructions: [
        "Inspect the rendered destination after the publish action completes.",
        "If the expected state is absent, refresh once and repeat only the final action.",
      ],
      taskSignatures: [task],
      environmentConstraints: exactEnvironment,
    });
    assert.deepEqual(proposal.privacyIssueCodes, []);
    assert.equal(proposal.status, "proposal");
    assert.equal(proposal.agentId, "agent-operational");
    assert.equal(proposal.basePackageHash, basePackageHash);
    assert.equal(proposal.baseAgentDefinitionId, definitionId);
    assert.equal(proposal.baseAgentReleaseId, releaseId);
    assert.equal(proposal.environmentKey, pack.environmentKey);
    assert.deepEqual(proposal.sourceBindings.map((binding) => binding.candidateId), [candidate.id]);
    assert.ok(proposal.sourceBindings.every((binding) => /^sha256:[0-9a-f]{64}$/.test(binding.sourceItemHash)));
    const storedProjection = JSON.stringify(db.prepare("SELECT * FROM experience_public_projections WHERE projection_id = ?").get(proposal.projectionId));
    assert.equal(storedProjection.includes(sourceText), false, "projection storage must not copy private source text");
    assert.equal(storedProjection.includes(projectRoot), false, "projection storage must not copy a local path");
    assert.equal(storedProjection.includes(entry.id), false, "projection storage must not copy a Memory id");
    assert.equal(storedProjection.includes(candidate.id), true, "projection storage must retain the exact source candidate id");

    const confirmed = generalization.confirmOperationalPublicProjection({
      projectionId: proposal.projectionId,
      proposalHash: proposal.proposalHash,
      explicitConsent: true,
    });
    assert.equal(confirmed.status, "confirmed");
    assert.match(confirmed.confirmationHash, /^[0-9a-f]{64}$/);
    assert.equal(
      generalization.confirmOperationalPublicProjection({
        projectionId: proposal.projectionId,
        proposalHash: proposal.proposalHash,
        explicitConsent: true,
      }).confirmationHash,
      confirmed.confirmationHash,
      "confirmation must be idempotent",
    );
    const replayedProposal = generalization.saveOperationalPublicProjection({
      packId: pack.id,
      sourceCandidateIds: [candidate.id],
      title: proposal.title,
      instructions: proposal.instructions,
      taskSignatures: proposal.taskSignatures,
      environmentConstraints: proposal.environmentConstraints,
    });
    assert.equal(replayedProposal.status, "confirmed", "an identical save replay must not invalidate confirmation");
    assert.equal(replayedProposal.confirmationHash, confirmed.confirmationHash);

    const publicBundle = portable.materializePortableExperienceBundle(pack.id, "public");
    const unlistedBundle = portable.materializePortableExperienceBundle(pack.id, "unlisted");
    for (const bundle of [publicBundle, unlistedBundle]) {
      assert.ok(bundle.items.every((item) => item.privacyScope === "public-safe" && item.status === "promoted"));
      assert.ok(bundle.items.every((item) => item.evidenceReceiptIds.length > 0));
      assert.ok(bundle.items.every((item) => bundle.sourceAttestations.some((receipt) => receipt.experienceItemId === item.experienceItemId)));
      assert.equal(JSON.stringify(bundle).includes(sourceText), false, "private source text must not enter public materialization");
      assert.equal(JSON.stringify(bundle).includes(entry.id), false, "Memory ids must not enter public materialization");
      assert.equal(JSON.stringify(bundle).includes(projectRoot), false, "local project paths must not enter public materialization");
      assert.deepEqual(bundle.pack.baseCompatibility, {
        agentDefinitionId: definitionId,
        compatibleBaseReleaseIds: [releaseId],
      });
      portable.validatePortableExperienceBundle(bundle);
    }

    const bundleFile = path.join(temp, "public-bundle.json");
    fs.writeFileSync(bundleFile, JSON.stringify(publicBundle), { mode: 0o600 });
    const webRoot = path.resolve(__dirname, "../../agentlas/AgentsAtlas/app");
    const webContract = spawnSync(
      path.join(webRoot, "node_modules/.bin/tsx"),
      ["--tsconfig", "tsconfig.json", "-e", "import fs from 'node:fs'; import { parsePublicExperienceBundle } from './src/lib/experience/portable-bundle'; const b=parsePublicExperienceBundle(JSON.parse(fs.readFileSync(process.env.BUNDLE_FILE!, 'utf8'))); if(!b.items.every(i=>i.privacyScope==='public-safe')) process.exit(9);"],
      { cwd: webRoot, env: { ...process.env, BUNDLE_FILE: bundleFile }, encoding: "utf8" },
    );
    assert.equal(webContract.status, 0, `Web public bundle contract rejected Desktop output: ${webContract.stderr || webContract.stdout}`);

    const changed = generalization.saveOperationalPublicProjection({
      packId: pack.id,
      sourceCandidateIds: [candidate.id],
      title: proposal.title,
      instructions: [...proposal.instructions, "Stop after recording the visible completion state."],
      taskSignatures: [task],
      environmentConstraints: exactEnvironment,
    });
    assert.equal(changed.status, "proposal", "proposal edits must invalidate confirmation");
    assert.equal(changed.confirmationHash, null);
    assert.throws(
      () => generalization.confirmOperationalPublicProjection({
        projectionId: changed.projectionId,
        proposalHash: confirmed.proposalHash,
        explicitConsent: true,
      }),
      /changed/,
    );
    const reconfirmed = generalization.confirmOperationalPublicProjection({
      projectionId: changed.projectionId,
      proposalHash: changed.proposalHash,
      explicitConsent: true,
    });
    assert.equal(reconfirmed.status, "confirmed");

    db.prepare("UPDATE experience_candidates SET updated_at = ? WHERE id = ?")
      .run("2026-07-13T02:00:00.000Z", candidate.id);
    const invalidated = generalization.listOperationalPublicProjections(pack.id)[0];
    assert.equal(invalidated.status, "proposal", "source mutation must invalidate confirmation");
    assert.equal(invalidated.confirmationHash, null);
    assert.ok(invalidated.privacyIssueCodes.includes("source-material-changed"));
    assert.throws(
      () => portable.materializePortableExperienceBundle(pack.id, "public"),
      /confirmed generalized public projection/,
    );

    assert.equal(db.prepare("SELECT public_safe FROM experience_candidates WHERE id = ?").get(candidate.id).public_safe, 0);
    assert.equal(db.prepare("SELECT public_safe FROM experience_promotion_receipts WHERE candidate_id = ?").get(candidate.id).public_safe, 0);
    console.log("Operational Experience public-safe generalization: PASS");
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
