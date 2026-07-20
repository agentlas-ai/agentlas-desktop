#!/usr/bin/env node

const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOST_ID = "host_11111111111111111111111111111111";
const SECRET_TITLE = "Customer password=never-store-this /Users/private/raw-transcript.txt";
const DAILY_RESEARCH_RECURRENCE = Object.freeze({
  contractVersion: "1.0.0",
  intentKind: "research",
  cadence: "daily",
  weekday: null,
  localTime: "09:00",
  timeZone: "Asia/Seoul",
  startPolicy: "after_review_approval",
  endPolicy: "manual_stop",
  permission: "draft_only",
});

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

function insertAgent(db, id, slug) {
  db.prepare(
    `INSERT OR IGNORE INTO installed_agents
       (id, slug, name, tagline, system_prompt, mcp_servers_json, trust_grade, installed_at, tone)
     VALUES (?, ?, ?, 'Worker', '', '[]', 'A', ?, 'neutral')`,
  ).run(id, slug, slug, new Date().toISOString());
}

function runtime() {
  return {
    chats: require("../dist/electron/store/chats.js"),
    tasks: require("../dist/electron/store/tasks.js"),
    runEvents: require("../dist/electron/store/run-events.js"),
    domainEvents: require("../dist/electron/one/domain-events.js"),
    closures: require("../dist/electron/one/accepted-result-value-closure.js"),
    producer: require("../dist/electron/one/completion-suggestion-producer.js"),
    suggestions: require("../dist/electron/one/suggestions.js"),
  };
}

function prepareAccepted(runtime, input) {
  const chat = runtime.chats.createChat({ agentId: input.chatAgentId ?? "agent-research", title: input.title });
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
    runId: input.runId,
    kind: "invoke_started",
    chatId: chat.id,
    agentId: input.participantIds[0],
    payload: {
      oneMode: input.oneMode,
      toolMode: "auto",
      hubMode: "hub-allowed",
      planMode: false,
      goalMode: false,
      appsGenerateMode: false,
      ...(input.recurrence ? {
        oneRecurrenceSelection: input.recurrence,
        oneRecurrencePolicy: "proposal_evidence_only_review_required",
      } : {}),
    },
  });
  runtime.domainEvents.recordOneDomainEvent({
    eventType: "run.started",
    actor: "one",
    entityId: input.runId,
    taskId: partial.id,
    version: 1,
    visibility: "personal",
    entries: [
      { name: "runId", value: input.runId },
      { name: "policyVersion", value: "agentlas-one-runtime-v1" },
    ],
  });
  for (const [index, participantId] of input.participantIds.entries()) {
    if (input.toolName && (!input.toolParticipantIds || input.toolParticipantIds.includes(participantId))) {
      runtime.runEvents.recordRunEvent({
        runId: input.runId,
        kind: input.toolEventKind ?? "mcp_tool-use",
        chatId: chat.id,
        agentId: participantId,
        nodeId: `node_${index + 1}`,
        payload: {
          role: index === 0 ? "research" : "verify",
          toolName: input.toolName,
          toolId: input.omitToolId ? undefined : `tool_${index + 1}`,
          toolIsError: input.toolIsError ?? false,
        },
      });
    } else if (index > 0) {
      runtime.runEvents.recordRunEvent({
        runId: input.runId,
        kind: "mcp_status",
        chatId: chat.id,
        agentId: participantId,
        nodeId: `node_${index + 1}`,
        payload: {
          role: "verify",
          status: "observed_without_successful_tool_receipt",
          // Deliberately tool-shaped payload on the wrong event kind. A roster
          // member only counts when the durable callback is exactly mcp_tool-use.
          toolName: input.toolName,
          toolId: `not_a_tool_receipt_${index + 1}`,
          toolIsError: false,
        },
      });
    }
  }
  runtime.runEvents.recordRunEvent({
    runId: input.runId,
    kind: "invoke_completed",
    chatId: chat.id,
    agentId: input.participantIds[0],
    payload: { resultFolder: "/private/tmp/never-project-this" },
  });
  const receipt = runtime.runEvents.getInvocationRunReceipt(input.runId);
  const accepted = runtime.tasks.acceptCanonicalTaskResult({
    taskId: partial.id,
    expectedVersion: partial.version,
    expectedRunId: input.runId,
  }, receipt);
  const closure = runtime.closures.ensureAcceptedResultValueClosure({
    priorTaskVersion: partial.version,
    acceptedTask: accepted,
    expectedRunId: input.runId,
    receipt,
    confirmedByUser: true,
  });
  return { partial, accepted, receipt, closure: closure.value };
}

function produce(runtime, prepared, hostId = HOST_ID) {
  return runtime.producer.produceAcceptedResultSuggestion({
    hostId,
    taskId: prepared.accepted.id,
    expectedTaskVersion: prepared.accepted.version,
    expectedTaskUpdatedAt: prepared.accepted.updatedAt,
    expectedRunId: prepared.receipt.runId,
    valueClosureId: prepared.closure.closure.valueClosureId,
    expectedValueClosureVersion: prepared.closure.version,
    confirmedByUser: true,
  });
}

function readObservations(db, producer) {
  const row = db.prepare("SELECT value FROM meta WHERE key = ? LIMIT 1")
    .get(producer.ONE_COMPLETION_OBSERVATION_META_KEY);
  return row ? JSON.parse(row.value) : null;
}

async function seedWorker() {
  const { app, db } = await openStore();
  insertAgent(db, "agent-research", "research-specialist");
  insertAgent(db, "agent-verify", "verification-specialist");
  insertAgent(db, "agent-default-owner", "agentlas-orchestrator-owner");
  const rt = runtime();

  const plainA = prepareAccepted(rt, {
    title: "Plain answer A",
    runId: "run_plain_answer_a",
    oneMode: true,
    participantIds: ["agent-research"],
    toolName: null,
  });
  const plainB = prepareAccepted(rt, {
    title: "Plain answer B",
    runId: "run_plain_answer_b",
    oneMode: true,
    participantIds: ["agent-research"],
    toolName: null,
  });
  assert.equal(produce(rt, plainA).reason, "no_reusable_execution_pattern");
  assert.equal(produce(rt, plainB).reason, "no_reusable_execution_pattern");
  assert.equal(rt.suggestions.getOneSuggestionState().suggestions.length, 0,
    "repeated plain owner answers must not pollute Agent Build suggestions");

  const defaultOwner = prepareAccepted(rt, {
    title: "Default orchestrator used a tool",
    runId: "run_default_owner_tool",
    oneMode: true,
    chatAgentId: "agent-default-owner",
    participantIds: ["agent-default-owner"],
    toolName: "web.search",
  });
  assert.equal(produce(rt, defaultOwner).reason, "no_reusable_execution_pattern");

  const notOne = prepareAccepted(rt, {
    title: "Work-only execution",
    runId: "run_work_only",
    oneMode: false,
    participantIds: ["agent-research"],
    toolName: "web.search",
  });
  assert.equal(produce(rt, notOne).reason, "not_one_mode");

  const toolShapedStatus = prepareAccepted(rt, {
    title: "Tool-shaped status is not a callback",
    runId: "run_tool_shaped_status",
    oneMode: true,
    participantIds: ["agent-research"],
    toolName: "web.search",
    toolEventKind: "mcp_status",
  });
  assert.equal(produce(rt, toolShapedStatus).reason, "no_reusable_execution_pattern",
    "only the exact mcp_tool-use ledger kind can prove a tool callback");

  const missingToolId = prepareAccepted(rt, {
    title: "Tool callback without invocation id",
    runId: "run_tool_without_id",
    oneMode: true,
    participantIds: ["agent-research"],
    toolName: "web.search",
    omitToolId: true,
  });
  assert.equal(produce(rt, missingToolId).reason, "no_reusable_execution_pattern",
    "a tool callback without a bounded nonempty toolId is not durable contribution evidence");

  const failedTool = prepareAccepted(rt, {
    title: "Failed tool callback",
    runId: "run_failed_tool",
    oneMode: true,
    participantIds: ["agent-research"],
    toolName: "web.search",
    toolIsError: true,
  });
  assert.equal(produce(rt, failedTool).reason, "no_reusable_execution_pattern",
    "failed tool callbacks must not enter a reusable execution pattern");

  const agentA = prepareAccepted(rt, {
    title: SECRET_TITLE,
    runId: "run_agent_pattern_a",
    oneMode: true,
    participantIds: ["agent-research"],
    toolName: "web.search",
  });
  const first = produce(rt, agentA);
  assert.equal(first.suggestion, null);
  assert.equal(first.reason, "insufficient_verified_completions");
  const agentB = prepareAccepted(rt, {
    title: "Second accepted research result",
    runId: "run_agent_pattern_b",
    oneMode: true,
    participantIds: ["agent-research"],
    toolName: "web.search",
  });
  const second = produce(rt, agentB);
  assert.equal(second.reason, "created");
  assert.equal(second.suggestion.type, "agent_build");
  assert.ok(second.suggestion.evidence.every((item) =>
    item.outcome === "accepted_internal_result"
    && item.acceptanceReceiptVerified === true
    && item.hostVerified === undefined));
  assert.equal(second.suggestion.proposal.signalSource, "accepted_result_pattern");
  assert.equal(second.suggestion.proposal.acceptedResultCount, 2);
  assert.equal(second.suggestion.proposal.userReuseIntentConfirmed, undefined,
    "observed repetition must never forge explicit reuse intent");
  assert.equal(second.suggestion.proposal.toolRefs.length, 1);
  const duplicate = produce(rt, agentB);
  assert.equal(duplicate.reason, "completed_task_already_arbitrated");
  assert.equal(rt.suggestions.getOneSuggestionState().suggestions
    .filter((item) => item.originTaskId === agentB.accepted.id).length, 1);
  const review = rt.suggestions.acceptOneSuggestionForReview({
    expectedStoreVersion: rt.suggestions.getOneSuggestionState().version,
    suggestionId: second.suggestion.id,
    expectedSuggestionVersion: second.suggestion.version,
    confirmedByUser: true,
    reviewOnly: true,
  });
  const reviewedSuggestion = rt.suggestions.getOneSuggestionState().suggestions
    .find((item) => item.id === second.suggestion.id);
  const handoff = rt.suggestions.getOneSuggestionReviewHandoff({
    suggestionId: reviewedSuggestion.id,
    expectedSuggestionVersion: reviewedSuggestion.version,
    reviewRequestId: review.value.id,
    draftId: review.value.draftId,
    originTaskId: reviewedSuggestion.originTaskId,
  });
  assert.equal(handoff.reviewOnly, true);
  assert.equal(handoff.actionState, "not_started");
  assert.equal(handoff.evidenceBasis, "accepted_internal_results");
  assert.equal(handoff.externalOutcomeVerified, false);
  assert.equal(handoff.sourceTaskCount, 2);

  const recurringA = prepareAccepted(rt, {
    title: "Recurring research result A",
    runId: "run_recurring_research_a",
    oneMode: true,
    participantIds: ["agent-research"],
    toolName: "web.search",
    recurrence: DAILY_RESEARCH_RECURRENCE,
  });
  const recurringB = prepareAccepted(rt, {
    title: "Recurring research result B",
    runId: "run_recurring_research_b",
    oneMode: true,
    participantIds: ["agent-research"],
    toolName: "web.search",
    recurrence: DAILY_RESEARCH_RECURRENCE,
  });
  const recurringC = prepareAccepted(rt, {
    title: "Recurring research result C",
    runId: "run_recurring_research_c",
    oneMode: true,
    participantIds: ["agent-research"],
    toolName: "web.search",
    recurrence: DAILY_RESEARCH_RECURRENCE,
  });
  assert.equal(produce(rt, recurringA).reason, "insufficient_verified_completions",
    "one accepted recurring Task must not produce any suggestion");
  const recurringAgent = produce(rt, recurringB);
  assert.equal(recurringAgent.reason, "created");
  assert.equal(recurringAgent.suggestion.type, "agent_build",
    "Agent Build keeps priority on the second exact accepted recurrence");
  const recurringAgentReview = rt.suggestions.acceptOneSuggestionForReview({
    expectedStoreVersion: rt.suggestions.getOneSuggestionState().version,
    suggestionId: recurringAgent.suggestion.id,
    expectedSuggestionVersion: recurringAgent.suggestion.version,
    confirmedByUser: true,
    reviewOnly: true,
  });
  assert.equal(recurringAgentReview.value.status, "review_required");
  const recurringAutomation = produce(rt, recurringC);
  assert.equal(recurringAutomation.reason, "created");
  assert.equal(recurringAutomation.suggestion.type, "automation",
    "an active same-pattern Agent review must not permanently starve the next eligible automation");
  assert.equal(recurringAutomation.suggestion.proposal.repeatedIntentCount, 3);
  assert.equal(recurringAutomation.suggestion.proposal.preview.permission, "draft_only");
  assert.equal(recurringAutomation.suggestion.proposal.preview.approvalPolicy,
    "explicit_approval_before_external_change");
  assert.match(recurringAutomation.suggestion.proposal.preview.stopControl, /Manual stop/);
  assert.ok(Date.parse(recurringAutomation.suggestion.proposal.preview.nextRunAt) > Date.now());
  assert.ok(Date.parse(recurringAutomation.suggestion.proposal.preview.nextRunAt) <= Date.now() + 8 * 24 * 60 * 60 * 1_000);
  const duplicateRecurring = prepareAccepted(rt, {
    title: "Recurring research result D",
    runId: "run_recurring_research_d",
    oneMode: true,
    participantIds: ["agent-research"],
    toolName: "web.search",
    recurrence: DAILY_RESEARCH_RECURRENCE,
  });
  assert.equal(produce(rt, duplicateRecurring).reason, "duplicate_active",
    "active Agent and automation reviews suppress duplicate live suggestions after restart-safe arbitration");

  const differentTime = { ...DAILY_RESEARCH_RECURRENCE, localTime: "10:00" };
  for (const [suffix, recurrence] of [
    ["time_a", differentTime],
    ["time_b", differentTime],
    ["timezone", { ...DAILY_RESEARCH_RECURRENCE, timeZone: "UTC" }],
    ["end", { ...DAILY_RESEARCH_RECURRENCE, endPolicy: "manual_stop" }],
  ]) {
    const prepared = prepareAccepted(rt, {
      title: `Non-merge recurrence ${suffix}`,
      runId: `run_non_merge_${suffix}`,
      oneMode: true,
      participantIds: ["agent-research"],
      toolName: "web.search",
      recurrence,
    });
    const result = produce(rt, prepared);
    assert.notEqual(result.suggestion?.type, "automation",
      "different schedule/time-zone patterns must not borrow completions from another recurrence");
  }

  const automationStateRow = db.prepare("SELECT value FROM meta WHERE key = ? LIMIT 1")
    .get(rt.producer.ONE_AUTOMATION_OBSERVATION_META_KEY);
  assert.ok(automationStateRow);
  const automationState = JSON.parse(automationStateRow.value);
  assert.ok(automationState.observations.length >= 3);
  const safeAutomationPersistence = JSON.stringify({
    automationState,
    suggestion: recurringAutomation.suggestion,
  });
  for (const forbidden of [
    SECRET_TITLE,
    "password=",
    "never-store-this",
    "/Users/",
    "/private/tmp/",
    "web.search",
    "web.race",
    "user:",
    "assistant:",
  ]) assert.equal(safeAutomationPersistence.includes(forbidden), false, `automation evidence leaked ${forbidden}`);

  const rosterOnlyA = prepareAccepted(rt, {
    title: "Roster without verified contribution A",
    runId: "run_roster_only_a",
    oneMode: true,
    participantIds: ["agent-research", "agent-verify"],
    toolParticipantIds: ["agent-research"],
    toolName: "document.compare",
  });
  const rosterOnlyB = prepareAccepted(rt, {
    title: "Roster without verified contribution B",
    runId: "run_roster_only_b",
    oneMode: true,
    participantIds: ["agent-research", "agent-verify"],
    toolParticipantIds: ["agent-research"],
    toolName: "document.compare",
  });
  assert.equal(produce(rt, rosterOnlyA).reason, "no_reusable_execution_pattern");
  assert.equal(produce(rt, rosterOnlyB).reason, "no_reusable_execution_pattern");
  assert.equal(rt.suggestions.getOneSuggestionState().suggestions
    .filter((item) => item.type === "retain_team").length, 0,
  "a roster without one durable successful participant event each must not become a Team suggestion");

  const teamA = prepareAccepted(rt, {
    title: "Team research A",
    runId: "run_team_pattern_a",
    oneMode: true,
    participantIds: ["agent-research", "agent-verify"],
    toolName: "document.compare",
  });
  const teamB = prepareAccepted(rt, {
    title: "Team research B",
    runId: "run_team_pattern_b",
    oneMode: true,
    participantIds: ["agent-research", "agent-verify"],
    toolName: "document.compare",
  });
  assert.equal(produce(rt, teamA).suggestion, null);
  const team = produce(rt, teamB);
  assert.equal(team.reason, "created");
  assert.equal(team.suggestion.type, "retain_team");
  assert.equal(team.suggestion.proposal.signalSource, "accepted_result_pattern");
  assert.equal(team.suggestion.proposal.participantRefs.length, 2);
  assert.equal(team.suggestion.proposal.acceptedResultCount, 2);
  assert.equal(team.suggestion.proposal.teamBenefitEvidenceRef, undefined,
    "participant repetition must not manufacture a team-benefit claim");
  assert.ok(team.suggestion.proposal.contributionReceiptRefs.every((ref) => ref.startsWith("evt_")));
  for (const ref of team.suggestion.proposal.contributionReceiptRefs) {
    const row = db.prepare("SELECT kind, payload_json FROM run_events WHERE id = ? LIMIT 1").get(ref);
    assert.ok(row, "every Team contribution receipt ref must resolve to an actual durable run event");
    assert.equal(row.kind, "mcp_tool-use");
    const payload = JSON.parse(row.payload_json);
    assert.equal(payload.toolIsError, false);
    assert.equal(typeof payload.toolName, "string");
    assert.equal(typeof payload.toolId, "string");
    assert.ok(payload.toolId.length > 0 && payload.toolId.length <= 240);
  }

  const observations = readObservations(db, rt.producer);
  assert.ok(observations.observations.length >= 4,
    "only reusable One execution patterns should enter the observation store");
  const persisted = JSON.stringify(observations);
  for (const forbidden of [
    SECRET_TITLE,
    "never-store-this",
    "/Users/private/raw-transcript.txt",
    "/private/tmp/never-project-this",
    "web.search",
    "document.compare",
    "agent-research",
    "agent-verify",
  ]) assert.equal(persisted.includes(forbidden), false, `observation store leaked ${forbidden}`);

  const raceBase = prepareAccepted(rt, {
    title: "Concurrent pattern base accepted research result",
    runId: "run_agent_pattern_race_base",
    oneMode: true,
    participantIds: ["agent-research"],
    toolName: "web.race",
  });
  assert.equal(produce(rt, raceBase).reason, "insufficient_verified_completions");
  const race = prepareAccepted(rt, {
    title: "Concurrent third accepted research result",
    runId: "run_agent_pattern_race",
    oneMode: true,
    participantIds: ["agent-research"],
    toolName: "web.race",
  });
  console.log(JSON.stringify({
    ok: true,
    raceTaskId: race.accepted.id,
    raceRunId: race.receipt.runId,
    raceClosureId: race.closure.closure.valueClosureId,
    agentSuggestionId: second.suggestion.id,
    teamSuggestionId: team.suggestion.id,
  }));
  db.close();
  app.quit();
}

async function raceWorker() {
  const { app, db } = await openStore();
  const rt = runtime();
  const task = rt.tasks.getCanonicalTask(argument("--task-id"));
  const receipt = rt.runEvents.getInvocationRunReceipt(argument("--run-id"));
  const closure = require("../dist/electron/one/value-closure.js")
    .getOneValueClosureState().closures.find((item) => item.closure.valueClosureId === argument("--closure-id"));
  const result = rt.producer.produceAcceptedResultSuggestion({
    hostId: HOST_ID,
    taskId: task.id,
    expectedTaskVersion: task.version,
    expectedTaskUpdatedAt: task.updatedAt,
    expectedRunId: receipt.runId,
    valueClosureId: closure.closure.valueClosureId,
    expectedValueClosureVersion: closure.version,
    confirmedByUser: true,
  });
  console.log(JSON.stringify({ ok: true, reason: result.reason, suggestionId: result.suggestion?.id ?? null }));
  db.close();
  app.quit();
}

async function reloadWorker() {
  const { app, db } = await openStore();
  const rt = runtime();
  const state = rt.suggestions.getOneSuggestionState();
  const taskId = argument("--task-id");
  assert.equal(state.suggestions.filter((item) => item.originTaskId === taskId).length, 1,
    "concurrent producer calls must persist at most one suggestion for the completion");
  assert.equal(state.taskArbitrations.filter((item) => item.taskId === taskId).length, 1);
  const observations = readObservations(db, rt.producer);
  assert.equal(new Set(observations.observations.map((item) => item.observationId)).size, observations.observations.length);
  assert.equal(observations.observations.filter((item) => item.taskId === taskId).length, 1,
    "restart-safe observation idempotency must preserve one exact binding");
  const serialized = JSON.stringify({ observations, suggestions: state.suggestions });
  assert.equal(/password=|\/Users\/|\/private\/tmp|raw-transcript|web\.(?:search|race)|document\.compare/.test(serialized), false);
  assert.equal(serialized.includes("hub_derivative"), false,
    "production producer must hold Hub derivatives without a safe materializer");
  console.log(JSON.stringify({
    ok: true,
    restoredAfterRestart: true,
    observations: observations.observations.length,
    suggestions: state.suggestions.length,
  }));
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
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-one-completion-suggestion-"));
  const storePath = path.join(temp, "completion-suggestion.sqlite");
  const env = { ...process.env, AGENTLAS_STORE_PATH: storePath };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const seed = spawnSync(executable, [
      __filename,
      "--seed",
      `--user-data=${path.join(temp, "seed-user-data")}`,
    ], { env, encoding: "utf8" });
    if (seed.status !== 0) throw new Error(`completion suggestion seed failed\n${seed.stdout}\n${seed.stderr}`);
    process.stdout.write(seed.stdout);
    const seeded = parseLastJson(seed.stdout);
    const common = [
      __filename,
      "--race",
      `--task-id=${seeded.raceTaskId}`,
      `--run-id=${seeded.raceRunId}`,
      `--closure-id=${seeded.raceClosureId}`,
    ];
    const [left, right] = await Promise.all([
      runAsync(executable, [...common, `--user-data=${path.join(temp, "race-left")}`], env),
      runAsync(executable, [...common, `--user-data=${path.join(temp, "race-right")}`], env),
    ]);
    if (left.status !== 0 || right.status !== 0) {
      throw new Error(`completion suggestion race failed\nL:${left.stdout}\n${left.stderr}\nR:${right.stdout}\n${right.stderr}`);
    }
    const outcomes = [parseLastJson(left.stdout), parseLastJson(right.stdout)];
    assert.ok(outcomes.every((item) => item.ok));
    assert.equal(outcomes.filter((item) => item.reason === "created").length, 1);
    assert.equal(outcomes.filter((item) => item.reason === "completed_task_already_arbitrated").length, 1);
    process.stdout.write(`${JSON.stringify({ ok: true, concurrentProducer: outcomes })}\n`);

    const reload = spawnSync(executable, [
      __filename,
      "--reload",
      `--task-id=${seeded.raceTaskId}`,
      `--user-data=${path.join(temp, "reload-user-data")}`,
    ], { env, encoding: "utf8" });
    if (reload.status !== 0) throw new Error(`completion suggestion reload failed\n${reload.stdout}\n${reload.stderr}`);
    process.stdout.write(reload.stdout);

    const ipcSource = fs.readFileSync(path.join(__dirname, "../electron/ipc.ts"), "utf8");
    const mobileSource = fs.readFileSync(path.join(__dirname, "../electron/mobile-bridge/authority.ts"), "utf8");
    const producerSource = fs.readFileSync(path.join(__dirname, "../electron/one/completion-suggestion-producer.ts"), "utf8");
    const assertAcceptanceProducerWiring = (source, startMarker, endMarker, label) => {
      const start = source.indexOf(startMarker);
      const end = source.indexOf(endMarker, start + startMarker.length);
      assert.ok(start >= 0 && end > start, `${label} result-acceptance handler must be present`);
      const handler = source.slice(start, end);
      const closureIndex = handler.indexOf("ensureAcceptedResultValueClosure(");
      const producerIndex = handler.indexOf("tryProduceAcceptedResultSuggestion(");
      assert.ok(closureIndex >= 0, `${label} acceptance must create its exact Value Closure`);
      assert.ok(
        producerIndex > closureIndex,
        `${label} acceptance must run the completion producer only after its Value Closure exists`,
      );
    };
    assertAcceptanceProducerWiring(
      ipcSource,
      'ipcMain.handle("tasks:acceptResult"',
      'ipcMain.handle("oneSearch:search"',
      "Desktop",
    );
    assertAcceptanceProducerWiring(
      mobileSource,
      'case "tasks.acceptResult"',
      'case "tasks.latestResult"',
      "Mobile",
    );
    assert.doesNotMatch(producerSource, /userPrompt|getOneMemory|localPath|credentialStore|resultFolder/,
      "producer source must not read raw/private comparison inputs");
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
