#!/usr/bin/env node

const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function argument(name) {
  const prefix = `${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : null;
}

async function openStore() {
  const { app } = require("electron");
  const userData = argument("--user-data");
  if (!userData) throw new Error("worker requires --user-data");
  app.setPath("userData", userData);
  await app.whenReady();
  const dbStore = require("../dist/electron/store/db.js");
  dbStore.initStore();
  return { app, db: dbStore.getDb() };
}

function insertTask(db, id, status = "completed", offsetMs = 0) {
  const now = new Date(Date.now() + offsetMs).toISOString();
  db.prepare(
    `INSERT INTO tasks
       (id, title, project_id, firm_id, status, created_at, updated_at, archived_at, origin_chat_id)
     VALUES (?, ?, NULL, NULL, ?, ?, ?, NULL, NULL)`,
  ).run(id, `Improvement Proof ${id}`, status, now, now);
  return Date.parse(now);
}

function commonEvidence(kind, suffix, taskKind) {
  return {
    evidenceRef: `evidence:${suffix}`,
    receiptRef: `receipt:${suffix}`,
    kind,
    taskKind,
    observedAt: new Date().toISOString(),
    sourceRef: `source:${suffix}`,
  };
}

function taskEvidence(kind, suffix, taskKind, taskId, taskVersion, verificationRef) {
  return {
    ...commonEvidence(kind, suffix, taskKind),
    source: kind === "output_verification" ? "artifact_verifier" : "outcome_verifier",
    taskId,
    taskVersion,
    verificationRef,
  };
}

function assetSource(assetKind) {
  return {
    memory: "memory_runtime",
    agent: "agent_runtime",
    team: "team_runtime",
    automation: "automation_runtime",
  }[assetKind];
}

function controlRefs(suffix) {
  return ["edit", "use_once", "disable", "delete"].map((control) => ({
    control,
    controlRef: `control:${suffix}:${control}`,
  }));
}

function numericInput(options) {
  const {
    storeVersion,
    suffix,
    baselineTaskId,
    baselineTaskVersion,
    currentTaskId,
    currentTaskVersion,
    evidenceType = "measured",
    result = "improved",
    baselineValue = 5,
    currentValue = 2,
    direction = "lower_is_better",
    assetKind = "memory",
    assetVersion = 3,
    attributionStatus = "established",
  } = options;
  const taskKind = "product_comparison";
  const assetId = `asset:${suffix}`;
  const comparisonRef = `comparison:${suffix}`;
  const changeRef = `change:${suffix}`;
  const baselineOutputRef = `verification:${suffix}:baseline-output`;
  const baselineOutcomeRef = `verification:${suffix}:baseline-outcome`;
  const currentOutputRef = `verification:${suffix}:current-output`;
  const currentOutcomeRef = `verification:${suffix}:current-outcome`;
  const method = "Count the same observable interaction from Task start through verified outcome.";
  const basis = "Both samples use the same Task kind, unit, method, and completion boundary.";
  const bindingControls = controlRefs(suffix);
  const assetReuse = {
    ...commonEvidence("asset_reuse", `${suffix}:asset-reuse`, taskKind),
    source: assetSource(assetKind),
    taskId: currentTaskId,
    taskVersion: currentTaskVersion,
    sourceTaskId: baselineTaskId,
    sourceTaskVersion: baselineTaskVersion,
    assetId,
    assetVersion,
    assetKind,
    sourceControlRef: `control:${suffix}:source`,
    controlRefs: bindingControls,
    rollbackRef: `rollback:${suffix}`,
    removeRef: `remove:${suffix}`,
  };
  const baselineMeasurement = {
    ...commonEvidence("measurement", `${suffix}:measurement-baseline`, taskKind),
    source: "measurement_engine",
    baselineTaskId,
    baselineTaskVersion,
    currentTaskId,
    currentTaskVersion,
    comparisonRef,
    role: "baseline",
    valueType: evidenceType === "measured" ? "fact" : "estimate",
    value: baselineValue,
    unit: "question_count",
    method,
    sampleSize: 1,
    comparable: true,
    comparabilityBasis: basis,
    comparisonDirection: direction,
  };
  const currentMeasurement = {
    ...commonEvidence("measurement", `${suffix}:measurement-current`, taskKind),
    source: "measurement_engine",
    baselineTaskId,
    baselineTaskVersion,
    currentTaskId,
    currentTaskVersion,
    comparisonRef,
    role: "current",
    valueType: evidenceType === "measured" ? "fact" : "estimate",
    value: currentValue,
    unit: "question_count",
    method,
    sampleSize: 1,
    comparable: true,
    comparabilityBasis: basis,
    comparisonDirection: direction,
  };
  const comparisonEvidence = {
    ...commonEvidence("comparison_verification", `${suffix}:comparison`, taskKind),
    source: "comparison_verifier",
    baselineTaskId,
    baselineTaskVersion,
    currentTaskId,
    currentTaskVersion,
    comparisonRef,
    evidenceType,
    result,
    baselineOutputVerificationRef: baselineOutputRef,
    baselineOutcomeVerificationRef: baselineOutcomeRef,
    currentOutputVerificationRef: currentOutputRef,
    currentOutcomeVerificationRef: currentOutcomeRef,
    reusedAssetVersions: [{ assetId, assetVersion }],
  };
  const trustedHostEvidence = [
    taskEvidence("output_verification", `${suffix}:baseline-output`, taskKind, baselineTaskId, baselineTaskVersion, baselineOutputRef),
    taskEvidence("outcome_verification", `${suffix}:baseline-outcome`, taskKind, baselineTaskId, baselineTaskVersion, baselineOutcomeRef),
    taskEvidence("output_verification", `${suffix}:current-output`, taskKind, currentTaskId, currentTaskVersion, currentOutputRef),
    taskEvidence("outcome_verification", `${suffix}:current-outcome`, taskKind, currentTaskId, currentTaskVersion, currentOutcomeRef),
    assetReuse,
    baselineMeasurement,
    currentMeasurement,
    comparisonEvidence,
  ];
  const changeEvidenceRefs = [baselineMeasurement.evidenceRef, currentMeasurement.evidenceRef, comparisonEvidence.evidenceRef];
  const change = evidenceType === "measured"
    ? {
        changeRef,
        kind: "instruction_reduction",
        evidenceType: "measured",
        statement: result === "improved"
          ? "Verified questions decreased on the same comparison basis."
          : result === "no_change"
            ? "Verified questions did not change on the same comparison basis."
            : "Verified questions increased on the same comparison basis.",
        baseline: baselineValue,
        current: currentValue,
        unit: "question_count",
        comparisonDirection: direction,
        evidenceRefs: changeEvidenceRefs,
      }
    : {
        changeRef,
        kind: "time_reduction",
        evidenceType: "estimate",
        statement: result === "improved"
          ? "Estimated questions decreased on a comparable basis."
          : result === "no_change"
            ? "Estimated questions remained unchanged on a comparable basis."
            : "Estimated questions increased on a comparable basis.",
        estimate: {
          value: Math.abs(currentValue - baselineValue),
          unit: "question_count",
          basis,
          method,
          evidenceRefs: changeEvidenceRefs,
        },
      };
  return {
    expectedStoreVersion: storeVersion,
    trustedHostAttested: true,
    currentTaskId,
    currentTaskVersion,
    taskKind,
    attributionStatus,
    reusedAssets: [{
      assetRef: assetId,
      assetType: assetKind,
      label: `${assetKind} reused for ${suffix}`,
      sourceTaskRef: baselineTaskId,
      receiptRefs: [assetReuse.receiptRef],
      controls: bindingControls.map((item) => item.control),
    }],
    changes: [change],
    assetBindings: [{
      assetId,
      assetVersion,
      assetKind,
      sourceTaskId: baselineTaskId,
      sourceTaskVersion: baselineTaskVersion,
      currentTaskId,
      currentTaskVersion,
      taskKind,
      reuseEvidenceRef: assetReuse.evidenceRef,
      reuseReceiptRef: assetReuse.receiptRef,
      sourceControlRef: assetReuse.sourceControlRef,
      controlRefs: bindingControls,
      rollbackRef: assetReuse.rollbackRef,
      removeRef: assetReuse.removeRef,
    }],
    comparisons: [{
      comparisonRef,
      changeRef,
      taskKind,
      baselineTaskId,
      baselineTaskVersion,
      currentTaskId,
      currentTaskVersion,
      evidenceType,
      result,
      baselineOutputVerificationRef: baselineOutputRef,
      baselineOutcomeVerificationRef: baselineOutcomeRef,
      currentOutputVerificationRef: currentOutputRef,
      currentOutcomeVerificationRef: currentOutcomeRef,
      reusedAssetVersions: [{ assetId, assetVersion }],
      comparisonEvidenceRef: comparisonEvidence.evidenceRef,
      measurementEvidenceRefs: [baselineMeasurement.evidenceRef, currentMeasurement.evidenceRef],
      evidenceRefs: changeEvidenceRefs,
      receiptRefs: changeEvidenceRefs.map((ref) => trustedHostEvidence.find((item) => item.evidenceRef === ref).receiptRef),
    }],
    receiptRefs: trustedHostEvidence.map((item) => item.receiptRef),
    trustedHostEvidence,
  };
}

function qualitativeInput(options) {
  const {
    storeVersion,
    suffix,
    baselineTaskId,
    baselineTaskVersion,
    currentTaskId,
    currentTaskVersion,
    attributionStatus = "established",
  } = options;
  const taskKind = "product_comparison";
  const assetKind = "team";
  const assetId = `asset:${suffix}`;
  const assetVersion = 7;
  const comparisonRef = `comparison:${suffix}`;
  const changeRef = `change:${suffix}`;
  const baselineOutputRef = `verification:${suffix}:baseline-output`;
  const baselineOutcomeRef = `verification:${suffix}:baseline-outcome`;
  const currentOutputRef = `verification:${suffix}:current-output`;
  const currentOutcomeRef = `verification:${suffix}:current-outcome`;
  const bindingControls = controlRefs(suffix);
  const assetReuse = {
    ...commonEvidence("asset_reuse", `${suffix}:asset-reuse`, taskKind),
    source: "team_runtime",
    taskId: currentTaskId,
    taskVersion: currentTaskVersion,
    sourceTaskId: baselineTaskId,
    sourceTaskVersion: baselineTaskVersion,
    assetId,
    assetVersion,
    assetKind,
    sourceControlRef: `control:${suffix}:source`,
    controlRefs: bindingControls,
    rollbackRef: `rollback:${suffix}`,
    removeRef: `remove:${suffix}`,
  };
  const rubricRef = `rubric:${suffix}`;
  const criterionRefs = [`criterion:${suffix}:coverage`, `criterion:${suffix}:accuracy`];
  const baselineRubric = {
    ...commonEvidence("rubric_assessment", `${suffix}:rubric-baseline`, taskKind),
    source: "rubric_evaluator",
    taskId: baselineTaskId,
    taskVersion: baselineTaskVersion,
    comparisonRef,
    role: "baseline",
    rubricRef,
    criterionRefs,
    assessmentRef: `assessment:${suffix}:baseline`,
    ordinalRank: 3,
    comparisonDirection: "higher_is_better",
  };
  const currentRubric = {
    ...commonEvidence("rubric_assessment", `${suffix}:rubric-current`, taskKind),
    source: "rubric_evaluator",
    taskId: currentTaskId,
    taskVersion: currentTaskVersion,
    comparisonRef,
    role: "current",
    rubricRef,
    criterionRefs,
    assessmentRef: `assessment:${suffix}:current`,
    ordinalRank: 1,
    comparisonDirection: "higher_is_better",
  };
  const comparisonEvidence = {
    ...commonEvidence("comparison_verification", `${suffix}:comparison`, taskKind),
    source: "comparison_verifier",
    baselineTaskId,
    baselineTaskVersion,
    currentTaskId,
    currentTaskVersion,
    comparisonRef,
    evidenceType: "qualitative",
    result: "regression",
    baselineOutputVerificationRef: baselineOutputRef,
    baselineOutcomeVerificationRef: baselineOutcomeRef,
    currentOutputVerificationRef: currentOutputRef,
    currentOutcomeVerificationRef: currentOutcomeRef,
    reusedAssetVersions: [{ assetId, assetVersion }],
  };
  const trustedHostEvidence = [
    taskEvidence("output_verification", `${suffix}:baseline-output`, taskKind, baselineTaskId, baselineTaskVersion, baselineOutputRef),
    taskEvidence("outcome_verification", `${suffix}:baseline-outcome`, taskKind, baselineTaskId, baselineTaskVersion, baselineOutcomeRef),
    taskEvidence("output_verification", `${suffix}:current-output`, taskKind, currentTaskId, currentTaskVersion, currentOutputRef),
    taskEvidence("outcome_verification", `${suffix}:current-outcome`, taskKind, currentTaskId, currentTaskVersion, currentOutcomeRef),
    assetReuse,
    baselineRubric,
    currentRubric,
    comparisonEvidence,
  ];
  const evidenceRefs = [baselineRubric.evidenceRef, currentRubric.evidenceRef, comparisonEvidence.evidenceRef];
  return {
    expectedStoreVersion: storeVersion,
    trustedHostAttested: true,
    currentTaskId,
    currentTaskVersion,
    taskKind,
    attributionStatus,
    reusedAssets: [{
      assetRef: assetId,
      assetType: assetKind,
      label: "Previously retained comparison team",
      sourceTaskRef: baselineTaskId,
      receiptRefs: [assetReuse.receiptRef],
      controls: bindingControls.map((item) => item.control),
    }],
    changes: [{
      changeRef,
      kind: "quality_improvement",
      evidenceType: "qualitative",
      statement: "The same explicit rubric found a regression in coverage and accuracy.",
      baselineRefs: [baselineRubric.assessmentRef],
      currentRefs: [currentRubric.assessmentRef],
      evidenceRefs,
    }],
    assetBindings: [{
      assetId,
      assetVersion,
      assetKind,
      sourceTaskId: baselineTaskId,
      sourceTaskVersion: baselineTaskVersion,
      currentTaskId,
      currentTaskVersion,
      taskKind,
      reuseEvidenceRef: assetReuse.evidenceRef,
      reuseReceiptRef: assetReuse.receiptRef,
      sourceControlRef: assetReuse.sourceControlRef,
      controlRefs: bindingControls,
      rollbackRef: assetReuse.rollbackRef,
      removeRef: assetReuse.removeRef,
    }],
    comparisons: [{
      comparisonRef,
      changeRef,
      taskKind,
      baselineTaskId,
      baselineTaskVersion,
      currentTaskId,
      currentTaskVersion,
      evidenceType: "qualitative",
      result: "regression",
      baselineOutputVerificationRef: baselineOutputRef,
      baselineOutcomeVerificationRef: baselineOutcomeRef,
      currentOutputVerificationRef: currentOutputRef,
      currentOutcomeVerificationRef: currentOutcomeRef,
      reusedAssetVersions: [{ assetId, assetVersion }],
      comparisonEvidenceRef: comparisonEvidence.evidenceRef,
      rubricEvidenceRefs: [baselineRubric.evidenceRef, currentRubric.evidenceRef],
      evidenceRefs,
      receiptRefs: evidenceRefs.map((ref) => trustedHostEvidence.find((item) => item.evidenceRef === ref).receiptRef),
    }],
    receiptRefs: trustedHostEvidence.map((item) => item.receiptRef),
    trustedHostEvidence,
  };
}

function entries(event) {
  return Object.fromEntries(event.payload.entries.map((item) => [item.name, item.value]));
}

async function seedWorker() {
  const { app, db } = await openStore();
  const storePath = process.env.AGENTLAS_STORE_PATH;
  assert.ok(storePath && fs.existsSync(storePath));
  if (process.platform !== "win32") assert.equal(fs.statSync(storePath).mode & 0o077, 0, "SQLite store must remain mode 0600");

  const runtime = require("../dist/electron/one/improvement-proof.js");
  const contract = require("../dist/shared/one-improvement-proof.js");
  const domainEvents = require("../dist/electron/one/domain-events.js");
  const beforeUserVersion = db.pragma("user_version", { simple: true });
  const initial = runtime.getOneImprovementProofState();
  assert.equal(db.pragma("user_version", { simple: true }), beforeUserVersion, "Improvement Proof must not add a migration");
  assert.deepEqual(initial.proofs, []);

  const validFixture = JSON.parse(fs.readFileSync(path.join(__dirname, "../../Agentlas_One/contracts/fixtures/valid/improvement-proof-verified.json"), "utf8"));
  const invalidFixture = JSON.parse(fs.readFileSync(path.join(__dirname, "../../Agentlas_One/contracts/fixtures/invalid/improvement-proof-engagement-score.json"), "utf8"));
  assert.equal(contract.isOneImprovementProofV1(validFixture), true, "published valid fixture must parse");
  assert.equal(contract.parseOneImprovementProofJson(JSON.stringify(validFixture))?.taskId, validFixture.taskId);
  assert.equal(contract.isOneImprovementProofV1(invalidFixture), false, "engagement scoring must fail closed");
  assert.equal(contract.isOneImprovementProofV1({ ...validFixture, privatePayload: "forbidden" }), false, "unknown fields must fail closed");
  const fixtureWithoutAttribution = { ...validFixture };
  delete fixtureWithoutAttribution.attributionStatus;
  assert.equal(contract.isOneImprovementProofV1(fixtureWithoutAttribution), false, "attribution status must be explicit");
  assert.equal(contract.isOneImprovementProofV1({ ...validFixture, attributionStatus: "correlated" }), false, "attribution status must use the closed enum");
  assert.equal(contract.isOneImprovementProofV1({ ...validFixture, attributionStatus: "not_established" }), false, "improved_result must require established attribution");
  assert.equal(contract.isOneImprovementProofV1({ ...validFixture, attributionStatus: "not_established", compoundingStep: "reused" }), true, "observed improvement may remain visible without causal promotion");

  const baselineTaskVersion = insertTask(db, "task_improve_baseline", "completed", 0);
  const currentTaskVersion = insertTask(db, "task_improve_current", "completed", 1);
  assert.equal(runtime.listOneImprovementProofs("task_improve_current").length, 0, "Task completion alone must not create proof");
  assert.equal(domainEvents.listOneDomainEvents("task_improve_current", 50).some((event) => event.eventType === "improvement.proof_ready"), false);

  const base = numericInput({
    storeVersion: initial.version,
    suffix: "measured",
    baselineTaskId: "task_improve_baseline",
    baselineTaskVersion,
    currentTaskId: "task_improve_current",
    currentTaskVersion,
  });
  assert.throws(() => runtime.createOneImprovementProof({ ...base, rendererPrivatePayload: "forbidden" }), /unsupported fields/);
  const missingAttribution = { ...base };
  delete missingAttribution.attributionStatus;
  assert.throws(() => runtime.createOneImprovementProof(missingAttribution), /attributionStatus/);
  assert.throws(() => runtime.createOneImprovementProof({ ...base, attributionStatus: "correlated" }), /attributionStatus/);
  assert.throws(() => runtime.createOneImprovementProof({ ...base, trustedHostAttested: false }), /trusted Main host attestation/);
  assert.throws(() => runtime.createOneImprovementProof({ ...base, currentTaskVersion: currentTaskVersion - 1 }), /canonical Task changed/);
  const wrongOutput = structuredClone(base);
  wrongOutput.comparisons[0].currentOutputVerificationRef = wrongOutput.comparisons[0].baselineOutputVerificationRef;
  assert.throws(() => runtime.createOneImprovementProof(wrongOutput), /not uniquely bound|cross-bind/);
  const incomparable = structuredClone(base);
  incomparable.trustedHostEvidence.find((item) => item.kind === "measurement" && item.role === "current").comparable = false;
  assert.throws(() => runtime.createOneImprovementProof(incomparable), /explicitly comparable/);
  const fakeFact = structuredClone(base);
  fakeFact.trustedHostEvidence.find((item) => item.kind === "measurement").valueType = "estimate";
  assert.throws(() => runtime.createOneImprovementProof(fakeFact), /must declare fact measurements/);
  for (const [text, reason] of [
    ["Use password=private-value to compare this result.", "secret"],
    ["Read /Users/example/private/customer.csv to compare this result.", "local_path"],
    ["Open https://private.example.test before comparing.", "transport_or_markup"],
    ["user: private transcript\nassistant: copied result", "raw_transcript"],
    ["Send this comparison to private.person@example.test.", "private_data"],
  ]) {
    const unsafe = structuredClone(base);
    unsafe.changes[0].statement = text;
    assert.throws(() => runtime.createOneImprovementProof(unsafe), new RegExp(reason));
  }
  assert.equal(runtime.getOneImprovementProofState().version, initial.version, "rejected claims must not mutate state");

  const measured = runtime.createOneImprovementProof(base);
  assert.equal(measured.value.comparisons[0].result, "improved");
  assert.equal(measured.value.proof.compoundingStep, "improved_result");
  assert.equal(measured.value.proof.attributionStatus, "established");
  assert.equal(measured.value.proof.placement, "after_value_closure");
  assert.equal(measured.value.proof.convertedToEngagementScore, false);
  assert.equal(measured.value.assetBindings[0].assetVersion, 3);
  assert.equal(measured.value.assetBindings[0].rollbackRef, "rollback:measured");
  assert.equal(measured.value.assetBindings[0].removeRef, "remove:measured");

  const proofEvent = domainEvents.listOneDomainEvents(measured.value.proof.improvementProofId, 20)
    .find((event) => event.eventType === "improvement.proof_ready");
  assert.ok(proofEvent, "exact improvement.proof_ready event must be durable");
  assert.deepEqual(Object.keys(entries(proofEvent)).sort(), ["baselineRefs", "evidenceType", "improvementProofRef", "reusedAssetRefs"]);
  assert.equal(proofEvent.taskId, "task_improve_current");
  for (const item of base.trustedHostEvidence) {
    assert.ok(domainEvents.listOneDomainEvents(item.evidenceRef, 10).some((event) => event.eventType === "receipt.recorded"));
  }

  const observedBaselineVersion = insertTask(db, "task_observed_baseline", "completed", 2);
  const observedCurrentVersion = insertTask(db, "task_observed_current", "completed", 3);
  const observed = runtime.createOneImprovementProof(numericInput({
    storeVersion: measured.storeVersion,
    suffix: "observed-not-attributed",
    baselineTaskId: "task_observed_baseline",
    baselineTaskVersion: observedBaselineVersion,
    currentTaskId: "task_observed_current",
    currentTaskVersion: observedCurrentVersion,
    attributionStatus: "not_established",
  }));
  assert.equal(observed.value.comparisons[0].result, "improved", "the observed comparison must remain visible");
  assert.equal(observed.value.proof.attributionStatus, "not_established");
  assert.equal(observed.value.proof.compoundingStep, "reused", "unestablished attribution must block improved_result promotion");

  const qualitativeBaselineVersion = insertTask(db, "task_qualitative_baseline", "completed", 4);
  const qualitativeCurrentVersion = insertTask(db, "task_qualitative_current", "completed", 5);
  const qualitative = runtime.createOneImprovementProof(qualitativeInput({
    storeVersion: observed.storeVersion,
    suffix: "qualitative",
    baselineTaskId: "task_qualitative_baseline",
    baselineTaskVersion: qualitativeBaselineVersion,
    currentTaskId: "task_qualitative_current",
    currentTaskVersion: qualitativeCurrentVersion,
  }));
  assert.equal(qualitative.value.comparisons[0].result, "regression", "verified regression must remain visible");
  assert.equal(qualitative.value.proof.compoundingStep, "reused", "regression must not masquerade as improved_result");
  assert.equal(qualitative.value.proof.changes[0].evidenceType, "qualitative");

  const estimateBaselineVersion = insertTask(db, "task_estimate_baseline", "completed", 6);
  const estimateCurrentVersion = insertTask(db, "task_estimate_current", "completed", 7);
  const estimateInput = numericInput({
    storeVersion: qualitative.storeVersion,
    suffix: "estimate",
    baselineTaskId: "task_estimate_baseline",
    baselineTaskVersion: estimateBaselineVersion,
    currentTaskId: "task_estimate_current",
    currentTaskVersion: estimateCurrentVersion,
    evidenceType: "estimate",
    result: "no_change",
    baselineValue: 4,
    currentValue: 4,
    assetKind: "automation",
  });
  const estimate = runtime.createOneImprovementProof(estimateInput);
  assert.equal(estimate.value.comparisons[0].result, "no_change", "verified no-change must remain visible");
  assert.equal(estimate.value.proof.changes[0].evidenceType, "estimate");
  assert.equal(estimate.value.proof.compoundingStep, "reused");

  const raw = db.prepare("SELECT value FROM meta WHERE key = ?").get(runtime.ONE_IMPROVEMENT_PROOF_META_KEY).value;
  db.prepare("UPDATE meta SET value = ? WHERE key = ?").run("{corrupt-json", runtime.ONE_IMPROVEMENT_PROOF_META_KEY);
  assert.throws(() => runtime.getOneImprovementProofState(), /corrupt; it was not overwritten/);
  assert.equal(db.prepare("SELECT value FROM meta WHERE key = ?").get(runtime.ONE_IMPROVEMENT_PROOF_META_KEY).value, "{corrupt-json");
  db.prepare("UPDATE meta SET value = ? WHERE key = ?").run(raw, runtime.ONE_IMPROVEMENT_PROOF_META_KEY);
  const semanticCorrupt = JSON.parse(raw);
  semanticCorrupt.privateTranscript = "forbidden";
  db.prepare("UPDATE meta SET value = ? WHERE key = ?").run(JSON.stringify(semanticCorrupt), runtime.ONE_IMPROVEMENT_PROOF_META_KEY);
  assert.throws(() => runtime.getOneImprovementProofState(), /violates its closed contract; it was not overwritten/);
  db.prepare("UPDATE meta SET value = ? WHERE key = ?").run(raw, runtime.ONE_IMPROVEMENT_PROOF_META_KEY);

  const raceBaselineVersion = insertTask(db, "task_improve_race_baseline", "completed", 8);
  const raceCurrentVersion = insertTask(db, "task_improve_race_current", "completed", 9);
  const finalState = runtime.getOneImprovementProofState();
  const ipcSource = fs.readFileSync(path.join(__dirname, "../electron/ipc.ts"), "utf8");
  const preloadSource = fs.readFileSync(path.join(__dirname, "../electron/preload.ts"), "utf8");
  assert.equal(ipcSource.includes("createOneImprovementProof"), false, "trusted create API must not be renderer IPC");
  assert.equal(preloadSource.includes("createOneImprovementProof"), false, "trusted create API must not be preload IPC");
  for (const channel of ["getState", "list", "latestForTask"]) {
    assert.ok(ipcSource.includes(`oneImprovementProof:${channel}`), `IPC must expose read-only ${channel}`);
    assert.ok(preloadSource.includes(`oneImprovementProof:${channel}`), `preload must expose read-only ${channel}`);
  }
  assert.match(ipcSource, /strictOneImprovementProofTaskId\(taskId,[\s\S]*Improvement Proof taskId/, "latestForTask must validate its Task id in Main");
  assert.match(ipcSource, /Object\.keys\(record\)\.some\(\(key\) => key !== "taskId"\)/, "list input must reject unknown fields");
  assert.match(ipcSource, /evidence:\s*_mainOnlyEvidence,[\s\S]*readState/, "Main-only attestations must be stripped from the renderer read model");
  console.log(JSON.stringify({
    ok: true,
    storeVersion: finalState.version,
    raceBaselineVersion,
    raceCurrentVersion,
    proofs: finalState.proofs.length,
  }));
  db.close();
  app.quit();
}

async function raceWorker() {
  const { app, db } = await openStore();
  const runtime = require("../dist/electron/one/improvement-proof.js");
  const suffix = argument("--suffix");
  try {
    const result = runtime.createOneImprovementProof(numericInput({
      storeVersion: Number(argument("--store-version")),
      suffix: `race:${suffix}`,
      baselineTaskId: "task_improve_race_baseline",
      baselineTaskVersion: Number(argument("--baseline-version")),
      currentTaskId: "task_improve_race_current",
      currentTaskVersion: Number(argument("--current-version")),
      assetKind: "agent",
    }));
    console.log(JSON.stringify({ success: true, suffix, storeVersion: result.storeVersion, proofId: result.value.proof.improvementProofId }));
  } catch (error) {
    console.log(JSON.stringify({ success: false, suffix, error: error instanceof Error ? error.message : String(error) }));
  }
  db.close();
  app.quit();
}

async function reloadWorker() {
  const { app, db } = await openStore();
  const runtime = require("../dist/electron/one/improvement-proof.js");
  const domainEvents = require("../dist/electron/one/domain-events.js");
  const winnerId = argument("--winner-id");
  const state = runtime.getOneImprovementProofState();
  assert.equal(state.proofs.length, 5, "four seeded proofs plus exactly one CAS winner must persist");
  const winner = state.proofs.find((item) => item.proof.improvementProofId === winnerId);
  assert.ok(winner, "CAS winner must survive a fresh Electron process");
  assert.equal(winner.proof.taskId, "task_improve_race_current");
  assert.ok(domainEvents.listOneDomainEvents(winnerId, 20).some((event) => event.eventType === "improvement.proof_ready"));
  assert.ok(state.proofs.some((item) => item.comparisons.some((comparison) => comparison.result === "regression")));
  assert.ok(state.proofs.some((item) => item.comparisons.some((comparison) => comparison.result === "no_change")));
  const serialized = JSON.stringify(state);
  assert.equal(serialized.includes("password="), false);
  assert.equal(serialized.includes("/Users/"), false);
  assert.equal(serialized.includes("user:"), false);
  console.log(JSON.stringify({ ok: true, restoredAfterRestart: true, proofs: state.proofs.length, winnerId }));
  db.close();
  app.quit();
}

function parseLastJson(output) {
  const lines = output.trim().split(/\r?\n/).filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

function runAsync(executable, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

async function orchestrate() {
  const electronModule = require("electron");
  const executable = typeof electronModule === "string" ? electronModule : process.execPath;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-one-improvement-proof-"));
  const storePath = path.join(temp, "improvement-proof.sqlite");
  const env = { ...process.env, AGENTLAS_STORE_PATH: storePath };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const seed = spawnSync(
      executable,
      [__filename, "--seed", `--user-data=${path.join(temp, "seed-user-data")}`],
      { env, encoding: "utf8" },
    );
    if (seed.status !== 0) throw new Error(`Improvement Proof seed failed (${seed.status})\n${seed.stdout}\n${seed.stderr}`);
    process.stdout.write(seed.stdout);
    const seeded = parseLastJson(seed.stdout);

    const common = [
      __filename,
      "--race",
      `--store-version=${seeded.storeVersion}`,
      `--baseline-version=${seeded.raceBaselineVersion}`,
      `--current-version=${seeded.raceCurrentVersion}`,
    ];
    const [raceA, raceB] = await Promise.all([
      runAsync(executable, [...common, "--suffix=a", `--user-data=${path.join(temp, "race-a")}`], env),
      runAsync(executable, [...common, "--suffix=b", `--user-data=${path.join(temp, "race-b")}`], env),
    ]);
    if (raceA.status !== 0 || raceB.status !== 0) {
      throw new Error(`Improvement Proof race failed\nA:${raceA.stdout}\n${raceA.stderr}\nB:${raceB.stdout}\n${raceB.stderr}`);
    }
    const outcomes = [parseLastJson(raceA.stdout), parseLastJson(raceB.stdout)];
    assert.equal(outcomes.filter((item) => item.success).length, 1, "exactly one concurrent CAS writer must succeed");
    assert.equal(outcomes.filter((item) => !item.success).length, 1);
    assert.match(outcomes.find((item) => !item.success).error, /changed|concurrently|locked|busy/i);
    const winner = outcomes.find((item) => item.success);
    process.stdout.write(`${JSON.stringify({ ok: true, concurrentCas: outcomes })}\n`);

    const reload = spawnSync(
      executable,
      [__filename, "--reload", `--winner-id=${winner.proofId}`, `--user-data=${path.join(temp, "reload-user-data")}`],
      { env, encoding: "utf8" },
    );
    if (reload.status !== 0) throw new Error(`Improvement Proof reload failed (${reload.status})\n${reload.stdout}\n${reload.stderr}`);
    process.stdout.write(reload.stdout);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv.includes("--seed")) {
  seedWorker().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
} else if (process.argv.includes("--race")) {
  raceWorker().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
} else if (process.argv.includes("--reload")) {
  reloadWorker().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
} else {
  orchestrate().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
}
