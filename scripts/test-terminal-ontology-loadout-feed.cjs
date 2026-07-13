#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-terminal-loadout-feed-"));
process.env.AGENTLAS_STORE_PATH = path.join(root, "agentlas.sqlite");
process.env.AGENTLAS_E2E = "1";

const store = require("../dist/electron/store/db.js");
store.initStore();

const {
  TERMINAL_ONTOLOGY_LOADOUT_CONTRACT,
  TerminalOntologyLoadoutFeedWriter,
  installedAgentFingerprint,
  writeTerminalOntologyLoadoutFeed,
} = require("../dist/electron/ontology/terminal-loadout-feed.js");
const {
  estimateTasteRuntimeTokens,
  renderTasteRuntimeDirective,
} = require("../dist/electron/ontology/taste-runtime-contract.js");

const file = path.join(root, "terminal-bridge", "ontology-loadout-v2.json");
const now = new Date("2026-07-13T04:00:00.000Z");
const binding = {
  installedAgentId: "installed_agent_exact_1",
  agentDefinitionId: "def1",
  agentReleaseId: "rel1",
  source: "hub-install",
  boundAt: "2026-07-13T03:00:00.000Z",
};
const tasteOverlayDraft = {
  schemaVersion: 2,
  chipId: "tc1",
  releaseId: "tr1",
  sourceContentHash: `sha256:${"a".repeat(64)}`,
  baseAgentDefinitionId: binding.agentDefinitionId,
  baseAgentReleaseId: binding.agentReleaseId,
  taskSignatures: ["agentlas.task.v1/presentation"],
  rules: [{
    ruleId: "rule1",
    axis: "composition",
    polarity: "prefer",
    attribute: "structure",
    value: "single-dominant",
    strength: 2,
  }],
  budgetTokens: 240,
};
const tasteRuntimeOverlay = {
  ...tasteOverlayDraft,
  estimatedTokens: estimateTasteRuntimeTokens(renderTasteRuntimeDirective(tasteOverlayDraft)),
};
const projection = {
  schemaVersion: 1,
  agentDefinitionId: binding.agentDefinitionId,
  agentReleaseId: binding.agentReleaseId,
  state: "live",
  generatedAt: "2026-07-13T03:59:59.000Z",
  revision: `rev_${"1".repeat(32)}`,
  operationalChips: [{
    chipId: "chip_operational_1",
    releaseId: "experience_release_exact_1",
    kind: "operational",
    displayName: "PRIVATE DISPLAY MUST NOT CROSS",
    summary: "PRIVATE SUMMARY MUST NOT CROSS",
    version: "1.0.0",
    verification: "verified",
    labels: ["private-label"],
    evidenceLabel: "private evidence",
    evidenceCount: 3,
  }],
  tasteChips: [{
    chipId: "tc1",
    releaseId: "tr1",
    kind: "taste",
    displayName: "Taste",
    summary: "Taste summary",
    version: "1.0.0",
    verification: "verified",
    labels: [],
    evidenceLabel: "pairwise",
    evidenceCount: 5,
    runtimeOverlay: tasteRuntimeOverlay,
  }],
  loadout: {
    revision: `rev_${"2".repeat(32)}`,
    state: "ready",
    entries: [
      { chipId: "chip_operational_1", releaseId: "experience_release_exact_1", kind: "operational", state: "attached" },
      { chipId: "tc1", releaseId: "tr1", kind: "taste", state: "update-available", availableReleaseId: "taste_release_unapproved_2" },
    ],
  },
  scheduledNextSession: {
    revision: `rev_${"3".repeat(32)}`,
    state: "pending-next-session",
    entries: [{ chipId: "chip_operational_2", releaseId: "experience_release_future_2", kind: "operational", state: "scheduled-next-session" }],
  },
  recommendations: [],
  pendingAttachApprovals: [],
};

try {
  const receipt = writeTerminalOntologyLoadoutFeed({
    file,
    bindings: [binding],
    result: { supported: true, status: "live", projections: [projection] },
    now,
  });
  assert.equal(receipt.contract, TERMINAL_ONTOLOGY_LOADOUT_CONTRACT);
  assert.equal(receipt.schemaVersion, 2);
  assert.match(receipt.authorityInstanceId, /^lai_[a-f0-9]{48}$/);
  assert.equal(receipt.authoritySequence, 1);
  assert.match(receipt.receiptHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(receipt.status, "live");
  assert.equal(receipt.entries.length, 1);
  assert.equal(
    receipt.entries[0].installedAgentFingerprint,
    installedAgentFingerprint(binding.installedAgentId),
  );
  assert.deepEqual(receipt.entries[0].chips, [
    { chipId: "chip_operational_1", releaseId: "experience_release_exact_1", kind: "operational" },
    { chipId: "tc1", releaseId: "tr1", kind: "taste", runtimeOverlay: tasteRuntimeOverlay },
  ]);
  const raw = fs.readFileSync(file, "utf8");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.doesNotMatch(raw, /PRIVATE|summary|displayName|evidenceLabel|labels|availableReleaseId|future_2|scheduled|recommendation|approval|installed_agent_exact_1|preview|rater/i);
  assert.match(raw, /tr1/);
  assert.match(raw, /single-dominant/);

  const tasteSurvivesOperationalShortage = writeTerminalOntologyLoadoutFeed({
    file,
    bindings: [binding],
    result: {
      supported: true,
      status: "live",
      projections: [{
        ...projection,
        operationalChips: projection.operationalChips.map((chip) => ({ ...chip, verification: "unverified" })),
      }],
    },
    now,
  });
  assert.deepEqual(
    tasteSurvivesOperationalShortage.entries[0].chips.map((chip) => chip.kind),
    ["taste"],
    "an unavailable Operational chip canceled an independent verified Taste overlay",
  );
  assert.equal(tasteSurvivesOperationalShortage.authorityInstanceId, receipt.authorityInstanceId);
  assert.equal(tasteSurvivesOperationalShortage.authoritySequence, 2);

  // A known stale/offline result replaces, rather than preserves, the last
  // executable entry. Terminal can safely skip this receipt.
  fs.chmodSync(file, 0o644);
  const unavailable = writeTerminalOntologyLoadoutFeed({
    file,
    bindings: [binding],
    result: {
      supported: true,
      status: "stale",
      projections: [{ ...projection, state: "stale" }],
    },
    now: new Date(now.getTime() + 1_000),
  });
  assert.equal(unavailable.status, "unavailable");
  assert.deepEqual(unavailable.entries, []);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  // A projection for another immutable base release cannot be rebound by
  // slug/latest inference.
  const mismatched = writeTerminalOntologyLoadoutFeed({
    file,
    bindings: [binding],
    result: {
      supported: true,
      status: "live",
      projections: [{ ...projection, agentReleaseId: "agent_release_other_2" }],
    },
    now: new Date(now.getTime() + 2_000),
  });
  assert.equal(mismatched.status, "unavailable");
  assert.deepEqual(mismatched.entries, []);
  const offlineCannotCarryLiveCache = writeTerminalOntologyLoadoutFeed({
    file,
    bindings: [binding],
    result: { supported: true, status: "offline", projections: [projection] },
    now: new Date(now.getTime() + 3_000),
  });
  assert.equal(offlineCannotCarryLiveCache.status, "unavailable");
  assert.deepEqual(offlineCannotCarryLiveCache.entries, []);

  // A retired Desktop bridge generation invalidates the receipt and cannot
  // overwrite it later when an older Hub query finally resolves.
  const lifecycleFile = path.join(root, "terminal-bridge", "lifecycle.json");
  writeTerminalOntologyLoadoutFeed({
    file: lifecycleFile,
    bindings: [binding],
    result: { supported: true, status: "live", projections: [projection] },
    now,
  });
  const writer = new TerminalOntologyLoadoutFeedWriter(lifecycleFile);
  assert.equal(JSON.parse(fs.readFileSync(lifecycleFile, "utf8")).status, "unavailable");
  assert.equal(writer.write({
    bindings: [binding],
    result: { supported: true, status: "live", projections: [projection] },
    now,
  }).status, "live");
  writer.dispose();
  assert.equal(JSON.parse(fs.readFileSync(lifecycleFile, "utf8")).status, "unavailable");
  assert.equal(writer.write({
    bindings: [binding],
    result: { supported: true, status: "live", projections: [projection] },
    now,
  }), null);
  assert.equal(JSON.parse(fs.readFileSync(lifecycleFile, "utf8")).status, "unavailable");

  console.log("terminal ontology loadout feed: PASS (private atomic Operational + bounded Taste receipt, exact current loadout, stale/mismatch fail closed)");
} finally {
  try { store.getDb().close(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
  app.quit();
}
