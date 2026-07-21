#!/usr/bin/env node

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
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
  const store = require("../dist/electron/store/db.js");
  store.initStore();
  return { app, db: store.getDb() };
}

function insertAgentRow(db, id, slug, name = "One") {
  db.prepare(
    `INSERT OR IGNORE INTO installed_agents
       (id, slug, name, tagline, system_prompt, mcp_servers_json, trust_grade, installed_at, tone)
     VALUES (?, ?, ?, ?, '', '[]', 'A', ?, 'neutral')`,
  ).run(id, slug, name, "Chief of Staff", new Date().toISOString());
}

function insertAgent(db) {
  insertAgentRow(db, "one-improvement-producer-agent", "one-improvement-producer", "One");
}

let activeTaskForceRunner = null;

function installActualTaskForceRuntimeBoundary() {
  const detect = require("../dist/electron/runtime/detect.js");
  const selection = require("../dist/electron/runtime/selection.js");
  detect.detectRuntimes = async () => [{ ...ACTIVE_RUNTIME, ready: true }];
  selection.selectRuntimeForTargets = () => {
    if (!activeTaskForceRunner) throw new Error("actual task-force fake runner is not armed");
    return {
      active: { ...ACTIVE_RUNTIME, ready: true },
      picked: { runner: activeTaskForceRunner, label: "One actual task-force fixture runner" },
      override: null,
      unavailableOverride: null,
    };
  };
}

function runtime() {
  return {
    db: require("../dist/electron/store/db.js").getDb(),
    chats: require("../dist/electron/store/chats.js"),
    tasks: require("../dist/electron/store/tasks.js"),
    runs: require("../dist/electron/store/run-events.js"),
    events: require("../dist/electron/one/domain-events.js"),
    closures: require("../dist/electron/one/value-closure.js"),
    acceptedClosures: require("../dist/electron/one/accepted-result-value-closure.js"),
    memory: require("../dist/electron/one/memory-candidates.js"),
    reuse: require("../dist/electron/one/experience-reuse.js"),
    proof: require("../dist/electron/one/improvement-proof.js"),
    producer: require("../dist/electron/one/improvement-proof-producer.js"),
    taskKind: require("../dist/electron/one/task-kind.js"),
    preflight: require("../dist/electron/one/team-preflight.js"),
    groups: require("../dist/electron/store/agent-groups.js"),
    registry: require("../dist/electron/mcp/registry.js"),
    agentFiles: require("../dist/electron/agents/files.js"),
    taskForce: require("../dist/electron/mcp/borrowed-task-force.js"),
    InvocationService: require("../dist/electron/invocation/service.js").InvocationService,
    surfaceResults: require("../dist/electron/store/one-surface-results.js"),
  };
}

const WEEKLY_TASK_PROMPT = "Prepare the weekly comparison report from the exact approved input snapshot.";
const TEAM_TASK_PROMPT = "Ask one-improvement-researcher to research with my saved team, prepare the market report, and cross-check every source.";
const SURFACE_INTENT_MARKER = "<<surface-intent>>";
const PARSER_FAILURE_SAFE_FINAL = "I couldn't finish preparing this result safely. Ask me to try again below and I'll continue.";

function participantBindings(rt, agentIds) {
  const installedById = new Map(rt.registry.listInstalledAgentsReadOnly().map((agent) => [agent.id, agent]));
  const agents = agentIds.map((agentId) => installedById.get(agentId));
  assert.ok(agents.every(Boolean), "every test participant must be installed at run start");
  const bindings = rt.taskKind.deriveOneParticipantVersionBindings(agents);
  assert.ok(bindings, "participant version bindings must be derivable at run start");
  return bindings;
}

const ACTIVE_RUNTIME = Object.freeze({
  kind: "claude-code",
  backend: "anthropic",
  source: "/test/claude",
  version: "1.0.0",
  active: true,
  model: "test-model",
  longContextEnabled: false,
  effort: "medium",
});

function preflightDeps() {
  return { detectRuntimes: async () => [{ ...ACTIVE_RUNTIME }] };
}

function waitFor(predicate, timeoutMs = 8_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("timed out waiting for actual task-force invocation"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

async function waitForCompletedRun(service, runId, diagnostics = null, timeoutMs = 8_000) {
  await waitFor(() => {
    const status = service.receipt(runId)?.status;
    return status === "completed" || status === "failed" || status === "cancelled" || status === "interrupted";
  }, timeoutMs);
  const receipt = service.receipt(runId);
  assert.equal(receipt?.status, "completed", `actual task-force invocation failed: ${JSON.stringify({ receipt, diagnostics: diagnostics?.() ?? null })}`);
}

function onePixelPng() {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
    "base64",
  );
}

function supportedMediaSurfaceText(mediaPath) {
  const manifest = {
    version: "0.1",
    kind: "surface",
    title: "Verified saved-team deliverable",
    domain: "one-improvement-team",
    layout: "creative-studio",
    data: {
      deliverable: {
        type: "media",
        rows: [{
          artifactRef: "block:deliverable:artifact-1",
          type: "image",
          label: "Saved-team report preview",
          path: mediaPath,
          sizeBytes: fs.statSync(mediaPath).size,
          provenance: "generated",
        }],
      },
    },
    widgets: [{ type: "asset-board", data: "deliverable", title: "Verified deliverable" }],
  };
  return [
    "Verified saved-team synthesis.",
    "<<agentlas-surface>>",
    JSON.stringify(manifest),
    "<</agentlas-surface>>",
  ].join("\n");
}

function parserThrowSurfaceText(mediaPath) {
  const deepValue = `${'{"safe":'.repeat(12_000)}0${"}".repeat(12_000)}`;
  const body = `{"deep":${deepValue},"rawMediaPath":${JSON.stringify(mediaPath)},"version":"0.1","kind":"surface","title":"Deep parser fixture","domain":"one-improvement-team","layout":"creative-studio","data":{},"widgets":[]}`;
  return [
    "Untrusted parser-throw synthesis.",
    "<<agentlas-surface>>",
    body,
    "<</agentlas-surface>>",
  ].join("\n");
}

function prepareAcceptedTask(
  rt,
  title,
  runId,
  userTurns,
  memoryReceipt = null,
  startPatch = {},
  taskKindPrompt = title,
) {
  const chat = rt.chats.createChat({
    agentId: "one-improvement-producer-agent",
    title,
  });
  const initial = rt.tasks.getCanonicalTaskForChat(chat.id);
  const oneTaskKindRef = rt.taskKind.deriveOneTaskKindRef({
    userPrompt: taskKindPrompt,
    projectId: chat.projectId,
    firmId: chat.firmId,
    agentGroupId: chat.agentGroupId,
    ownerAgentId: chat.agentId,
    inputRefs: [],
  });
  assert.ok(oneTaskKindRef);
  rt.runs.recordRunEvent({
    runId,
    kind: "invoke_started",
    chatId: chat.id,
    agentId: "one-improvement-producer-agent",
    payload: {
      oneMode: true,
      oneTaskKindRef,
      oneParticipantVersionBindings: participantBindings(rt, [chat.agentId]),
      planMode: false,
      goalMode: false,
      appsGenerateMode: false,
      toolMode: "auto",
      hubMode: "local-only",
      oneTeamExecutionPolicy: "solo_locked",
      hasImages: false,
      hasOneAttachments: false,
      ...startPatch,
    },
  });
  rt.events.recordOneDomainEvent({
    eventType: "run.started",
    actor: "one",
    entityId: runId,
    taskId: initial.id,
    version: 1,
    visibility: "personal",
    entries: [
      { name: "runId", value: runId },
      { name: "policyVersion", value: "agentlas-one-runtime-v1" },
    ],
  });
  // Production persists the visible user request inside the execution path,
  // after the durable run start and before its terminal receipt.
  for (let index = 0; index < userTurns; index += 1) {
    rt.chats.appendChatMessage(chat.id, "user", `bounded instruction ${index + 1}`);
  }
  if (memoryReceipt) {
    rt.runs.recordRunEvent({
      runId,
      kind: "one_memory_context_applied",
      chatId: chat.id,
      payload: memoryReceipt,
    });
  }
  rt.runs.recordRunEvent({
    runId,
    kind: "invoke_completed",
    chatId: chat.id,
    agentId: "one-improvement-producer-agent",
    payload: {},
  });
  const beforePartial = rt.tasks.getCanonicalTaskForChat(chat.id);
  const partial = rt.tasks.setCanonicalTaskStatus(beforePartial.id, "partial");
  rt.events.recordOneDomainEvent({
    eventType: "task.state_changed",
    occurredAt: partial.updatedAt,
    actor: "system",
    entityId: partial.id,
    taskId: partial.id,
    version: partial.version,
    visibility: "personal",
    entries: [
      { name: "from", value: beforePartial.status },
      { name: "to", value: "partial" },
      { name: "reason", value: "authoritative invocation lifecycle" },
    ],
  });
  const receipt = rt.runs.getInvocationRunReceipt(runId);
  assert.ok(receipt && receipt.status === "completed" && receipt.finishedAt);
  const accepted = rt.tasks.acceptCanonicalTaskResult({
    taskId: partial.id,
    expectedVersion: partial.version,
    expectedRunId: runId,
  }, receipt);
  const partialClosure = rt.acceptedClosures.ensureAcceptedResultValueClosure({
    priorTaskVersion: partial.version,
    acceptedTask: accepted,
    expectedRunId: runId,
    receipt,
    confirmedByUser: true,
  });
  return { chat, accepted, receipt, partialClosure };
}

function verifiedClosure(rt, prepared, suffix) {
  const state = rt.closures.getOneValueClosureState();
  const execution = {
    evidenceRef: `evidence:${suffix}:execution`,
    receiptRef: `receipt:${suffix}:execution`,
    taskId: prepared.accepted.id,
    taskVersion: prepared.accepted.version,
    kind: "execution_receipt",
    source: "invocation_runtime",
    verificationStatus: "verified",
    observedAt: prepared.receipt.finishedAt,
    sourceRef: prepared.receipt.runId,
    sourceRunRef: prepared.receipt.runId,
  };
  const artifact = {
    evidenceRef: `evidence:${suffix}:artifact`,
    receiptRef: `receipt:${suffix}:artifact`,
    taskId: prepared.accepted.id,
    taskVersion: prepared.accepted.version,
    kind: "artifact_verification",
    source: "artifact_verifier",
    verificationStatus: "verified",
    observedAt: prepared.receipt.finishedAt,
    sourceRef: `source:${suffix}:artifact-verifier`,
    artifactRef: `artifact:${suffix}:verified`,
    sourceRunRef: prepared.receipt.runId,
  };
  const outcome = {
    evidenceRef: `evidence:${suffix}:outcome`,
    receiptRef: `receipt:${suffix}:outcome`,
    taskId: prepared.accepted.id,
    taskVersion: prepared.accepted.version,
    kind: "outcome_verification",
    source: "host_connector",
    verificationStatus: "verified",
    observedAt: prepared.receipt.finishedAt,
    sourceRef: `source:${suffix}:host-verifier`,
    outcomeRef: `outcome:${suffix}:verified`,
    sourceRunRef: prepared.receipt.runId,
  };
  return rt.closures.createOneValueClosure({
    expectedStoreVersion: state.version,
    trustedHostAttested: true,
    taskId: prepared.accepted.id,
    expectedTaskVersion: prepared.accepted.version,
    outcomeStatus: "verified",
    outcomeRefs: [outcome.outcomeRef],
    lifecycleClaims: [
      { phase: "discovery", status: "not_started", summary: "Discovery was not part of this verification.", evidenceRefs: [] },
      { phase: "preparation", status: "not_started", summary: "Preparation was not part of this verification.", evidenceRefs: [] },
      { phase: "execution", status: "completed", summary: "The exact bound run reached its durable terminal receipt.", evidenceRefs: [execution.evidenceRef] },
      { phase: "verification", status: "completed", summary: "The bound artifact and outcome passed their independent host checks.", evidenceRefs: [artifact.evidenceRef, outcome.evidenceRef] },
    ],
    valueItems: [{
      valueItemId: `value:${suffix}:verified`,
      kind: "fact",
      statement: "The bound deliverable passed artifact and host outcome verification.",
      evidenceRefs: [artifact.evidenceRef, outcome.evidenceRef],
    }],
    originalPreservation: { status: "not_applicable", artifactRefs: [], receiptRefs: [] },
    remainingWork: [],
    receiptRefs: [execution.receiptRef, artifact.receiptRef, outcome.receiptRef],
    reflectionEligible: false,
    trustedHostEvidence: [execution, artifact, outcome],
  });
}

function saveMemory(rt, source) {
  let state = rt.memory.getOneMemoryState();
  const proposed = rt.memory.proposeOneMemoryCandidate({
    expectedStoreVersion: state.version,
    normalizedPreview: "Use the approved comparison structure.",
    scope: "personal",
    source: {
      provenanceStatus: "verified",
      sourceTaskId: source.accepted.id,
      sourceTaskVersion: source.accepted.version,
      sourceRunId: source.receipt.runId,
      sourceValueClosureId: source.partialClosure.value.closure.valueClosureId,
      sourceValueClosureVersion: source.partialClosure.value.version,
      sourceRef: `source:verified-comparison-structure:${source.accepted.id}`,
      evidenceRefs: [`evidence:verified-comparison-structure:${source.accepted.id}`],
      basis: "explicit_user_statement",
    },
    suppressionKey: `suppression:verified-comparison-structure:${source.accepted.id}`,
  });
  state = rt.memory.getOneMemoryState();
  return rt.memory.saveOneMemoryCandidate({
    expectedStoreVersion: state.version,
    candidateId: proposed.value.id,
    expectedCandidateVersion: proposed.value.version,
    approvedByUser: true,
  }).value.memory;
}

function prepareVerifiedMemoryReuse(
  rt,
  memory,
  title,
  runId,
  userTurns,
  suffix,
  taskKindPrompt = title,
) {
  const memoryState = rt.memory.getOneMemoryState();
  const prepared = prepareAcceptedTask(rt, title, runId, userTurns, {
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
  }, {}, taskKindPrompt);
  const reuse = rt.reuse.ensureOneExperienceReuseReceipt({
    taskId: prepared.accepted.id,
    expectedTaskVersion: prepared.accepted.version,
    expectedTaskUpdatedAt: prepared.accepted.updatedAt,
    expectedRunId: prepared.receipt.runId,
    valueClosureId: prepared.partialClosure.value.closure.valueClosureId,
    expectedValueClosureVersion: prepared.partialClosure.value.version,
    confirmedByUser: true,
  });
  assert.ok(reuse);
  verifiedClosure(rt, prepared, suffix);
  return prepared;
}

async function finishAcceptedTeamChat(
  rt,
  chat,
  reservedRef,
  runId,
  userTurns,
  taskKindPrompt,
  tamperReceipt,
  mediaPath,
  scenario = "verified",
) {
  const plannerText = [
    "## Agent Input Packets",
    "```json",
    JSON.stringify({
      packets: [{
        agent: "installed:one-improvement-researcher",
        inputType: "research",
        inputKind: "text",
        brief: "Research the exact saved-team report inputs.",
        context: ["Use only the frozen local roster."],
        expectedOutput: "A concise evidence-backed research result.",
        constraints: ["Do not synthesize the final answer."],
      }],
    }),
    "```",
  ].join("\n");
  let modelCall = 0;
  const runnerRequests = [];
  const runner = async (request, events) => {
    runnerRequests.push(request);
    modelCall += 1;
    if (modelCall === 1) {
      return {
        text: scenario === "planner-fallback" ? "Planner output without the required packet contract." : plannerText,
        tokens: 2,
      };
    }
    if (modelCall === 2) {
      if (scenario === "failed-worker") throw new Error("fixture worker failure");
      return { text: "Verified researcher output.", tokens: 3 };
    }
    if (modelCall === 3) {
      const synthesisText = scenario === "parser-throw"
        ? parserThrowSurfaceText(mediaPath)
        : scenario === "marker-only"
        ? `${SURFACE_INTENT_MARKER}\nMarker-only team result.`
        : scenario === "multiple-surfaces"
          ? `${supportedMediaSurfaceText(mediaPath)}\n${supportedMediaSurfaceText(mediaPath)}`
          : supportedMediaSurfaceText(mediaPath);
      events.onPartial(synthesisText);
      return { text: synthesisText, tokens: 4 };
    }
    throw new Error(`unexpected fake task-force model call ${modelCall}`);
  };
  activeTaskForceRunner = runner;
  const service = new rt.InvocationService();
  const wireEvents = [];
  let taskVersionAtSurfaceWire = null;
  let bindingTableAtSurfaceWire = false;
  service.onEvent((envelope) => {
    if (envelope.runId === runId) {
      wireEvents.push(envelope.event);
      if (envelope.event.kind === "surface") {
        taskVersionAtSurfaceWire = rt.tasks.getCanonicalTaskForChat(chat.id)?.version ?? null;
        bindingTableAtSurfaceWire = Boolean(rt.db.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'one_artifact_bindings'",
        ).get());
      }
    }
  });
  assert.equal(
    require("../dist/electron/fs/access.js").resolveFsReadPath(mediaPath, { kind: "chat-assets", chatId: chat.id }),
    mediaPath,
    "the exact chat workspace must authorize its media result before execution",
  );
  service.start({
    runId,
    chatId: chat.id,
    userPrompt: "renderer prompt must be ignored in favor of the reserved team prompt",
    taskIntent: "task",
    locale: "en",
    permissions: "full",
    oneMode: true,
    oneTeamPreflightRef: reservedRef,
    toolMode: "manual",
    hubMode: "hub-first",
    sessionRouting: true,
  });
  await waitForCompletedRun(service, runId, () => ({
    modelCall,
    wireEvents,
    ledger: rt.runs.listRunEvents(runId, 50),
  }));
  activeTaskForceRunner = null;
  if (scenario === "staging-cleanup") {
    // One attachment staging is run-scoped and removed in InvocationService's
    // finally path. Reproduce that post-run disappearance after the Surface
    // was sealed; verification must freshly reopen bytes instead of trusting
    // the now-stale binding row.
    fs.rmSync(path.dirname(mediaPath), { recursive: true, force: true });
    assert.equal(fs.existsSync(mediaPath), false);
  }
  assert.equal(modelCall, 3, "planner, installed worker, and synthesis must each execute once");
  assert.equal(runnerRequests[2].forceSurface, true, "top-level One synthesis must receive the full Surface protocol");
  assert.ok(wireEvents.some((event) =>
    event.phase === "delegate"
    && event.runtimeAgentId === "one-improvement-researcher"),
  "the installed worker UI alias must retain its canonical runtime Agent id");
  const surfaceIndex = wireEvents.findIndex((event) => event.kind === "surface");
  const finalIndex = wireEvents.findIndex((event) => event.kind === "final");
  const expectsSurface = scenario === "verified" || scenario === "staging-cleanup";
  const expectsVerifiedClosure = scenario === "verified";
  assert.equal(
    wireEvents.filter((event) => event.kind === "surface").length,
    expectsSurface ? 1 : 0,
    expectsSurface
      ? "the run must publish exactly one Surface"
      : `${scenario} must not publish a Surface`,
  );
  assert.equal(wireEvents.filter((event) => event.kind === "final").length, 1, "the run must publish exactly one final");
  const taskForceSummary = rt.runs.listRunEvents(runId, 500)
    .find((event) => event.kind === "task_force_execution_receipt");
  if (expectsSurface) {
    assert.ok(
      surfaceIndex >= 0 && finalIndex > surfaceIndex,
      `the actual team Surface must be published before final: ${JSON.stringify({
        eventKinds: wireEvents.map((event) => event.kind),
        verifierIssues: taskForceSummary?.payload?.verifierIssues ?? [],
      })}`,
    );
    const wireSurface = wireEvents[surfaceIndex];
    assert.ok(wireSurface.oneSurface, "Main must project the team Surface into the shared One contract");
    assert.equal(wireSurface.surface, undefined, "raw legacy media transport must stay Main-private");
  } else {
    assert.equal(surfaceIndex, -1);
    assert.ok(finalIndex >= 0);
    if (scenario === "failed-worker") {
      assert.ok(taskForceSummary.payload.verifierIssues.some((issue) => issue.startsWith("child_failed:")));
    }
    if (scenario === "planner-fallback") {
      assert.ok(taskForceSummary.payload.verifierIssues.includes("planner_parse_failed"));
      assert.ok(taskForceSummary.payload.verifierIssues.includes("planner_fallback_used"));
    }
  }
  assert.equal(JSON.stringify(wireEvents).includes(mediaPath), false, "One wire events must never expose a local media path");
  assert.equal(JSON.stringify(wireEvents).includes("<<agentlas-surface>>"), false,
    "One team partials must never expose an unvalidated Surface fence");
  assert.equal(JSON.stringify(wireEvents).includes(SURFACE_INTENT_MARKER), false,
    "One team events must never expose the internal Surface intent marker");
  const surfaceTask = rt.tasks.getCanonicalTaskForChat(chat.id);
  const durableSurface = rt.surfaceResults.getDurableOneSurfaceResult({
    runId,
    chatId: chat.id,
    taskId: surfaceTask.id,
  });
  assert.equal(Boolean(durableSurface), expectsSurface,
    expectsSurface ? "actual team Surface must become a durable One result" : `${scenario} must have no durable Surface`);
  if (durableSurface) {
    assert.equal(JSON.stringify(durableSurface).includes(mediaPath), false, "durable One Surface must contain only opaque artifact refs");
  }
  const bindingTable = rt.db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'one_artifact_bindings'",
  ).get();
  const bindingCount = bindingTable
    ? rt.db.prepare("SELECT COUNT(*) AS count FROM one_artifact_bindings WHERE run_id = ? AND source_path = ?")
      .get(runId, mediaPath).count
    : 0;
  assert.equal(bindingCount, expectsSurface ? 1 : 0, expectsSurface
    ? `InvocationService must seal the Main-private media binding: ${JSON.stringify({
        taskVersion: surfaceTask.version,
        taskVersionAtSurfaceWire,
        bindingTableAtSurfaceWire,
        manifestId: durableSurface?.manifest.manifestId,
        artifactRefs: durableSurface?.manifest.fallback.artifacts.map((item) => item.artifactRef),
      })}`
    : `${scenario} must not seal a media binding`);
  assert.equal(JSON.stringify(rt.runs.listRunEvents(runId, 500)).includes(mediaPath), false, "run ledger must not retain local paths");
  assert.equal(JSON.stringify(rt.runs.listRunEvents(runId, 500)).includes("<<agentlas-surface>>"), false,
    "run ledger must not retain an unvalidated Surface fence");
  assert.equal(JSON.stringify(rt.runs.listRunEvents(runId, 500)).includes(SURFACE_INTENT_MARKER), false,
    "run ledger must not retain the internal Surface intent marker");
  assert.equal(JSON.stringify(rt.chats.listChatMessages(chat.id, 200)).includes(mediaPath), false, "chat history must not retain local paths");
  assert.equal(JSON.stringify(rt.chats.listChatMessages(chat.id, 200)).includes("<<agentlas-surface>>"), false,
    "chat history must contain only the cleaned synthesis text");
  assert.equal(JSON.stringify(rt.chats.listChatMessages(chat.id, 200)).includes(SURFACE_INTENT_MARKER), false,
    "chat history must not retain the internal Surface intent marker");
  const persistedMessages = rt.chats.listChatMessages(chat.id, 200);
  assert.equal(persistedMessages.filter((message) => message.role === "user").length, userTurns,
    "the actual task-force path must persist each user turn exactly once");
  assert.equal(persistedMessages.filter((message) => message.role === "assistant").length, 1,
    "the actual task-force path must persist the cleaned synthesis exactly once");
  if (scenario === "parser-throw") {
    assert.equal(wireEvents[finalIndex].text, PARSER_FAILURE_SAFE_FINAL,
      "a parser exception must replace the entire saved-team final with fixed safe copy");
    assert.equal(
      persistedMessages.find((message) => message.role === "assistant")?.text,
      PARSER_FAILURE_SAFE_FINAL,
      "a parser exception must persist only fixed safe copy in chat history",
    );
  }
  if (tamperReceipt) tamperReceipt(rt, { chat, runId });
  const partial = rt.tasks.getCanonicalTaskForChat(chat.id);
  assert.equal(partial.status, "partial", "InvocationService final must leave the result awaiting explicit acceptance");
  const receipt = rt.runs.getInvocationRunReceipt(runId);
  assert.ok(receipt && receipt.status === "completed" && receipt.finishedAt);
  const accepted = rt.tasks.acceptCanonicalTaskResult({
    taskId: partial.id,
    expectedVersion: partial.version,
    expectedRunId: runId,
  }, receipt);
  const partialClosure = rt.acceptedClosures.ensureAcceptedResultValueClosure({
    priorTaskVersion: partial.version,
    acceptedTask: accepted,
    expectedRunId: runId,
    receipt,
    confirmedByUser: true,
  });
  const verifiedArtifactClosure = rt.acceptedClosures.ensureVerifiedAcceptedResultValueClosure({
    priorTaskVersion: partial.version,
    acceptedTask: accepted,
    expectedRunId: runId,
    receipt,
    confirmedByUser: true,
  });
  assert.equal(Boolean(verifiedArtifactClosure), expectsVerifiedClosure,
    expectsVerifiedClosure
      ? "the actual bound media result must produce its verified sibling closure"
      : `${scenario} must not produce a verified sibling closure`);
  return { chat, accepted, receipt, partialClosure, verifiedArtifactClosure, mediaPath, wireEvents };
}

async function prepareVerifiedSavedTeam(rt, groupId, title, runId, userTurns, suffix, tamperReceipt, scenario = "verified") {
  const actualRunId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)
    ? runId
    : randomUUID();
  const chat = rt.chats.createChat({
    agentId: "one-improvement-producer-agent",
    agentGroupId: groupId,
    title,
    taskMode: "conversation",
  });
  // Freeze workspace identity and earlier durable turns before preflight. The
  // reservation intentionally fails closed to any later Task/chat mutation.
  for (let index = 0; index < Math.max(0, userTurns - 1); index += 1) {
    rt.chats.appendChatMessage(chat.id, "user", `bounded team instruction ${index + 1}`);
  }
  const workspace = path.join(
    require("electron").app.getPath("userData"),
    "generated-assets",
    "one-improvement-team",
    actualRunId,
  );
  const mediaFile = scenario === "staging-cleanup"
    ? path.join(workspace, ".agentlas", "one-attachments", actualRunId, "team-report-preview.png")
    : path.join(workspace, "team-report-preview.png");
  fs.mkdirSync(path.dirname(mediaFile), { recursive: true });
  fs.writeFileSync(mediaFile, onePixelPng());
  const mediaPath = fs.realpathSync.native(mediaFile);
  rt.chats.setChatWorkingFolder(chat.id, fs.realpathSync.native(workspace));
  const prepared = await rt.preflight.prepareOneTeamPreflight({
    chatId: chat.id,
    userPrompt: TEAM_TASK_PROMPT,
    expectedTaskId: null,
    expectedTaskVersion: null,
  }, preflightDeps());
  assert.equal(prepared.kind, "proposal");
  assert.equal(prepared.proposal.canConfirmTeam, true);
  assert.equal(prepared.proposal.roles.length, 2);
  assert.equal(prepared.proposal.roles[1].candidate.slug, "one-improvement-researcher");
  const reserved = await rt.preflight.resolveOneTeamPreflight({
    proposalId: prepared.proposal.proposalId,
    expectedProposalVersion: prepared.proposal.version,
    resolution: "confirm_team",
    requestedRunId: actualRunId,
    confirmedByUser: true,
  }, preflightDeps());
  const accepted = await finishAcceptedTeamChat(
    rt,
    chat,
    reserved.ref,
    actualRunId,
    userTurns,
    TEAM_TASK_PROMPT,
    tamperReceipt,
    mediaPath,
    scenario,
  );
  const started = rt.preflight.getOneTeamPreflightForChat(chat.id);
  assert.equal(started.status, "team_started", "InvocationService must own the one-shot team claim");
  return accepted;
}

async function assertProjectionFailureKeepsRawSurfacePrivate(rt) {
  const chat = rt.chats.createChat({
    agentId: "one-improvement-producer-agent",
    title: "Projection failure redaction",
    taskMode: "task",
  });
  const workspace = path.join(
    require("electron").app.getPath("userData"),
    "generated-assets",
    "one-projection-failure",
  );
  const mediaPath = path.join(workspace, "must-remain-main-private.png");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(mediaPath, onePixelPng());
  rt.chats.setChatWorkingFolder(chat.id, workspace);
  const client = require("../dist/electron/mcp/client.js");
  const originalRun = client.runMcpInvocation;
  const service = new rt.InvocationService();
  const runId = randomUUID();
  const wireEvents = [];
  let bufferedAfterSurface = null;
  service.onEvent((envelope) => {
    if (envelope.runId === runId) wireEvents.push(envelope.event);
  });
  const hostileManifest = new Proxy({
    version: "0.1",
    kind: "surface",
    title: "Hostile projection fixture",
    domain: "projection-failure",
    layout: "creative-studio",
    rawMediaPath: mediaPath,
    widgets: [],
  }, {
    get(target, property, receiver) {
      if (property === "data") throw new Error("fixture projection failure");
      return Reflect.get(target, property, receiver);
    },
  });
  client.runMcpInvocation = async (_request, sink) => {
    sink({ kind: "surface", surfaceId: "surface:projection-failure", surface: hostileManifest });
    bufferedAfterSurface = service.attach(chat.id)?.events ?? null;
    sink({ kind: "final", text: "Projection failure stayed fail-closed." });
    return { finalText: "Projection failure stayed fail-closed.", stormbreakerContinueRequested: false };
  };
  try {
    service.start({
      runId,
      chatId: chat.id,
      userPrompt: "Exercise projection failure redaction.",
      taskIntent: "task",
      locale: "en",
      permissions: "read",
      oneMode: true,
    });
    await waitForCompletedRun(service, runId, () => ({
      wireEvents,
      ledger: rt.runs.listRunEvents(runId, 50),
    }));
  } finally {
    client.runMcpInvocation = originalRun;
  }
  const surface = wireEvents.find((event) => event.kind === "surface");
  assert.ok(surface, "projection failure should remain observable as a content-free Surface event");
  assert.equal(surface.surface, undefined);
  assert.equal(surface.oneSurface, undefined);
  // Customer-safe status (beta feedback #1): a validation failure shows plain
  // retry copy, never the internal "safe One Surface" schema term.
  assert.match(surface.status, /couldn't finish preparing this result safely/);
  assert.doesNotMatch(surface.status, /safe One Surface|structured result|manifest/i);
  assert.equal(JSON.stringify(bufferedAfterSurface).includes(mediaPath), false, "active record.events must strip raw paths");
  assert.equal(JSON.stringify(wireEvents).includes(mediaPath), false, "renderer/Mobile envelopes must strip raw paths");
  assert.equal(JSON.stringify(rt.runs.listRunEvents(runId, 500)).includes(mediaPath), false, "run ledger must strip raw paths");
}

function recordHostileModelCallEvent(rt, input) {
  rt.runs.recordRunEvent({
    runId: input.runId,
    kind: `task_force_model_call_${input.status}`,
    chatId: input.chatId,
    nodeId: input.nodeId,
    agentId: input.agentId,
    payload: {
      schemaVersion: "agentlas.one-model-call-receipt.v1",
      callRef: input.callRef,
      phase: input.phase,
      ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
      status: input.status,
    },
  });
}

function recordHostileModelCallPair(rt, input) {
  const callRef = input.callRef ?? `one-model-call:${randomUUID()}`;
  recordHostileModelCallEvent(rt, { ...input, callRef, status: "started" });
  recordHostileModelCallEvent(rt, { ...input, callRef, status: "completed" });
  return callRef;
}

async function seedWorker() {
  const { app, db } = await openStore();
  insertAgent(db);
  insertAgentRow(db, "one-improvement-researcher", "one-improvement-researcher", "Researcher");
  installActualTaskForceRuntimeBoundary();
  const rt = runtime();
  const skillPath = path.join(
    app.getPath("userData"),
    "agents",
    "one-improvement-producer",
    "skills",
    "comparison",
    "SKILL.md",
  );
  const researcherSkillPath = path.join(
    app.getPath("userData"),
    "agents",
    "one-improvement-researcher",
    "skills",
    "research",
    "SKILL.md",
  );
  fs.mkdirSync(path.dirname(skillPath), { recursive: true });
  fs.mkdirSync(path.dirname(researcherSkillPath), { recursive: true });
  fs.writeFileSync(skillPath, "# Comparison skill\nRUN_START_SKILL_VERSION_A\n", "utf8");
  fs.writeFileSync(researcherSkillPath, "# Research skill\nTEAM_SKILL_VERSION_A\n", "utf8");

  const scopePrompt = "Prepare the weekly comparison report for 2026-07-01.";
  const personalKind = rt.taskKind.deriveOneTaskKindRef({
    userPrompt: scopePrompt,
    projectId: null,
    firmId: null,
    agentGroupId: null,
    ownerAgentId: "one-improvement-producer-agent",
    inputRefs: [],
  });
  const projectKind = rt.taskKind.deriveOneTaskKindRef({
    userPrompt: scopePrompt,
    projectId: "project-scope-a",
    firmId: null,
    agentGroupId: null,
    ownerAgentId: "one-improvement-producer-agent",
    inputRefs: [],
  });
  const firmKind = rt.taskKind.deriveOneTaskKindRef({
    userPrompt: scopePrompt,
    projectId: null,
    firmId: "firm-scope-a",
    agentGroupId: null,
    ownerAgentId: "one-improvement-producer-agent",
    inputRefs: [],
  });
  assert.notEqual(personalKind, projectKind, "Task kind must not cross project scope");
  assert.notEqual(personalKind, firmKind, "Task kind must not cross firm scope");

  const pathA = rt.taskKind.deriveOneTaskKindRef({
    userPrompt: "Analyze /a.pdf for 10 participants on 2026-07-01.",
    projectId: null,
    firmId: null,
    agentGroupId: null,
    ownerAgentId: "one-improvement-producer-agent",
    inputRefs: ["attachment:file:application/pdf:10:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
  });
  const pathB = rt.taskKind.deriveOneTaskKindRef({
    userPrompt: "Analyze /b.pdf for 1000 participants on 2026-07-08.",
    projectId: null,
    firmId: null,
    agentGroupId: null,
    ownerAgentId: "one-improvement-producer-agent",
    inputRefs: ["attachment:file:application/pdf:11:sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
  });
  assert.ok(pathA && pathB);
  assert.notEqual(pathA, pathB, "paths, numbers, dates, and exact input identities must never collapse");

  const baseline = prepareAcceptedTask(
    rt,
    "Weekly comparison 2026-07-01",
    "run_improvement_producer_baseline",
    3,
    null,
    {},
    WEEKLY_TASK_PROMPT,
  );
  verifiedClosure(rt, baseline, "producer-baseline");
  const memory = saveMemory(rt, baseline);
  const memoryState = rt.memory.getOneMemoryState();

  const current = prepareAcceptedTask(rt, "Weekly comparison 2026-07-08", "run_improvement_producer_current", 1, {
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
  }, {}, WEEKLY_TASK_PROMPT);
  const beforeVerification = rt.producer.produceOneImprovementProofForTask(current.accepted.id);
  assert.equal(beforeVerification.reason, "verified_result_unavailable");
  assert.equal(rt.proof.listOneImprovementProofs(current.accepted.id).length, 0);

  const reuse = rt.reuse.ensureOneExperienceReuseReceipt({
    taskId: current.accepted.id,
    expectedTaskVersion: current.accepted.version,
    expectedTaskUpdatedAt: current.accepted.updatedAt,
    expectedRunId: current.receipt.runId,
    valueClosureId: current.partialClosure.value.closure.valueClosureId,
    expectedValueClosureVersion: current.partialClosure.value.version,
    confirmedByUser: true,
  });
  assert.ok(reuse);
  verifiedClosure(rt, current, "producer-current");

  // A later completed run in the same chat must never replace the exact run
  // bound by explicit acceptance and its accepted-result Value Closure.
  rt.runs.recordRunEvent({
    runId: "run_improvement_producer_later_unaccepted",
    kind: "invoke_started",
    chatId: current.chat.id,
    agentId: "one-improvement-producer-agent",
    payload: { oneMode: true, toolMode: "manual", hubMode: "hub" },
  });
  rt.runs.recordRunEvent({
    runId: "run_improvement_producer_later_unaccepted",
    kind: "invoke_completed",
    chatId: current.chat.id,
    agentId: "one-improvement-producer-agent",
    payload: {},
  });
  assert.equal(
    rt.runs.getLatestInvocationRunReceipt(current.chat.id).runId,
    "run_improvement_producer_later_unaccepted",
  );

  const created = rt.producer.produceOneImprovementProofForTask(current.accepted.id);
  assert.equal(created.reason, "created");
  assert.ok(created.proof);
  assert.equal(created.proof.proof.compoundingStep, "reused");
  assert.equal(created.proof.proof.attributionStatus, "not_established");
  assert.equal(created.proof.proof.reusedAssets.length, 1);
  assert.equal(created.proof.proof.reusedAssets[0].assetRef, memory.id);
  assert.equal(created.proof.proof.reusedAssets[0].assetType, "memory");
  assert.deepEqual(created.proof.proof.reusedAssets[0].controls, ["edit", "use_once", "disable", "delete"]);
  assert.equal(created.proof.proof.changes.length, 1);
  assert.equal(created.proof.proof.changes[0].kind, "instruction_reduction");
  assert.equal(created.proof.proof.changes[0].evidenceType, "measured");
  assert.equal(created.proof.proof.changes[0].baseline, 3);
  assert.equal(created.proof.proof.changes[0].current, 1);
  assert.equal(created.proof.comparisons[0].result, "improved");
  assert.equal(created.proof.comparisons[0].baselineTaskId, baseline.accepted.id);
  assert.equal(created.proof.comparisons[0].currentTaskId, current.accepted.id);
  assert.equal(created.proof.proof.convertedToEngagementScore, false);
  const baselineKind = rt.runs.listRunEvents(baseline.receipt.runId, 20)
    .find((event) => event.kind === "invoke_started").payload.oneTaskKindRef;
  const currentKind = rt.runs.listRunEvents(current.receipt.runId, 20)
    .find((event) => event.kind === "invoke_started").payload.oneTaskKindRef;
  assert.match(baselineKind, /^task-kind:[a-f0-9]{64}$/);
  assert.equal(currentKind, baselineKind, "an identical product-owned Task request and input identity must retain its Task kind");
  assert.equal(JSON.stringify(rt.runs.listRunEvents(current.receipt.runId, 20)).includes("Weekly comparison"), false);

  const state = rt.proof.getOneImprovementProofState();
  const serialized = JSON.stringify(state);
  assert.equal(serialized.includes("bounded instruction"), false, "prompt bodies must never enter Improvement Proof state");
  assert.equal(serialized.includes("Use the approved comparison structure"), false, "Memory content must never enter Improvement Proof state");
  assert.ok(state.evidence.every((item) => !Object.hasOwn(item, "text") && !Object.hasOwn(item, "prompt")));
  assert.equal(rt.producer.produceOneImprovementProofForTask(current.accepted.id).reason, "existing");
  assert.equal(rt.producer.reconcileOneImprovementProofs(), 0);

  const unrelated = prepareVerifiedMemoryReuse(
    rt,
    memory,
    "Vacation packing 2026-07-09",
    "run_improvement_producer_unrelated",
    1,
    "producer-unrelated",
  );
  assert.equal(
    rt.producer.produceOneImprovementProofForTask(unrelated.accepted.id).reason,
    "comparable_baseline_unavailable",
    "an unrelated Task must not become comparable merely because its runtime settings match",
  );
  assert.equal(rt.proof.listOneImprovementProofs(unrelated.accepted.id).length, 0);

  const unchanged = prepareVerifiedMemoryReuse(
    rt,
    memory,
    "Weekly comparison 2026-07-15",
    "run_improvement_producer_unchanged",
    3,
    "producer-unchanged",
    WEEKLY_TASK_PROMPT,
  );
  const unchangedProof = rt.producer.produceOneImprovementProofForTask(unchanged.accepted.id);
  assert.equal(unchangedProof.reason, "created");
  assert.equal(unchangedProof.proof.comparisons[0].result, "no_change");
  assert.equal(unchangedProof.proof.proof.compoundingStep, "reused");
  assert.match(unchangedProof.proof.proof.changes[0].statement, /unchanged/);

  const regression = prepareVerifiedMemoryReuse(
    rt,
    memory,
    "Weekly comparison 2026-07-22",
    "run_improvement_producer_regression",
    5,
    "producer-regression",
    WEEKLY_TASK_PROMPT,
  );
  const regressionProof = rt.producer.produceOneImprovementProofForTask(regression.accepted.id);
  assert.equal(regressionProof.reason, "created");
  assert.equal(regressionProof.proof.comparisons[0].result, "regression");
  assert.equal(regressionProof.proof.proof.compoundingStep, "reused");
  assert.match(regressionProof.proof.proof.changes[0].statement, /regression remains visible/);

  // Capture the exact effective bytes once, then mutate SKILL.md. The same
  // validator/accessor used by the dispatcher must keep serving snapshot A;
  // a fresh run must bind B with a different host-local opaque ref.
  const installedOwner = rt.registry.listInstalledAgentsReadOnly()
    .find((agent) => agent.id === "one-improvement-producer-agent");
  const installedResearcher = rt.registry.listInstalledAgentsReadOnly()
    .find((agent) => agent.id === "one-improvement-researcher");
  assert.ok(installedOwner && installedResearcher);
  const directOwnerPromptA = rt.agentFiles.buildEffectiveAgentSystemPrompt(
    installedOwner.id,
    installedOwner.systemPrompt,
  );
  const directResearcherPromptA = rt.agentFiles.buildEffectiveAgentSystemPrompt(
    installedResearcher.id,
    installedResearcher.systemPrompt,
  );
  const skillSnapshotA = rt.taskKind.snapshotOneParticipantExecution([installedOwner, installedResearcher]);
  assert.ok(skillSnapshotA);
  const ownerPromptA = skillSnapshotA.effectivePrompts.find((item) => item.agentId === installedOwner.id);
  const researcherPromptA = skillSnapshotA.effectivePrompts.find((item) => item.agentId === installedResearcher.id);
  assert.match(ownerPromptA.effectivePrompt, /RUN_START_SKILL_VERSION_A/);
  assert.match(researcherPromptA.effectivePrompt, /TEAM_SKILL_VERSION_A/);
  assert.equal(ownerPromptA.effectivePrompt, directOwnerPromptA);
  assert.equal(researcherPromptA.effectivePrompt, directResearcherPromptA);
  assert.ok(skillSnapshotA.bindings.every((item) => /^effective-prompt:[a-f0-9]{64}$/.test(item.effectivePromptRef)));
  assert.equal(JSON.stringify(skillSnapshotA.bindings).includes("sha256:"), false);
  assert.ok(skillSnapshotA.bindings.every((item) => !Object.hasOwn(item, "effectivePrompt")));
  assert.ok(skillSnapshotA.bindings.every((item) => !Object.hasOwn(item, "effectivePromptDigest")));
  fs.writeFileSync(skillPath, "# Comparison skill\nRUN_START_SKILL_VERSION_B\n", "utf8");
  fs.writeFileSync(researcherSkillPath, "# Research skill\nTEAM_SKILL_VERSION_B\n", "utf8");
  const frozenPromptMap = rt.taskKind.validatedOneParticipantEffectivePromptMap(skillSnapshotA);
  assert.ok(frozenPromptMap);
  const exactFrozenOwnerPrompt = rt.taskKind.exactOneParticipantEffectivePrompt(
    frozenPromptMap,
    installedOwner.id,
    installedOwner.slug,
  );
  const exactFrozenResearcherPrompt = rt.taskKind.exactOneParticipantEffectivePrompt(
    frozenPromptMap,
    installedResearcher.id,
    installedResearcher.slug,
  );
  assert.match(exactFrozenOwnerPrompt, /RUN_START_SKILL_VERSION_A/);
  assert.doesNotMatch(exactFrozenOwnerPrompt, /RUN_START_SKILL_VERSION_B/);
  assert.match(exactFrozenResearcherPrompt, /TEAM_SKILL_VERSION_A/);
  assert.doesNotMatch(exactFrozenResearcherPrompt, /TEAM_SKILL_VERSION_B/);
  const tamperedSnapshot = structuredClone(skillSnapshotA);
  tamperedSnapshot.effectivePrompts[0].effectivePrompt += "\nTAMPERED_AFTER_RECEIPT";
  assert.equal(rt.taskKind.validatedOneParticipantEffectivePromptMap(tamperedSnapshot), null);
  const skillSnapshotB = rt.taskKind.snapshotOneParticipantExecution([installedOwner, installedResearcher]);
  assert.ok(skillSnapshotB);
  assert.notEqual(
    rt.agentFiles.buildEffectiveAgentSystemPrompt(installedOwner.id, installedOwner.systemPrompt),
    exactFrozenOwnerPrompt,
    "disk re-read after start must differ while the dispatcher still serves the bound bytes",
  );
  assert.match(
    skillSnapshotB.effectivePrompts.find((item) => item.agentId === installedOwner.id).effectivePrompt,
    /RUN_START_SKILL_VERSION_B/,
  );
  const promptRefsA = new Map(skillSnapshotA.bindings.map((item) => [item.agentId, item.effectivePromptRef]));
  const promptRefsB = new Map(skillSnapshotB.bindings.map((item) => [item.agentId, item.effectivePromptRef]));
  assert.notEqual(promptRefsA.get(installedOwner.id), promptRefsB.get(installedOwner.id));
  assert.notEqual(
    promptRefsA.get(installedResearcher.id),
    promptRefsB.get(installedResearcher.id),
    "every local team participant must bind its own exact SKILL.md bytes",
  );
  const skillDrift = prepareVerifiedMemoryReuse(
    rt,
    memory,
    "Weekly comparison with changed effective skill bytes",
    "run_improvement_producer_skill_drift",
    1,
    "producer-skill-drift",
    WEEKLY_TASK_PROMPT,
  );
  const skillDriftStart = rt.runs.listRunEvents(skillDrift.receipt.runId, 20)
    .find((event) => event.kind === "invoke_started");
  const durableSkillBinding = skillDriftStart.payload.oneParticipantVersionBindings[0];
  assert.deepEqual(
    Object.keys(durableSkillBinding).sort(),
    ["agentId", "agentSlug", "effectivePromptRef", "versionRef"],
  );
  const durableSkillPayload = JSON.stringify(skillDriftStart.payload);
  assert.equal(durableSkillPayload.includes("RUN_START_SKILL_VERSION"), false);
  assert.equal(durableSkillPayload.includes("TEAM_SKILL_VERSION"), false);
  assert.equal(durableSkillPayload.includes("sha256:"), false);
  fs.writeFileSync(skillPath, "# Comparison skill\nRUN_START_SKILL_VERSION_A\n", "utf8");
  fs.writeFileSync(researcherSkillPath, "# Research skill\nTEAM_SKILL_VERSION_A\n", "utf8");
  assert.equal(
    rt.producer.produceOneImprovementProofForTask(skillDrift.accepted.id).reason,
    "comparable_baseline_unavailable",
    "restoring SKILL.md after the run must not erase its historical effective-prompt binding",
  );

  db.prepare("UPDATE installed_agents SET system_prompt = ? WHERE id = ?")
    .run("A changed execution definition that must remain historical.", "one-improvement-producer-agent");
  const participantDrift = prepareVerifiedMemoryReuse(
    rt,
    memory,
    "Weekly comparison with changed agent definition",
    "run_improvement_producer_participant_drift",
    1,
    "producer-participant-drift",
    WEEKLY_TASK_PROMPT,
  );
  db.prepare("UPDATE installed_agents SET system_prompt = '' WHERE id = ?")
    .run("one-improvement-producer-agent");
  assert.equal(
    rt.producer.produceOneImprovementProofForTask(participantDrift.accepted.id).reason,
    "comparable_baseline_unavailable",
    "restoring the current registry must not erase the historical run-start participant version",
  );

  const advanced = rt.tasks.setCanonicalTaskStatus(unchanged.accepted.id, "completed");
  assert.notEqual(advanced.version, unchangedProof.proof.currentTaskVersion);
  assert.equal(
    rt.producer.produceOneImprovementProofForTask(advanced.id).reason,
    "result_not_explicitly_accepted",
    "a historical proof must not short-circuit evaluation of a newer Task version",
  );

  const disabledSource = prepareVerifiedMemoryReuse(
    rt,
    memory,
    "Weekly comparison 2026-07-29",
    "run_improvement_producer_disabled_source",
    1,
    "producer-disabled-source",
    WEEKLY_TASK_PROMPT,
  );
  const memoryBeforeDisable = rt.memory.getOneMemoryState();
  rt.memory.setOneMemoryAssetEnabled({
    expectedStoreVersion: memoryBeforeDisable.version,
    memoryId: memory.id,
    expectedMemoryVersion: memory.version,
    enabled: false,
    confirmedByUser: true,
  });
  assert.equal(
    rt.producer.produceOneImprovementProofForTask(disabledSource.accepted.id).reason,
    "comparable_baseline_unavailable",
    "a source asset changed after reuse must be revalidated before proof creation",
  );

  const sourceVersionBaseline = prepareAcceptedTask(
    rt,
    "Immutable source baseline",
    "run_improvement_source_version_baseline",
    2,
    null,
    {},
    WEEKLY_TASK_PROMPT,
  );
  verifiedClosure(rt, sourceVersionBaseline, "producer-source-version-baseline");
  const sourceVersionMemory = saveMemory(rt, sourceVersionBaseline);
  const sourceVersionCurrent = prepareVerifiedMemoryReuse(
    rt,
    sourceVersionMemory,
    "Immutable source current",
    "run_improvement_source_version_current",
    1,
    "producer-source-version-current",
    WEEKLY_TASK_PROMPT,
  );
  const advancedSourceTask = rt.tasks.setCanonicalTaskStatus(
    sourceVersionBaseline.accepted.id,
    "completed",
  );
  assert.notEqual(advancedSourceTask.version, sourceVersionMemory.sourceTaskVersion);
  assert.equal(
    rt.producer.produceOneImprovementProofForTask(sourceVersionCurrent.accepted.id).reason,
    "comparable_baseline_unavailable",
    "a Memory source Task advanced after reuse must invalidate its immutable provenance",
  );

  const addedAt = new Date().toISOString();
  const savedTeam = rt.groups.createAgentGroup({
    name: "Verified comparison team",
    description: "A saved team used by two verified comparable Tasks.",
    orchestratorName: "One",
    members: [
      {
        id: randomUUID(),
        source: "installed",
        agentId: "one-improvement-producer-agent",
        agentSlug: "one-improvement-producer",
        role: "Coordinator",
        snapshot: { name: "One", nameEn: "One", tagline: "Coordinate", taglineEn: "Coordinate", routeLabel: "Local" },
        addedAt,
      },
      {
        id: randomUUID(),
        source: "installed",
        agentId: "one-improvement-researcher",
        agentSlug: "one-improvement-researcher",
        role: "Researcher",
        snapshot: { name: "Researcher", nameEn: "Researcher", tagline: "Research", taglineEn: "Research", routeLabel: "Local" },
        addedAt,
      },
    ],
  });
  const teamBaseline = await prepareVerifiedSavedTeam(
    rt,
    savedTeam.id,
    "Team market report 2026-07-01",
    "run_improvement_team_baseline",
    4,
    "producer-team-baseline",
  );
  const teamCurrent = await prepareVerifiedSavedTeam(
    rt,
    savedTeam.id,
    "Team market report 2026-07-08",
    "run_improvement_team_current",
    2,
    "producer-team-current",
  );
  const teamProof = rt.producer.produceOneImprovementProofForTask(teamCurrent.accepted.id);
  assert.equal(teamProof.reason, "created");
  assert.equal(teamProof.proof.proof.reusedAssets.length, 1);
  assert.equal(teamProof.proof.proof.reusedAssets[0].assetRef, savedTeam.id);
  assert.equal(teamProof.proof.proof.reusedAssets[0].assetType, "team");
  assert.deepEqual(teamProof.proof.proof.reusedAssets[0].controls, ["edit", "delete"]);
  assert.equal(teamProof.proof.assetBindings[0].assetVersion, Date.parse(savedTeam.updatedAt));
  assert.equal(teamProof.proof.comparisons[0].baselineTaskId, teamBaseline.accepted.id);
  assert.equal(teamProof.proof.comparisons[0].result, "improved");
  assert.equal(teamProof.proof.proof.compoundingStep, "reused");
  assert.equal(teamProof.proof.proof.attributionStatus, "not_established");
  await assertProjectionFailureKeepsRawSurfacePrivate(rt);

  for (const scenario of ["failed-worker", "planner-fallback", "marker-only", "multiple-surfaces", "parser-throw", "staging-cleanup"]) {
    const rejectedSurfaceRun = await prepareVerifiedSavedTeam(
      rt,
      savedTeam.id,
      `Team Surface fail-closed: ${scenario}`,
      randomUUID(),
      1,
      `producer-team-surface-${scenario}`,
      null,
      scenario,
    );
    assert.equal(
      rt.producer.produceOneImprovementProofForTask(rejectedSurfaceRun.accepted.id).reason,
      "verified_result_unavailable",
      `${scenario} must not create a saved-team proof without a verified Surface sibling`,
    );
    assert.equal(rt.proof.listOneImprovementProofs(rejectedSurfaceRun.accepted.id).length, 0,
      `${scenario} must leave the durable improvement-proof ledger empty`);
  }

  insertAgentRow(db, "one-improvement-observer", "one-improvement-observer", "Observer");
  const mismatchedTeam = rt.groups.createAgentGroup({
    name: "Mismatched saved team",
    description: "This saved group contains a member that does not execute the verified run.",
    orchestratorName: "One",
    members: [
      {
        id: randomUUID(),
        source: "installed",
        agentId: "one-improvement-producer-agent",
        agentSlug: "one-improvement-producer",
        role: "Coordinator",
        snapshot: { name: "One", nameEn: "One", tagline: "Coordinate", taglineEn: "Coordinate", routeLabel: "Local" },
        addedAt,
      },
      {
        id: randomUUID(),
        source: "installed",
        agentId: "one-improvement-researcher",
        agentSlug: "one-improvement-researcher",
        role: "Researcher",
        snapshot: { name: "Researcher", nameEn: "Researcher", tagline: "Research", taglineEn: "Research", routeLabel: "Local" },
        addedAt,
      },
      {
        id: randomUUID(),
        source: "installed",
        agentId: "one-improvement-observer",
        agentSlug: "one-improvement-observer",
        role: "Observer",
        snapshot: { name: "Observer", nameEn: "Observer", tagline: "Observe", taglineEn: "Observe", routeLabel: "Local" },
        addedAt,
      },
    ],
  });
  const mismatchedTeamRun = await prepareVerifiedSavedTeam(
    rt,
    mismatchedTeam.id,
    "Team market report with an unexecuted saved member",
    "run_improvement_team_mismatched_roster",
    2,
    "producer-team-mismatched-roster",
  );
  assert.equal(
    rt.producer.produceOneImprovementProofForTask(mismatchedTeamRun.accepted.id).reason,
    "comparable_baseline_unavailable",
    "a saved AgentGroup must exactly equal the durable execution roster",
  );

  const assertHostileTeamEvidenceBlocked = async (label, runId, suffix, tamperReceipt) => {
    const prepared = await prepareVerifiedSavedTeam(
      rt,
      savedTeam.id,
      label,
      runId,
      1,
      suffix,
      tamperReceipt,
    );
    assert.equal(
      rt.producer.produceOneImprovementProofForTask(prepared.accepted.id).reason,
      "verified_result_unavailable",
      label,
    );
  };

  await assertHostileTeamEvidenceBlocked(
    "a missing worker completion receipt must fail closed",
    "run_improvement_team_missing_worker_receipt",
    "producer-team-missing-worker-receipt",
    (hostileRt, { runId }) => {
      const removed = hostileRt.db.prepare(
        `DELETE FROM run_events
          WHERE run_id = ?
            AND kind = 'task_force_model_call_completed'
            AND agent_id = ?`,
      ).run(runId, "one-improvement-researcher");
      assert.equal(removed.changes, 1);
    },
  );
  await assertHostileTeamEvidenceBlocked(
    "a duplicate completed receipt for one opaque call must fail closed",
    "run_improvement_team_duplicate_completed_receipt",
    "producer-team-duplicate-completed-receipt",
    (hostileRt, { chat, runId }) => {
      const row = hostileRt.db.prepare(
        `SELECT node_id, agent_id, payload_json
           FROM run_events
          WHERE run_id = ? AND kind = 'task_force_model_call_completed' AND agent_id = ?
          LIMIT 1`,
      ).get(runId, "one-improvement-researcher");
      assert.ok(row);
      hostileRt.runs.recordRunEvent({
        runId,
        kind: "task_force_model_call_completed",
        chatId: chat.id,
        nodeId: row.node_id,
        agentId: row.agent_id,
        payload: JSON.parse(row.payload_json),
      });
    },
  );
  await assertHostileTeamEvidenceBlocked(
    "a completed receipt without its matching start must fail closed",
    "run_improvement_team_orphan_completed_receipt",
    "producer-team-orphan-completed-receipt",
    (hostileRt, { chat, runId }) => {
      recordHostileModelCallEvent(hostileRt, {
        runId,
        chatId: chat.id,
        nodeId: `${chat.id}:borrow-orchestrator`,
        agentId: "one-improvement-producer-agent",
        callRef: `one-model-call:${randomUUID()}`,
        phase: "synthesis",
        status: "completed",
      });
    },
  );
  await assertHostileTeamEvidenceBlocked(
    "any failed model-call receipt in an otherwise completed run must remain visible",
    "run_improvement_team_failed_receipt",
    "producer-team-failed-receipt",
    (hostileRt, { chat, runId }) => {
      const callRef = `one-model-call:${randomUUID()}`;
      recordHostileModelCallEvent(hostileRt, {
        runId,
        chatId: chat.id,
        nodeId: `${chat.id}:borrow-orchestrator`,
        agentId: "one-improvement-producer-agent",
        callRef,
        phase: "planner",
        attempt: 2,
        status: "started",
      });
      recordHostileModelCallEvent(hostileRt, {
        runId,
        chatId: chat.id,
        nodeId: `${chat.id}:borrow-orchestrator`,
        agentId: "one-improvement-producer-agent",
        callRef,
        phase: "planner",
        attempt: 2,
        status: "failed",
      });
    },
  );
  await assertHostileTeamEvidenceBlocked(
    "an extra installed Agent receipt outside the run-start roster must fail closed",
    "run_improvement_team_extra_installed_receipt",
    "producer-team-extra-installed-receipt",
    (hostileRt, { chat, runId }) => {
      recordHostileModelCallPair(hostileRt, {
        runId,
        chatId: chat.id,
        nodeId: "borrow:one-improvement-observer",
        agentId: "one-improvement-observer",
        phase: "worker",
      });
    },
  );
  await assertHostileTeamEvidenceBlocked(
    "a borrowed UI alias in durable MCP attribution must fail closed",
    "run_improvement_team_alias_spoof",
    "producer-team-alias-spoof",
    (hostileRt, { chat, runId }) => {
      hostileRt.runs.recordRunEvent({
        runId,
        kind: "mcp_tool-use",
        chatId: chat.id,
        agentId: "borrow:one-improvement-researcher",
        payload: { toolName: "alias-spoof", toolId: "alias_spoof", toolIsError: false },
      });
    },
  );

  console.log(JSON.stringify({
    ok: true,
    proofId: created.proof.proof.improvementProofId,
    taskId: current.accepted.id,
    baseline: created.proof.proof.changes[0].baseline,
    current: created.proof.proof.changes[0].current,
    unrelatedBlocked: true,
    noChangePreserved: true,
    regressionPreserved: true,
    historicalParticipantVersionVerified: true,
    effectiveSkillSnapshotVerified: true,
    staleSourceBlocked: true,
    immutableSourceVersionVerified: true,
    savedTeamAssetVerified: true,
    mismatchedSavedTeamBlocked: true,
    actualTaskForceAttributionVerified: true,
    actualTaskForceSurfaceBindingVerified: true,
    projectionFailureRawSurfaceRedacted: true,
    failedTaskForceSurfacesBlocked: true,
    parserThrowSurfaceBlocked: true,
    stagingOutputReverificationBlocked: true,
    hostileTaskForceReceiptsBlocked: true,
  }));
  db.close();
  app.quit();
}

async function reloadWorker() {
  const { app, db } = await openStore();
  const rt = runtime();
  const taskId = argument("--task-id");
  const proofId = argument("--proof-id");
  const proof = rt.proof.getLatestOneImprovementProof(taskId);
  assert.ok(proof);
  assert.equal(proof.proof.improvementProofId, proofId);
  assert.equal(rt.producer.produceOneImprovementProofForTask(taskId).reason, "existing");
  assert.equal(rt.proof.listOneImprovementProofs(taskId).length, 1);
  console.log(JSON.stringify({ ok: true, restoredAfterRestart: true, proofId }));
  db.close();
  app.quit();
}

function parseLastJson(output) {
  const lines = output.trim().split(/\r?\n/).filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

function orchestrate() {
  const electronModule = require("electron");
  const executable = typeof electronModule === "string" ? electronModule : process.execPath;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-one-improvement-producer-"));
  const env = { ...process.env, AGENTLAS_STORE_PATH: path.join(temp, "producer.sqlite") };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const seed = spawnSync(executable, [__filename, "--seed", `--user-data=${path.join(temp, "seed-user-data")}`], {
      env,
      encoding: "utf8",
    });
    if (seed.status !== 0) throw new Error(`Improvement producer seed failed (${seed.status})\n${seed.stdout}\n${seed.stderr}`);
    process.stdout.write(seed.stdout);
    const result = parseLastJson(seed.stdout);
    const reload = spawnSync(executable, [
      __filename,
      "--reload",
      `--task-id=${result.taskId}`,
      `--proof-id=${result.proofId}`,
      `--user-data=${path.join(temp, "reload-user-data")}`,
    ], { env, encoding: "utf8" });
    if (reload.status !== 0) throw new Error(`Improvement producer reload failed (${reload.status})\n${reload.stdout}\n${reload.stderr}`);
    process.stdout.write(reload.stdout);

    const ipc = fs.readFileSync(path.join(__dirname, "../electron/ipc.ts"), "utf8");
    const mobile = fs.readFileSync(path.join(__dirname, "../electron/mobile-bridge/projector.ts"), "utf8");
    const mobileAuthority = fs.readFileSync(path.join(__dirname, "../electron/mobile-bridge/authority.ts"), "utf8");
    const invocationService = fs.readFileSync(path.join(__dirname, "../electron/invocation/service.ts"), "utf8");
    const invocationClient = fs.readFileSync(path.join(__dirname, "../electron/mcp/client.ts"), "utf8");
    const taskForceRuntime = fs.readFileSync(path.join(__dirname, "../electron/mcp/borrowed-task-force.ts"), "utf8");
    const oneShell = fs.readFileSync(path.join(__dirname, "../renderer/components/one/OneShell.tsx"), "utf8");
    const agentGroupPage = fs.readFileSync(path.join(__dirname, "../renderer/app/(shell)/library/agent-groups/page.tsx"), "utf8");
    assert.match(ipc, /tryProduceOneImprovementProofForTask\(accepted\.id\)/);
    assert.match(ipc, /oneImprovementProof:getState[\s\S]{0,180}reconcileOneImprovementProofs/);
    assert.match(mobile, /projectMobileBridgeOneImprovementProofs[\s\S]{0,300}reconcileOneImprovementProofs/);
    assert.match(mobileAuthority, /case "tasks\.acceptResult"[\s\S]{0,1800}ensureVerifiedAcceptedResultValueClosure[\s\S]{0,4000}tryProduceOneImprovementProofForTask\(accepted\.id\)/);
    assert.match(invocationService, /buildOneTaskKindInputRefs[\s\S]{0,1200}deriveOneTaskKindRef/);
    assert.match(invocationService, /snapshotOneParticipantExecution[\s\S]{0,800}oneParticipantExecutionSnapshot = executionSnapshot/);
    assert.match(invocationService, /kind: "invoke_started"[\s\S]{0,300}agentId: chat\.agentId[\s\S]{0,300}oneParticipantVersionBindings/);
    assert.match(invocationClient, /validatedOneParticipantEffectivePromptMap[\s\S]{0,2600}effectivePromptFor/);
    assert.match(invocationClient, /localEffectivePrompts: oneParticipantEffectivePrompts[\s\S]{0,500}orchestratorEffectivePrompt: effectivePromptFor\(agent\)/);
    assert.match(taskForceRuntime, /orchestratorEffectivePrompt \?\? buildEffectiveAgentSystemPrompt/);
    assert.match(taskForceRuntime, /forceSurface: p\.req\.oneMode === true && emitFinal && !p\.req\.agentAppMode/);
    assert.match(taskForceRuntime, /emitFinal && p\.req\.oneMode === true && !p\.req\.agentAppMode/,
      "ordinary Work and nested task forces must stay outside One Surface emission");
    assert.match(taskForceRuntime, /emitFinal && p\.req\.oneMode !== true && !p\.req\.agentAppMode/,
      "ordinary Work synthesis partial streaming must remain unchanged");
    assert.match(taskForceRuntime, /parsed\.errors\.length === 0 && parsed\.surfaces\.length === 1/);
    // Customer-safe copy (beta feedback #1): the surface-parse-failed branch now
    // replaces the raw body with plain retry copy, not the internal schema term.
    assert.match(taskForceRuntime, /diagnostic\.code === "surface-parse-failed"[\s\S]{0,500}couldn't finish preparing this result safely/);
    assert.match(invocationClient, /diagnostic\.code === "surface-parse-failed"[\s\S]{0,500}couldn't finish preparing this result safely/);
    assert.match(taskForceRuntime, /surfaceExecutionVerified = verifierIssues\.length === 0[\s\S]{0,180}results\.every/);
    assert.match(invocationService, /const surfaceTask = findCanonicalTaskForChat\(runReq\.chatId\);[\s\S]{0,80}canonicalTask = surfaceTask/);
    assert.match(invocationService, /\(requestedOneMode \|\| runWorkspaceBinding\) && event\.kind === "surface" && event\.surface/);
    assert.match(oneShell, /asset\.assetType === "team"[\s\S]{0,180}\/library\/agent-groups\?edit=/);
    assert.match(agentGroupPage, /URLSearchParams\(window\.location\.search\)\.get\("edit"\)[\s\S]{0,220}editGroup\(target\)/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv.includes("--seed")) {
  seedWorker().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
} else if (process.argv.includes("--reload")) {
  reloadWorker().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
} else {
  try {
    orchestrate();
    // This top-level verifier runs under Electron only to launch isolated
    // seed/reload workers. After their synchronous assertions finish there is
    // no app lifecycle to keep alive, so exit explicitly instead of leaving a
    // successful verifier resident in CI and local regression runs.
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
