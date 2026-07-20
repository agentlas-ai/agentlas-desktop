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

let verifiedMemorySource = null;

function proposal(storeVersion, key, preview, basis = "inferred") {
  assert.ok(verifiedMemorySource, "verified source fixture must be initialized");
  return {
    expectedStoreVersion: storeVersion,
    normalizedPreview: preview,
    scope: "personal",
    source: {
      ...verifiedMemorySource,
      sourceRef: `source_${key.replace(/[^A-Za-z0-9]/g, "_")}`,
      evidenceRefs: [`evidence_${key.replace(/[^A-Za-z0-9]/g, "_")}`],
      basis,
    },
    suppressionKey: key,
  };
}

async function seedWorker() {
  const { app, db } = await openStore();
  const storePath = process.env.AGENTLAS_STORE_PATH;
  assert.ok(storePath && fs.existsSync(storePath));
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(storePath).mode & 0o077, 0, "the existing SQLite store must remain mode 0600");
  }
  const memory = require("../dist/electron/one/memory-candidates.js");
  const detector = require("../dist/electron/one/memory-detector.js");
  const domainEvents = require("../dist/electron/one/domain-events.js");
  const runEvents = require("../dist/electron/store/run-events.js");
  const acceptedClosures = require("../dist/electron/one/accepted-result-value-closure.js");
  const chats = require("../dist/electron/store/chats.js");
  const tasks = require("../dist/electron/store/tasks.js");
  db.prepare(
    `INSERT INTO installed_agents (
       id, slug, name, name_en, tagline, tagline_en, system_prompt,
       mcp_servers_json, env_requirements_json, preferred_backend,
       trust_grade, installed_at, tone, builtin, role, visibility, entity_kind
     ) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', '[]', NULL, 'A', ?, 'neutral', 0, NULL, 'visible', 'agent')`,
  ).run(
    "agent-memory-use-once",
    "agent-memory-use-once",
    "One Memory Use Once",
    "One Memory Use Once",
    "Ephemeral claim fixture",
    "Ephemeral claim fixture",
    "Exercise the exact one-time Memory boundary.",
    "2026-07-18T00:00:00.000Z",
  );

  const sourceChat = chats.createChat({
    agentId: "agent-memory-use-once",
    title: "Verified Memory provenance source",
    taskMode: "task",
  });
  const sourceInitial = tasks.findCanonicalTaskForChat(sourceChat.id);
  assert.ok(sourceInitial);
  const sourcePartial = tasks.setCanonicalTaskStatus(sourceInitial.id, "partial");
  domainEvents.recordOneDomainEvent({
    eventType: "task.state_changed",
    occurredAt: sourcePartial.updatedAt,
    actor: "system",
    entityId: sourcePartial.id,
    taskId: sourcePartial.id,
    version: sourcePartial.version,
    visibility: "personal",
    entries: [
      { name: "from", value: sourceInitial.status },
      { name: "to", value: "partial" },
      { name: "reason", value: "authoritative invocation lifecycle" },
    ],
  });
  const sourceRunId = "run_memory_verified_source";
  runEvents.recordRunEvent({ runId: sourceRunId, kind: "invoke_started", chatId: sourceChat.id });
  domainEvents.recordOneDomainEvent({
    eventType: "run.started",
    actor: "one",
    entityId: sourceRunId,
    taskId: sourcePartial.id,
    version: 1,
    visibility: "personal",
    entries: [
      { name: "runId", value: sourceRunId },
      { name: "policyVersion", value: "agentlas-one-runtime-v1" },
    ],
  });
  runEvents.recordRunEvent({ runId: sourceRunId, kind: "invoke_completed", chatId: sourceChat.id });
  const sourceReceipt = runEvents.getInvocationRunReceipt(sourceRunId);
  const sourceAccepted = tasks.acceptCanonicalTaskResult({
    taskId: sourcePartial.id,
    expectedVersion: sourcePartial.version,
    expectedRunId: sourceRunId,
  }, sourceReceipt);
  const sourceClosure = acceptedClosures.ensureAcceptedResultValueClosure({
    priorTaskVersion: sourcePartial.version,
    acceptedTask: sourceAccepted,
    expectedRunId: sourceRunId,
    receipt: sourceReceipt,
    confirmedByUser: true,
  });
  verifiedMemorySource = {
    provenanceStatus: "verified",
    sourceTaskId: sourceAccepted.id,
    sourceTaskVersion: sourceAccepted.version,
    sourceRunId,
    sourceValueClosureId: sourceClosure.value.closure.valueClosureId,
    sourceValueClosureVersion: sourceClosure.value.version,
  };
  db.prepare(
    `INSERT INTO installed_agents (
       id, slug, name, name_en, tagline, tagline_en, system_prompt,
       mcp_servers_json, env_requirements_json, preferred_backend,
       trust_grade, installed_at, tone, builtin, role, visibility, entity_kind
     ) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', '[]', NULL, 'A', ?, 'neutral', 0, NULL, 'visible', 'agent')`,
  ).run(
    "agent-memory-changed",
    "agent-memory-changed",
    "Changed Memory Binding",
    "Changed Memory Binding",
    "Binding mismatch fixture",
    "Binding mismatch fixture",
    "Exercise changed binding rejection.",
    "2026-07-18T00:00:00.000Z",
  );

  assert.deepEqual(detector.detectExplicitOneMemoryIntent("앞으로는 결론과 근거를 먼저 보여줘."), {
    normalizedPreview: "결론과 근거를 먼저 보여줘",
    suppressionKey: detector.detectExplicitOneMemoryIntent("앞으로는 결론과 근거를 먼저 보여줘.").suppressionKey,
    basis: "explicit_user_statement",
  });
  assert.equal(detector.detectExplicitOneMemoryIntent("아니, 앞으로는 표보다 결론을 먼저 보여줘.").basis, "user_correction");
  assert.equal(detector.detectExplicitOneMemoryIntent("Please remember that I prefer the decision before detail.").normalizedPreview, "I prefer the decision before detail");
  assert.equal(detector.detectExplicitOneMemoryIntent("I prefer concise reports."), null, "ordinary preference text must not be inferred as Memory");
  assert.equal(detector.detectExplicitOneMemoryIntent("기억해줘: /Users/mason/private/customer.csv를 먼저 읽어"), null, "local paths must fail quiet");
  assert.equal(detector.detectExplicitOneMemoryIntent("Remember that password=secret-value"), null, "secret-like text must fail quiet");

  const initial = memory.getOneMemoryState();
  assert.equal(initial.candidates.length, 0);
  assert.equal(initial.memories.length, 0);

  const pendingChat = chats.createChat({
    agentId: "agent-memory-use-once",
    title: "Pending provenance seal",
    taskMode: "task",
  });
  const pendingInitial = tasks.findCanonicalTaskForChat(pendingChat.id);
  const pendingPartial = tasks.setCanonicalTaskStatus(pendingInitial.id, "partial");
  domainEvents.recordOneDomainEvent({
    eventType: "task.state_changed",
    occurredAt: pendingPartial.updatedAt,
    actor: "system",
    entityId: pendingPartial.id,
    taskId: pendingPartial.id,
    version: pendingPartial.version,
    visibility: "personal",
    entries: [
      { name: "from", value: pendingInitial.status },
      { name: "to", value: "partial" },
      { name: "reason", value: "authoritative invocation lifecycle" },
    ],
  });
  const pendingRunId = "run_memory_pending_seal";
  runEvents.recordRunEvent({ runId: pendingRunId, kind: "invoke_started", chatId: pendingChat.id });
  domainEvents.recordOneDomainEvent({
    eventType: "run.started",
    actor: "one",
    entityId: pendingRunId,
    taskId: pendingPartial.id,
    version: 1,
    visibility: "personal",
    entries: [
      { name: "runId", value: pendingRunId },
      { name: "policyVersion", value: "agentlas-one-runtime-v1" },
    ],
  });
  runEvents.recordRunEvent({ runId: pendingRunId, kind: "invoke_completed", chatId: pendingChat.id });
  const pendingProposal = memory.proposeUnverifiedOneMemoryCandidateFromRun({
    expectedStoreVersion: initial.version,
    normalizedPreview: "Keep this candidate pending until exact result acceptance.",
    scope: "personal",
    sourceTaskId: pendingPartial.id,
    sourceRunId: pendingRunId,
    basis: "explicit_user_statement",
    suppressionKey: "memory-key:pending-seal",
  });
  assert.equal(pendingProposal.value.source.provenanceStatus, "legacy_unversioned");
  assert.throws(() => memory.saveOneMemoryCandidate({
    expectedStoreVersion: pendingProposal.storeVersion,
    candidateId: pendingProposal.value.id,
    expectedCandidateVersion: pendingProposal.value.version,
    approvedByUser: true,
  }), /Accept this Task result/);
  const pendingReceipt = runEvents.getInvocationRunReceipt(pendingRunId);
  const pendingAccepted = tasks.acceptCanonicalTaskResult({
    taskId: pendingPartial.id,
    expectedVersion: pendingPartial.version,
    expectedRunId: pendingRunId,
  }, pendingReceipt);
  const pendingClosure = acceptedClosures.ensureAcceptedResultValueClosure({
    priorTaskVersion: pendingPartial.version,
    acceptedTask: pendingAccepted,
    expectedRunId: pendingRunId,
    receipt: pendingReceipt,
    confirmedByUser: true,
  });
  const sealed = memory.sealOneMemoryCandidateProvenance({
    sourceTaskId: pendingAccepted.id,
    sourceTaskVersion: pendingAccepted.version,
    sourceRunId: pendingRunId,
    sourceValueClosureId: pendingClosure.value.closure.valueClosureId,
    sourceValueClosureVersion: pendingClosure.value.version,
  });
  assert.equal(sealed.value.length, 1);
  assert.equal(sealed.value[0].source.provenanceStatus, "verified");
  const removedSealed = memory.deleteOneMemoryCandidate({
    expectedStoreVersion: sealed.storeVersion,
    candidateId: sealed.value[0].id,
    expectedCandidateVersion: sealed.value[0].version,
    confirmedByUser: true,
  });

  const inferred = memory.proposeOneMemoryCandidate(proposal(
    removedSealed.storeVersion,
    "memory-key:report-format",
    "Put the decision and evidence before supporting detail.",
  ));
  assert.equal(inferred.value.status, "pending");
  assert.equal(inferred.value.source.basis, "inferred");
  assert.equal(memory.listOneMemoryAssets(true).length, 0, "inference must never auto-promote to Memory");
  assert.throws(
    () => memory.saveOneMemoryCandidate({
      expectedStoreVersion: inferred.storeVersion,
      candidateId: inferred.value.id,
      expectedCandidateVersion: inferred.value.version,
      approvedByUser: false,
    }),
    /explicit user approval/,
  );
  assert.throws(
    () => memory.proposeOneMemoryCandidate({
      ...proposal(inferred.storeVersion, "memory-key:extra", "This is otherwise valid."),
      rawPrivateFileContents: "forbidden",
    }),
    /unsupported fields/,
    "the closed proposal schema must reject raw private payload fields",
  );
  for (const [text, reason] of [
    ["Use password=secret-value on the next run.", "secret"],
    ["Read /Users/mason/private/customer.csv before answering.", "local_path"],
    ["https://private.example.test/customer-record", "transport_or_markup"],
    ["user: private transcript\nassistant: copied answer", "raw_transcript"],
  ]) {
    assert.throws(
      () => memory.proposeOneMemoryCandidate(proposal(inferred.storeVersion, `memory-key:${reason}`, text)),
      new RegExp(reason),
    );
  }
  assert.equal(memory.getOneMemoryState().version, inferred.storeVersion, "invalid candidates must not mutate state");
  assert.throws(
    () => memory.proposeOneMemoryCandidate(proposal(initial.version, "memory-key:stale", "Stale writes must fail.")),
    /One Memory state changed/,
  );

  const saved = memory.editAndSaveOneMemoryCandidate({
    expectedStoreVersion: inferred.storeVersion,
    candidateId: inferred.value.id,
    expectedCandidateVersion: inferred.value.version,
    content: "Lead with the decision, then cite the evidence used.",
    scope: "personal",
    approvedByUser: true,
  });
  assert.equal(saved.value.candidate.status, "saved");
  assert.equal(saved.value.memory.approvalSource, "explicit_user");
  assert.equal(saved.value.memory.content, "Lead with the decision, then cite the evidence used.");
  assert.deepEqual(saved.value.memory.evidenceRefs, inferred.value.source.evidenceRefs);
  assert.deepEqual({
    provenanceStatus: saved.value.memory.provenanceStatus,
    sourceTaskId: saved.value.memory.sourceTaskId,
    sourceTaskVersion: saved.value.memory.sourceTaskVersion,
    sourceRunId: saved.value.memory.sourceRunId,
    sourceValueClosureId: saved.value.memory.sourceValueClosureId,
    sourceValueClosureVersion: saved.value.memory.sourceValueClosureVersion,
  }, verifiedMemorySource, "saved Memory must copy the exact immutable source tuple");

  const onceCandidate = memory.proposeOneMemoryCandidate(proposal(
    saved.storeVersion,
    "memory-key:one-time-budget",
    "Use a temporary budget ceiling of 500 dollars for this Task.",
    "explicit_user_statement",
  ));
  const targetChat = chats.createChat({
    agentId: "agent-memory-use-once",
    title: "Task-free one-time Memory target",
    taskMode: "conversation",
  });
  const wrongChat = chats.createChat({
    agentId: "agent-memory-use-once",
    title: "Wrong one-time Memory target",
    taskMode: "conversation",
  });
  assert.equal(tasks.findCanonicalTaskForChat(targetChat.id), null, "issuing use-once must not promote a conversation to Task");
  const assetCountBeforeOnce = memory.listOneMemoryAssets(true).length;
  const once = memory.useOneMemoryCandidateOnce({
    expectedStoreVersion: onceCandidate.storeVersion,
    candidateId: onceCandidate.value.id,
    expectedCandidateVersion: onceCandidate.value.version,
    target: {
      chatId: targetChat.id,
      expectedTaskId: null,
      expectedTaskVersion: null,
    },
    confirmedByUser: true,
  });
  assert.equal(once.value.persisted, false);
  assert.deepEqual(Object.keys(once.value).sort(), [
    "contractVersion", "expiresAt", "issuedAt", "persisted", "receiptId",
  ], "renderer receipt must contain only opaque capability metadata");
  assert.equal(JSON.stringify(once.value).includes("temporary budget ceiling"), false, "renderer receipt must never carry the original");
  assert.equal(memory.listOneMemoryAssets(true).length, assetCountBeforeOnce, "Use once must create no durable Memory asset");
  const stateAfterOnce = memory.getOneMemoryState();
  assert.equal(stateAfterOnce.candidates.find((item) => item.id === onceCandidate.value.id).status, "used_once");
  assert.equal(JSON.stringify(stateAfterOnce).includes("temporary budget ceiling"), false, "Use once content must not survive in the durable candidate ledger");
  assert.equal(JSON.stringify(stateAfterOnce).includes(once.value.receiptId), false, "ephemeral use-once receipt must not persist");
  assert.equal(
    JSON.stringify(domainEvents.listOneDomainEvents(onceCandidate.value.id, 20)).includes("temporary budget ceiling"),
    false,
    "the append-only domain ledger must not retain use-once candidate text",
  );
  assert.equal(tasks.findCanonicalTaskForChat(targetChat.id), null, "preparing use-once must keep a general conversation Task-free");
  const onceRef = { contractVersion: once.value.contractVersion, receiptId: once.value.receiptId };
  assert.throws(
    () => memory.prepareOneMemoryUseOnceClaim(onceRef, wrongChat.id),
    /different conversation/,
  );
  db.prepare("UPDATE chats SET agent_id = ? WHERE id = ?").run("agent-memory-changed", targetChat.id);
  assert.throws(
    () => memory.prepareOneMemoryUseOnceClaim(onceRef, targetChat.id),
    /binding changed/,
    "agent/team/project bindings must be re-derived by Main at claim time",
  );
  db.prepare("UPDATE chats SET agent_id = ? WHERE id = ?").run("agent-memory-use-once", targetChat.id);
  const preparedOnce = memory.prepareOneMemoryUseOnceClaim(onceRef, targetChat.id);
  assert.match(preparedOnce.context, /temporary budget ceiling/, "only Main's prepared invocation context may contain the original");
  assert.equal(JSON.stringify(preparedOnce).includes("password="), false);
  const claimedOnce = memory.claimPreparedOneMemoryUseOnce(preparedOnce);
  assert.equal(claimedOnce.receiptId, once.value.receiptId);
  assert.equal(tasks.findCanonicalTaskForChat(targetChat.id), null, "claiming use-once must not manufacture a Task");
  assert.throws(
    () => memory.prepareOneMemoryUseOnceClaim(onceRef, targetChat.id),
    /unavailable|already used/,
    "an accepted claim must be atomic and single-use",
  );

  const expiryCandidate = memory.proposeOneMemoryCandidate(proposal(
    once.storeVersion,
    "memory-key:one-time-expiry",
    "Use this sentence only before its one-time receipt expires.",
    "explicit_user_statement",
  ));
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  const realDateNow = Date.now;
  let evictionCallback = null;
  let evictionDelay = null;
  let evictionUnrefCalled = false;
  let expiry;
  global.setTimeout = (callback, delay) => {
    evictionCallback = callback;
    evictionDelay = delay;
    return { unref: () => { evictionUnrefCalled = true; } };
  };
  global.clearTimeout = () => {};
  try {
    expiry = memory.useOneMemoryCandidateOnce({
      expectedStoreVersion: expiryCandidate.storeVersion,
      candidateId: expiryCandidate.value.id,
      expectedCandidateVersion: expiryCandidate.value.version,
      target: {
        chatId: targetChat.id,
        expectedTaskId: null,
        expectedTaskVersion: null,
      },
      confirmedByUser: true,
    });
    assert.equal(typeof evictionCallback, "function", "grant issuance must schedule real TTL eviction");
    assert.ok(evictionDelay > 0 && evictionDelay <= 60 * 60 * 1_000, "eviction timer must be bounded by the grant TTL");
    assert.equal(evictionUnrefCalled, true, "an idle grant timer must not keep Desktop alive");
    Date.now = () => Date.parse(expiry.value.expiresAt) + 1;
    evictionCallback();
  } finally {
    Date.now = realDateNow;
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
  }
  const expiryRef = { contractVersion: expiry.value.contractVersion, receiptId: expiry.value.receiptId };
  assert.throws(
    () => memory.prepareOneMemoryUseOnceClaim(expiryRef, targetChat.id),
    /unavailable|expired/,
    "timer eviction must remove the original even when no later grant or claim occurs",
  );

  const taskChat = chats.createChat({
    agentId: "agent-memory-use-once",
    title: "Task-bound one-time Memory target",
    taskMode: "task",
  });
  const exactTask = tasks.findCanonicalTaskForChat(taskChat.id);
  assert.ok(exactTask);
  const taskBoundCandidate = memory.proposeOneMemoryCandidate(proposal(
    expiry.storeVersion,
    "memory-key:one-time-task-version",
    "Apply this only to the exact canonical Task version.",
    "explicit_user_statement",
  ));
  const taskBoundReceipt = memory.useOneMemoryCandidateOnce({
    expectedStoreVersion: taskBoundCandidate.storeVersion,
    candidateId: taskBoundCandidate.value.id,
    expectedCandidateVersion: taskBoundCandidate.value.version,
    target: {
      chatId: taskChat.id,
      expectedTaskId: exactTask.id,
      expectedTaskVersion: exactTask.version,
    },
    confirmedByUser: true,
  });
  const changedTask = tasks.setCanonicalTaskStatus(exactTask.id, "running");
  assert.notEqual(changedTask.version, exactTask.version);
  const taskBoundRef = {
    contractVersion: taskBoundReceipt.value.contractVersion,
    receiptId: taskBoundReceipt.value.receiptId,
  };
  assert.throws(
    () => memory.prepareOneMemoryUseOnceClaim(taskBoundRef, taskChat.id),
    /Task changed/,
    "the capability must fail closed when its exact canonical Task version changes",
  );

  const invocationChat = chats.createChat({
    agentId: "agent-memory-use-once",
    title: "Production invocation use-once target",
    taskMode: "task",
  });
  const invocationTask = tasks.findCanonicalTaskForChat(invocationChat.id);
  assert.ok(invocationTask);
  const invocationCandidate = memory.proposeOneMemoryCandidate(proposal(
    taskBoundReceipt.storeVersion,
    "memory-key:one-time-production-invocation",
    "One-time invocation integration marker for Main context only.",
    "explicit_user_statement",
  ));
  const invocationReceipt = memory.useOneMemoryCandidateOnce({
    expectedStoreVersion: invocationCandidate.storeVersion,
    candidateId: invocationCandidate.value.id,
    expectedCandidateVersion: invocationCandidate.value.version,
    target: {
      chatId: invocationChat.id,
      expectedTaskId: invocationTask.id,
      expectedTaskVersion: invocationTask.version,
    },
    confirmedByUser: true,
  });
  const invocationRef = {
    contractVersion: invocationReceipt.value.contractVersion,
    receiptId: invocationReceipt.value.receiptId,
  };
  const mcpClient = require("../dist/electron/mcp/client.js");
  let capturedInvocation = null;
  let capturedSink = null;
  mcpClient.runMcpInvocation = (request, sink) => {
    capturedInvocation = request;
    capturedSink = sink;
    return Promise.resolve({});
  };
  const { InvocationService } = require("../dist/electron/invocation/service.js");
  const invocationService = new InvocationService();
  const invocationRunId = "11111111-1111-4111-8111-111111111111";
  invocationService.start({
    runId: invocationRunId,
    chatId: invocationChat.id,
    userPrompt: "Apply the one-time instruction to this exact Task.",
    taskIntent: "task",
    oneMode: true,
    oneMemoryUseOnceRef: invocationRef,
    locale: "en",
    permissions: "read",
  });
  assert.ok(capturedInvocation, "the production InvocationService must dispatch the accepted run");
  assert.match(capturedInvocation.oneProfileContext, /One-time invocation integration marker/);
  assert.equal("oneMemoryUseOnceRef" in capturedInvocation, false, "the opaque renderer ref must not be forwarded to a runtime");
  const durableStartRow = db.prepare(
    "SELECT payload_json FROM run_events WHERE run_id = ? AND kind = ? ORDER BY seq DESC LIMIT 1",
  ).get(invocationRunId, "invoke_started");
  assert.ok(durableStartRow);
  assert.equal(JSON.parse(durableStartRow.payload_json).oneMemoryUseOnceReceiptId, invocationReceipt.value.receiptId);
  assert.equal(durableStartRow.payload_json.includes("One-time invocation integration marker"), false, "durable acceptance evidence must contain no original text");
  const claimRow = db.prepare(
    "SELECT payload_json FROM run_events WHERE run_id = ? AND kind = ? ORDER BY seq DESC LIMIT 1",
  ).get(invocationRunId, "one_memory_use_once_claimed");
  assert.ok(claimRow, "actual production consumption must write a run receipt");
  assert.equal(claimRow.payload_json.includes("One-time invocation integration marker"), false, "claim evidence must contain no original text");
  const claimDomainEvents = domainEvents.listOneDomainEvents(invocationReceipt.value.receiptId, 10);
  assert.ok(claimDomainEvents.some((event) => event.eventType === "receipt.recorded"), "Task-bound claim must write domain evidence");
  capturedSink({ kind: "error", error: { code: "fixture-runtime-failure", message: "Bounded fixture failure." } });
  assert.throws(
    () => invocationService.start({
      runId: "22222222-2222-4222-8222-222222222222",
      chatId: invocationChat.id,
      userPrompt: "Do not auto-retry the claimed one-time instruction.",
      taskIntent: "task",
      oneMode: true,
      oneMemoryUseOnceRef: invocationRef,
      locale: "en",
      permissions: "read",
    }),
    /unavailable|already used/,
    "a runtime failure after accepted start must never restore or auto-retry the claim",
  );

  const rejectCandidate = memory.proposeOneMemoryCandidate(proposal(
    invocationReceipt.storeVersion,
    "memory-key:rejected-tone",
    "Use a playful tone for formal release notes.",
  ));
  const rejected = memory.rejectOneMemoryCandidate({
    expectedStoreVersion: rejectCandidate.storeVersion,
    candidateId: rejectCandidate.value.id,
    expectedCandidateVersion: rejectCandidate.value.version,
    rejectedByUser: true,
    cooldownMs: 60 * 60 * 1_000,
  });
  assert.equal(rejected.value.status, "rejected");
  assert.ok(Date.parse(rejected.value.cooldownUntil) > Date.now());
  assert.throws(
    () => memory.proposeOneMemoryCandidate(proposal(
      rejected.storeVersion,
      "memory-key:rejected-tone",
      "Use a playful tone for formal release notes.",
    )),
    /suppressed until/,
  );
  assert.equal(memory.getOneMemoryState().version, rejected.storeVersion, "suppressed proposals must not mutate state");

  const deleteCandidate = memory.proposeOneMemoryCandidate(proposal(
    rejected.storeVersion,
    "memory-key:delete-candidate",
    "Prefer a temporary outline for the next report.",
  ));
  const deletedCandidate = memory.deleteOneMemoryCandidate({
    expectedStoreVersion: deleteCandidate.storeVersion,
    candidateId: deleteCandidate.value.id,
    expectedCandidateVersion: deleteCandidate.value.version,
    confirmedByUser: true,
  });
  assert.equal(memory.getOneMemoryState().candidates.some((item) => item.id === deleteCandidate.value.id), false);

  const secondCandidate = memory.proposeOneMemoryCandidate(proposal(
    deletedCandidate.storeVersion,
    "memory-key:source-citations",
    "Always retain opaque evidence references with research conclusions.",
    "user_correction",
  ));
  const secondSaved = memory.saveOneMemoryCandidate({
    expectedStoreVersion: secondCandidate.storeVersion,
    candidateId: secondCandidate.value.id,
    expectedCandidateVersion: secondCandidate.value.version,
    approvedByUser: true,
  });

  const editedFirst = memory.updateOneMemoryAsset({
    expectedStoreVersion: secondSaved.storeVersion,
    memoryId: saved.value.memory.id,
    expectedMemoryVersion: saved.value.memory.version,
    content: "Lead with the decision and show only verified supporting evidence.",
    approvedByUser: true,
  });
  assert.ok(editedFirst.value.approvedAt > saved.value.memory.approvedAt);
  assert.deepEqual({
    provenanceStatus: editedFirst.value.provenanceStatus,
    sourceTaskId: editedFirst.value.sourceTaskId,
    sourceTaskVersion: editedFirst.value.sourceTaskVersion,
    sourceRunId: editedFirst.value.sourceRunId,
    sourceValueClosureId: editedFirst.value.sourceValueClosureId,
    sourceValueClosureVersion: editedFirst.value.sourceValueClosureVersion,
  }, verifiedMemorySource, "editing content must not rewrite Memory source provenance");
  assert.throws(
    () => memory.updateOneMemoryAsset({
      expectedStoreVersion: editedFirst.storeVersion,
      memoryId: editedFirst.value.id,
      expectedMemoryVersion: saved.value.memory.version,
      content: "This edit uses a stale asset version.",
      approvedByUser: true,
    }),
    /Memory changed/,
  );
  const disabled = memory.setOneMemoryAssetEnabled({
    expectedStoreVersion: editedFirst.storeVersion,
    memoryId: editedFirst.value.id,
    expectedMemoryVersion: editedFirst.value.version,
    enabled: false,
    confirmedByUser: true,
  });
  assert.equal(memory.buildApprovedOneMemoryContext().includes(editedFirst.value.content), false);
  const reenabled = memory.setOneMemoryAssetEnabled({
    expectedStoreVersion: disabled.storeVersion,
    memoryId: disabled.value.id,
    expectedMemoryVersion: disabled.value.version,
    enabled: true,
    confirmedByUser: true,
  });
  const deletedMemory = memory.deleteOneMemoryAsset({
    expectedStoreVersion: reenabled.storeVersion,
    memoryId: reenabled.value.id,
    expectedMemoryVersion: reenabled.value.version,
    confirmedByUser: true,
  });
  assert.equal(memory.listOneMemoryAssets(true).some((item) => item.id === reenabled.value.id), false);

  const createdEvents = domainEvents.listOneDomainEvents(inferred.value.id, 20);
  assert.ok(createdEvents.some((event) => event.eventType === "memory.candidate_created"));
  assert.ok(createdEvents.some((event) => event.eventType === "memory.resolved"));
  const deletedEvents = domainEvents.listOneDomainEvents(reenabled.value.id, 20);
  assert.ok(deletedEvents.some((event) => event.eventType === "memory.deleted"));

  const durable = memory.getOneMemoryState();
  assert.equal(durable.memories.length, 1);
  assert.equal(durable.memories[0].id, secondSaved.value.memory.id);
  assert.equal(JSON.stringify(durable).includes("improvementProof"), false, "Memory state must not manufacture improvement evidence");

  const raw = db.prepare("SELECT value FROM meta WHERE key = ?").get(memory.ONE_MEMORY_META_KEY).value;
  const legacyRaw = JSON.parse(raw);
  legacyRaw.candidates = legacyRaw.candidates.map((candidate) => ({
    ...candidate,
    source: {
      taskId: candidate.source.sourceTaskId,
      sourceRef: candidate.source.sourceRef,
      evidenceRefs: candidate.source.evidenceRefs,
      basis: candidate.source.basis,
    },
  }));
  legacyRaw.memories = legacyRaw.memories.map((asset) => {
    const {
      provenanceStatus, sourceTaskVersion, sourceRunId,
      sourceValueClosureId, sourceValueClosureVersion, ...legacyAsset
    } = asset;
    return legacyAsset;
  });
  db.prepare("UPDATE meta SET value = ? WHERE key = ?").run(JSON.stringify(legacyRaw), memory.ONE_MEMORY_META_KEY);
  const normalizedLegacy = memory.getOneMemoryState();
  assert.ok(normalizedLegacy.candidates.every((candidate) => candidate.source.provenanceStatus === "legacy_unversioned"));
  assert.ok(normalizedLegacy.memories.every((asset) =>
    asset.provenanceStatus === "legacy_unversioned"
    && asset.sourceTaskVersion === null
    && asset.sourceRunId === null
    && asset.sourceValueClosureId === null
    && asset.sourceValueClosureVersion === null));
  assert.equal(
    db.prepare("SELECT value FROM meta WHERE key = ?").get(memory.ONE_MEMORY_META_KEY).value,
    JSON.stringify(legacyRaw),
    "legacy normalization must be read-only until an explicit mutation",
  );
  db.prepare("UPDATE meta SET value = ? WHERE key = ?").run(raw, memory.ONE_MEMORY_META_KEY);

  const malformedProvenance = JSON.parse(raw);
  malformedProvenance.memories[0].sourceRunId = null;
  db.prepare("UPDATE meta SET value = ? WHERE key = ?").run(JSON.stringify(malformedProvenance), memory.ONE_MEMORY_META_KEY);
  assert.throws(() => memory.getOneMemoryState(), /closed contract/, "partially versioned provenance must fail closed");
  db.prepare("UPDATE meta SET value = ? WHERE key = ?").run(raw, memory.ONE_MEMORY_META_KEY);

  db.prepare("UPDATE meta SET value = ? WHERE key = ?").run("{not-json", memory.ONE_MEMORY_META_KEY);
  assert.throws(() => memory.getOneMemoryState(), /corrupt; it was not overwritten/);
  assert.equal(db.prepare("SELECT value FROM meta WHERE key = ?").get(memory.ONE_MEMORY_META_KEY).value, "{not-json");
  db.prepare("UPDATE meta SET value = ? WHERE key = ?").run(raw, memory.ONE_MEMORY_META_KEY);

  const beforeRestartGrant = memory.getOneMemoryState();
  const restartCandidate = memory.proposeOneMemoryCandidate(proposal(
    beforeRestartGrant.version,
    "memory-key:one-time-restart",
    "This one-time instruction must disappear after a Main process restart.",
    "explicit_user_statement",
  ));
  const restartReceipt = memory.useOneMemoryCandidateOnce({
    expectedStoreVersion: restartCandidate.storeVersion,
    candidateId: restartCandidate.value.id,
    expectedCandidateVersion: restartCandidate.value.version,
    target: {
      chatId: targetChat.id,
      expectedTaskId: null,
      expectedTaskVersion: null,
    },
    confirmedByUser: true,
  });
  const finalState = memory.getOneMemoryState();
  assert.equal(JSON.stringify(finalState).includes("must disappear after a Main process restart"), false);
  console.log(JSON.stringify({
    ok: true,
    storeVersion: finalState.version,
    memoryId: secondSaved.value.memory.id,
    memoryVersion: secondSaved.value.memory.version,
    candidates: finalState.candidates.length,
    memories: finalState.memories.length,
    restartReceiptId: restartReceipt.value.receiptId,
    restartTargetChatId: targetChat.id,
  }));
  db.close();
  app.quit();
}

async function raceWorker() {
  const { app, db } = await openStore();
  const memory = require("../dist/electron/one/memory-candidates.js");
  const content = argument("--content");
  try {
    const result = memory.updateOneMemoryAsset({
      expectedStoreVersion: Number(argument("--store-version")),
      memoryId: argument("--memory-id"),
      expectedMemoryVersion: Number(argument("--memory-version")),
      content,
      approvedByUser: true,
    });
    console.log(JSON.stringify({ success: true, content, storeVersion: result.storeVersion, memoryVersion: result.value.version }));
  } catch (error) {
    console.log(JSON.stringify({ success: false, content, error: error instanceof Error ? error.message : String(error) }));
  }
  db.close();
  app.quit();
}

async function reloadWorker() {
  const { app, db } = await openStore();
  const memory = require("../dist/electron/one/memory-candidates.js");
  const expectedContent = argument("--expected-content");
  const state = memory.getOneMemoryState();
  const asset = state.memories.find((item) => item.id === argument("--memory-id"));
  assert.ok(asset, "approved Memory must survive a fresh Electron process");
  assert.equal(asset.content, expectedContent);
  assert.equal(asset.approvalSource, "explicit_user");
  assert.equal(asset.provenanceStatus, "verified");
  assert.ok(Number.isSafeInteger(asset.sourceTaskVersion) && asset.sourceTaskVersion > 0);
  assert.equal(typeof asset.sourceRunId, "string");
  assert.match(asset.sourceValueClosureId, /^value_closure_[a-f0-9]{32}$/);
  assert.ok(Number.isSafeInteger(asset.sourceValueClosureVersion) && asset.sourceValueClosureVersion > 0);
  assert.equal(state.memories.length, 1, "Use once and rejected candidates must not create assets");
  assert.ok(state.candidates.some((item) => item.status === "used_once"));
  assert.ok(state.candidates.some((item) => item.status === "rejected"));
  const context = memory.buildApprovedOneMemoryContext();
  assert.match(context, /explicit user approvals only/);
  assert.match(context, /not evidence that a later result improved/);
  assert.equal(context.includes("temporary budget ceiling"), false);
  assert.throws(
    () => memory.prepareOneMemoryUseOnceClaim({
      contractVersion: "1.0.0",
      receiptId: argument("--restart-receipt-id"),
    }, argument("--restart-target-chat-id")),
    /unavailable|expired|restarted|already used/,
    "a fresh Main process must not restore an ephemeral use-once grant",
  );
  console.log(JSON.stringify({ ok: true, restoredAfterRestart: true, storeVersion: state.version, memoryVersion: asset.version }));
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
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-one-memory-runtime-"));
  const storePath = path.join(temp, "one-memory.sqlite");
  const env = { ...process.env, AGENTLAS_STORE_PATH: storePath };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const seed = spawnSync(
      executable,
      [__filename, "--seed", `--user-data=${path.join(temp, "seed-user-data")}`],
      { env, encoding: "utf8" },
    );
    if (seed.status !== 0) throw new Error(`One Memory seed failed (${seed.status})\n${seed.stdout}\n${seed.stderr}`);
    process.stdout.write(seed.stdout);
    const seeded = parseLastJson(seed.stdout);

    const contentA = "Race winner A preserves explicit approval and evidence.";
    const contentB = "Race winner B preserves exact optimistic concurrency.";
    const common = [
      __filename,
      "--race",
      `--store-version=${seeded.storeVersion}`,
      `--memory-id=${seeded.memoryId}`,
      `--memory-version=${seeded.memoryVersion}`,
    ];
    const [raceA, raceB] = await Promise.all([
      runAsync(executable, [...common, `--content=${contentA}`, `--user-data=${path.join(temp, "race-a")}`], env),
      runAsync(executable, [...common, `--content=${contentB}`, `--user-data=${path.join(temp, "race-b")}`], env),
    ]);
    if (raceA.status !== 0 || raceB.status !== 0) {
      throw new Error(`One Memory race process failed\nA:${raceA.stdout}\n${raceA.stderr}\nB:${raceB.stdout}\n${raceB.stderr}`);
    }
    const outcomes = [parseLastJson(raceA.stdout), parseLastJson(raceB.stdout)];
    assert.equal(outcomes.filter((item) => item.success).length, 1, "exactly one concurrent CAS writer must succeed");
    assert.equal(outcomes.filter((item) => !item.success).length, 1);
    assert.match(outcomes.find((item) => !item.success).error, /changed|concurrently|locked|busy/i);
    const winner = outcomes.find((item) => item.success);
    process.stdout.write(`${JSON.stringify({ ok: true, concurrentCas: outcomes })}\n`);

    const reload = spawnSync(
      executable,
      [
        __filename,
        "--reload",
        `--memory-id=${seeded.memoryId}`,
        `--expected-content=${winner.content}`,
        `--restart-receipt-id=${seeded.restartReceiptId}`,
        `--restart-target-chat-id=${seeded.restartTargetChatId}`,
        `--user-data=${path.join(temp, "reload-user-data")}`,
      ],
      { env, encoding: "utf8" },
    );
    if (reload.status !== 0) throw new Error(`One Memory reload failed (${reload.status})\n${reload.stdout}\n${reload.stderr}`);
    process.stdout.write(reload.stdout);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv.includes("--seed")) {
  seedWorker().then(() => process.exit(0)).catch((error) => {
    console.error(error);
    process.exit(1);
  });
} else if (process.argv.includes("--race")) {
  raceWorker().then(() => process.exit(0)).catch((error) => {
    console.error(error);
    process.exit(1);
  });
} else if (process.argv.includes("--reload")) {
  reloadWorker().then(() => process.exit(0)).catch((error) => {
    console.error(error);
    process.exit(1);
  });
} else {
  orchestrate().then(() => process.exit(0)).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
