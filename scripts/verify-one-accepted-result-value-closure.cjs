#!/usr/bin/env node

const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nM8AAAAASUVORK5CYII=",
  "base64",
);

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

function insertAgent(db) {
  db.prepare(
    `INSERT OR IGNORE INTO installed_agents
       (id, slug, name, tagline, system_prompt, mcp_servers_json, trust_grade, installed_at, tone)
     VALUES (?, ?, ?, ?, '', '[]', 'A', ?, 'neutral')`,
  ).run("one-accepted-result-agent", "one-accepted-result", "One", "Chief of Staff", new Date().toISOString());
}

function entries(event) {
  return Object.fromEntries(event.payload.entries.map((item) => [item.name, item.value]));
}

function prepareAcceptedTask(runtime, title, runId, terminalPayload = {}) {
  const chat = runtime.chats.createChat({
    agentId: "one-accepted-result-agent",
    title,
  });
  const initial = runtime.tasks.getCanonicalTaskForChat(chat.id);
  assert.ok(initial);
  const partial = runtime.tasks.setCanonicalTaskStatus(initial.id, "partial");
  runtime.domainEvents.recordOneDomainEvent({
    eventType: "task.state_changed",
    occurredAt: partial.updatedAt,
    actor: "system",
    entityId: partial.id,
    taskId: partial.id,
    version: partial.version,
    visibility: "personal",
    entries: [
      { name: "from", value: initial.status },
      { name: "to", value: "partial" },
      { name: "reason", value: "authoritative invocation lifecycle" },
    ],
  });
  runtime.runEvents.recordRunEvent({
    runId,
    kind: "invoke_started",
    chatId: chat.id,
    agentId: "one-accepted-result-agent",
    payload: { chatId: chat.id },
  });
  runtime.domainEvents.recordOneDomainEvent({
    eventType: "run.started",
    actor: "one",
    entityId: runId,
    taskId: partial.id,
    version: 1,
    visibility: "personal",
    entries: [
      { name: "runId", value: runId },
      { name: "policyVersion", value: "agentlas-one-runtime-v1" },
    ],
  });
  runtime.runEvents.recordRunEvent({
    runId,
    kind: "invoke_completed",
    chatId: chat.id,
    agentId: "one-accepted-result-agent",
    payload: terminalPayload,
  });
  const receipt = runtime.runEvents.getInvocationRunReceipt(runId);
  assert.ok(receipt);
  assert.equal(receipt.status, "completed");
  const accepted = runtime.tasks.acceptCanonicalTaskResult({
    taskId: partial.id,
    expectedVersion: partial.version,
    expectedRunId: runId,
  }, receipt);
  return { chat, partial, accepted, receipt };
}

function mediaManifest(title, rows) {
  return {
    version: "0.1",
    kind: "surface",
    title,
    domain: "one-accepted-result-verification-test",
    layout: "gallery",
    data: { media: { type: "media", rows } },
    widgets: [{ type: "gallery", data: "media", title }],
  };
}

function artifactManifest(title, rows) {
  return {
    version: "0.1",
    kind: "surface",
    title,
    domain: "one-accepted-result-verification-test",
    layout: "document",
    data: { artifacts: { type: "artifacts", rows } },
    widgets: [{ type: "artifact-list", data: "artifacts", title }],
  };
}

function prepareAcceptedSurfaceTask(runtime, input) {
  const chat = runtime.chats.createChat({
    agentId: "one-accepted-result-agent",
    title: input.title,
  });
  runtime.chats.setChatWorkingFolder(chat.id, input.workspace);
  const initial = runtime.tasks.getCanonicalTaskForChat(chat.id);
  assert.ok(initial);
  const taskKindRef = runtime.taskKind.deriveOneTaskKindRef({
    userPrompt: input.taskKindPrompt || input.title,
    projectId: chat.projectId,
    firmId: chat.firmId,
    agentGroupId: chat.agentGroupId,
    ownerAgentId: chat.agentId,
    inputRefs: [],
  });
  const installedAgent = runtime.registry.listInstalledAgentsReadOnly()
    .find((agent) => agent.id === chat.agentId);
  assert.ok(taskKindRef && installedAgent);
  const participantBindings = runtime.taskKind.deriveOneParticipantVersionBindings([installedAgent]);
  assert.ok(participantBindings);
  runtime.runEvents.recordRunEvent({
    runId: input.runId,
    kind: "invoke_started",
    chatId: chat.id,
    agentId: "one-accepted-result-agent",
    payload: {
      chatId: chat.id,
      oneMode: true,
      oneTaskKindRef: taskKindRef,
      oneParticipantVersionBindings: participantBindings,
      planMode: false,
      goalMode: false,
      appsGenerateMode: false,
      toolMode: "auto",
      hubMode: "local-only",
      oneTeamExecutionPolicy: "solo_locked",
      hasImages: false,
      hasOneAttachments: false,
    },
  });
  runtime.domainEvents.recordOneDomainEvent({
    eventType: "run.started",
    actor: "one",
    entityId: input.runId,
    taskId: initial.id,
    version: 1,
    visibility: "personal",
    entries: [
      { name: "runId", value: input.runId },
      { name: "policyVersion", value: "agentlas-one-runtime-v1" },
    ],
  });
  for (let index = 0; index < (input.userTurns || 1); index += 1) {
    runtime.chats.appendChatMessage(chat.id, "user", `bounded accepted media instruction ${index + 1}`);
  }
  if (input.memoryReceipt) {
    runtime.runEvents.recordRunEvent({
      runId: input.runId,
      kind: "one_memory_context_applied",
      chatId: chat.id,
      payload: input.memoryReceipt,
    });
  }
  const surfaceTask = runtime.tasks.getCanonicalTaskForChat(chat.id);
  assert.ok(surfaceTask && surfaceTask.id === initial.id);
  const rawManifest = input.manifest;
  const surface = runtime.surface.adaptLegacySurfaceToOneV1({
    manifest: rawManifest,
    surfaceId: `surface:${input.runId}`,
    taskId: surfaceTask.id,
    syncedAt: new Date().toISOString(),
  });
  if (input.forgeManifestVerificationStatus) {
    for (const artifact of surface.fallback.artifacts) artifact.verificationStatus = "verified";
  }
  runtime.surfaceResults.recordDurableOneSurfaceResult({
    runId: input.runId,
    chatId: chat.id,
    manifest: surface,
  });
  const bound = runtime.artifacts.bindOneSurfaceArtifacts({
    rawManifest,
    surface,
    taskId: surfaceTask.id,
    taskVersion: surfaceTask.version,
    chatId: chat.id,
    runId: input.runId,
  });
  runtime.domainEvents.recordOneDomainEvent({
    eventType: "result.manifest_ready",
    actor: "system",
    entityId: surfaceTask.id,
    taskId: surfaceTask.id,
    version: surfaceTask.version,
    visibility: "personal",
    entries: [
      { name: "manifestId", value: surface.manifestId },
      { name: "contractVersion", value: surface.contractVersion },
      { name: "artifactRefs", value: surface.fallback.artifacts.map((item) => item.artifactRef) },
    ],
  });
  runtime.runEvents.recordRunEvent({
    runId: input.runId,
    kind: "invoke_completed",
    chatId: chat.id,
    agentId: "one-accepted-result-agent",
    payload: {},
  });
  const partial = runtime.tasks.setCanonicalTaskStatus(surfaceTask.id, "partial");
  runtime.domainEvents.recordOneDomainEvent({
    eventType: "task.state_changed",
    occurredAt: partial.updatedAt,
    actor: "system",
    entityId: partial.id,
    taskId: partial.id,
    version: partial.version,
    visibility: "personal",
    entries: [
      { name: "from", value: surfaceTask.status },
      { name: "to", value: "partial" },
      { name: "reason", value: "authoritative invocation lifecycle" },
    ],
  });
  runtime.domainEvents.recordOneDomainEvent({
    eventType: "receipt.recorded",
    occurredAt: partial.updatedAt,
    actor: "system",
    entityId: partial.id,
    taskId: partial.id,
    version: partial.version,
    visibility: "personal",
    entries: [
      { name: "receiptId", value: `receipt:${input.runId}` },
      { name: "kind", value: "invoke_completed" },
      { name: "sourceOrRunRefs", value: [input.runId] },
    ],
  });
  const receipt = runtime.runEvents.getInvocationRunReceipt(input.runId);
  assert.ok(receipt && receipt.status === "completed");
  const accepted = runtime.tasks.acceptCanonicalTaskResult({
    taskId: partial.id,
    expectedVersion: partial.version,
    expectedRunId: input.runId,
  }, receipt);
  const exact = { priorTaskVersion: partial.version, acceptedTask: accepted, expectedRunId: input.runId, receipt, confirmedByUser: true };
  const partialClosure = input.skipPartialClosure
    ? null
    : runtime.acceptedClosures.ensureAcceptedResultValueClosure(exact);
  return { chat, initial, partial, accepted, receipt, surface, bound, partialClosure, exact };
}

function loadRuntime() {
  return {
    chats: require("../dist/electron/store/chats.js"),
    tasks: require("../dist/electron/store/tasks.js"),
    runEvents: require("../dist/electron/store/run-events.js"),
    domainEvents: require("../dist/electron/one/domain-events.js"),
    closures: require("../dist/electron/one/value-closure.js"),
    acceptedClosures: require("../dist/electron/one/accepted-result-value-closure.js"),
    artifacts: require("../dist/electron/one/artifact-preview.js"),
    surface: require("../dist/shared/one-surface.js"),
    surfaceResults: require("../dist/electron/store/one-surface-results.js"),
    taskKind: require("../dist/electron/one/task-kind.js"),
    registry: require("../dist/electron/mcp/registry.js"),
    memory: require("../dist/electron/one/memory-candidates.js"),
    reuse: require("../dist/electron/one/experience-reuse.js"),
    proof: require("../dist/electron/one/improvement-proof.js"),
    producer: require("../dist/electron/one/improvement-proof-producer.js"),
  };
}

function saveVerifiedMemory(runtime, source) {
  let state = runtime.memory.getOneMemoryState();
  const proposed = runtime.memory.proposeOneMemoryCandidate({
    expectedStoreVersion: state.version,
    normalizedPreview: "Use the approved accepted-media comparison structure.",
    scope: "personal",
    source: {
      provenanceStatus: "verified",
      sourceTaskId: source.accepted.id,
      sourceTaskVersion: source.accepted.version,
      sourceRunId: source.receipt.runId,
      sourceValueClosureId: source.partialClosure.value.closure.valueClosureId,
      sourceValueClosureVersion: source.partialClosure.value.version,
      sourceRef: `source:accepted-media:${source.accepted.id}`,
      evidenceRefs: [`evidence:accepted-media:${source.accepted.id}`],
      basis: "explicit_user_statement",
    },
    suppressionKey: `suppression:accepted-media:${source.accepted.id}`,
  });
  state = runtime.memory.getOneMemoryState();
  return runtime.memory.saveOneMemoryCandidate({
    expectedStoreVersion: state.version,
    candidateId: proposed.value.id,
    expectedCandidateVersion: proposed.value.version,
    approvedByUser: true,
  }).value.memory;
}

function exactInput(prepared) {
  return {
    priorTaskVersion: prepared.partial.version,
    acceptedTask: prepared.accepted,
    expectedRunId: prepared.receipt.runId,
    receipt: prepared.receipt,
    confirmedByUser: true,
  };
}

async function seedWorker() {
  const { app, db } = await openStore();
  insertAgent(db);
  const runtime = loadRuntime();
  const base = argument("--base");
  if (!base) throw new Error("seed worker requires --base");
  const workspace = fs.realpathSync.native(fs.mkdirSync(path.join(base, "workspace"), { recursive: true }) || path.join(base, "workspace"));
  const first = prepareAcceptedTask(
    runtime,
    "Accept one internal result",
    "run_accepted_result_primary",
    { resultFolder: "/private/tmp/agentlas-secret-result" },
  );
  const created = runtime.acceptedClosures.ensureAcceptedResultValueClosure(exactInput(first));
  const closure = created.value.closure;
  assert.equal(closure.taskId, first.accepted.id);
  assert.equal(created.value.taskVersion, first.accepted.version);
  assert.equal(closure.outcomeStatus, "partially_verified");
  assert.deepEqual(closure.lifecycleClaims.map((claim) => claim.status), [
    "not_started", "not_started", "completed", "not_started",
  ]);
  assert.equal(closure.originalPreservation.status, "not_applicable");
  assert.deepEqual(closure.originalPreservation.artifactRefs, []);
  assert.deepEqual(created.value.artifactRefs, []);
  assert.equal(closure.reflection.eligible, false);
  assert.equal(closure.remainingWork.length, 1);
  assert.equal(closure.remainingWork[0].owner, "external");
  assert.equal(closure.remainingWork[0].status, "pending");
  assert.match(closure.remainingWork[0].action, /outside Agentlas/);
  assert.match(closure.valueItems[0].statement, /completed internal run result was explicitly accepted/);

  const state = runtime.closures.getOneValueClosureState();
  const evidence = state.evidence.filter((item) => created.value.trustedEvidenceRefs.includes(item.evidenceRef));
  assert.deepEqual(evidence.map((item) => item.kind), ["execution_receipt", "result_acceptance"]);
  assert.deepEqual(evidence.map((item) => item.source), ["invocation_runtime", "canonical_task_runtime"]);
  assert.ok(evidence.every((item) => item.sourceRunRef === first.receipt.runId));
  assert.equal(JSON.stringify(state).includes("/private/tmp/agentlas-secret-result"), false);

  const internalResultRef = closure.outcomeRefs[0];
  assert.equal(
    runtime.domainEvents.listOneDomainEvents(internalResultRef, 20)
      .some((event) => event.eventType === "outcome.verified"),
    false,
    "internal result acceptance must not manufacture an external outcome verification event",
  );
  const closureEvent = runtime.domainEvents.listOneDomainEvents(closure.valueClosureId, 20)
    .find((event) => event.eventType === "value_closure.ready");
  assert.ok(closureEvent);
  assert.deepEqual(entries(closureEvent).outcomeRefs, [internalResultRef]);
  for (const item of evidence) {
    const receiptEvent = runtime.domainEvents.listOneDomainEvents(item.evidenceRef, 20)
      .find((event) => event.eventType === "receipt.recorded");
    assert.ok(receiptEvent);
    assert.equal(receiptEvent.actor, item.kind === "result_acceptance" ? "user" : "system");
  }

  const sameProcessRetry = runtime.acceptedClosures.ensureAcceptedResultValueClosure(exactInput(first));
  assert.equal(sameProcessRetry.value.closure.valueClosureId, closure.valueClosureId);
  assert.equal(runtime.closures.listOneValueClosures(first.accepted.id).length, 1);
  assert.throws(
    () => runtime.acceptedClosures.ensureAcceptedResultValueClosure({
      ...exactInput(first),
      priorTaskVersion: first.accepted.version,
    }),
    /exact prior Task version/,
  );
  assert.throws(
    () => runtime.acceptedClosures.ensureAcceptedResultValueClosure({
      ...exactInput(first),
      priorTaskVersion: first.partial.version - 1,
    }),
    /result-ready Task-version event/,
  );
  assert.throws(
    () => runtime.acceptedClosures.ensureAcceptedResultValueClosure({
      ...exactInput(first),
      expectedRunId: "run_missing_completed_receipt",
    }),
    /exact durable completed InvocationRunReceipt/,
  );
  assert.throws(
    () => runtime.acceptedClosures.ensureAcceptedResultValueClosure({
      ...exactInput(first),
      rendererPayload: "forbidden",
    }),
    /unsupported fields/,
  );

  const verifiedImagePath = path.join(workspace, "verified.png");
  fs.writeFileSync(verifiedImagePath, PNG_BYTES, { mode: 0o600 });
  const verifiedMedia = prepareAcceptedSurfaceTask(runtime, {
    title: "Accepted exact media bundle",
    workspace,
    runId: "run_accepted_result_verified_media",
    manifest: mediaManifest("Accepted exact media bundle", [
      { path: verifiedImagePath, mediaType: "image", label: "Verified media" },
    ]),
  });
  assert.equal(verifiedMedia.bound, 1);
  assert.deepEqual(
    verifiedMedia.surface.fallback.artifacts.map((item) => item.verificationStatus),
    ["verified"],
    "an exact Main-private file binding may mark the in-memory surface verified",
  );
  const verifiedResult = runtime.acceptedClosures.ensureVerifiedAcceptedResultValueClosure(verifiedMedia.exact);
  assert.ok(verifiedResult);
  assert.equal(verifiedResult.value.closure.outcomeStatus, "verified");
  assert.equal(
    verifiedResult.value.closure.lifecycleClaims.find((claim) => claim.phase === "verification").status,
    "completed",
  );
  assert.equal(verifiedResult.value.closure.remainingWork.length, 1);
  assert.match(verifiedResult.value.closure.remainingWork[0].reason, /not an external effect/);
  const verifiedState = runtime.closures.getOneValueClosureState();
  const verifiedEvidence = verifiedState.evidence.filter((item) =>
    verifiedResult.value.trustedEvidenceRefs.includes(item.evidenceRef));
  assert.ok(verifiedEvidence.some((item) => item.kind === "artifact_verification" && item.source === "filesystem_guard"));
  assert.ok(verifiedEvidence.some((item) => item.kind === "outcome_verification" && item.source === "filesystem_guard"));
  assert.equal(verifiedEvidence.some((item) => item.source === "explicit_user_observation"), false);
  assert.equal(runtime.acceptedClosures.ensureVerifiedAcceptedResultValueClosure(verifiedMedia.exact).value.closure.valueClosureId,
    verifiedResult.value.closure.valueClosureId, "verified artifact closure retry must be idempotent");

  const tamperedPath = path.join(workspace, "tampered.png");
  fs.writeFileSync(tamperedPath, PNG_BYTES, { mode: 0o600 });
  const tampered = prepareAcceptedSurfaceTask(runtime, {
    title: "Tampered accepted media",
    workspace,
    runId: "run_accepted_result_tampered_media",
    manifest: mediaManifest("Tampered accepted media", [
      { path: tamperedPath, mediaType: "image", label: "Tampered media" },
    ]),
  });
  assert.equal(tampered.bound, 1);
  fs.writeFileSync(tamperedPath, Buffer.from(PNG_BYTES.map((byte, index) => index === 20 ? byte ^ 1 : byte)));
  assert.equal(runtime.acceptedClosures.ensureVerifiedAcceptedResultValueClosure(tampered.exact), null,
    "same-size byte replacement must remain partially verified");

  const partialPath = path.join(workspace, "partial.png");
  fs.writeFileSync(partialPath, PNG_BYTES, { mode: 0o600 });
  const partialBundle = prepareAcceptedSurfaceTask(runtime, {
    title: "Partially bound media bundle",
    workspace,
    runId: "run_accepted_result_partial_media",
    manifest: mediaManifest("Partially bound media bundle", [
      { path: partialPath, mediaType: "image", label: "Bound media" },
      { path: path.join(workspace, "missing.png"), mediaType: "image", label: "Missing media" },
    ]),
  });
  assert.equal(partialBundle.bound, 1);
  assert.equal(runtime.acceptedClosures.ensureVerifiedAcceptedResultValueClosure(partialBundle.exact), null,
    "one missing binding must keep the entire bundle partial");

  const wrongSizePath = path.join(workspace, "wrong-size.png");
  fs.writeFileSync(wrongSizePath, PNG_BYTES, { mode: 0o600 });
  const wrongSize = prepareAcceptedSurfaceTask(runtime, {
    title: "Manifest size mismatch",
    workspace,
    runId: "run_accepted_result_wrong_size",
    forgeManifestVerificationStatus: true,
    manifest: mediaManifest("Manifest size mismatch", [
      { path: wrongSizePath, mediaType: "image", label: "Wrong declared size", sizeBytes: PNG_BYTES.length + 1 },
    ]),
  });
  assert.equal(wrongSize.bound, 1);
  assert.equal(runtime.acceptedClosures.ensureVerifiedAcceptedResultValueClosure(wrongSize.exact), null,
    "a forged verified status cannot override a manifest/file size mismatch");

  const document = prepareAcceptedSurfaceTask(runtime, {
    title: "Document remains partial",
    workspace,
    runId: "run_accepted_result_document",
    forgeManifestVerificationStatus: true,
    manifest: artifactManifest("Document remains partial", [
      { path: path.join(workspace, "report.pdf"), type: "document", label: "Report" },
    ]),
  });
  assert.equal(document.surface.fallback.artifacts[0].verificationStatus, "verified");
  assert.equal(runtime.acceptedClosures.ensureVerifiedAcceptedResultValueClosure(document.exact), null,
    "a forged manifest status and document claim must never manufacture host verification");

  const noClosurePath = path.join(workspace, "no-partial-closure.png");
  fs.writeFileSync(noClosurePath, PNG_BYTES, { mode: 0o600 });
  const noPartialClosure = prepareAcceptedSurfaceTask(runtime, {
    title: "Accepted media without durable partial closure",
    workspace,
    runId: "run_accepted_result_no_partial_closure",
    skipPartialClosure: true,
    manifest: mediaManifest("Accepted media without durable partial closure", [
      { path: noClosurePath, mediaType: "image", label: "No partial closure" },
    ]),
  });
  assert.equal(noPartialClosure.bound, 1);
  assert.equal(runtime.acceptedClosures.ensureVerifiedAcceptedResultValueClosure(noPartialClosure.exact), null,
    "acceptance events and bound bytes cannot replace the exact durable partial accepted closure");

  const proofTaskKind = "Prepare the same accepted-media comparison from the exact approved inputs.";
  const baselinePath = path.join(workspace, "proof-baseline.png");
  fs.writeFileSync(baselinePath, PNG_BYTES, { mode: 0o600 });
  const proofBaseline = prepareAcceptedSurfaceTask(runtime, {
    title: "Accepted media proof baseline",
    workspace,
    runId: "run_accepted_result_proof_baseline",
    taskKindPrompt: proofTaskKind,
    userTurns: 3,
    manifest: mediaManifest("Accepted media proof baseline", [
      { path: baselinePath, mediaType: "image", label: "Baseline deliverable" },
    ]),
  });
  const verifiedBaseline = runtime.acceptedClosures.ensureVerifiedAcceptedResultValueClosure(proofBaseline.exact);
  assert.ok(verifiedBaseline);
  const memory = saveVerifiedMemory(runtime, proofBaseline);
  const memoryState = runtime.memory.getOneMemoryState();
  const currentPath = path.join(workspace, "proof-current.png");
  fs.writeFileSync(currentPath, PNG_BYTES, { mode: 0o600 });
  const proofCurrent = prepareAcceptedSurfaceTask(runtime, {
    title: "Accepted media proof current",
    workspace,
    runId: "run_accepted_result_proof_current",
    taskKindPrompt: proofTaskKind,
    userTurns: 1,
    memoryReceipt: {
      storeVersion: memoryState.version,
      memoryIds: [memory.id],
      scopeKinds: [memory.scope],
      assets: [{
        assetId: memory.id,
        assetVersion: memory.version,
        provenanceStatus: memory.provenanceStatus,
        sourceTaskId: memory.sourceTaskId,
        sourceTaskVersion: memory.sourceTaskVersion,
        sourceRunId: memory.sourceRunId,
        sourceValueClosureId: memory.sourceValueClosureId,
        sourceValueClosureVersion: memory.sourceValueClosureVersion,
        scope: memory.scope,
      }],
    },
    manifest: mediaManifest("Accepted media proof current", [
      { path: currentPath, mediaType: "image", label: "Current deliverable" },
    ]),
  });
  const verifiedCurrent = runtime.acceptedClosures.ensureVerifiedAcceptedResultValueClosure(proofCurrent.exact);
  assert.ok(verifiedCurrent);
  const reuse = runtime.reuse.ensureOneExperienceReuseReceipt({
    taskId: proofCurrent.accepted.id,
    expectedTaskVersion: proofCurrent.accepted.version,
    expectedTaskUpdatedAt: proofCurrent.accepted.updatedAt,
    expectedRunId: proofCurrent.receipt.runId,
    valueClosureId: proofCurrent.partialClosure.value.closure.valueClosureId,
    expectedValueClosureVersion: proofCurrent.partialClosure.value.version,
    confirmedByUser: true,
  });
  assert.ok(reuse);
  const productionProof = runtime.producer.produceOneImprovementProofForTask(proofCurrent.accepted.id);
  assert.equal(productionProof.reason, "created",
    "two real bound-media accepted runs must reach the production proof composer without a synthetic closure");
  assert.ok(productionProof.proof);
  assert.equal(productionProof.proof.comparisons[0].baselineTaskId, proofBaseline.accepted.id);
  assert.equal(productionProof.proof.comparisons[0].result, "improved");
  assert.equal(productionProof.proof.proof.attributionStatus, "not_established");
  assert.ok(runtime.closures.listOneValueClosures(proofBaseline.accepted.id)
    .some((record) => record.closure.valueClosureId === verifiedBaseline.value.closure.valueClosureId));
  assert.ok(runtime.closures.listOneValueClosures(proofCurrent.accepted.id)
    .some((record) => record.closure.valueClosureId === verifiedCurrent.value.closure.valueClosureId));
  assert.equal(JSON.stringify(runtime.closures.getOneValueClosureState()).includes(base), false,
    "public Value Closure state must never contain the private artifact path");

  const race = prepareAcceptedTask(runtime, "Concurrent exact acceptance", "run_accepted_result_race");
  const finalState = runtime.closures.getOneValueClosureState();
  console.log(JSON.stringify({
    ok: true,
    firstClosureId: closure.valueClosureId,
    firstTaskId: first.accepted.id,
    raceTaskId: race.accepted.id,
    racePriorTaskVersion: race.partial.version,
    raceAcceptedTaskVersion: race.accepted.version,
    raceRunId: race.receipt.runId,
    seededStoreVersion: finalState.version,
    seededClosureCount: finalState.closures.length,
    verifiedTaskId: verifiedMedia.accepted.id,
    verifiedClosureId: verifiedResult.value.closure.valueClosureId,
    productionProofTaskId: proofCurrent.accepted.id,
    productionProofId: productionProof.proof.proof.improvementProofId,
  }));
  db.close();
  app.quit();
}

async function raceWorker() {
  const { app, db } = await openStore();
  const runtime = loadRuntime();
  const taskId = argument("--task-id");
  const runId = argument("--run-id");
  const priorTaskVersion = Number(argument("--prior-task-version"));
  const acceptedTask = runtime.tasks.getCanonicalTask(taskId);
  const receipt = runtime.runEvents.getInvocationRunReceipt(runId);
  const result = runtime.acceptedClosures.ensureAcceptedResultValueClosure({
    priorTaskVersion,
    acceptedTask,
    expectedRunId: runId,
    receipt,
    confirmedByUser: true,
  });
  console.log(JSON.stringify({
    ok: true,
    closureId: result.value.closure.valueClosureId,
    storeVersion: result.storeVersion,
  }));
  db.close();
  app.quit();
}

async function reloadWorker() {
  const { app, db } = await openStore();
  const runtime = loadRuntime();
  const raceTaskId = argument("--race-task-id");
  const raceClosureId = argument("--race-closure-id");
  const verifiedTaskId = argument("--verified-task-id");
  const verifiedClosureId = argument("--verified-closure-id");
  const expectedClosures = Number(argument("--expected-closures"));
  const state = runtime.closures.getOneValueClosureState();
  assert.equal(state.closures.length, expectedClosures, "all accepted and verified closures must survive restart");
  const records = runtime.closures.listOneValueClosures(raceTaskId);
  assert.equal(records.length, 1);
  assert.equal(records[0].closure.valueClosureId, raceClosureId);
  assert.equal(records[0].closure.outcomeStatus, "partially_verified");
  const events = runtime.domainEvents.listOneDomainEvents(raceClosureId, 20);
  assert.equal(events.filter((event) => event.eventType === "value_closure.ready").length, 1);
  const raceEvidence = state.evidence.filter((item) => records[0].trustedEvidenceRefs.includes(item.evidenceRef));
  assert.equal(raceEvidence.length, 2);
  for (const item of raceEvidence) {
    assert.equal(
      runtime.domainEvents.listOneDomainEvents(item.evidenceRef, 20)
        .filter((event) => event.eventType === "receipt.recorded").length,
      1,
    );
  }
  const restoredVerified = runtime.closures.listOneValueClosures(verifiedTaskId)
    .find((record) => record.closure.valueClosureId === verifiedClosureId);
  assert.ok(restoredVerified);
  assert.equal(restoredVerified.closure.outcomeStatus, "verified");
  console.log(JSON.stringify({ ok: true, restoredAfterRestart: true, closures: state.closures.length }));
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
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-one-accepted-result-"));
  const storePath = path.join(temp, "accepted-result.sqlite");
  const env = { ...process.env, AGENTLAS_STORE_PATH: storePath };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const seed = spawnSync(
      executable,
      [__filename, "--seed", `--base=${path.join(temp, "artifacts")}`, `--user-data=${path.join(temp, "seed-user-data")}`],
      { env, encoding: "utf8" },
    );
    if (seed.status !== 0) throw new Error(`Accepted-result seed failed (${seed.status})\n${seed.stdout}\n${seed.stderr}`);
    process.stdout.write(seed.stdout);
    const seeded = parseLastJson(seed.stdout);

    const common = [
      __filename,
      "--race",
      `--task-id=${seeded.raceTaskId}`,
      `--run-id=${seeded.raceRunId}`,
      `--prior-task-version=${seeded.racePriorTaskVersion}`,
    ];
    const [raceA, raceB] = await Promise.all([
      runAsync(executable, [...common, `--user-data=${path.join(temp, "race-a")}`], env),
      runAsync(executable, [...common, `--user-data=${path.join(temp, "race-b")}`], env),
    ]);
    if (raceA.status !== 0 || raceB.status !== 0) {
      throw new Error(`Accepted-result race failed\nA:${raceA.stdout}\n${raceA.stderr}\nB:${raceB.stdout}\n${raceB.stderr}`);
    }
    const outcomes = [parseLastJson(raceA.stdout), parseLastJson(raceB.stdout)];
    assert.ok(outcomes.every((item) => item.ok), "both idempotent concurrent callers must converge successfully");
    assert.equal(new Set(outcomes.map((item) => item.closureId)).size, 1);
    const raceClosureId = outcomes[0].closureId;
    process.stdout.write(`${JSON.stringify({ ok: true, concurrentIdempotency: outcomes })}\n`);

    const reload = spawnSync(
      executable,
      [
        __filename,
        "--reload",
        `--race-task-id=${seeded.raceTaskId}`,
        `--race-closure-id=${raceClosureId}`,
        `--verified-task-id=${seeded.verifiedTaskId}`,
        `--verified-closure-id=${seeded.verifiedClosureId}`,
        `--expected-closures=${seeded.seededClosureCount + 1}`,
        `--user-data=${path.join(temp, "reload-user-data")}`,
      ],
      { env, encoding: "utf8" },
    );
    if (reload.status !== 0) throw new Error(`Accepted-result reload failed (${reload.status})\n${reload.stdout}\n${reload.stderr}`);
    process.stdout.write(reload.stdout);

    const ipcSource = fs.readFileSync(path.join(__dirname, "../electron/ipc.ts"), "utf8");
    const authoritySource = fs.readFileSync(path.join(__dirname, "../electron/mobile-bridge/authority.ts"), "utf8");
    assert.match(ipcSource, /acceptCanonicalTaskResult[\s\S]{0,800}ensureAcceptedResultValueClosure[\s\S]{0,900}ensureVerifiedAcceptedResultValueClosure[\s\S]{0,2400}ensureOneExperienceReuseReceipt/);
    assert.match(authoritySource, /case "tasks\.acceptResult"[\s\S]{0,1400}ensureAcceptedResultValueClosure[\s\S]{0,900}ensureVerifiedAcceptedResultValueClosure[\s\S]{0,3000}ensureOneExperienceReuseReceipt/);
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
