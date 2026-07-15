const assert = require("node:assert/strict");
const { app } = require("electron");

const {
  emitWorkforceBenchmarkSelectionArtifacts,
  parseLeaderJson,
  parseWorkforceCommand,
  runWorkforceSelection,
  validateExecutionPreparation,
  validateCandidateSet,
  validateLeaderSelection,
  validateSelectionReceipt,
  validateWorkOrder,
} = require("../dist/electron/mcp/workforce-orchestrator.js");
const { normalizePacketsForRoster } = require("../dist/electron/mcp/borrowed-task-force.js");

const hash = (char) => `sha256:${char.repeat(64)}`;
const active = {
  kind: "ollama",
  backend: "ollama",
  source: "local",
  model: "qwen3:30b-a3b",
  available: true,
};

const workOrder = {
  schemaVersion: "agentlas.workforce-work-order.v1",
  workOrderId: "work-order:test-backend",
  taskBrief: "Design and verify a payment API without local or customer data.",
  redacted: true,
  ontologyVersion: "awo:2026-07-15.1",
  roleSlots: [{
    slotId: "slot:backend",
    title: "Backend payment engineer",
    task: "Design the API and database transaction boundary.",
    cardinality: 1,
    criticality: "required",
    requiredCommunities: ["community:software-engineering"],
    optionalCommunities: ["community:payments-engineering"],
    excludedCommunities: ["community:travel"],
    requiredRoles: ["role:backend-engineer"],
    requiredSkills: ["skill:api-design"],
    optionalSkills: ["skill:billing-integration"],
    requiredKnowledge: [],
    requiredToolCapabilities: ["tool:postgresql"],
    consumes: ["artifact:requirements"],
    produces: ["artifact:api-spec"],
    requiredAuthorities: [],
    forbiddenAuthorities: ["authority:production-deploy"],
    runtimes: [],
    languages: ["language:typescript"],
    modalities: ["modality:text"],
    allowedEntityKinds: ["agent"],
  }],
  edges: [],
  forbiddenCommunities: ["community:travel"],
  selectionPolicy: {
    minimumCandidatesPerSlot: 2,
    maximumCandidatesPerSlot: 20,
    allowHistoryEvidence: false,
  },
};

const travelRelease = "release:travel-v1";
const backendRelease = "release:backend-v7";
const candidateSet = {
  schemaVersion: "agentlas.workforce-candidate-set.v1",
  selectionSessionId: "selection:test-backend",
  workOrderId: workOrder.workOrderId,
  ontologyVersion: "awo:2026-07-15.1",
  candidateSetDigest: hash("a"),
  decisionOwner: "host_llm",
  historyInfluence: "none",
  slots: [{
    slotId: "slot:backend",
    candidates: [
      {
        agentDefinitionId: "definition:travel",
        agentReleaseId: travelRelease,
        packageHash: hash("1"),
        contentDigest: hash("2"),
        releaseVersion: "1.0.0",
        entityKind: "agent",
        name: "Travel Planner",
        communities: ["community:travel"],
        fitEvidence: ["fit:text:term:api"],
        qualificationEvidence: ["eval:schema"],
        optionalGaps: ["gap:skill:payment-integration"],
        semanticSnapshot: {
          summaries: ["Travel itinerary specialist"],
          roles: ["role:travel-planner"],
          skills: [{ concept: "skill:itinerary-planning", level: "declared" }],
          toolCapabilities: [],
          consumes: [],
          produces: [],
          authorities: [],
          runtimes: ["desktop"],
          languages: ["en"],
        },
        operational: { callable: true, installable: true, unavailableReasons: [] },
      },
      {
        agentDefinitionId: "definition:backend",
        agentReleaseId: backendRelease,
        packageHash: hash("b"),
        contentDigest: hash("c"),
        releaseVersion: "7.0.0",
        entityKind: "agent",
        name: "Backend Engineer",
        communities: ["community:software-engineering", "community:payments"],
        fitEvidence: ["fit:skills:skill:api-design", "fit:tools:tool:postgresql"],
        qualificationEvidence: ["eval:payment-api-work-sample"],
        optionalGaps: [],
        semanticSnapshot: {
          summaries: ["Payment API and PostgreSQL transactions"],
          roles: ["role:backend-engineer"],
          skills: [{ concept: "skill:api-design", level: "demonstrated" }],
          toolCapabilities: [{ concept: "tool:postgresql", level: "checked" }],
          consumes: ["artifact:requirements"],
          produces: ["artifact:api-spec"],
          authorities: [],
          runtimes: ["desktop"],
          languages: ["typescript"],
        },
        operational: { callable: true, installable: true, unavailableReasons: [] },
      },
    ],
    coverageGaps: [],
  }],
  issuedAt: "2026-07-15T00:00:00Z",
  expiresAt: "2030-01-01T00:00:00Z",
};

const selection = {
  schemaVersion: "agentlas.workforce-selection.v1",
  selectionSessionId: candidateSet.selectionSessionId,
  candidateSetDigest: candidateSet.candidateSetDigest,
  decisionAuthor: {
    kind: "host_llm",
    modelId: "qwen3:30b-a3b",
    runtimeId: "ollama:ollama:local",
  },
  assignments: [{
    slotId: "slot:backend",
    agentReleaseId: backendRelease,
    reasonCodes: ["fit:payment-api", "fit:postgresql-transaction"],
  }],
  edges: [],
  alternativesConsidered: [travelRelease],
  requestExpansionForSlots: [],
};

const validation = {
  schemaVersion: "agentlas.workforce-selection-validation.v1",
  status: "accepted",
  issues: [],
  selectionReceiptId: "workforce-selection:test-backend",
  decisionOwner: "host_llm",
  historyInfluence: "none",
  ontologyVersion: candidateSet.ontologyVersion,
  candidateSetDigest: candidateSet.candidateSetDigest,
  idealTeam: [{
    slotId: "slot:backend",
    agentDefinitionId: "definition:backend",
    agentReleaseId: backendRelease,
    releaseVersion: "7.0.0",
    packageHash: hash("b"),
    contentDigest: hash("c"),
    entityKind: "agent",
    reasonCodes: ["fit:payment-api"],
  }],
  executableTeam: [{
    slotId: "slot:backend",
    agentDefinitionId: "definition:backend",
    agentReleaseId: backendRelease,
    releaseVersion: "7.0.0",
    packageHash: hash("b"),
    contentDigest: hash("c"),
    entityKind: "agent",
    reasonCodes: ["fit:payment-api"],
  }],
  unfilledPosts: [],
  substitutions: [],
  edges: [],
  receipt: {},
};

const preparation = {
  schemaVersion: "agentlas.workforce-execution-plan.v1",
  status: "prepared",
  issues: [],
  preparationReceiptId: "workforce-preparation:test-backend",
  selectionReceiptId: validation.selectionReceiptId,
  candidateSetDigest: candidateSet.candidateSetDigest,
  decisionOwner: "host_llm",
  substitutions: [],
  executionRoster: [{
    slotId: "slot:backend",
    agentDefinitionId: "definition:backend",
    agentReleaseId: backendRelease,
    packageHash: hash("b"),
    contentDigest: hash("c"),
    releaseVersion: "7.0.0",
    entityKind: "agent",
    directiveBundle: {
      slug: "backend-payment-engineer",
      name: "Backend Engineer",
      instructions: "Design payment APIs and PostgreSQL transaction boundaries. Produce evidence and handoff notes.",
    },
    bundleDigest: hash("d"),
  }],
};

function fenced(heading, value) {
  return `${heading}\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
}

(async () => {
  assert.deepEqual(parseWorkforceCommand("/hep-network build an API"), {
    kind: "workforce",
    goal: "build an API",
    benchmarkMode: false,
  });
  assert.deepEqual(parseWorkforceCommand("hep-network --legacy old route"), {
    kind: "legacy-network",
    goal: "old route",
  });
  assert.deepEqual(parseWorkforceCommand("/workforce --benchmark hard fixture"), {
    kind: "workforce",
    goal: "hard fixture",
    benchmarkMode: true,
  });
  assert.deepEqual(parseWorkforceCommand("/hep-network --stormbreaker long run"), { kind: "none" });
  assert.deepEqual(parseWorkforceCommand("/workforce hidden", true), { kind: "none" });
  assert.deepEqual(parseLeaderJson(fenced("## Workforce Work Order", workOrder), "## Workforce Work Order"), workOrder);
  assert.throws(
    () => validateWorkOrder({ ...workOrder, taskBrief: "Inspect /Users/mason/private-project" }),
    /redaction gate/,
  );

  const toolCalls = [];
  const leaderTurns = [];
  const events = [];
  let searchedCandidateSet = candidateSet;
  const hubMcp = {
    async call(name, args) {
      toolCalls.push({ name, args });
      if (name === "workforce.search_candidates") {
        searchedCandidateSet = { ...candidateSet, workOrderId: args.workOrder.workOrderId };
        return searchedCandidateSet;
      }
      if (name === "workforce.validate_selection") return validation;
      if (name === "workforce.prepare_execution") return preparation;
      throw new Error(`unexpected tool ${name}`);
    },
  };
  const result = await runWorkforceSelection({
    goal: "Build a payment API",
    active,
    sink: (event) => events.push(event),
    hubMcp,
    leader: async (turn) => {
      leaderTurns.push(turn);
      const assignedId = turn.systemPrompt.match(/workOrderId must be exactly ([A-Za-z0-9._:/@-]+)/)?.[1];
      return turn.phase === "work-order"
        ? fenced("## Workforce Work Order", { ...workOrder, workOrderId: assignedId })
        : fenced("## Workforce Selection", selection);
    },
  });

  assert.deepEqual(toolCalls.map((call) => call.name), [
    "workforce.search_candidates",
    "workforce.validate_selection",
    "workforce.prepare_execution",
  ]);
  assert.equal(leaderTurns.length, 2, "the active host LLM must author work order and selection");
  assert.match(leaderTurns[0].systemPrompt, /awo:2026-07-15\.1/);
  assert.match(leaderTurns[0].systemPrompt, /role:payments-engineer/);
  assert.match(leaderTurns[0].systemPrompt, /role:quality-engineer/);
  assert.match(leaderTurns[0].systemPrompt, /community:payments-engineering/);
  assert.match(toolCalls[0].args.workOrder.workOrderId, /^work-order:/);
  assert.equal(searchedCandidateSet.workOrderId, toolCalls[0].args.workOrder.workOrderId);
  assert.equal(toolCalls[2].args.validationReceipt.selectionReceiptId, validation.selectionReceiptId);
  assert.equal(toolCalls[2].args.candidateSet.candidateSetDigest, candidateSet.candidateSetDigest);
  assert.equal(result.selection.assignments[0].agentReleaseId, backendRelease, "host LLM choice must survive unchanged");
  assert.notEqual(result.selection.assignments[0].agentReleaseId, travelRelease, "candidate insertion order is not a picker");
  assert.equal(result.specs.length, 1);
  assert.equal(result.specs[0].agentReleaseId, backendRelease);
  assert.equal(result.specs[0].packageHash, hash("b"));
  assert.equal(result.specs[0].contentDigest, hash("c"));
  assert.equal(result.receipt.decisionOwner, "host_llm");
  assert.equal(result.receipt.historyInfluence, "none");
  assert.deepEqual(result.receipt.substitutions, []);
  assert.ok(events.some((event) => event.tool?.name === "workforce.search_candidates"));

  const ordinaryEvents = [];
  emitWorkforceBenchmarkSelectionArtifacts((event) => ordinaryEvents.push(event), false, result);
  assert.deepEqual(ordinaryEvents, [], "ordinary Workforce runs must not emit benchmark artifacts");

  const benchmarkEvents = [];
  emitWorkforceBenchmarkSelectionArtifacts((event) => benchmarkEvents.push(event), true, result);
  assert.equal(benchmarkEvents.length, 1);
  const benchmarkEvent = benchmarkEvents[0];
  assert.equal(benchmarkEvent.kind, "tool-use");
  assert.equal(benchmarkEvent.done, true);
  assert.equal(benchmarkEvent.tool.name, "agentlas.workforce.benchmark_selection_artifacts");
  assert.equal(benchmarkEvent.tool.id, result.receipt.selectionReceiptId);
  const benchmarkArtifacts = JSON.parse(benchmarkEvent.tool.result);
  assert.equal(benchmarkArtifacts.schemaVersion, "agentlas.workforce-benchmark-selection-artifacts.v1");
  assert.equal(benchmarkArtifacts.benchmarkMode, true);
  assert.deepEqual(Object.keys(benchmarkArtifacts).sort(), [
    "benchmarkMode",
    "candidateSet",
    "preparation",
    "schemaVersion",
    "selection",
    "selectionReceipt",
    "validation",
    "workOrder",
  ]);
  assert.deepEqual(benchmarkArtifacts.workOrder, result.workOrder);
  assert.deepEqual(benchmarkArtifacts.candidateSet, result.candidateSet);
  assert.deepEqual(benchmarkArtifacts.selection, result.selection);
  assert.deepEqual(benchmarkArtifacts.validation, result.validation);
  assert.deepEqual(benchmarkArtifacts.preparation, preparation, "raw preparation must remain complete");
  assert.deepEqual(benchmarkArtifacts.selectionReceipt, result.receipt);
  assert.equal(JSON.stringify(benchmarkArtifacts).includes(process.cwd()), false, "do not append the local cwd");

  assert.throws(
    () => validateWorkOrder({ ...workOrder, ontologyVersion: "awo:stale" }),
    /must use ontology/,
  );

  assert.throws(
    () => validateLeaderSelection({
      ...selection,
      assignments: [{ slotId: "slot:backend", agentReleaseId: "release:not-a-candidate", reasonCodes: ["fit:fake"] }],
    }, candidateSet, active),
    /outside the candidate set/,
  );
  assert.throws(
    () => validateLeaderSelection({
      ...selection,
      decisionAuthor: { ...selection.decisionAuthor, kind: "deterministic_router" },
    }, candidateSet, active),
    /host LLM/,
  );
  assert.throws(
    () => validateSelectionReceipt({
      ...validation,
      executableTeam: [],
      unfilledPosts: [{ slotId: "slot:backend", agentReleaseId: backendRelease }],
    }, selection, candidateSet),
    /not executable/,
  );
  assert.throws(
    () => validateExecutionPreparation({
      ...preparation,
      substitutions: [{ from: backendRelease, to: travelRelease }],
    }, validation, candidateSet),
    /unapproved substitution/,
  );
  assert.throws(
    () => validateExecutionPreparation({
      ...preparation,
      executionRoster: [{ ...preparation.executionRoster[0], agentReleaseId: travelRelease }],
    }, validation, candidateSet),
    /unknown or duplicate release/,
  );
  assert.throws(
    () => validateExecutionPreparation({
      ...preparation,
      executionRoster: [{ ...preparation.executionRoster[0], packageHash: hash("9") }],
    }, validation, candidateSet),
    /identity or digest mismatch/,
  );
  assert.throws(
    () => validateCandidateSet({ ...candidateSet, issuedAt: undefined }, workOrder),
    /issuedAt/,
  );
  assert.throws(
    () => validateCandidateSet({ ...candidateSet, issuedAt: candidateSet.expiresAt }, workOrder),
    /issuance window/,
  );
  assert.throws(
    () => validateCandidateSet({
      ...candidateSet,
      slots: [{
        ...candidateSet.slots[0],
        candidates: [{ ...candidateSet.slots[0].candidates[1], semanticSnapshot: { summaries: ["incomplete"] } }],
      }],
    }, workOrder),
    /semanticSnapshot\.roles/,
  );
  assert.throws(
    () => validateSelectionReceipt({
      ...validation,
      idealTeam: [{ ...validation.idealTeam[0], packageHash: hash("9") }],
    }, selection, candidateSet),
    /frozen candidate release/,
  );
  assert.throws(
    () => validateCandidateSet({
      ...candidateSet,
      slots: [{
        ...candidateSet.slots[0],
        candidates: [{ ...candidateSet.slots[0].candidates[0], rating: 5 }],
      }],
    }, workOrder),
    /forbidden fit signal/,
  );

  const plannerSpecs = [
    { slug: "backend", name: "Backend", directive: "Backend work" },
    { slug: "reviewer", name: "Reviewer", directive: "Review work" },
  ];
  const missingPlannerJson = normalizePacketsForRoster([], plannerSpecs, "original request");
  assert.equal(missingPlannerJson.parseSuccess, false);
  assert.equal(missingPlannerJson.fallbackUsed, true, "benchmark mode must be able to detect fallback packets");
  assert.equal(missingPlannerJson.packets.length, 2);
  const packet = (agent) => ({
    agent,
    inputType: "implementation",
    inputKind: "codebase",
    brief: `${agent} brief`,
    context: [],
    expectedOutput: `${agent} output`,
    constraints: [],
    allocation: {
      schemaVersion: "agentlas.workload-allocation.v1",
      phase: "delegate",
      modelClass: "balanced",
      effort: "medium",
      contextClass: "standard",
      capabilityRequirements: [],
      risk: "medium",
      rationaleCodes: ["test"],
    },
  });
  const completePlannerJson = normalizePacketsForRoster(
    [packet("backend"), packet("reviewer")],
    plannerSpecs,
    "original request",
  );
  assert.equal(completePlannerJson.parseSuccess, true);
  assert.equal(completePlannerJson.fallbackUsed, false);

  console.log("workforce orchestrator contract: ok");
  app.quit();
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
  app.quit();
});
