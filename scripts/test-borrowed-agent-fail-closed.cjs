#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-borrow-fail-closed-"));
const userData = path.join(tmp, "user-data");
fs.mkdirSync(userData, { recursive: true });
process.env.AGENTLAS_STORE_PATH = path.join(tmp, "agentlas.sqlite");
process.env.AGENTLAS_RUNTIME_DETECT_CACHE_MS = "0";
app.setPath("userData", userData);

function result(json, options = {}) {
  const ok = options.ok !== false;
  return {
    ok,
    exitCode: options.exitCode ?? (ok ? 0 : 7),
    json,
    stdout: json ? JSON.stringify(json) : "",
    stderr: "",
    error: options.error,
  };
}

function preparedAgent(slug, entry = `AUTHORITATIVE_${slug.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`) {
  return {
    action: "hub_invoke",
    status: "prepared",
    slug,
    execution_id: `exec-${slug}`,
    output: {
      entry_excerpt: entry,
      grounding: { directive: "Attach to the current project first." },
      next_step: "Execute this returned bundle with the user's local model.",
    },
  };
}

function preparedTeam(slug, { graph = true } = {}) {
  const output = {
    entity_kind: "team",
    entry_excerpt: `AUTHORITATIVE_TEAM_${slug}`,
    grounding: {
      directive: "Attach to the current project first; use exact selective recall commands when relevant.",
      commands: {
        experience_query: `ontology --db /tmp/${slug}-experience.sqlite query task --agent hub:${slug}`,
        ontology_query: `ontology --db /tmp/${slug}-project.sqlite query task`,
      },
    },
    next_step: "Execute the team bundle with the user's local model.",
    runtime_bundle: {
      entity_kind: "team",
      entry: { path: "AGENTS.md", content: `AUTHORITATIVE_TEAM_${slug}` },
    },
  };
  if (graph) {
    output.runtime_bundle.execution_graph = {
      schemaVersion: "1.0",
      manager: { path: "agents/00-manager/agent.md", content: "TEAM_MANAGER_DIRECTIVE" },
      workers: [
        { id: "worker-one", path: "agents/10-worker/agent.md", content: "TEAM_WORKER_ONE_DIRECTIVE" },
        { id: "worker-two", path: "agents/20-worker/agent.md", content: "TEAM_WORKER_TWO_DIRECTIVE" },
      ],
    };
  }
  return { action: "hub_invoke", status: "prepared", slug, entityKind: "team", output };
}

async function main() {
  await app.whenReady();

  const store = require("../dist/electron/store/db.js");
  store.initStore();
  store.getDb()
    .prepare(
      `INSERT INTO installed_agents
       (id, slug, name, name_en, tagline, tagline_en, system_prompt, mcp_servers_json,
        env_requirements_json, preferred_backend, trust_grade, installed_at, tone, builtin, role, visibility)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "borrow-fail-closed-orchestrator",
      "borrow-fail-closed-orchestrator",
      "Borrow Fail-Closed Orchestrator",
      "Borrow Fail-Closed Orchestrator",
      "Fail-closed runtime fixture",
      "Fail-closed runtime fixture",
      "Coordinate only the agents that were actually returned by Agentlas Hub.",
      "[]",
      "[]",
      null,
      "A",
      "2026-07-11T00:00:00.000Z",
      "neutral",
      0,
      null,
      "visible",
    );

  const marketplace = require("../dist/electron/marketplace/index.js");
  marketplace.getSource = () => ({
    searchAgents: async () => [
      {
        source: "hub",
        slug: "group-hub-agent",
        name: "Group Hub Agent",
        nameEn: "Group Hub Agent",
        tagline: "Must be fetched from Hub",
        taglineEn: "Must be fetched from Hub",
        kind: "agent",
        entityKind: "agent",
        callable: true,
      },
    ],
  });

  let nextHubResult = result(null);
  const hubCalls = [];
  const commands = require("../dist/electron/hephaestus/commands.js");
  const realHepCall = commands.hepCall;
  commands.hepCall = async (agents, context, options) => {
    hubCalls.push({ agents, context, options });
    if (nextHubResult instanceof Error) throw nextHubResult;
    return nextHubResult;
  };

  const active = {
    kind: "ollama",
    backend: null,
    source: "borrow-fail-closed-test",
    ready: true,
    active: true,
    model: "mock-borrow-runtime",
  };
  const runnerRequests = [];
  let queuedRunnerTexts = [];
  const mockRunner = async (request) => {
    runnerRequests.push(request);
    return {
      text: queuedRunnerTexts.length > 0 ? queuedRunnerTexts.shift() : "PRIMARY_RUNNER_COMPLETED",
      tokens: 1,
    };
  };
  const picked = { runner: mockRunner, label: "Fail-Closed Capture Runner" };

  const detect = require("../dist/electron/runtime/detect.js");
  const selection = require("../dist/electron/runtime/selection.js");
  const envResolver = require("../dist/electron/runtime/env-resolver.js");
  const stormbreaker = require("../dist/electron/hephaestus/stormbreaker-supervisor.js");
  detect.detectRuntimes = async () => [active];
  selection.selectRuntimeForTargets = () => ({
    active,
    picked,
    override: null,
    unavailableOverride: null,
  });
  envResolver.buildRunnerEnv = async () => ({ env: {}, injectedKeys: [] });
  stormbreaker.superviseStormbreaker = () => null;

  const chats = require("../dist/electron/store/chats.js");
  const groups = require("../dist/electron/store/agent-groups.js");
  const firms = require("../dist/electron/store/firms.js");
  const automations = require("../dist/electron/store/automations.js");
  const client = require("../dist/electron/mcp/client.js");
  const agentId = "borrow-fail-closed-orchestrator";

  async function invoke({
    title,
    userPrompt = "hello",
    borrowAgents,
    hubResult,
    agentGroupId,
    firmId,
    kind = "user",
    swarmMode = false,
    permission = "read",
    runnerTexts = [],
    taskForceTargets,
    beforeRun,
  }) {
    const chat = chats.createChat({ agentId, agentGroupId, firmId, kind, title });
    if (swarmMode) chats.setChatSwarmMode(chat.id, true);
    if (beforeRun) await beforeRun(chat);
    nextHubResult = hubResult;
    queuedRunnerTexts = [...runnerTexts];
    const events = [];
    const runnerStart = runnerRequests.length;
    const hubCallStart = hubCalls.length;
    const response = await client.runMcpInvocation(
      {
        chatId: chat.id,
        userPrompt,
        locale: "en",
        permissions: permission,
        ...(borrowAgents ? { borrowAgents } : {}),
        ...(taskForceTargets ? { taskForceTargets } : {}),
      },
      (event) => events.push(event),
    );
    return {
      chat,
      events,
      response,
      runnerStart,
      runnerDelta: runnerRequests.length - runnerStart,
      hubCallStart,
      hubCallDelta: hubCalls.length - hubCallStart,
    };
  }

  const refusedSingle = await invoke({
    title: "Single refusal",
    borrowAgents: ["metered-agent"],
    hubResult: result({
      schema: "hephaestus.call.v1",
      status: "failed",
      agents: [{ action: "hub_invoke", slug: "metered-agent", status: "insufficient_credits" }],
    }),
  });
  assert.equal(refusedSingle.runnerDelta, 0, "single refusal must not reach the primary runner");
  const refusedSingleError = refusedSingle.events.find((event) => event.kind === "error");
  assert.equal(refusedSingleError?.error?.code, "borrowed-agent-unavailable");
  assert.match(refusedSingleError?.error?.message ?? "", /insufficient_credits/);

  const emptySingle = await invoke({
    title: "Single empty bundle",
    borrowAgents: ["empty-agent"],
    hubResult: result({
      schema: "hephaestus.call.v1",
      status: "prepared",
      agents: [{ action: "hub_invoke", slug: "empty-agent", status: "prepared", output: {} }],
    }),
  });
  assert.equal(emptySingle.runnerDelta, 0, "single no-directive response must not reach the primary runner");
  assert.match(
    emptySingle.events.find((event) => event.kind === "error")?.error?.message ?? "",
    /missing_directive:empty-agent/,
  );

  const failedTransport = await invoke({
    title: "Single transport failure",
    borrowAgents: ["transport-agent"],
    hubResult: result(
      { directive: "DIRECTIVE_SHAPED_STDOUT_MUST_NOT_RUN" },
      { ok: false, exitCode: 7, error: "engine_unavailable" },
    ),
  });
  assert.equal(failedTransport.runnerDelta, 0, "failed hep-call transport must not reach the primary runner");
  assert.match(
    failedTransport.events.find((event) => event.kind === "error")?.error?.message ?? "",
    /engine_unavailable/,
  );

  const partialMulti = await invoke({
    title: "Partial multi borrow",
    borrowAgents: ["multi-a", "multi-b"],
    hubResult: result({
      schema: "hephaestus.call.v1",
      status: "partial",
      agents: [
        preparedAgent("multi-a"),
        { action: "hub_invoke", slug: "multi-b", status: "agent_not_found" },
      ],
    }),
  });
  assert.equal(partialMulti.runnerDelta, 0, "partial explicit task force must not run a reduced or fake roster");
  const partialError = partialMulti.events.find((event) => event.kind === "error");
  assert.equal(partialError?.error?.code, "borrowed-task-force-failed");
  assert.match(partialError?.error?.message ?? "", /agent_not_found/);

  const swarmRefusedMulti = await invoke({
    title: "Swarm must not bypass refused multi borrow",
    swarmMode: true,
    borrowAgents: ["swarm-metered-a", "swarm-metered-b"],
    hubResult: result({
      schema: "hephaestus.call.v1",
      status: "failed",
      agents: [
        { action: "hub_invoke", slug: "swarm-metered-a", status: "insufficient_credits" },
        { action: "hub_invoke", slug: "swarm-metered-b", status: "no_cloud_package" },
      ],
    }),
  });
  assert.equal(swarmRefusedMulti.hubCallDelta, 1, "swarm + explicit multi borrow must make one authoritative hep-call");
  assert.equal(swarmRefusedMulti.runnerDelta, 0, "swarm must not run local workers after a Hub refusal");
  const swarmRefusedError = swarmRefusedMulti.events.find((event) => event.kind === "error");
  assert.equal(swarmRefusedError?.error?.code, "borrowed-task-force-failed");
  assert.match(swarmRefusedError?.error?.message ?? "", /insufficient_credits|no_cloud_package/);

  const swarmEmptyMulti = await invoke({
    title: "Swarm must not bypass empty multi borrow",
    swarmMode: true,
    borrowAgents: ["swarm-empty-a", "swarm-empty-b"],
    hubResult: result({
      schema: "hephaestus.call.v1",
      status: "prepared",
      agents: [
        { action: "hub_invoke", slug: "swarm-empty-a", status: "prepared", output: {} },
        { action: "hub_invoke", slug: "swarm-empty-b", status: "prepared", output: {} },
      ],
    }),
  });
  assert.equal(swarmEmptyMulti.hubCallDelta, 1, "swarm + empty Hub bundles must still make exactly one hep-call");
  assert.equal(swarmEmptyMulti.runnerDelta, 0, "swarm must not replace empty Hub bundles with local workers");
  assert.equal(
    swarmEmptyMulti.events.find((event) => event.kind === "error")?.error?.code,
    "borrowed-task-force-failed",
  );

  const swarmRealMulti = await invoke({
    title: "Swarm yields to real borrowed task force",
    swarmMode: true,
    borrowAgents: ["swarm-real-a", "swarm-real-b"],
    hubResult: result({
      schema: "hephaestus.call.v1",
      status: "prepared",
      agents: [
        preparedAgent("swarm-real-a", "SWARM_REAL_DIRECTIVE_A_2F11"),
        preparedAgent("swarm-real-b", "SWARM_REAL_DIRECTIVE_B_8D04"),
      ],
    }),
    runnerTexts: [
      "task-force plan",
      "worker A complete",
      "worker B complete",
      "more verified task-force work remains\n<<stormbreaker-continue>>",
    ],
  });
  assert.equal(swarmRealMulti.hubCallDelta, 1);
  assert.equal(swarmRealMulti.runnerDelta, 4, "real multi borrow must run planner, two Hub workers, and synthesis");
  const swarmRealRequests = runnerRequests.slice(swarmRealMulti.runnerStart);
  assert.equal(
    swarmRealRequests.filter((request) => request.systemPrompt.includes("## Agentlas Task-Force Orchestrator")).length,
    1,
  );

  const missingTeamGraph = await invoke({
    title: "Exact Hub team missing graph",
    taskForceTargets: [{ source: "hub", entityKind: "team", slug: "missing-team-graph" }],
    hubResult: result({
      schema: "hephaestus.call.v1",
      status: "prepared",
      agents: [preparedTeam("missing-team-graph", { graph: false })],
    }),
  });
  assert.equal(missingTeamGraph.runnerDelta, 0, "an exact Hub Team without an executable graph must fail before any model call");
  assert.match(
    missingTeamGraph.events.find((event) => event.kind === "error")?.error?.message ?? "",
    /team_execution_graph_unavailable/,
  );

  const executableTeam = await invoke({
    title: "Exact executable Hub team",
    taskForceTargets: [{ source: "hub", entityKind: "team", slug: "executable-team" }],
    hubResult: result({
      schema: "hephaestus.call.v1",
      status: "prepared",
      agents: [preparedTeam("executable-team")],
    }),
    runnerTexts: [
      "outer plan",
      "team manager plan",
      "worker one result",
      "worker two result",
      "team manager synthesis",
      "outer synthesis",
    ],
  });
  assert.equal(executableTeam.runnerDelta, 6, "Hub Team must run outer planner, manager twice, every worker, and outer synthesis");
  const executableRequests = runnerRequests.slice(executableTeam.runnerStart);
  const executableEvidence = executableRequests.map((request) => `${request.systemPrompt}\n${request.userPrompt}`).join("\n");
  assert.match(executableEvidence, /TEAM_MANAGER_DIRECTIVE/);
  assert.match(executableEvidence, /TEAM_WORKER_ONE_DIRECTIVE/);
  assert.match(executableEvidence, /TEAM_WORKER_TWO_DIRECTIVE/);
  assert.match(executableEvidence, /experience_query:/, "Hub team nodes must retain the exact experience recall command");
  assert.match(executableEvidence, /ontology_query:/, "Hub team nodes must retain the exact project ontology command");
  assert.equal(
    executableRequests.filter((request) => (
      request.systemPrompt.includes("Only when this turn produced a durable decision")
    )).length >= 3,
    true,
    "Hub team workers, team synthesis, and outer synthesis must receive the Memory Curator emitter contract",
  );
  assert.equal(executableTeam.events.filter((event) => event.kind === "final").length, 1);
  assert.equal(
    swarmRealRequests.filter((request) => request.systemPrompt.includes("## Agentlas Task-Force Agent Host Policy")).length,
    2,
  );
  assert.equal(
    swarmRealRequests.filter((request) => request.systemPrompt.includes("## Agentlas Task-Force Synthesis")).length,
    1,
  );
  const swarmRealPromptEvidence = swarmRealRequests
    .map((request) => `${request.systemPrompt}\n${request.userPrompt}`)
    .join("\n");
  assert.match(swarmRealPromptEvidence, /SWARM_REAL_DIRECTIVE_A_2F11/);
  assert.match(swarmRealPromptEvidence, /SWARM_REAL_DIRECTIVE_B_8D04/);
  assert.doesNotMatch(swarmRealPromptEvidence, /EMERGENT AGENT SWARM/);
  const swarmRealFinal = swarmRealMulti.events.find((event) => event.kind === "final")?.text ?? "";
  assert.match(swarmRealFinal, /multi-Hub or Agent Group run is never replaced by a local single-agent continuation/);
  assert.doesNotMatch(swarmRealFinal, /stormbreaker-continue/);
  assert.equal(
    automations.listAutomations().some((automation) =>
      automation.promptTemplate.includes(`Source chat: ${swarmRealMulti.chat.id}`),
    ),
    false,
    "multi-Hub continuation requests must not become a fake local automation",
  );

  const firm = firms.upsertLocalTeamFirm({
    slug: "borrow-fail-closed-firm",
    name: "Borrow Fail-Closed Firm",
    tagline: "Firm precedence fixture",
    ceoAgentId: agentId,
    orgChart: [
      {
        agentSlug: "borrow-fail-closed-orchestrator",
        role: "CEO",
        reportsTo: null,
        agentId,
      },
    ],
  });
  const firmRefusedMulti = await invoke({
    title: "Firm must not bypass refused multi borrow",
    firmId: firm.id,
    borrowAgents: ["firm-hire-a", "firm-hire-b"],
    hubResult: result({
      schema: "hephaestus.call.v1",
      status: "failed",
      agents: [
        { action: "hub_invoke", slug: "firm-hire-a", status: "agent_not_found" },
        { action: "hub_invoke", slug: "firm-hire-b", status: "no_cloud_package" },
      ],
    }),
  });
  assert.equal(firmRefusedMulti.hubCallDelta, 1, "firm + explicit multi borrow must make one authoritative hep-call");
  assert.equal(firmRefusedMulti.runnerDelta, 0, "firm orchestration must not run after explicit Hub refusal");
  assert.equal(
    firmRefusedMulti.events.find((event) => event.kind === "error")?.error?.code,
    "borrowed-task-force-failed",
  );

  const divisionRefusedMulti = await invoke({
    title: "Division must not bypass refused multi borrow",
    kind: "division",
    borrowAgents: ["division-hire-a", "division-hire-b"],
    hubResult: result({
      schema: "hephaestus.call.v1",
      status: "partial",
      agents: [
        preparedAgent("division-hire-a", "DIVISION_A_MUST_NOT_RUN_ALONE"),
        { action: "hub_invoke", slug: "division-hire-b", status: "owner_only" },
      ],
    }),
  });
  assert.equal(divisionRefusedMulti.hubCallDelta, 1, "division + explicit multi borrow must make one authoritative hep-call");
  assert.equal(divisionRefusedMulti.runnerDelta, 0, "division runtime must not run a reduced fake roster");
  assert.equal(
    divisionRefusedMulti.events.find((event) => event.kind === "error")?.error?.code,
    "borrowed-agent-unavailable",
  );

  const divisionRealMulti = await invoke({
    title: "Division receives verified multi borrow preamble",
    kind: "division",
    borrowAgents: ["division-real-a", "division-real-b"],
    hubResult: result({
      schema: "hephaestus.call.v1",
      status: "prepared",
      agents: [
        preparedAgent("division-real-a", "DIVISION_REAL_DIRECTIVE_A_04E1"),
        preparedAgent("division-real-b", "DIVISION_REAL_DIRECTIVE_B_73C9"),
      ],
    }),
  });
  assert.equal(divisionRealMulti.hubCallDelta, 1);
  assert.equal(divisionRealMulti.runnerDelta, 1);
  const divisionRealRequest = runnerRequests[divisionRealMulti.runnerStart];
  assert.match(divisionRealRequest.userPrompt, /DIVISION_REAL_DIRECTIVE_A_04E1/);
  assert.match(divisionRealRequest.userPrompt, /DIVISION_REAL_DIRECTIVE_B_73C9/);
  assert.doesNotMatch(divisionRealRequest.systemPrompt, /DIVISION_REAL_DIRECTIVE_[AB]/);

  const group = groups.createAgentGroup({
    name: "Hub Fail-Closed Group",
    description: "A saved group whose Hub member still requires a live bundle",
    orchestratorName: "Hub Fail-Closed Group Orchestrator",
    members: [
      {
        id: "group-hub-member",
        source: "hub",
        agentSlug: "group-hub-agent",
        hubSlug: "group-hub-agent",
        addedAt: "2026-07-11T00:00:00.000Z",
        snapshot: {
          name: "Group Hub Agent",
          nameEn: "Group Hub Agent",
          tagline: "Must be fetched from Hub",
          taglineEn: "Must be fetched from Hub",
          routeLabel: "Hub",
          trustGrade: "A",
          entityKind: "agent",
        },
      },
    ],
  });
  const nestedGroup = await invoke({
    title: "Saved group nested in exact top task force",
    taskForceTargets: [{ source: "local", entityKind: "group", groupId: group.id }],
    hubResult: result({
      schema: "hephaestus.call.v1",
      status: "prepared",
      agents: [preparedAgent("group-hub-agent", "NESTED_GROUP_MEMBER_DIRECTIVE")],
    }),
    runnerTexts: [
      "outer planner",
      "group planner",
      "group member result",
      "group synthesis",
      "outer synthesis",
    ],
  });
  assert.equal(nestedGroup.runnerDelta, 5, "top TF must execute Group planner, member, and Group synthesis before outer synthesis");
  assert.equal(nestedGroup.events.filter((event) => event.kind === "final").length, 1);
  assert.match(
    runnerRequests.slice(nestedGroup.runnerStart).map((request) => `${request.systemPrompt}\n${request.userPrompt}`).join("\n"),
    /NESTED_GROUP_MEMBER_DIRECTIVE/,
  );
  const emptyGroup = await invoke({
    title: "Saved group empty Hub bundle",
    agentGroupId: group.id,
    hubResult: result({
      schema: "hephaestus.call.v1",
      status: "prepared",
      agents: [{ action: "hub_invoke", slug: "group-hub-agent", status: "prepared", output: {} }],
    }),
  });
  assert.equal(emptyGroup.runnerDelta, 0, "saved group Hub member without a directive must not reach the primary runner");
  const groupError = emptyGroup.events.find((event) => event.kind === "error");
  assert.equal(groupError?.error?.code, "agent-group-failed");
  assert.match(groupError?.error?.message ?? "", /missing_directive:group-hub-agent/);

  const mixedMissingGroup = groups.createAgentGroup({
    name: "Mixed Missing Hub Group",
    description: "A local member must not mask a missing saved Hub member",
    orchestratorName: "Mixed Missing Hub Group Orchestrator",
    members: [
      {
        id: "mixed-local-member",
        source: "installed",
        agentId,
        agentSlug: "borrow-fail-closed-orchestrator",
        addedAt: "2026-07-11T00:00:00.000Z",
        snapshot: {
          name: "Borrow Fail-Closed Orchestrator",
          nameEn: "Borrow Fail-Closed Orchestrator",
          tagline: "Local member",
          taglineEn: "Local member",
          routeLabel: "Installed",
          trustGrade: "A",
          entityKind: "agent",
        },
      },
      {
        id: "mixed-missing-hub-member",
        source: "hub",
        agentSlug: "missing-group-hub-agent",
        hubSlug: "missing-group-hub-agent",
        addedAt: "2026-07-11T00:00:00.000Z",
        snapshot: {
          name: "Missing Group Hub Agent",
          nameEn: "Missing Group Hub Agent",
          tagline: "Must not be silently skipped",
          taglineEn: "Must not be silently skipped",
          routeLabel: "Hub",
          trustGrade: "A",
          entityKind: "agent",
        },
      },
    ],
  });
  const mixedMissing = await invoke({
    title: "Mixed group missing Hub member",
    agentGroupId: mixedMissingGroup.id,
    hubResult: result(null),
  });
  assert.equal(mixedMissing.runnerDelta, 0, "a local group member must not mask a missing explicit Hub member");
  const mixedMissingError = mixedMissing.events.find((event) => event.kind === "error");
  assert.equal(mixedMissingError?.error?.code, "agent-group-failed");
  assert.match(mixedMissingError?.error?.message ?? "", /missing-group-hub-agent:hub_missing/);

  const localOnlyGroup = groups.createAgentGroup({
    name: "Local Group With Explicit Hub Hires",
    description: "Persisted Hub hires must be verified before this local group runs",
    orchestratorName: "Local Group With Explicit Hub Hires Orchestrator",
    members: [
      {
        id: "local-only-group-member",
        source: "installed",
        agentId,
        agentSlug: "borrow-fail-closed-orchestrator",
        addedAt: "2026-07-11T00:00:00.000Z",
        snapshot: {
          name: "Borrow Fail-Closed Orchestrator",
          nameEn: "Borrow Fail-Closed Orchestrator",
          tagline: "Local group member",
          taglineEn: "Local group member",
          routeLabel: "Installed",
          trustGrade: "A",
          entityKind: "agent",
        },
      },
    ],
  });

  const installedTeamGroup = groups.createAgentGroup({
    name: "Nested Installed Team Group",
    description: "The complete installed firm must execute through its own manager boundary",
    orchestratorName: "Nested Installed Team Group Orchestrator",
    members: [
      {
        id: "nested-installed-team",
        source: "firm",
        firmId: firm.id,
        firmSlug: firm.slug,
        addedAt: "2026-07-11T00:00:00.000Z",
        snapshot: {
          name: firm.name,
          nameEn: firm.nameEn,
          tagline: firm.tagline,
          taglineEn: firm.taglineEn,
          routeLabel: "Installed Team",
          entityKind: "team",
        },
      },
    ],
  });
  const nestedInstalledTeam = await invoke({
    title: "Saved group executes complete installed team",
    agentGroupId: installedTeamGroup.id,
    hubResult: result(null),
    runnerTexts: ["PARENT_GROUP_PLAN", "INSTALLED_TEAM_MANAGER_RESULT", "PARENT_GROUP_SYNTHESIS"],
  });
  assert.equal(
    nestedInstalledTeam.runnerDelta,
    3,
    "a complete installed team must run parent planner, team manager, and parent synthesis",
  );
  const nestedRequests = runnerRequests.slice(nestedInstalledTeam.runnerStart);
  assert.equal(
    nestedRequests.filter((request) => request.systemPrompt.includes("## Agentlas Task-Force Agent Host Policy")).length,
    0,
    "an installed team must not be executed by the flat leaf-specialist host",
  );
  assert.equal(
    nestedInstalledTeam.events.filter((event) => event.kind === "final").length,
    1,
    "the nested team returns to the parent; only the top-level TF emits a user-visible final",
  );
  const nestedTeamChat = store.getDb()
    .prepare("SELECT id, firm_id, parent_chat_id FROM chats WHERE parent_chat_id = ? AND title = ?")
    .get(nestedInstalledTeam.chat.id, `⟦firm⟧${firm.id}`);
  assert.equal(nestedTeamChat?.firm_id, firm.id, "the nested team keeps a dedicated firm-bound session");
  assert.equal(nestedTeamChat?.parent_chat_id, nestedInstalledTeam.chat.id);
  assert.match(
    chats.listChatMessages(nestedTeamChat.id, 10).map((message) => message.text).join("\n"),
    /INSTALLED_TEAM_MANAGER_RESULT/,
    "the team manager result must persist in the nested team session",
  );
  const groupExplicitRefusal = await invoke({
    title: "Saved group persisted Hub hires refused",
    agentGroupId: localOnlyGroup.id,
    borrowAgents: ["group-hire-a", "group-hire-b"],
    hubResult: result({
      schema: "hephaestus.call.v1",
      status: "partial",
      agents: [
        preparedAgent("group-hire-a", "GROUP_HIRE_A_MUST_NOT_RUN_ALONE"),
        { action: "hub_invoke", slug: "group-hire-b", status: "owner_only" },
      ],
    }),
  });
  assert.equal(groupExplicitRefusal.hubCallDelta, 1, "saved group explicit hires require one authoritative hep-call");
  assert.equal(groupExplicitRefusal.runnerDelta, 0, "saved group must not ignore a refused persisted Hub hire");
  const groupExplicitError = groupExplicitRefusal.events.find((event) => event.kind === "error");
  assert.equal(groupExplicitError?.error?.code, "borrowed-agent-unavailable");
  assert.match(groupExplicitError?.error?.message ?? "", /owner_only/);

  const groupExplicitReal = await invoke({
    title: "Saved group receives verified persisted Hub hires",
    agentGroupId: localOnlyGroup.id,
    borrowAgents: ["group-real-a", "group-real-b"],
    hubResult: result({
      schema: "hephaestus.call.v1",
      status: "prepared",
      agents: [
        preparedAgent("group-real-a", "GROUP_REAL_DIRECTIVE_A_1E20"),
        preparedAgent("group-real-b", "GROUP_REAL_DIRECTIVE_B_9A73"),
      ],
    }),
  });
  assert.equal(groupExplicitReal.hubCallDelta, 1);
  assert.equal(groupExplicitReal.runnerDelta, 3, "verified hires must flow through group planner, member, and synthesis");
  const groupExplicitEvidence = runnerRequests
    .slice(groupExplicitReal.runnerStart)
    .map((request) => `${request.systemPrompt}\n${request.userPrompt}`)
    .join("\n");
  assert.match(groupExplicitEvidence, /GROUP_REAL_DIRECTIVE_A_1E20/);
  assert.match(groupExplicitEvidence, /GROUP_REAL_DIRECTIVE_B_9A73/);
  assert.doesNotMatch(groupExplicitEvidence, /EMERGENT AGENT SWARM/);

  const successfulSingle = await invoke({
    title: "Single authoritative bundle",
    borrowAgents: ["real-agent"],
    hubResult: result({
      schema: "hephaestus.call.v1",
      status: "prepared",
      agents: [preparedAgent("real-agent", "REAL_HUB_DIRECTIVE_7C21")],
    }),
  });
  assert.equal(successfulSingle.runnerDelta, 1, "a real prepared Hub bundle must still run normally");
  const successfulRequest = runnerRequests[successfulSingle.runnerStart];
  assert.match(successfulRequest.userPrompt, /REAL_HUB_DIRECTIVE_7C21/);
  assert.match(successfulRequest.userPrompt, /Hephaestus Network · borrowed Hub agents: real-agent/);
  assert.doesNotMatch(successfulRequest.systemPrompt, /REAL_HUB_DIRECTIVE_7C21/);
  assert.doesNotMatch(successfulRequest.userPrompt, /Apply the borrowed specialist agent/);
  assert.ok(successfulSingle.events.some((event) => event.kind === "final"));

  const swarmSingleReal = await invoke({
    title: "Swarm yields to real single borrow",
    swarmMode: true,
    borrowAgents: ["swarm-single-real"],
    hubResult: result({
      schema: "hephaestus.call.v1",
      status: "prepared",
      agents: [preparedAgent("swarm-single-real", "SWARM_SINGLE_REAL_DIRECTIVE_61B2")],
    }),
  });
  assert.equal(swarmSingleReal.hubCallDelta, 1);
  assert.equal(swarmSingleReal.runnerDelta, 1, "single verified Hub hire must bypass local swarm and run directly");
  const swarmSingleRequest = runnerRequests[swarmSingleReal.runnerStart];
  assert.match(swarmSingleRequest.userPrompt, /SWARM_SINGLE_REAL_DIRECTIVE_61B2/);
  assert.doesNotMatch(swarmSingleRequest.systemPrompt, /SWARM_SINGLE_REAL_DIRECTIVE_61B2/);
  assert.doesNotMatch(swarmSingleRequest.systemPrompt, /EMERGENT AGENT SWARM/);

  const continuedSingle = await invoke({
    title: "Single Hub authority survives immediate and hidden continuation",
    // Hidden durable continuations mutate the automation store. Keep this
    // legacy-retargeting contract on an explicitly approved Desktop write run;
    // read-only runs are covered separately and must never create or retarget it.
    permission: "write",
    borrowAgents: ["continuation-hub-agent"],
    hubResult: result({
      schema: "hephaestus.call.v1",
      status: "prepared",
      agents: [preparedAgent("continuation-hub-agent", "CONTINUATION_HUB_DIRECTIVE_44D8")],
    }),
    runnerTexts: [
      "pass one\n<<stormbreaker-continue>>",
      "pass two\n<<stormbreaker-continue>>",
      "pass three\n<<stormbreaker-continue>>",
    ],
    beforeRun: async (chat) => {
      automations.createAutomation({
        name: "Legacy unsafe continuation target",
        scheduleHuman: "every-30m",
        targetType: "agent",
        targetId: agentId,
        promptTemplate: `<<stormbreaker-long-run>>\nSource chat: ${chat.id}\nlegacy fixture`,
        createdBy: "agent",
      });
    },
  });
  assert.equal(continuedSingle.hubCallDelta, 1);
  assert.equal(continuedSingle.runnerDelta, 3, "Stormbreaker must run all three immediate passes in this fixture");
  const continuedRequests = runnerRequests.slice(continuedSingle.runnerStart);
  assert.equal(
    continuedRequests.every((request) => request.userPrompt.includes("CONTINUATION_HUB_DIRECTIVE_44D8")),
    true,
    "the authoritative Hub user preamble must survive stateless pass 2 and pass 3",
  );
  assert.equal(
    continuedRequests.every((request) => !request.systemPrompt.includes("CONTINUATION_HUB_DIRECTIVE_44D8")),
    true,
    "remote Hub instructions must never be promoted into the local system prompt",
  );
  assert.match(continuedRequests[1].userPrompt, /CONTINUATION_HUB_DIRECTIVE_44D8/);
  assert.match(continuedRequests[1].userPrompt, /Continue Stormbreaker execution pass 2/);
  const hiddenContinuation = automations
    .listAutomations()
    .find((automation) => automation.promptTemplate.includes(`Source chat: ${continuedSingle.chat.id}`));
  assert.ok(hiddenContinuation, "third-pass continuation marker must retain a hidden durable continuation");
  assert.equal(hiddenContinuation.targetType, "hub", "legacy hidden continuation must be retargeted to Hub revalidation");
  assert.equal(hiddenContinuation.targetId, "continuation-hub-agent");

  const failureEvents = [
    refusedSingle,
    emptySingle,
    failedTransport,
    partialMulti,
    swarmRefusedMulti,
    swarmEmptyMulti,
    firmRefusedMulti,
    divisionRefusedMulti,
    emptyGroup,
    mixedMissing,
    groupExplicitRefusal,
  ]
    .flatMap((run) => run.events);
  assert.doesNotMatch(
    JSON.stringify(failureEvents),
    /You are the borrowed Hub specialist|Apply the borrowed specialist agent|actual expertise and synthesize/,
    "failure paths must not emit a fake specialist persona or directive",
  );
  assert.equal(hubCalls.length, 19, "every executable explicit path must make exactly one authoritative hep-call attempt");

  const ragProject = path.join(tmp, "task-force-rag-project");
  const ragMemoryDir = path.join(ragProject, ".agentlas");
  fs.mkdirSync(path.join(ragMemoryDir, "code-map"), { recursive: true });
  fs.writeFileSync(
    path.join(ragMemoryDir, "project-soul-memory.md"),
    "# Project Soul Memory\n\n- SOUL_SENTINEL_TF_RAG_4D91\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(ragMemoryDir, "sitemap.json"),
    JSON.stringify({ nodes: [{ status: "SITEMAP_SENTINEL_TF_RAG_71C2" }] }),
    "utf8",
  );
  await require("../dist/electron/architecture/activation.js")
    .activateFolder(ragProject, "Task Force RAG Fixture", { permission: "write" });
  fs.writeFileSync(
    path.join(ragMemoryDir, "code-map", "project-map.json"),
    JSON.stringify({
      project: "CODEMAP_SENTINEL_TF_RAG_8A63",
      stats: { codeFiles: 1, symbols: 1 },
      modules: [{ id: "codemap-sentinel-module", role: "benchmark" }],
    }),
    "utf8",
  );
  const memoryStore = require("../dist/electron/memory/store.js");
  memoryStore.insertMemoryEntry({
    scope: "project",
    kind: "procedure",
    content: "For the task-force RAG sentinel procedure, apply CURATED_SENTINEL_TF_RAG_2B57.",
    projectId: null,
    projectPath: ragProject,
    agentId,
  });
  const ragTask = "Use the task-force RAG sentinel procedure and verify all grounded sources.";
  assert.match(
    require("../dist/electron/memory/context.js").buildMemoryContext(ragProject, agentId, {
      materializeCodeMap: false,
      taskPrompt: ragTask,
    }),
    /CURATED_SENTINEL_TF_RAG_2B57/,
    "the seeded curated row must be retrievable before entering the task-force executor",
  );
  const ragRun = await invoke({
    title: "Task-force RAG grounding probe",
    userPrompt: ragTask,
    taskForceTargets: [{ source: "hub", entityKind: "team", slug: "rag-team" }],
    hubResult: result({
      schema: "hephaestus.call.v1",
      status: "prepared",
      agents: [preparedTeam("rag-team")],
    }),
    permission: "read",
    runnerTexts: [
      "RAG outer plan",
      "RAG manager plan",
      "RAG worker one",
      "RAG worker two",
      "RAG team synthesis",
      "RAG outer synthesis",
    ],
    beforeRun: async (chat) => chats.setChatWorkingFolder(chat.id, ragProject),
  });
  assert.equal(ragRun.runnerDelta, 6);
  const ragEvidence = runnerRequests
    .slice(ragRun.runnerStart)
    .map((request) => request.systemPrompt)
    .join("\n");
  assert.match(ragEvidence, /SOUL_SENTINEL_TF_RAG_4D91/);
  assert.match(ragEvidence, /SITEMAP_SENTINEL_TF_RAG_71C2/);
  assert.match(ragEvidence, /CODEMAP_SENTINEL_TF_RAG_8A63/);
  assert.match(ragEvidence, /CURATED_SENTINEL_TF_RAG_2B57/);

  let liveHubTeamProof = null;
  if (process.env.AGENTLAS_LIVE_HUB_TEAM_PROBE === "1") {
    const sourceRoot = process.env.AGENTLAS_LIVE_HUB_TEAM_SOURCE_ROOT;
    const previousRoot = process.env.HEPHAESTUS_RUNTIME_ROOT;
    if (sourceRoot) {
      process.env.HEPHAESTUS_RUNTIME_ROOT = sourceRoot;
      require("../dist/electron/hephaestus/root.js").resetHephaestusRootCache();
    }
    const live = await realHepCall(
      "hub/team/product-development-hq",
      ["Verify the live team manager-worker execution graph through the Desktop task-force executor."],
      { project: "/private/tmp/agentlas-core-terra" },
    );
    if (sourceRoot) {
      if (previousRoot === undefined) delete process.env.HEPHAESTUS_RUNTIME_ROOT;
      else process.env.HEPHAESTUS_RUNTIME_ROOT = previousRoot;
      require("../dist/electron/hephaestus/root.js").resetHephaestusRootCache();
    }
    assert.equal(live.ok, true, live.error || live.stderr || "live Hub team call failed");
    const liveSpecs = require("../dist/electron/mcp/borrowed-task-force.js")
      .requireBorrowedAgentSpecs(["product-development-hq"], live.json, {
        locale: "en",
        transportOk: live.ok,
      });
    assert.equal(liveSpecs[0].entityKind, "team");
    const liveWorkerCount = liveSpecs[0].executionGraph?.workers?.length ?? 0;
    assert.equal(liveWorkerCount >= 2, true, "live Hub team must expose at least two reviewed workers");
    const liveRun = await invoke({
      title: "Live Hub team execution-graph probe",
      taskForceTargets: [{ source: "hub", entityKind: "team", slug: "product-development-hq" }],
      hubResult: live,
      runnerTexts: Array.from({ length: liveWorkerCount + 4 }, (_, index) => `LIVE_TEAM_STEP_${index + 1}`),
    });
    assert.equal(
      liveRun.runnerDelta,
      liveWorkerCount + 4,
      "live Hub Team must run outer plan, manager plan, every worker, manager synthesis, and outer synthesis",
    );
    const liveRequests = runnerRequests.slice(liveRun.runnerStart);
    const liveEvidence = liveRequests.map((request) => `${request.systemPrompt}\n${request.userPrompt}`).join("\n");
    assert.match(liveEvidence, /Product Development HQ/);
    assert.match(liveEvidence, /experience_query:/);
    assert.match(liveEvidence, /ontology_query:/);
    assert.equal(liveRun.events.filter((event) => event.kind === "final").length, 1);
    liveHubTeamProof = {
      receiptId: live.json?.receipt_id ?? null,
      workerCount: liveWorkerCount,
      runnerCalls: liveRun.runnerDelta,
    };
  }

  console.log(JSON.stringify({
    ok: true,
    checks: 79,
    nestedAgentGroupExecutionVerified: true,
    hubTeamGraphFailClosed: true,
    hubTeamManagerWorkerExecutionVerified: true,
    explicitSingleRefusalBlocked: true,
    explicitSingleEmptyBlocked: true,
    failedTransportBlocked: true,
    partialTaskForceBlocked: true,
    swarmBorrowBypassBlocked: true,
    swarmRealBorrowUsesTaskForce: true,
    firmBorrowPrecedenceVerified: true,
    divisionBorrowPrecedenceVerified: true,
    savedGroupEmptyHubBundleBlocked: true,
    savedGroupMissingHubMemberBlocked: true,
    savedGroupPersistedHiresVerified: true,
    realBundleStillRuns: true,
    singleBorrowUserPreambleSurvivesPasses: true,
    hiddenContinuationRetargetedToHub: true,
    ragGroundingProof: {
      soul: true,
      sitemap: true,
      codeMap: true,
      curatedMemory: true,
      runnerCalls: ragRun.runnerDelta,
    },
    liveHubTeamProof,
    fakeDirectiveLeak: false,
    primaryRunnerCalls: runnerRequests.length,
    hepCalls: hubCalls.length,
  }, null, 2));
}

main()
  .then(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // Best-effort fixture cleanup.
    }
    app.exit(1);
  });
