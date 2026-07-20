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

function emptySignals() {
  return { agentBuild: null, retainTeam: null, automation: null, hubDerivative: null };
}

function agentBuildSignal(suffix = "default") {
  return {
    roleRef: `role_research_${suffix}`,
    inputSchemaRef: `schema_input_${suffix}`,
    outputContractRef: `contract_output_${suffix}`,
    reuseIntentRef: `intent_reuse_${suffix}`,
    userReuseIntentConfirmed: true,
  };
}

function retainTeamSignal(suffix = "default") {
  return {
    teamSignatureRef: `team_signature_${suffix}`,
    assignmentRefs: [`assignment_research_${suffix}`, `assignment_verify_${suffix}`],
    roleRefs: [`role_research_${suffix}`, `role_verify_${suffix}`],
    contributionEvidenceRefs: [`contribution_research_${suffix}`, `contribution_verify_${suffix}`],
    teamBenefitEvidenceRef: `team_benefit_${suffix}`,
  };
}

function automationSignal(overrides = {}) {
  return {
    intentRef: "intent_weekly_price_check",
    startConditionRef: "condition_monday_morning",
    endConditionRef: "condition_summary_reviewed",
    repeatedIntentCount: 3,
    reversible: true,
    riskControlsVerified: true,
    preview: {
      trigger: "Every Monday at 9 AM, check for material price changes.",
      nextRunAt: new Date(Date.now() + 8 * 24 * 60 * 60 * 1_000).toISOString(),
      permission: "draft_only",
      stopControl: "Pause from the One routine sheet before the next run.",
      approvalPolicy: "explicit_approval_before_external_change",
    },
    ...overrides,
  };
}

function hubSignal(overrides = {}) {
  return {
    privateSourceId: "private_agent_research_monitor",
    ownerVerified: true,
    publicReleaseIntentConfirmed: true,
    privateInputExcluded: true,
    publicSuitability: "passed",
    publicSuitabilityRef: "review_public_suitability_passed",
    sanitizedManifestRef: "manifest_public_allowlist_v1",
    rightsReviewRef: "rights_review_passed_v1",
    economy: {
      available: true,
      policyRef: "hub_economy_policy_active",
      feeScheduleRef: "hub_fee_schedule_current",
      settlementRuleRef: "hub_settlement_rules_current",
    },
    excludedPrivateCategories: [
      "memory",
      "credentials",
      "local_paths",
      "customer_data",
      "private_examples",
      "raw_task_context",
    ],
    ...overrides,
  };
}

function request(storeVersion, originTaskId, patternKey, evidence, signals, importantBriefingActive = false) {
  return {
    expectedStoreVersion: storeVersion,
    originTaskId,
    patternKey,
    importantBriefingActive,
    evidence: evidence.map((item) => ({ ...item, patternKey })),
    signals,
  };
}

function createTaskEvidence(db, runEvents, index) {
  const taskId = `task_suggestion_${String(index).padStart(2, "0")}`;
  const chatId = `chat_suggestion_${String(index).padStart(2, "0")}`;
  const runId = `run_suggestion_${String(index).padStart(2, "0")}`;
  const completedAt = new Date(Date.now() - 120_000 + index * 1_000).toISOString();
  db.prepare(
    `INSERT INTO tasks
       (id, title, project_id, firm_id, status, created_at, updated_at, archived_at, origin_chat_id)
     VALUES (?, ?, NULL, NULL, 'completed', ?, ?, NULL, ?)`,
  ).run(taskId, `Suggestion fixture ${index}`, completedAt, completedAt, chatId);
  runEvents.recordRunEvent({ runId, kind: "invoke_started", chatId, payload: { chatId } });
  runEvents.recordRunEvent({ runId, kind: "invoke_completed", chatId, payload: { fixture: true } });
  return {
    taskId,
    taskVersion: Date.parse(completedAt),
    patternKey: "pattern_placeholder",
    status: "completed",
    outcome: "success",
    hostVerified: true,
    hostId: "host_local_authority",
    runId,
    completionReceiptRef: runId,
    verificationRef: `verification_suggestion_${String(index).padStart(2, "0")}`,
    evidenceRefs: [`outcome_suggestion_${String(index).padStart(2, "0")}`],
    completedAt,
  };
}

function eventTypes(domainEvents, entityId) {
  return domainEvents.listOneDomainEvents(entityId, 100).map((event) => event.eventType);
}

function assertNoForbiddenRuntimeEvents(db) {
  const rows = db.prepare("SELECT payload_json FROM run_events WHERE kind = 'one_domain_event'").all();
  const raw = rows.map((row) => row.payload_json).join("\n");
  assert.equal(raw.includes("automation.enabled"), false);
  assert.equal(raw.includes("hub.release_published"), false);
  assert.equal(raw.includes("improvement.proof_ready"), false);
}

function reviewHandoffInput(suggestion, review, suggestionVersion) {
  return {
    suggestionId: suggestion.id,
    expectedSuggestionVersion: suggestionVersion,
    reviewRequestId: review.id,
    draftId: review.draftId,
    originTaskId: suggestion.originTaskId,
  };
}

async function seedWorker() {
  const { app, db } = await openStore();
  const suggestions = require("../dist/electron/one/suggestions.js");
  const domainEvents = require("../dist/electron/one/domain-events.js");
  const runEvents = require("../dist/electron/store/run-events.js");
  const storePath = process.env.AGENTLAS_STORE_PATH;
  assert.ok(storePath && fs.existsSync(storePath));
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(storePath).mode & 0o077, 0, "the SQLite store must remain mode 0600");
  }
  const schemaVersion = db.pragma("user_version", { simple: true });
  const fixtures = Array.from({ length: 32 }, (_, index) => createTaskEvidence(db, runEvents, index + 1));
  let state = suggestions.getOneSuggestionState();
  assert.equal(state.suggestions.length, 0);

  const firstOnly = suggestions.arbitrateOneSuggestion(request(
    state.version,
    fixtures[0].taskId,
    "pattern_first_success",
    [fixtures[0]],
    { ...emptySignals(), agentBuild: agentBuildSignal("first") },
  ));
  assert.equal(firstOnly.reason, "insufficient_verified_successes");
  assert.equal(firstOnly.suggestion, null);
  assert.equal(suggestions.getOneSuggestionState().version, state.version, "a first success must not mutate suggestion state");

  const failedEvidence = { ...fixtures[1], outcome: "failure" };
  const failed = suggestions.arbitrateOneSuggestion(request(
    state.version,
    failedEvidence.taskId,
    "pattern_failed",
    [fixtures[0], failedEvidence],
    { ...emptySignals(), agentBuild: agentBuildSignal("failed") },
  ));
  assert.equal(failed.reason, "host_verified_success_required");
  assert.equal(suggestions.getOneSuggestionState().version, state.version, "failure evidence must not mutate state");

  const forged = { ...fixtures[1], taskVersion: fixtures[1].taskVersion + 1 };
  const forgedResult = suggestions.arbitrateOneSuggestion(request(
    state.version,
    forged.taskId,
    "pattern_forged",
    [fixtures[0], forged],
    { ...emptySignals(), agentBuild: agentBuildSignal("forged") },
  ));
  assert.equal(forgedResult.reason, "host_verified_success_required", "Main must re-check canonical Task versions");

  const briefing = suggestions.arbitrateOneSuggestion(request(
    state.version,
    fixtures[2].taskId,
    "pattern_briefing_blocked",
    [fixtures[1], fixtures[2]],
    { ...emptySignals(), agentBuild: agentBuildSignal("briefing") },
    true,
  ));
  assert.equal(briefing.reason, "important_briefing_active");
  assert.equal(suggestions.getOneSuggestionState().taskArbitrations.length, 0, "Briefing deferral must not claim the Task");

  const allCandidates = {
    agentBuild: agentBuildSignal("priority"),
    retainTeam: retainTeamSignal("priority"),
    automation: automationSignal(),
    hubDerivative: hubSignal(),
  };
  const priority = suggestions.arbitrateOneSuggestion(request(
    state.version,
    fixtures[3].taskId,
    "pattern_priority",
    [fixtures[1], fixtures[2], fixtures[3]],
    allCandidates,
  ));
  assert.equal(priority.reason, "created");
  assert.equal(priority.suggestion.type, "agent_build", "documented Build→Team→Automation→Hub priority must be deterministic");
  assert.deepEqual(priority.suggestion.evidence.map((item) => item.taskId), [fixtures[1].taskId, fixtures[2].taskId, fixtures[3].taskId]);
  assert.ok(priority.suggestion.evidenceRefs.includes(fixtures[3].runId));
  assert.deepEqual(eventTypes(domainEvents, priority.suggestion.id), ["ecosystem.suggestion_created"]);
  const duplicateTask = suggestions.arbitrateOneSuggestion(request(
    priority.storeVersion,
    fixtures[3].taskId,
    "pattern_priority",
    [fixtures[1], fixtures[2], fixtures[3]],
    { ...emptySignals(), retainTeam: retainTeamSignal("duplicate") },
  ));
  assert.equal(duplicateTask.reason, "completed_task_already_arbitrated");
  assert.equal(suggestions.getOneSuggestionState().suggestions.filter((item) => item.originTaskId === fixtures[3].taskId).length, 1);

  const acceptedBuild = suggestions.acceptOneSuggestionForReview({
    expectedStoreVersion: priority.storeVersion,
    suggestionId: priority.suggestion.id,
    expectedSuggestionVersion: priority.suggestion.version,
    confirmedByUser: true,
    reviewOnly: true,
  });
  assert.equal(acceptedBuild.value.status, "review_required");
  assert.equal(acceptedBuild.value.reviewKind, "agent_definition_draft");
  assert.deepEqual(Object.keys(acceptedBuild.value).sort(), [
    "createdAt", "draftId", "id", "originTaskId", "reviewKind", "sourceTaskRefs", "status", "suggestionId", "type",
  ].sort());
  assert.equal(JSON.stringify(acceptedBuild.value).match(/(?:built|enabled|published)/i), null, "acceptance must stop at a review draft");
  assert.ok(eventTypes(domainEvents, priority.suggestion.id).includes("agent.build_requested"));
  const acceptedBuildSuggestion = suggestions.getOneSuggestionState().suggestions.find((item) => item.id === priority.suggestion.id);
  const buildHandoffInput = reviewHandoffInput(acceptedBuildSuggestion, acceptedBuild.value, acceptedBuildSuggestion.version);
  const buildHandoff = suggestions.getOneSuggestionReviewHandoff(buildHandoffInput);
  assert.deepEqual(Object.keys(buildHandoff).sort(), [
    "actionState", "contractVersion", "createdAt", "draftId", "evidenceBasis", "externalOutcomeVerified",
    "fallbackReason", "fallbackToOriginTaskWork",
    "originTaskId", "reviewKind", "reviewOnly", "reviewRequestId", "sourceTaskCount", "suggestionId",
    "suggestionVersion", "targetRoute", "targetSurface", "type",
  ].sort());
  assert.equal(buildHandoff.targetSurface, "build");
  assert.equal(buildHandoff.targetRoute.startsWith("/build?"), true);
  assert.equal(buildHandoff.reviewOnly, true);
  assert.equal(buildHandoff.actionState, "not_started");
  assert.equal(buildHandoff.fallbackToOriginTaskWork, false);
  assert.equal(buildHandoff.fallbackReason, null);
  assert.equal(buildHandoff.sourceTaskCount, priority.suggestion.evidence.length);
  assert.equal(buildHandoff.evidenceBasis, "verified_outcomes");
  assert.equal(buildHandoff.externalOutcomeVerified, true);
  assert.equal(/roleRef|inputSchemaRef|outputContractRef|evidenceRefs|raw|secret|\/Users\//i.test(JSON.stringify(buildHandoff)), false,
    "review handoff must expose only opaque binding metadata");
  const buildRoute = new URL(buildHandoff.targetRoute, "https://desktop.agentlas.local");
  assert.equal(buildRoute.searchParams.get("suggestionId"), priority.suggestion.id);
  assert.equal(buildRoute.searchParams.get("suggestionVersion"), String(acceptedBuildSuggestion.version));
  assert.equal(buildRoute.searchParams.get("reviewRequestId"), acceptedBuild.value.id);
  assert.equal(buildRoute.searchParams.get("draftId"), acceptedBuild.value.draftId);
  assert.equal(buildRoute.searchParams.get("originTaskId"), priority.suggestion.originTaskId);
  assert.throws(
    () => suggestions.getOneSuggestionReviewHandoff({ ...buildHandoffInput, expectedSuggestionVersion: buildHandoffInput.expectedSuggestionVersion - 1 }),
    /changed; refresh/,
  );
  assert.throws(
    () => suggestions.getOneSuggestionReviewHandoff({ ...buildHandoffInput, reviewRequestId: "one_suggestion_review_00000000000000000000000000000000" }),
    /no longer bound/,
  );
  assert.throws(
    () => suggestions.getOneSuggestionReviewHandoff({ ...buildHandoffInput, draftId: "one_agent_draft_00000000000000000000000000000000" }),
    /canonical draft/,
  );
  assert.throws(
    () => suggestions.getOneSuggestionReviewHandoff({ ...buildHandoffInput, originTaskId: fixtures[2].taskId }),
    /canonical draft|originating Task/,
  );
  assert.throws(
    () => suggestions.getOneSuggestionReviewHandoff({ ...buildHandoffInput, privateContext: "/Users/private/customer.csv" }),
    /unsupported fields/,
  );

  state = suggestions.getOneSuggestionState();
  const duplicateGuardTeam = suggestions.arbitrateOneSuggestion(request(
    state.version,
    fixtures[28].taskId,
    "pattern_priority",
    [fixtures[1], fixtures[2], fixtures[28]],
    allCandidates,
  ));
  assert.equal(duplicateGuardTeam.reason, "created");
  assert.equal(duplicateGuardTeam.suggestion.type, "retain_team",
    "an active same-pattern Agent review must yield to the next eligible Team candidate");
  const duplicateGuardAutomation = suggestions.arbitrateOneSuggestion(request(
    duplicateGuardTeam.storeVersion,
    fixtures[29].taskId,
    "pattern_priority",
    [fixtures[1], fixtures[2], fixtures[29]],
    allCandidates,
  ));
  assert.equal(duplicateGuardAutomation.reason, "created");
  assert.equal(duplicateGuardAutomation.suggestion.type, "automation",
    "active Agent and Team candidates must not permanently starve an eligible automation");
  const allActiveDuplicate = suggestions.arbitrateOneSuggestion(request(
    duplicateGuardAutomation.storeVersion,
    fixtures[30].taskId,
    "pattern_priority",
    [fixtures[1], fixtures[2], fixtures[30]],
    { ...allCandidates, hubDerivative: null },
  ));
  assert.equal(allActiveDuplicate.reason, "duplicate_active");
  assert.equal(allActiveDuplicate.suggestion, null);
  assert.equal(suggestions.getOneSuggestionState().taskArbitrations
    .some((item) => item.taskId === fixtures[30].taskId), false,
  "a duplicate-only completion must not consume its one-suggestion arbitration slot");

  state = suggestions.getOneSuggestionState();
  const twoRunAutomation = suggestions.arbitrateOneSuggestion(request(
    state.version,
    fixtures[5].taskId,
    "pattern_automation_two",
    [fixtures[4], fixtures[5]],
    { ...emptySignals(), automation: automationSignal() },
  ));
  assert.equal(twoRunAutomation.reason, "no_eligible_candidate");
  const irreversible = suggestions.arbitrateOneSuggestion(request(
    state.version,
    fixtures[8].taskId,
    "pattern_automation_irreversible",
    [fixtures[6], fixtures[7], fixtures[8]],
    { ...emptySignals(), automation: automationSignal({ reversible: false }) },
  ));
  assert.equal(irreversible.reason, "no_eligible_candidate");
  assert.throws(
    () => suggestions.arbitrateOneSuggestion(request(
      state.version,
      fixtures[8].taskId,
      "pattern_automation_secret",
      [fixtures[6], fixtures[7], fixtures[8]],
      { ...emptySignals(), automation: automationSignal({
        preview: { ...automationSignal().preview, trigger: "Use password=private-secret before running." },
      }) },
    )),
    /unsafe secret/,
  );
  const automation = suggestions.arbitrateOneSuggestion(request(
    state.version,
    fixtures[8].taskId,
    "pattern_automation_valid",
    [fixtures[6], fixtures[7], fixtures[8]],
    { ...emptySignals(), automation: automationSignal() },
  ));
  assert.equal(automation.suggestion.type, "automation");
  assert.deepEqual(Object.keys(automation.suggestion.proposal.preview).sort(), [
    "approvalPolicy", "nextRunAt", "permission", "stopControl", "trigger",
  ].sort());
  const automationReview = suggestions.acceptOneSuggestionForReview({
    expectedStoreVersion: automation.storeVersion,
    suggestionId: automation.suggestion.id,
    expectedSuggestionVersion: automation.suggestion.version,
    confirmedByUser: true,
    reviewOnly: true,
  });
  assert.equal(automationReview.value.reviewKind, "automation_proposal_draft");
  assert.ok(eventTypes(domainEvents, automation.suggestion.id).includes("automation.proposed"));
  const acceptedAutomationSuggestion = suggestions.getOneSuggestionState().suggestions.find((item) => item.id === automation.suggestion.id);
  const automationHandoff = suggestions.getOneSuggestionReviewHandoff(
    reviewHandoffInput(acceptedAutomationSuggestion, automationReview.value, acceptedAutomationSuggestion.version),
  );
  assert.equal(automationHandoff.targetSurface, "automation");
  assert.equal(automationHandoff.targetRoute.startsWith("/automation/new?"), true);

  state = suggestions.getOneSuggestionState();
  const economyInactive = suggestions.arbitrateOneSuggestion(request(
    state.version,
    fixtures[10].taskId,
    "pattern_hub_inactive",
    [fixtures[9], fixtures[10]],
    { ...emptySignals(), hubDerivative: hubSignal({
      economy: { ...hubSignal().economy, available: false },
    }) },
  ));
  assert.equal(economyInactive.reason, "no_eligible_candidate");
  const privateNotExcluded = suggestions.arbitrateOneSuggestion(request(
    state.version,
    fixtures[10].taskId,
    "pattern_hub_private",
    [fixtures[9], fixtures[10]],
    { ...emptySignals(), hubDerivative: hubSignal({ privateInputExcluded: false }) },
  ));
  assert.equal(privateNotExcluded.reason, "no_eligible_candidate");
  assert.throws(
    () => suggestions.arbitrateOneSuggestion(request(
      state.version,
      fixtures[10].taskId,
      "pattern_hub_missing_exclusion",
      [fixtures[9], fixtures[10]],
      { ...emptySignals(), hubDerivative: hubSignal({
        excludedPrivateCategories: ["memory", "credentials", "local_paths"],
      }) },
    )),
    /exclude every private and raw category/,
  );
  assert.throws(
    () => suggestions.arbitrateOneSuggestion({
      ...request(
        state.version,
        fixtures[10].taskId,
        "pattern_hub_raw_field",
        [fixtures[9], fixtures[10]],
        { ...emptySignals(), hubDerivative: { ...hubSignal(), rawPrivateSource: "/Users/private/customer.csv" } },
      ),
    }),
    /unsupported fields/,
  );
  const hub = suggestions.arbitrateOneSuggestion(request(
    state.version,
    fixtures[10].taskId,
    "pattern_hub_valid",
    [fixtures[9], fixtures[10]],
    { ...emptySignals(), hubDerivative: hubSignal() },
  ));
  assert.equal(hub.suggestion.type, "hub_derivative");
  assert.equal(hub.suggestion.proposal.economy.available, true);
  assert.equal(hub.suggestion.proposal.privateInputExcluded, true);
  assert.throws(() => suggestions.acceptOneSuggestionForReview({
    expectedStoreVersion: hub.storeVersion,
    suggestionId: hub.suggestion.id,
    expectedSuggestionVersion: hub.suggestion.version,
    confirmedByUser: true,
    reviewOnly: true,
  }), /explicit publicDerivativeReview selection/,
  "even internal callers must not create a state-only Hub review");
  assert.equal(suggestions.getOneSuggestionState().version, hub.storeVersion);
  assert.equal(eventTypes(domainEvents, hub.suggestion.id).includes("hub.derivative_requested"), false);

  state = suggestions.getOneSuggestionState();
  const team = suggestions.arbitrateOneSuggestion(request(
    state.version,
    fixtures[27].taskId,
    "pattern_team_handoff",
    [fixtures[26], fixtures[27]],
    { ...emptySignals(), retainTeam: retainTeamSignal("handoff") },
  ));
  assert.equal(team.suggestion.type, "retain_team");
  const teamReview = suggestions.acceptOneSuggestionForReview({
    expectedStoreVersion: team.storeVersion,
    suggestionId: team.suggestion.id,
    expectedSuggestionVersion: team.suggestion.version,
    confirmedByUser: true,
    reviewOnly: true,
  });
  const acceptedTeamSuggestion = suggestions.getOneSuggestionState().suggestions.find((item) => item.id === team.suggestion.id);
  const teamHandoff = suggestions.getOneSuggestionReviewHandoff(
    reviewHandoffInput(acceptedTeamSuggestion, teamReview.value, acceptedTeamSuggestion.version),
  );
  assert.equal(teamHandoff.targetSurface, "agent_groups");
  assert.equal(teamHandoff.targetRoute.startsWith("/library/agent-groups?"), true);

  state = suggestions.getOneSuggestionState();
  const snoozeCandidate = suggestions.arbitrateOneSuggestion(request(
    state.version,
    fixtures[12].taskId,
    "pattern_team_snooze",
    [fixtures[11], fixtures[12]],
    { ...emptySignals(), retainTeam: retainTeamSignal("snooze") },
  ));
  assert.throws(
    () => suggestions.snoozeOneSuggestion({
      expectedStoreVersion: snoozeCandidate.storeVersion,
      suggestionId: snoozeCandidate.suggestion.id,
      expectedSuggestionVersion: snoozeCandidate.suggestion.version,
      confirmedByUser: true,
      snoozeMs: 60 * 60 * 1_000,
    }),
    /snoozeMs must be between/,
  );
  const snoozed = suggestions.snoozeOneSuggestion({
    expectedStoreVersion: snoozeCandidate.storeVersion,
    suggestionId: snoozeCandidate.suggestion.id,
    expectedSuggestionVersion: snoozeCandidate.suggestion.version,
    confirmedByUser: true,
  });
  assert.equal(snoozed.value.status, "snoozed");
  assert.ok(Date.parse(snoozed.value.resumeAfter) - Date.parse(snoozed.updatedAt) >= 7 * 24 * 60 * 60 * 1_000);
  assert.ok(eventTypes(domainEvents, snoozeCandidate.suggestion.id).includes("suggestion.snoozed"));

  const dismissCandidate = suggestions.arbitrateOneSuggestion(request(
    snoozed.storeVersion,
    fixtures[14].taskId,
    "pattern_team_dismiss",
    [fixtures[13], fixtures[14]],
    { ...emptySignals(), retainTeam: retainTeamSignal("dismiss") },
  ));
  const dismissed = suggestions.dismissOneSuggestion({
    expectedStoreVersion: dismissCandidate.storeVersion,
    suggestionId: dismissCandidate.suggestion.id,
    expectedSuggestionVersion: dismissCandidate.suggestion.version,
    confirmedByUser: true,
  });
  assert.equal(dismissed.value.status, "dismissed");
  assert.ok(Date.parse(dismissed.value.cooldownUntil) - Date.parse(dismissed.updatedAt) >= 30 * 24 * 60 * 60 * 1_000);
  assert.ok(eventTypes(domainEvents, dismissCandidate.suggestion.id).includes("suggestion.dismissed"));
  const teamSuppressed = suggestions.arbitrateOneSuggestion(request(
    dismissed.storeVersion,
    fixtures[16].taskId,
    "pattern_team_suppressed",
    [fixtures[15], fixtures[16]],
    { ...emptySignals(), retainTeam: retainTeamSignal("suppressed") },
  ));
  assert.equal(teamSuppressed.reason, "suppressed");

  const neverCandidate = suggestions.arbitrateOneSuggestion(request(
    dismissed.storeVersion,
    fixtures[18].taskId,
    "pattern_hub_never",
    [fixtures[17], fixtures[18]],
    { ...emptySignals(), hubDerivative: hubSignal({ privateSourceId: "private_agent_never" }) },
  ));
  const never = suggestions.neverAskOneSuggestion({
    expectedStoreVersion: neverCandidate.storeVersion,
    suggestionId: neverCandidate.suggestion.id,
    expectedSuggestionVersion: neverCandidate.suggestion.version,
    confirmedByUser: true,
  });
  assert.equal(never.value.status, "never_ask_again");
  assert.equal(never.value.cooldownUntil, null);
  const hubSuppressed = suggestions.arbitrateOneSuggestion(request(
    never.storeVersion,
    fixtures[20].taskId,
    "pattern_hub_suppressed",
    [fixtures[19], fixtures[20]],
    { ...emptySignals(), hubDerivative: hubSignal({ privateSourceId: "private_agent_after_never" }) },
  ));
  assert.equal(hubSuppressed.reason, "suppressed");

  const ignoredA = suggestions.arbitrateOneSuggestion(request(
    never.storeVersion,
    fixtures[22].taskId,
    "pattern_ignore_frequency",
    [fixtures[21], fixtures[22]],
    { ...emptySignals(), agentBuild: agentBuildSignal("ignore_a") },
  ));
  const ignoredB = suggestions.arbitrateOneSuggestion(request(
    ignoredA.storeVersion,
    fixtures[23].taskId,
    "pattern_ignore_frequency",
    [fixtures[21], fixtures[22], fixtures[23]],
    { ...emptySignals(), automation: automationSignal({ intentRef: "intent_ignore_frequency" }) },
  ));
  assert.equal(ignoredB.suggestion.type, "automation",
    "the live duplicate guard is scoped to type plus pattern, not all ecosystem candidates");
  const firstIgnored = suggestions.markOneSuggestionIgnored({
    expectedStoreVersion: ignoredB.storeVersion,
    suggestionId: ignoredA.suggestion.id,
    expectedSuggestionVersion: ignoredA.suggestion.version,
    observationConfirmed: true,
  });
  assert.equal(firstIgnored.value.ignoredCount, 1);
  assert.equal(firstIgnored.value.frequencyDivisor, 1);
  const secondIgnored = suggestions.markOneSuggestionIgnored({
    expectedStoreVersion: firstIgnored.storeVersion,
    suggestionId: ignoredB.suggestion.id,
    expectedSuggestionVersion: ignoredB.suggestion.version,
    observationConfirmed: true,
  });
  assert.equal(secondIgnored.value.ignoredCount, 2);
  assert.equal(secondIgnored.value.frequencyDivisor, 2, "two consecutive ignores must halve exposure frequency");
  assert.equal(eventTypes(domainEvents, ignoredA.suggestion.id).includes("suggestion.dismissed"), false, "implicit ignore must not fake a dismissal event");
  const ignoredCooldown = suggestions.arbitrateOneSuggestion(request(
    secondIgnored.storeVersion,
    fixtures[24].taskId,
    "pattern_ignore_frequency",
    [fixtures[23], fixtures[24]],
    { ...emptySignals(), agentBuild: agentBuildSignal("ignore_c") },
  ));
  assert.equal(ignoredCooldown.reason, "ignored_pattern_cooldown");

  assert.throws(
    () => suggestions.arbitrateOneSuggestion({
      ...request(
        secondIgnored.storeVersion,
        fixtures[24].taskId,
        "pattern_extra_field",
        [fixtures[23], fixtures[24]],
        { ...emptySignals(), agentBuild: agentBuildSignal("extra") },
      ),
      rawTaskTranscript: "user: private content",
    }),
    /unsupported fields/,
  );
  assert.throws(
    () => suggestions.arbitrateOneSuggestion(request(
      secondIgnored.storeVersion,
      fixtures[24].taskId,
      "pattern_secret_id",
      [fixtures[23], fixtures[24]],
      { ...emptySignals(), agentBuild: {
        ...agentBuildSignal("secret"),
        roleRef: "sk-proj-abcdefghijklmnop",
      } },
    )),
    /without secrets/,
  );
  assert.equal(suggestions.getOneSuggestionState().version, secondIgnored.storeVersion, "invalid payloads must not mutate state");

  const raceSuggestion = suggestions.arbitrateOneSuggestion(request(
    secondIgnored.storeVersion,
    fixtures[26].taskId,
    "pattern_race_review",
    [fixtures[25], fixtures[26]],
    { ...emptySignals(), agentBuild: agentBuildSignal("race") },
  ));
  assert.equal(raceSuggestion.reason, "created");
  state = suggestions.getOneSuggestionState();
  assert.equal(JSON.stringify(state).includes("improvementProof"), false);
  assert.equal(db.pragma("user_version", { simple: true }), schemaVersion, "suggestion storage must not create a schema migration");
  assertNoForbiddenRuntimeEvents(db);

  const raw = db.prepare("SELECT value FROM meta WHERE key = ?").get(suggestions.ONE_SUGGESTION_META_KEY).value;
  db.prepare("UPDATE meta SET value = ? WHERE key = ?").run("{not-json", suggestions.ONE_SUGGESTION_META_KEY);
  assert.throws(() => suggestions.getOneSuggestionState(), /corrupt; it was not overwritten/);
  assert.equal(db.prepare("SELECT value FROM meta WHERE key = ?").get(suggestions.ONE_SUGGESTION_META_KEY).value, "{not-json");
  db.prepare("UPDATE meta SET value = ? WHERE key = ?").run(raw, suggestions.ONE_SUGGESTION_META_KEY);

  console.log(JSON.stringify({
    ok: true,
    storeVersion: state.version,
    raceSuggestionId: raceSuggestion.suggestion.id,
    raceSuggestionVersion: raceSuggestion.suggestion.version,
    suggestions: state.suggestions.length,
    reviewRequests: state.reviewRequests.length,
    suppressions: state.suppressions.length,
    schemaVersion,
  }));
  db.close();
  app.quit();
}

async function raceWorker() {
  const { app, db } = await openStore();
  const suggestions = require("../dist/electron/one/suggestions.js");
  try {
    const result = suggestions.acceptOneSuggestionForReview({
      expectedStoreVersion: Number(argument("--store-version")),
      suggestionId: argument("--suggestion-id"),
      expectedSuggestionVersion: Number(argument("--suggestion-version")),
      confirmedByUser: true,
      reviewOnly: true,
    });
    console.log(JSON.stringify({ success: true, reviewId: result.value.id, storeVersion: result.storeVersion }));
  } catch (error) {
    console.log(JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }));
  }
  db.close();
  app.quit();
}

async function reloadWorker() {
  const { app, db } = await openStore();
  const suggestions = require("../dist/electron/one/suggestions.js");
  const domainEvents = require("../dist/electron/one/domain-events.js");
  const state = suggestions.getOneSuggestionState();
  const raceId = argument("--suggestion-id");
  const raceSuggestion = state.suggestions.find((item) => item.id === raceId);
  assert.ok(raceSuggestion, "race suggestion must survive a fresh Electron process");
  assert.equal(raceSuggestion.status, "accepted_for_review");
  assert.equal(state.reviewRequests.filter((item) => item.suggestionId === raceId).length, 1, "race must create one review request");
  assert.equal(eventTypes(domainEvents, raceId).filter((type) => type === "agent.build_requested").length, 1);
  assert.ok(state.suppressions.some((item) => item.mode === "never_ask_again" && item.until === null));
  assert.ok(state.patternFeedback.some((item) => item.ignoredCount === 2 && item.frequencyDivisor === 2));
  assert.equal(new Set(state.taskArbitrations.map((item) => item.taskId)).size, state.taskArbitrations.length);
  assertNoForbiddenRuntimeEvents(db);
  console.log(JSON.stringify({
    ok: true,
    restoredAfterRestart: true,
    storeVersion: state.version,
    suggestions: state.suggestions.length,
    reviewRequests: state.reviewRequests.length,
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
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-one-suggestions-runtime-"));
  const storePath = path.join(temp, "one-suggestions.sqlite");
  const env = { ...process.env, AGENTLAS_STORE_PATH: storePath };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const seed = spawnSync(
      executable,
      [__filename, "--seed", `--user-data=${path.join(temp, "seed-user-data")}`],
      { env, encoding: "utf8" },
    );
    if (seed.status !== 0) throw new Error(`One suggestion seed failed (${seed.status})\n${seed.stdout}\n${seed.stderr}`);
    process.stdout.write(seed.stdout);
    const seeded = parseLastJson(seed.stdout);
    const common = [
      __filename,
      "--race",
      `--store-version=${seeded.storeVersion}`,
      `--suggestion-id=${seeded.raceSuggestionId}`,
      `--suggestion-version=${seeded.raceSuggestionVersion}`,
    ];
    const [raceA, raceB] = await Promise.all([
      runAsync(executable, [...common, `--user-data=${path.join(temp, "race-a")}`], env),
      runAsync(executable, [...common, `--user-data=${path.join(temp, "race-b")}`], env),
    ]);
    if (raceA.status !== 0 || raceB.status !== 0) {
      throw new Error(`One suggestion race process failed\nA:${raceA.stdout}\n${raceA.stderr}\nB:${raceB.stdout}\n${raceB.stderr}`);
    }
    const outcomes = [parseLastJson(raceA.stdout), parseLastJson(raceB.stdout)];
    assert.equal(outcomes.filter((item) => item.success).length, 1, "exactly one concurrent CAS writer must succeed");
    assert.equal(outcomes.filter((item) => !item.success).length, 1);
    assert.match(outcomes.find((item) => !item.success).error, /changed|concurrently|locked|busy/i);
    process.stdout.write(`${JSON.stringify({ ok: true, concurrentCas: outcomes })}\n`);

    const reload = spawnSync(
      executable,
      [
        __filename,
        "--reload",
        `--suggestion-id=${seeded.raceSuggestionId}`,
        `--user-data=${path.join(temp, "reload-user-data")}`,
      ],
      { env, encoding: "utf8" },
    );
    if (reload.status !== 0) throw new Error(`One suggestion reload failed (${reload.status})\n${reload.stdout}\n${reload.stderr}`);
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
