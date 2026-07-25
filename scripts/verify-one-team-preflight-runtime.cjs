#!/usr/bin/env node

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

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
const TEAM_SECRET = "password=do-not-project-this /Users/private/team-input.txt";

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

function insertAgent(db, id, slug, name, tagline) {
  db.prepare(
    `INSERT OR IGNORE INTO installed_agents (
       id, slug, name, name_en, tagline, tagline_en, system_prompt,
       mcp_servers_json, env_requirements_json, preferred_backend,
       trust_grade, installed_at, tone, builtin, role, visibility, entity_kind
     ) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', '[]', NULL, 'A', ?, 'neutral', 0, NULL, 'visible', 'agent')`,
  ).run(
    id,
    slug,
    name,
    name,
    tagline,
    tagline,
    `Stay within the declared ${slug} role.`,
    "2026-07-18T00:00:00.000Z",
  );
}

function deps(overrides = {}) {
  return {
    detectRuntimes: async () => [{ ...ACTIVE_RUNTIME }],
    ...overrides,
  };
}

async function runtimeWorker() {
  const { app, db } = await openStore();
  insertAgent(db, "one-coordinator", "agentlas-orchestrator", "One", "Coordinate and synthesize exact contributions.");
  insertAgent(db, "installed-researcher", "installed-researcher", "Researcher", "Research the exact requested scope.");
  insertAgent(
    db,
    "product-researcher",
    "product-researcher",
    "제품 리서처",
    "50만원 이하 공기청정기 중 25평 거실에 맞는 제품 후보를 비교 조사하고 골라주는 전문가.",
  );
  const chats = require("../dist/electron/store/chats.js");
  const tasks = require("../dist/electron/store/tasks.js");
  const domain = require("../dist/electron/one/domain-events.js");
  const preflight = require("../dist/electron/one/team-preflight.js");
  const contract = require("../dist/shared/one-team-preflight.js");

  const simple = chats.createChat({ agentId: "one-coordinator", title: "Simple", taskMode: "conversation" });
  const simpleResult = await preflight.prepareOneTeamPreflight({
    chatId: simple.id,
    userPrompt: "안녕하세요",
    expectedTaskId: null,
    expectedTaskVersion: null,
  }, deps());
  assert.deepEqual(simpleResult, { kind: "not_required" });
  assert.equal(tasks.findCanonicalTaskForChat(simple.id), null, "simple conversation must remain Task-free and team-free");

  const promotedConversation = chats.createChat({ agentId: "one-coordinator", title: "", taskMode: "conversation" });
  chats.appendChatMessage(promotedConversation.id, "user", "안녕하세요");
  chats.autoTitleFromFirstMessage(promotedConversation.id, "안녕하세요");
  const promotedResult = await preflight.prepareOneTeamPreflight({
    chatId: promotedConversation.id,
    userPrompt: "/hep-network 50만원 이하 공기청정기를 조사하고 출처를 교차 검증해서 골라줘.",
    expectedTaskId: null,
    expectedTaskVersion: null,
  }, deps());
  assert.equal(promotedResult.kind, "proposal");
  assert.match(chats.getChat(promotedConversation.id).title, /^50만원 이하 공기청정기/);
  assert.match(tasks.findCanonicalTaskForChat(promotedConversation.id).title, /^50만원 이하 공기청정기/);

  const naturalDecision = chats.createChat({ agentId: "one-coordinator", title: "Natural decision", taskMode: "conversation" });
  const naturalDecisionResult = await preflight.prepareOneTeamPreflight({
    chatId: naturalDecision.id,
    userPrompt: "50만원 이하 공기청정기 중 25평 거실에 맞는 제품을 골라줘.",
    expectedTaskId: null,
    expectedTaskVersion: null,
  }, deps());
  assert.equal(naturalDecisionResult.kind, "proposal");
  assert.equal(naturalDecisionResult.proposal.status, "proposed");
  assert.equal(naturalDecisionResult.proposal.canConfirmTeam, true, "a constrained real-world decision should propose a clearly matched installed specialist without team jargon");
  assert.ok(naturalDecisionResult.proposal.complexityReasons.includes("constrained_research_decision"));
  assert.deepEqual(naturalDecisionResult.proposal.roles.map((role) => role.candidate.slug), [
    "agentlas-orchestrator",
    "product-researcher",
  ]);

  // ── Resident judge decides team need; complexity wordlists are hints only ──
  // (a) A judged "yes" fires on phrasing every regex misses (Arabic), and the
  //     proposal records the model-assessed reason.
  const judgedYesChat = chats.createChat({ agentId: "one-coordinator", title: "Judged yes", taskMode: "conversation" });
  const judgedYesResult = await preflight.prepareOneTeamPreflight({
    chatId: judgedYesChat.id,
    userPrompt: "قارن ثلاث شركات شحن دولية من مصادر مستقلة وجهّز تقريراً مفصلاً مع جدول مقارنة",
    expectedTaskId: null,
    expectedTaskVersion: null,
  }, deps({ judgeTeamNeed: async () => ({ needed: true, source: "llm", reason: "parallel multi-deliverable research" }) }));
  assert.equal(judgedYesResult.kind, "proposal", "a judged team need must fire even when every complexity regex misses");
  assert.deepEqual(judgedYesResult.proposal.complexityReasons, ["model_assessed_team_benefit"]);

  // (b) A judged "no" vetoes a wordlist false positive.
  const judgedNoChat = chats.createChat({ agentId: "one-coordinator", title: "Judged no", taskMode: "conversation" });
  const judgedNoResult = await preflight.prepareOneTeamPreflight({
    chatId: judgedNoChat.id,
    userPrompt: "Ask installed-researcher to research the market in parallel, write a report and table, then cross-check every source.",
    expectedTaskId: null,
    expectedTaskVersion: null,
  }, deps({ judgeTeamNeed: async () => ({ needed: false, source: "llm", reason: "one simple deliverable" }) }));
  assert.deepEqual(judgedNoResult, { kind: "not_required" }, "a judged 'no team' verdict must override the wordlist reasons");

  // (c) Structured /workforce·/hep-network commands stay closed-form: never judged away.
  const commandChat = chats.createChat({ agentId: "one-coordinator", title: "Command", taskMode: "conversation" });
  const commandResult = await preflight.prepareOneTeamPreflight({
    chatId: commandChat.id,
    userPrompt: "/workforce 50만원 이하 공기청정기를 조사하고 비교해줘",
    expectedTaskId: null,
    expectedTaskVersion: null,
  }, deps({ judgeTeamNeed: async () => ({ needed: false, source: "llm", reason: "should not be consulted" }) }));
  assert.equal(commandResult.kind, "proposal", "an explicit structured team command must never be vetoed by the judge");

  // (d) No model (source fallback) keeps today's wordlist verdict, labeled.
  const fallbackChat = chats.createChat({ agentId: "one-coordinator", title: "Fallback", taskMode: "conversation" });
  const fallbackResult = await preflight.prepareOneTeamPreflight({
    chatId: fallbackChat.id,
    userPrompt: "Research three vendors in parallel, write a report and a table, then cross-check the sources.",
    expectedTaskId: null,
    expectedTaskVersion: null,
  }, deps({ judgeTeamNeed: async () => ({ needed: false, source: "fallback", reason: "no connected model answered" }) }));
  assert.equal(fallbackResult.kind, "proposal", "no model = previous deterministic behavior");
  assert.ok(fallbackResult.proposal.complexityReasons.includes("parallel_work_requested"));

  const adaptiveLocal = chats.createChat({ agentId: "one-coordinator", title: "Adaptive local", taskMode: "conversation" });
  const adaptiveLocalResult = await preflight.prepareOneTeamPreflight({
    chatId: adaptiveLocal.id,
    userPrompt: "Ask installed-researcher to research the market in parallel, write a report and table, then cross-check every source.",
    expectedTaskId: null,
    expectedTaskVersion: null,
  }, deps());
  assert.equal(adaptiveLocalResult.kind, "proposal");
  assert.equal(adaptiveLocalResult.proposal.status, "proposed");
  assert.equal(adaptiveLocalResult.proposal.canConfirmTeam, true, "a clearly matched exact local specialist should be previewable without a pre-hired card");
  assert.deepEqual(adaptiveLocalResult.proposal.roles.map((role) => role.candidate.slug), [
    "agentlas-orchestrator",
    "installed-researcher",
  ]);
  const adaptiveLocalReserved = await preflight.autoResolveOneTeamPreflight({
    proposalId: adaptiveLocalResult.proposal.proposalId,
    expectedProposalVersion: adaptiveLocalResult.proposal.version,
    requestedRunId: "run-adaptive-local",
  }, deps());
  assert.equal(adaptiveLocalReserved.ref.mode, "team", "One should silently use an exact installed team");
  assert.equal(
    domain.listOneDomainEvents(adaptiveLocalResult.proposal.proposalId, 30)
      .some((event) => event.eventType === "approval.requested" || event.eventType === "approval.resolved"),
    false,
    "automatic staffing is not a user approval decision",
  );
  const adaptiveLocalClaim = preflight.prepareOneTeamPreflightClaim(adaptiveLocalReserved.ref, adaptiveLocal.id);
  assert.deepEqual(adaptiveLocalClaim.taskForceTargets, [
    { source: "local", entityKind: "agent", agentId: "installed-researcher" },
  ]);
  preflight.claimPreparedOneTeamPreflight(adaptiveLocalClaim);

  const unrelatedLocal = chats.createChat({ agentId: "one-coordinator", title: "Unrelated local", taskMode: "conversation" });
  const unrelatedLocalResult = await preflight.prepareOneTeamPreflight({
    chatId: unrelatedLocal.id,
    userPrompt: "Split a vacation itinerary and grocery budget into a presentation and spreadsheet, then cross-check it.",
    expectedTaskId: null,
    expectedTaskVersion: null,
  }, deps());
  assert.equal(unrelatedLocalResult.kind, "proposal");
  assert.equal(unrelatedLocalResult.proposal.status, "blocked");
  assert.equal(unrelatedLocalResult.proposal.canConfirmTeam, false, "unrelated installed agents must not be guessed into a team");
  assert.equal(unrelatedLocalResult.proposal.roles.length, 1);
  const unrelatedLocalReserved = await preflight.autoResolveOneTeamPreflight({
    proposalId: unrelatedLocalResult.proposal.proposalId,
    expectedProposalVersion: unrelatedLocalResult.proposal.version,
    requestedRunId: "run-unrelated-local-solo",
  }, deps());
  assert.equal(unrelatedLocalReserved.ref.mode, "solo", "One must silently continue alone when no exact local team is proven");
  assert.equal(unrelatedLocalReserved.proposal.status, "solo_reserved");
  const unrelatedLocalClaim = preflight.prepareOneTeamPreflightClaim(unrelatedLocalReserved.ref, unrelatedLocal.id);
  assert.deepEqual(unrelatedLocalClaim.taskForceTargets, []);
  assert.equal(unrelatedLocalClaim.userPrompt.startsWith("/workforce"), false, "automatic fallback must never enter paid or external Workforce routing");
  preflight.claimPreparedOneTeamPreflight(unrelatedLocalClaim);

  const workforceRequest = chats.createChat({ agentId: "one-coordinator", title: "External request", taskMode: "conversation" });
  const blockedResult = await preflight.prepareOneTeamPreflight({
    chatId: workforceRequest.id,
    userPrompt: "/hep-network research competitors in parallel and independently verify every source",
    expectedTaskId: null,
    expectedTaskVersion: null,
  }, deps());
  assert.equal(blockedResult.kind, "proposal");
  assert.equal(blockedResult.proposal.status, "blocked");
  assert.equal(blockedResult.proposal.canConfirmTeam, false);
  assert.equal(blockedResult.proposal.selectionBoundary, "external_selection_requires_work_review");
  assert.equal(blockedResult.proposal.cost.hubBorrowing, "unknown");
  assert.equal(blockedResult.proposal.cost.runtimeUsage, "unknown");
  assert.equal(blockedResult.proposal.cost.authoritativeQuoteRef, null);
  assert.equal(
    domain.listOneDomainEvents(blockedResult.proposal.proposalId, 20).some((event) => event.eventType === "team.proposed"),
    false,
    "an unavailable external roster must not emit team.proposed",
  );
  await assert.rejects(
    preflight.resolveOneTeamPreflight({
      proposalId: blockedResult.proposal.proposalId,
      expectedProposalVersion: blockedResult.proposal.version,
      resolution: "confirm_team",
      requestedRunId: "run-blocked-team",
      confirmedByUser: true,
    }, deps()),
    /External candidates|not authoritative/,
  );
  const workforceReserved = await preflight.resolveOneTeamPreflight({
    proposalId: blockedResult.proposal.proposalId,
    expectedProposalVersion: blockedResult.proposal.version,
    resolution: "confirm_workforce",
    requestedRunId: "run-confirmed-workforce",
    confirmedByUser: true,
  }, deps());
  assert.equal(workforceReserved.kind, "reserved");
  assert.equal(workforceReserved.ref.mode, "workforce");
  assert.equal(workforceReserved.proposal.status, "workforce_reserved");
  const workforceClaim = preflight.prepareOneTeamPreflightClaim(workforceReserved.ref, workforceRequest.id);
  assert.deepEqual(workforceClaim.taskForceTargets, []);
  assert.match(workforceClaim.userPrompt, /^\/workforce research competitors/);
  const workforceStarted = preflight.claimPreparedOneTeamPreflight(workforceClaim);
  assert.equal(workforceStarted.status, "workforce_started");
  assert.equal(
    domain.listOneDomainEvents(workforceStarted.proposalId, 30).some((event) => event.eventType === "team.assigned"),
    false,
    "Workforce must not claim a team assignment before Hub prepares exact releases",
  );

  const soloRequest = chats.createChat({ agentId: "one-coordinator", title: "External request solo", taskMode: "conversation" });
  const soloBlocked = await preflight.prepareOneTeamPreflight({
    chatId: soloRequest.id,
    userPrompt: "/hep-network research competitors in parallel and independently verify every source",
    expectedTaskId: null,
    expectedTaskVersion: null,
  }, deps());
  const soloReserved = await preflight.resolveOneTeamPreflight({
    proposalId: soloBlocked.proposal.proposalId,
    expectedProposalVersion: soloBlocked.proposal.version,
    resolution: "continue_solo",
    requestedRunId: "run-explicit-solo",
    confirmedByUser: true,
  }, deps());
  assert.equal(soloReserved.kind, "reserved");
  assert.equal(soloReserved.ref.mode, "solo");
  const soloClaim = preflight.prepareOneTeamPreflightClaim(soloReserved.ref, soloRequest.id);
  assert.deepEqual(soloClaim.taskForceTargets, []);
  assert.equal(soloClaim.userPrompt.startsWith("/hep-network"), false, "solo execution cannot re-enter Workforce through a command prefix");
  assert.equal(soloClaim.permission, "write");
  const soloStarted = preflight.claimPreparedOneTeamPreflight(soloClaim);
  assert.equal(soloStarted.status, "solo_started");
  assert.equal(
    domain.listOneDomainEvents(soloStarted.proposalId, 30).some((event) => event.eventType === "team.assigned"),
    false,
    "declining a team must never claim a team assignment",
  );

  const teamChat = chats.createChat({ agentId: "one-coordinator", title: "Team request", taskMode: "conversation" });
  chats.setChatHiredAgents(teamChat.id, [{
    slug: "installed-researcher",
    name: "Researcher",
    source: "installed",
    hiredAt: "2026-07-18T00:00:00.000Z",
  }]);
  const prepared = await preflight.prepareOneTeamPreflight({
    chatId: teamChat.id,
    userPrompt: `Research the market in parallel, write a report and table, then independently verify the sources. ${TEAM_SECRET}`,
    expectedTaskId: null,
    expectedTaskVersion: null,
  }, deps());
  assert.equal(prepared.kind, "proposal");
  assert.ok(contract.isOneTeamPreflightProposal(prepared.proposal));
  assert.equal(prepared.proposal.status, "proposed");
  assert.equal(prepared.proposal.canConfirmTeam, true);
  assert.equal(prepared.proposal.roles.length, 2);
  assert.deepEqual(prepared.proposal.roles.map((role) => role.responsibility), [
    "coordinate_and_synthesize",
    "bounded_specialist_contribution",
  ]);
  for (const role of prepared.proposal.roles) {
    assert.ok(role.inputScopes.includes("current_user_request"));
    assert.ok(role.permissionScopes.includes("workspace.write"));
    assert.ok(role.permissionScopes.includes("external.recruitment.denied"));
    assert.ok(role.expectedOutput.length > 0);
  }
  assert.equal(prepared.proposal.cost.hubBorrowing, "none");
  assert.equal(prepared.proposal.cost.runtimeUsage, "unknown", "no runtime price may be invented");
  assert.equal(prepared.proposal.binding.permission, "write");
  assert.equal("taskForceTargets" in prepared.proposal, false, "renderer projection must not receive executable targets");
  assert.equal("runtime" in prepared.proposal, false, "renderer projection receives only the runtime digest");
  assert.equal(JSON.stringify(prepared.proposal).includes(TEAM_SECRET), false, "renderer proposal must not duplicate the raw prompt");
  const pendingMeta = db.prepare("SELECT value FROM meta WHERE key = ?").get(preflight.ONE_TEAM_PREFLIGHT_META_KEY).value;
  assert.equal(pendingMeta.includes("password=do-not-project-this"), false, "pending proposal must retain raw prompt only in process memory");
  assert.equal(pendingMeta.includes("/Users/private/team-input.txt"), false, "durable preflight store must not retain a private path");
  assert.equal(pendingMeta.includes(ACTIVE_RUNTIME.source), false, "durable preflight store must hash the runtime executable source");
  const task = tasks.getCanonicalTask(prepared.proposal.binding.taskId);
  assert.equal(task.status, "waiting-decision");
  assert.ok(domain.listOneDomainEvents(prepared.proposal.proposalId, 20).some((event) => event.eventType === "team.proposed"));

  await assert.rejects(
    preflight.prepareOneTeamPreflight({
      chatId: teamChat.id,
      userPrompt: "Research in parallel as a team",
      expectedTaskId: task.id,
      expectedTaskVersion: task.version,
      cost: "free",
    }, deps()),
    /Invalid One team preflight request/,
    "renderer cannot inject cost or candidates into preparation",
  );
  await assert.rejects(
    preflight.resolveOneTeamPreflight({
      proposalId: prepared.proposal.proposalId,
      expectedProposalVersion: prepared.proposal.version,
      resolution: "confirm_team",
      requestedRunId: "run-team-injected",
      confirmedByUser: true,
      permission: "full",
    }, deps()),
    /Invalid One team preflight resolution/,
    "renderer cannot inject permission into resolution",
  );

  await assert.rejects(
    preflight.resolveOneTeamPreflight({
      proposalId: prepared.proposal.proposalId,
      expectedProposalVersion: prepared.proposal.version,
      resolution: "confirm_team",
      requestedRunId: "run-runtime-drift",
      confirmedByUser: true,
    }, deps({ detectRuntimes: async () => [{ ...ACTIVE_RUNTIME, model: "changed-model" }] })),
    /runtime changed/i,
  );
  assert.equal(preflight.getOneTeamPreflightForChat(teamChat.id).status, "proposed", "failed revalidation must not mutate proposal");

  const reserved = await preflight.resolveOneTeamPreflight({
    proposalId: prepared.proposal.proposalId,
    expectedProposalVersion: prepared.proposal.version,
    resolution: "confirm_team",
    requestedRunId: "run-exact-team",
    confirmedByUser: true,
  }, deps());
  assert.equal(reserved.kind, "reserved");
  assert.equal(reserved.ref.mode, "team");
  assert.deepEqual(Object.keys(reserved.ref).sort(), [
    "contractVersion", "expectedTaskId", "expectedTaskVersion", "mode", "proposalId", "reservedRunId",
  ]);
  const sameDoubleClick = await preflight.resolveOneTeamPreflight({
    proposalId: prepared.proposal.proposalId,
    expectedProposalVersion: prepared.proposal.version,
    resolution: "confirm_team",
    requestedRunId: "run-exact-team",
    confirmedByUser: true,
  }, deps());
  assert.equal(sameDoubleClick.kind, "reserved");
  assert.equal(sameDoubleClick.ref.reservedRunId, reserved.ref.reservedRunId);
  await assert.rejects(
    preflight.resolveOneTeamPreflight({
      proposalId: prepared.proposal.proposalId,
      expectedProposalVersion: prepared.proposal.version,
      resolution: "confirm_team",
      requestedRunId: "run-stolen-team",
      confirmedByUser: true,
    }, deps()),
    /different run reservation/,
    "double click cannot steal the existing reservation",
  );
  const claim = preflight.prepareOneTeamPreflightClaim(reserved.ref, teamChat.id);
  assert.deepEqual(claim.taskForceTargets, [{ source: "local", entityKind: "agent", agentId: "installed-researcher" }]);
  assert.equal(claim.runtime.digest, prepared.proposal.binding.runtimeDigest);
  assert.ok(claim.userPrompt.includes(TEAM_SECRET), "only Main's one-shot invocation claim may recover the exact prompt");
  assert.equal(preflight.oneTeamRuntimeBindingMatches(claim.runtime, [{ ...ACTIVE_RUNTIME }]), true);
  assert.equal(preflight.oneTeamRuntimeBindingMatches(claim.runtime, [{ ...ACTIVE_RUNTIME, model: "changed-model" }]), false);
  const started = preflight.claimPreparedOneTeamPreflight(claim);
  assert.equal(started.status, "team_started");
  assert.equal(started.startedRun.runId, "run-exact-team");
  assert.ok(domain.listOneDomainEvents(started.proposalId, 40).some((event) => event.eventType === "team.assigned"));
  const claimedMeta = db.prepare("SELECT value FROM meta WHERE key = ?").get(preflight.ONE_TEAM_PREFLIGHT_META_KEY).value;
  assert.equal(claimedMeta.includes("password=do-not-project-this"), false);
  assert.equal(JSON.stringify(domain.listOneDomainEvents(started.proposalId, 40)).includes("password=do-not-project-this"), false);
  assert.throws(
    () => preflight.prepareOneTeamPreflightClaim(reserved.ref, teamChat.id),
    /unavailable/,
    "a claimed capability is one-shot",
  );

  // Production authority seam: renderer-shaped mutable fields must be ignored
  // by InvocationService in favor of the opaque Main reservation.
  const mcpClient = require("../dist/electron/mcp/client.js");
  const dispatched = [];
  mcpClient.runMcpInvocation = async (request, sink) => {
    dispatched.push(request);
    sink({ kind: "final", text: "verified test result" });
    return { finalText: "verified test result", stormbreakerContinueRequested: false };
  };
  const { invocationService } = require("../dist/electron/invocation/service.js");
  const serviceTeamChat = chats.createChat({ agentId: "one-coordinator", title: "Service team", taskMode: "conversation" });
  chats.setChatHiredAgents(serviceTeamChat.id, [{
    slug: "installed-researcher",
    source: "installed",
    hiredAt: "2026-07-18T00:00:00.000Z",
  }]);
  const serviceProposal = await preflight.prepareOneTeamPreflight({
    chatId: serviceTeamChat.id,
    userPrompt: `Research in parallel, produce a report and table, and independently verify it. ${TEAM_SECRET}`,
    expectedTaskId: null,
    expectedTaskVersion: null,
  }, deps());
  const serviceReservation = await preflight.resolveOneTeamPreflight({
    proposalId: serviceProposal.proposal.proposalId,
    expectedProposalVersion: serviceProposal.proposal.version,
    resolution: "confirm_team",
    requestedRunId: randomUUID(),
    confirmedByUser: true,
  }, deps());
  invocationService.start({
    runId: serviceReservation.ref.reservedRunId,
    chatId: serviceTeamChat.id,
    userPrompt: "renderer-injected-prompt",
    taskIntent: "conversation",
    oneMode: true,
    oneTeamPreflightRef: serviceReservation.ref,
    permissions: "full",
    sessionRouting: true,
    hubMode: "hub-first",
    borrowAgents: ["renderer-hub-agent"],
    taskForceTargets: [{ source: "hub", entityKind: "agent", slug: "renderer-hub-agent" }],
    pipelineStages: [{ id: "renderer-stage", label: "Injected", agentSlug: "renderer-hub-agent", instruction: "Injected", order: 0 }],
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(dispatched.length, 1);
  assert.ok(dispatched[0].userPrompt.includes(TEAM_SECRET), "Main must restore only the process-local bound prompt");
  assert.equal(dispatched[0].userPrompt.includes("renderer-injected-prompt"), false);
  assert.equal(dispatched[0].permissions, "write");
  assert.equal(dispatched[0].sessionRouting, false);
  assert.equal(dispatched[0].hubMode, "local-only");
  assert.deepEqual(dispatched[0].borrowAgents, []);
  assert.deepEqual(dispatched[0].taskForceTargets, [{ source: "local", entityKind: "agent", agentId: "installed-researcher" }]);
  assert.equal(dispatched[0].pipelineStages, undefined);
  assert.equal(dispatched[0].routerAgent, undefined);
  assert.equal(dispatched[0].oneTeamExecutionPolicy, "confirmed_existing_roster");
  assert.equal(dispatched[0].oneTeamRuntimeBinding.digest, serviceProposal.proposal.binding.runtimeDigest);
  assert.equal(dispatched[0].oneTeamPreflightRef, undefined, "opaque renderer capability must not cross into the model runtime");
  assert.equal(preflight.getOneTeamPreflightForChat(serviceTeamChat.id).status, "team_started");

  const serviceWorkforceChat = chats.createChat({ agentId: "one-coordinator", title: "Service workforce", taskMode: "conversation" });
  const serviceWorkforceProposal = await preflight.prepareOneTeamPreflight({
    chatId: serviceWorkforceChat.id,
    userPrompt: "/hep-network Design a mobile launch video in parallel and independently verify every asset.",
    expectedTaskId: null,
    expectedTaskVersion: null,
  }, deps());
  const serviceWorkforceReservation = await preflight.resolveOneTeamPreflight({
    proposalId: serviceWorkforceProposal.proposal.proposalId,
    expectedProposalVersion: serviceWorkforceProposal.proposal.version,
    resolution: "confirm_workforce",
    requestedRunId: randomUUID(),
    confirmedByUser: true,
  }, deps());
  invocationService.start({
    runId: serviceWorkforceReservation.ref.reservedRunId,
    chatId: serviceWorkforceChat.id,
    userPrompt: "renderer-injected-workforce-prompt",
    taskIntent: "conversation",
    oneMode: true,
    oneTeamPreflightRef: serviceWorkforceReservation.ref,
    permissions: "read",
    hubMode: "local-only",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(dispatched.length, 2);
  assert.match(dispatched[1].userPrompt, /^\/workforce Design a mobile launch video/);
  assert.equal(dispatched[1].userPrompt.includes("renderer-injected-workforce-prompt"), false);
  assert.equal(dispatched[1].hubMode, "hub-first");
  assert.equal(dispatched[1].oneTeamExecutionPolicy, "confirmed_external_workforce");
  assert.equal(dispatched[1].oneTeamRuntimeBinding.digest, serviceWorkforceProposal.proposal.binding.runtimeDigest);
  assert.equal(preflight.getOneTeamPreflightForChat(serviceWorkforceChat.id).status, "workforce_started");

  const serviceSoloChat = chats.createChat({ agentId: "one-coordinator", title: "Service solo", taskMode: "conversation" });
  invocationService.start({
    runId: randomUUID(),
    chatId: serviceSoloChat.id,
    userPrompt: "Hello from a single One turn",
    taskIntent: "conversation",
    oneMode: true,
    permissions: "read",
    sessionRouting: true,
    hubMode: "hub-first",
    borrowAgents: ["renderer-hub-agent"],
    taskForceTargets: [{ source: "hub", entityKind: "agent", slug: "renderer-hub-agent" }],
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(dispatched.length, 3);
  assert.equal(dispatched[2].oneTeamExecutionPolicy, "solo_locked");
  assert.equal(dispatched[2].sessionRouting, false);
  assert.equal(dispatched[2].hubMode, "local-only");
  assert.deepEqual(dispatched[2].borrowAgents, []);
  assert.equal(dispatched[2].taskForceTargets, undefined);
  assert.equal(tasks.findCanonicalTaskForChat(serviceSoloChat.id), null, "a simple solo conversation remains Task-free through the production service");

  const candidateSwapChat = chats.createChat({ agentId: "one-coordinator", title: "Candidate swap", taskMode: "conversation" });
  chats.setChatHiredAgents(candidateSwapChat.id, [{
    slug: "installed-researcher",
    source: "installed",
    hiredAt: "2026-07-18T00:00:00.000Z",
  }]);
  const candidateSwap = await preflight.prepareOneTeamPreflight({
    chatId: candidateSwapChat.id,
    userPrompt: "Split the research and report work, then cross-check the result.",
    expectedTaskId: null,
    expectedTaskVersion: null,
  }, deps());
  db.prepare("UPDATE installed_agents SET installed_at = ? WHERE id = ?").run("2026-07-18T00:00:01.000Z", "installed-researcher");
  await assert.rejects(
    preflight.resolveOneTeamPreflight({
      proposalId: candidateSwap.proposal.proposalId,
      expectedProposalVersion: candidateSwap.proposal.version,
      resolution: "confirm_team",
      requestedRunId: "run-candidate-drift",
      confirmedByUser: true,
    }, deps()),
    /candidate changed|roster changed/i,
  );

  const raw = db.prepare("SELECT value FROM meta WHERE key = ?").get(preflight.ONE_TEAM_PREFLIGHT_META_KEY).value;
  db.prepare("UPDATE meta SET value = ? WHERE key = ?").run("{corrupt-json", preflight.ONE_TEAM_PREFLIGHT_META_KEY);
  assert.throws(() => preflight.getOneTeamPreflightForChat(teamChat.id), /corrupt; it was not overwritten/);
  assert.equal(db.prepare("SELECT value FROM meta WHERE key = ?").get(preflight.ONE_TEAM_PREFLIGHT_META_KEY).value, "{corrupt-json");
  db.prepare("UPDATE meta SET value = ? WHERE key = ?").run(raw, preflight.ONE_TEAM_PREFLIGHT_META_KEY);

  console.log(JSON.stringify({ ok: true, simplePassThrough: true, blockedExternal: true, exactTeam: true }));
  db.close();
  app.quit();
}

async function reserveCrashWorker() {
  const { app, db } = await openStore();
  insertAgent(db, "one-coordinator", "agentlas-orchestrator", "One", "Coordinate exact work.");
  insertAgent(db, "installed-researcher", "installed-researcher", "Researcher", "Research exact scope.");
  const chats = require("../dist/electron/store/chats.js");
  const preflight = require("../dist/electron/one/team-preflight.js");
  const chat = chats.createChat({ agentId: "one-coordinator", title: "Crash reservation", taskMode: "conversation" });
  chats.setChatHiredAgents(chat.id, [{ slug: "installed-researcher", source: "installed", hiredAt: new Date().toISOString() }]);
  const prepared = await preflight.prepareOneTeamPreflight({
    chatId: chat.id,
    userPrompt: "Split this report and table in parallel, then independently verify it.",
    expectedTaskId: null,
    expectedTaskVersion: null,
  }, deps());
  await preflight.resolveOneTeamPreflight({
    proposalId: prepared.proposal.proposalId,
    expectedProposalVersion: prepared.proposal.version,
    resolution: "confirm_team",
    requestedRunId: "run-crash-reservation",
    confirmedByUser: true,
  }, deps());
  console.log(JSON.stringify({ chatId: chat.id, proposalId: prepared.proposal.proposalId }));
  db.close();
  app.quit();
}

async function prepareOnlyWorker() {
  const { app, db } = await openStore();
  insertAgent(db, "one-coordinator", "agentlas-orchestrator", "One", "Coordinate exact work.");
  insertAgent(db, "installed-researcher", "installed-researcher", "Researcher", "Research exact scope.");
  const chats = require("../dist/electron/store/chats.js");
  const preflight = require("../dist/electron/one/team-preflight.js");
  const chat = chats.createChat({ agentId: "one-coordinator", title: "Prepared before restart", taskMode: "conversation" });
  chats.setChatHiredAgents(chat.id, [{ slug: "installed-researcher", source: "installed", hiredAt: new Date().toISOString() }]);
  const prepared = await preflight.prepareOneTeamPreflight({
    chatId: chat.id,
    userPrompt: "Split this report and table in parallel, then independently verify it. password=process-only",
    expectedTaskId: null,
    expectedTaskVersion: null,
  }, deps());
  assert.equal(prepared.proposal.status, "proposed");
  const durable = db.prepare("SELECT value FROM meta WHERE key = ?").get(preflight.ONE_TEAM_PREFLIGHT_META_KEY).value;
  assert.equal(durable.includes("password=process-only"), false);
  console.log(JSON.stringify({ chatId: chat.id, proposalId: prepared.proposal.proposalId }));
  db.close();
  app.quit();
}

async function recoveryWorker() {
  const { app, db } = await openStore();
  const preflight = require("../dist/electron/one/team-preflight.js");
  const proposal = preflight.getOneTeamPreflightForChat(argument("--chat-id"));
  assert.equal(proposal.status, "recovery_required");
  assert.equal(proposal.reservedRun, null);
  assert.equal(proposal.startedRun, null);
  assert.throws(
    () => preflight.prepareOneTeamPreflightClaim({
      contractVersion: proposal.contractVersion,
      proposalId: proposal.proposalId,
      reservedRunId: "run-crash-reservation",
      expectedTaskId: proposal.binding.taskId,
      expectedTaskVersion: proposal.binding.taskVersion,
      mode: "team",
    }, proposal.binding.chatId),
    /unavailable/,
  );
  console.log(JSON.stringify({ ok: true, restartRecovery: true }));
  db.close();
  app.quit();
}

function parseLastJson(output) {
  const lines = output.trim().split(/\r?\n/).filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

function runWorker(args, env) {
  const electronModule = require("electron");
  const executable = typeof electronModule === "string" ? electronModule : process.execPath;
  return spawnSync(executable, [__filename, ...args], { env, encoding: "utf8" });
}

function orchestrate() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-one-team-preflight-"));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  // Hermetic: the un-injected judge path must deterministically fall back to the
  // wordlist verdict instead of reaching a live model on the host machine.
  env.AGENTLAS_DISABLE_RUNTIME_PROBES = "1";
  try {
    env.AGENTLAS_STORE_PATH = path.join(temp, "runtime.sqlite");
    const runtime = runWorker(["--runtime", `--user-data=${path.join(temp, "runtime-user")}`], env);
    if (runtime.status !== 0) throw new Error(`runtime worker failed\n${runtime.stdout}\n${runtime.stderr}`);
    process.stdout.write(runtime.stdout);

    env.AGENTLAS_STORE_PATH = path.join(temp, "recovery.sqlite");
    const reserved = runWorker(["--reserve-crash", `--user-data=${path.join(temp, "reserve-user")}`], env);
    if (reserved.status !== 0) throw new Error(`reservation worker failed\n${reserved.stdout}\n${reserved.stderr}`);
    const info = parseLastJson(reserved.stdout);
    const recovered = runWorker(["--recover", `--chat-id=${info.chatId}`, `--user-data=${path.join(temp, "recover-user")}`], env);
    if (recovered.status !== 0) throw new Error(`recovery worker failed\n${recovered.stdout}\n${recovered.stderr}`);
    process.stdout.write(recovered.stdout);

    env.AGENTLAS_STORE_PATH = path.join(temp, "prepared-restart.sqlite");
    const preparedOnly = runWorker(["--prepare-only", `--user-data=${path.join(temp, "prepare-only-user")}`], env);
    if (preparedOnly.status !== 0) throw new Error(`prepare-only worker failed\n${preparedOnly.stdout}\n${preparedOnly.stderr}`);
    const preparedInfo = parseLastJson(preparedOnly.stdout);
    const preparedRecovered = runWorker(["--recover", `--chat-id=${preparedInfo.chatId}`, `--user-data=${path.join(temp, "prepare-only-recover-user")}`], env);
    if (preparedRecovered.status !== 0) throw new Error(`prepared proposal recovery failed\n${preparedRecovered.stdout}\n${preparedRecovered.stderr}`);
    process.stdout.write(preparedRecovered.stdout);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv.includes("--runtime")) {
  runtimeWorker().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
} else if (process.argv.includes("--reserve-crash")) {
  reserveCrashWorker().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
} else if (process.argv.includes("--prepare-only")) {
  prepareOnlyWorker().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
} else if (process.argv.includes("--recover")) {
  recoveryWorker().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
} else {
  try {
    orchestrate();
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
