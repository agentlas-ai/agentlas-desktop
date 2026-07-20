#!/usr/bin/env node

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOST_ID = "host_11111111111111111111111111111111";
const INSTALL_A = "2026-07-01T00:00:00.000Z";
const INSTALL_B = "2026-07-02T00:00:00.000Z";

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

function insertAgent(db, id, slug, installedAt) {
  db.prepare(
    `INSERT INTO installed_agents
       (id, slug, name, tagline, system_prompt, mcp_servers_json, trust_grade, installed_at, tone)
     VALUES (?, ?, ?, 'Installed specialist', ?, '[]', 'A', ?, 'blue')`,
  ).run(id, slug, slug, "system: password=must-never-cross /Users/private/system-prompt.md", installedAt);
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
    reviewSeed: require("../dist/electron/one/review-seed.js"),
    reviewContract: require("../dist/shared/one-review-seed.js"),
  };
}

function prepareAccepted(rt, { title, runId, participantIds, toolName }) {
  const chat = rt.chats.createChat({ agentId: participantIds[0], title });
  const initial = rt.tasks.getCanonicalTaskForChat(chat.id);
  const partial = rt.tasks.setCanonicalTaskStatus(initial.id, "partial");
  rt.domainEvents.recordOneDomainEvent({
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
  rt.runEvents.recordRunEvent({
    runId,
    kind: "invoke_started",
    chatId: chat.id,
    agentId: participantIds[0],
    payload: {
      oneMode: true,
      toolMode: "auto",
      hubMode: "hub-allowed",
      planMode: false,
      goalMode: false,
      appsGenerateMode: false,
    },
  });
  rt.domainEvents.recordOneDomainEvent({
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
  participantIds.forEach((participantId, index) => {
    rt.runEvents.recordRunEvent({
      runId,
      kind: "mcp_tool-use",
      chatId: chat.id,
      agentId: participantId,
      nodeId: `node_${index + 1}`,
      payload: {
        role: index === 0 ? "research" : "verify",
        toolName,
        toolId: `tool_${index + 1}`,
        toolIsError: false,
      },
    });
  });
  rt.runEvents.recordRunEvent({
    runId,
    kind: "invoke_completed",
    chatId: chat.id,
    agentId: participantIds[0],
    payload: { resultFolder: "/private/tmp/must-never-cross" },
  });
  const receipt = rt.runEvents.getInvocationRunReceipt(runId);
  const accepted = rt.tasks.acceptCanonicalTaskResult({
    taskId: partial.id,
    expectedVersion: partial.version,
    expectedRunId: runId,
  }, receipt);
  const closure = rt.closures.ensureAcceptedResultValueClosure({
    priorTaskVersion: partial.version,
    acceptedTask: accepted,
    expectedRunId: runId,
    receipt,
    confirmedByUser: true,
  }).value;
  return { accepted, receipt, closure };
}

function produce(rt, prepared) {
  return rt.producer.produceAcceptedResultSuggestion({
    hostId: HOST_ID,
    taskId: prepared.accepted.id,
    expectedTaskVersion: prepared.accepted.version,
    expectedTaskUpdatedAt: prepared.accepted.updatedAt,
    expectedRunId: prepared.receipt.runId,
    valueClosureId: prepared.closure.closure.valueClosureId,
    expectedValueClosureVersion: prepared.closure.version,
    confirmedByUser: true,
  });
}

function acceptInput(rt, suggestion) {
  const review = rt.suggestions.acceptOneSuggestionForReview({
    expectedStoreVersion: rt.suggestions.getOneSuggestionState().version,
    suggestionId: suggestion.id,
    expectedSuggestionVersion: suggestion.version,
    confirmedByUser: true,
    reviewOnly: true,
  }).value;
  const accepted = rt.suggestions.getOneSuggestionState().suggestions.find((item) => item.id === suggestion.id);
  return {
    suggestionId: accepted.id,
    expectedSuggestionVersion: accepted.version,
    reviewRequestId: review.id,
    draftId: review.draftId,
    originTaskId: accepted.originTaskId,
  };
}

function manualEvidence(db, runEvents, prefix, index) {
  const suffix = `${prefix}_${index}`;
  const taskId = `task_${suffix}`;
  const chatId = `chat_${suffix}`;
  const runId = `run_${suffix}`;
  const completedAt = new Date(Date.UTC(2026, 6, 10, 0, index, prefix === "hub" ? 1 : 0)).toISOString();
  db.prepare(
    `INSERT INTO tasks
       (id, title, project_id, firm_id, status, created_at, updated_at, archived_at, origin_chat_id)
     VALUES (?, ?, NULL, NULL, 'completed', ?, ?, NULL, ?)`,
  ).run(taskId, `${prefix} fixture ${index}`, completedAt, completedAt, chatId);
  runEvents.recordRunEvent({ runId, kind: "invoke_started", chatId, payload: { oneMode: false } });
  runEvents.recordRunEvent({ runId, kind: "invoke_completed", chatId, payload: { fixture: true } });
  return {
    taskId,
    taskVersion: Date.parse(completedAt),
    patternKey: `pattern_${prefix}`,
    status: "completed",
    outcome: "success",
    hostVerified: true,
    hostId: "host_local_authority",
    runId,
    completionReceiptRef: runId,
    verificationRef: `verification_${suffix}`,
    evidenceRefs: [`outcome_${suffix}`],
    completedAt,
  };
}

function emptySignals() {
  return { agentBuild: null, retainTeam: null, automation: null, hubDerivative: null };
}

function automationSignal() {
  return {
    intentRef: "intent_weekly_review",
    startConditionRef: "condition_week_start",
    endConditionRef: "condition_draft_reviewed",
    repeatedIntentCount: 3,
    reversible: true,
    riskControlsVerified: true,
    preview: {
      trigger: "Every Monday, prepare a read-only change summary.",
      nextRunAt: "2026-08-03T00:00:00.000Z",
      permission: "draft_only",
      stopControl: "Pause before the next proposed run.",
      approvalPolicy: "explicit_approval_before_external_change",
    },
  };
}

function hubSignal() {
  return {
    privateSourceId: "private_agent_review_source",
    ownerVerified: true,
    publicReleaseIntentConfirmed: true,
    privateInputExcluded: true,
    publicSuitability: "passed",
    publicSuitabilityRef: "public_suitability_review_passed",
    sanitizedManifestRef: "sanitized_manifest_allowlist",
    rightsReviewRef: "rights_review_passed",
    economy: {
      available: true,
      policyRef: "hub_economy_policy_active",
      feeScheduleRef: "hub_fee_schedule_current",
      settlementRuleRef: "hub_settlement_rule_current",
    },
    excludedPrivateCategories: [
      "memory", "credentials", "local_paths", "customer_data", "private_examples", "raw_task_context",
    ],
  };
}

function createManualSuggestion(rt, evidence, type, signal) {
  const signals = emptySignals();
  signals[type] = signal;
  const state = rt.suggestions.getOneSuggestionState();
  const result = rt.suggestions.arbitrateOneSuggestion({
    expectedStoreVersion: state.version,
    originTaskId: evidence[evidence.length - 1].taskId,
    patternKey: evidence[0].patternKey,
    importantBriefingActive: false,
    evidence,
    signals,
  });
  assert.equal(result.reason, "created");
  return result.suggestion;
}

function dbSnapshot(db) {
  return JSON.stringify({
    meta: db.prepare("SELECT key, value FROM meta ORDER BY key").all(),
    tasks: db.prepare("SELECT * FROM tasks ORDER BY id").all(),
    agents: db.prepare("SELECT * FROM installed_agents ORDER BY id").all(),
    automations: db.prepare("SELECT * FROM automations ORDER BY id").all(),
    groups: db.prepare("SELECT * FROM agent_groups ORDER BY id").all(),
    events: db.prepare("SELECT * FROM run_events ORDER BY rowid").all(),
  });
}

function assertReadOnlySeed(rt, db, input) {
  const before = dbSnapshot(db);
  const seed = rt.reviewSeed.getOneSuggestionReviewSeed(input);
  assert.equal(rt.reviewContract.isOneSuggestionReviewSeed(seed), true);
  assert.equal(dbSnapshot(db), before, "getReviewSeed must not mutate canonical or product state");
  return seed;
}

async function worker() {
  const { app, db } = await openStore();
  insertAgent(db, "agent-research", "research-specialist", INSTALL_A);
  insertAgent(db, "agent-verify", "verification-specialist", INSTALL_B);
  const rt = runtime();

  const buildA = prepareAccepted(rt, {
    title: "Secret title password=never /Users/private/raw.txt",
    runId: "run_review_build_a",
    participantIds: ["agent-research"],
    toolName: "web.search",
  });
  const buildB = prepareAccepted(rt, {
    title: "Second accepted result",
    runId: "run_review_build_b",
    participantIds: ["agent-research"],
    toolName: "web.search",
  });
  assert.equal(produce(rt, buildA).suggestion, null);
  const buildSuggestion = produce(rt, buildB).suggestion;
  assert.equal(buildSuggestion.type, "agent_build");
  const buildInput = acceptInput(rt, buildSuggestion);
  db.prepare("UPDATE installed_agents SET name = ?, tagline = ? WHERE id = ?")
    .run("password=must-never-cross", "/Users/private/customer.csv", "agent-research");
  const buildSeed = assertReadOnlySeed(rt, db, buildInput);
  assert.equal(buildSeed.kind, "agent_build");
  assert.equal(buildSeed.buildMode, "single");
  assert.equal(buildSeed.candidate.installedAt, INSTALL_A);
  assert.equal(buildSeed.candidate.packageHash, null);
  const buildRaw = JSON.stringify(buildSeed);
  assert.equal(/must-never-cross|password=|\/Users\/|system-prompt|resultFolder|web\.search/i.test(buildRaw), false);
  assert.throws(
    () => rt.reviewSeed.getOneSuggestionReviewSeed({ ...buildInput, privateContext: "/Users/private/customer.csv" }),
    /unsupported fields/,
  );

  db.prepare("UPDATE installed_agents SET installed_at = ? WHERE id = ?")
    .run("2026-07-12T00:00:00.000Z", "agent-research");
  assert.equal(rt.reviewSeed.getOneSuggestionReviewSeed(buildInput).reason, "installed_agent_unavailable");
  db.prepare("UPDATE installed_agents SET installed_at = ? WHERE id = ?").run(INSTALL_A, "agent-research");
  db.prepare("DELETE FROM installed_agents WHERE id = ?").run("agent-research");
  assert.equal(rt.reviewSeed.getOneSuggestionReviewSeed(buildInput).reason, "installed_agent_unavailable");
  insertAgent(db, "agent-research", "research-specialist", INSTALL_A);

  const teamA = prepareAccepted(rt, {
    title: "Team accepted result A",
    runId: "run_review_team_a",
    participantIds: ["agent-research", "agent-verify"],
    toolName: "document.compare",
  });
  const teamB = prepareAccepted(rt, {
    title: "Team accepted result B",
    runId: "run_review_team_b",
    participantIds: ["agent-research", "agent-verify"],
    toolName: "document.compare",
  });
  assert.equal(produce(rt, teamA).suggestion, null);
  const teamSuggestion = produce(rt, teamB).suggestion;
  assert.equal(teamSuggestion.type, "retain_team");
  const teamInput = acceptInput(rt, teamSuggestion);
  const teamSeed = assertReadOnlySeed(rt, db, teamInput);
  assert.equal(teamSeed.kind, "retain_team");
  assert.deepEqual(teamSeed.candidates.map((item) => item.agentId).sort(), ["agent-research", "agent-verify"]);
  db.prepare("UPDATE installed_agents SET installed_at = ? WHERE id = ?")
    .run("2026-07-13T00:00:00.000Z", "agent-verify");
  assert.equal(rt.reviewSeed.getOneSuggestionReviewSeed(teamInput).reason, "installed_agent_unavailable");
  db.prepare("UPDATE installed_agents SET installed_at = ? WHERE id = ?").run(INSTALL_B, "agent-verify");

  const automationEvidence = [1, 2, 3].map((index) => manualEvidence(db, rt.runEvents, "automation", index));
  const automationSuggestion = createManualSuggestion(rt, automationEvidence, "automation", automationSignal());
  const automationInput = acceptInput(rt, automationSuggestion);
  const automationSeed = assertReadOnlySeed(rt, db, automationInput);
  assert.equal(automationSeed.kind, "automation");
  assert.deepEqual(Object.keys(automationSeed).filter((key) => [
    "nextRunAt", "schedule", "scheduleJson", "prompt", "promptTemplate", "target", "targetId", "targetType", "enabled",
  ].includes(key)), []);
  assert.equal(automationSeed.executableScheduleIncluded, false);
  db.prepare("UPDATE tasks SET status = 'failed' WHERE id = ?").run(automationEvidence[0].taskId);
  assert.equal(rt.reviewSeed.getOneSuggestionReviewSeed(automationInput).reason, "source_evidence_changed");

  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM automations").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agent_groups").get().n, 0);
  const serialized = JSON.stringify({ buildSeed, teamSeed, automationSeed });
  assert.equal(/systemPrompt|localPath|password=|\/Users\/|\/private\/tmp/.test(serialized), false);
  assert.equal(/"(?:credential|credentialValue|secret|system_prompt)"\s*:/.test(serialized), false);
  console.log(JSON.stringify({
    ok: true,
    build: "safe_unsaved_single",
    team: "exact_installed_unsaved",
    automation: "name_and_preview_only",
    hub: "covered_by_one_hub_derivative_runtime",
    staleBindingsBlocked: true,
    readOnly: true,
  }));
  db.close();
  app.quit();
}

function orchestrate() {
  const electronModule = require("electron");
  const executable = typeof electronModule === "string" ? electronModule : process.execPath;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-one-review-seed-"));
  const env = { ...process.env, AGENTLAS_STORE_PATH: path.join(temp, "review-seed.sqlite") };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const result = spawnSync(executable, [
      __filename,
      "--worker",
      `--user-data=${path.join(temp, "user-data")}`,
    ], { env, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`One review seed worker failed\n${result.stdout}\n${result.stderr}`);
    process.stdout.write(result.stdout);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv.includes("--worker")) {
  worker().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
} else {
  try {
    orchestrate();
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
