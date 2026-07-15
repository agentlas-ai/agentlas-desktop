const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const hash = (char) => `sha256:${char.repeat(64)}`;

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-workforce-receipt-"));
  process.env.AGENTLAS_STORE_PATH = path.join(tmp, "agentlas.sqlite");
  app.setPath("userData", path.join(tmp, "user-data"));
  await app.whenReady();
  const db = require("../dist/electron/store/db.js");
  db.initStore();
  const { seedBuiltinAgents } = require("../dist/electron/architecture/seed.js");
  const { listInstalledAgents } = require("../dist/electron/mcp/registry.js");
  const { createChat } = require("../dist/electron/store/chats.js");
  seedBuiltinAgents();
  const orchestratorAgent = listInstalledAgents().find((agent) => agent.slug === "agentlas-orchestrator") || listInstalledAgents()[0];
  assert.ok(orchestratorAgent, "fixture needs the built-in orchestrator");
  const receiptChat = createChat({ agentId: orchestratorAgent.id });
  const { runBorrowedTaskForceInvocation } = require("../dist/electron/mcp/borrowed-task-force.js");

  const events = [];
  const calls = [];
  const specs = [
    {
      slug: "backend",
      name: "Backend Engineer",
      directive: "Implement the API boundary.",
      source: "hub",
      entityKind: "agent",
      routeLabel: "workforce:slot:backend",
      agentDefinitionId: "definition:backend",
      agentReleaseId: "release:backend-v7",
      packageHash: hash("b"),
      contentDigest: hash("c"),
      releaseVersion: "7.0.0",
      bundleDigest: hash("d"),
    },
    {
      slug: "reviewer",
      name: "Payment Reviewer",
      directive: "Review transaction and payment failure semantics.",
      source: "hub",
      entityKind: "agent",
      routeLabel: "workforce:slot:review",
      agentDefinitionId: "definition:reviewer",
      agentReleaseId: "release:reviewer-v3",
      packageHash: hash("e"),
      contentDigest: hash("f"),
      releaseVersion: "3.0.0",
      bundleDigest: hash("1"),
    },
  ];
  const workforceSelectionReceipt = {
    schemaVersion: "agentlas.desktop-workforce-selection-receipt.v1",
    receiptId: "desktop-workforce:test",
    workOrderId: "work-order:test",
    selectionSessionId: "selection:test",
    selectionReceiptId: "workforce-selection:test",
    preparationReceiptId: "workforce-preparation:test",
    candidateSetDigest: hash("a"),
    ontologyVersion: "awo:1.0.0",
    decisionOwner: "host_llm",
    decisionModel: "qwen3:30b-a3b",
    decisionRuntime: "ollama:ollama:local",
    historyInfluence: "none",
    idealTeam: specs.map((spec) => ({
      slotId: spec.routeLabel.slice("workforce:".length),
      agentDefinitionId: spec.agentDefinitionId,
      agentReleaseId: spec.agentReleaseId,
      entityKind: spec.entityKind,
    })),
    executableTeam: specs.map((spec) => ({
      slotId: spec.routeLabel.slice("workforce:".length),
      agentDefinitionId: spec.agentDefinitionId,
      agentReleaseId: spec.agentReleaseId,
      entityKind: spec.entityKind,
    })),
    unfilledPosts: [],
    substitutions: [],
    preparedReleases: specs.map((spec) => ({
      slotId: spec.routeLabel.slice("workforce:".length),
      agentDefinitionId: spec.agentDefinitionId,
      agentReleaseId: spec.agentReleaseId,
      packageHash: spec.packageHash,
      contentDigest: spec.contentDigest,
      releaseVersion: spec.releaseVersion,
      bundleDigest: spec.bundleDigest,
    })),
    mcpCalls: [
      { tool: "workforce.search_candidates", invocationId: "mcp:search", status: "ok" },
      { tool: "workforce.validate_selection", invocationId: "mcp:validate", status: "ok" },
      { tool: "workforce.prepare_execution", invocationId: "mcp:prepare", status: "ok" },
    ],
    leaderInvocations: [
      { phase: "work-order", invocationId: "workforce-leader:order", modelId: "qwen3:30b-a3b", runtimeId: "ollama:ollama:local", status: "completed" },
      { phase: "selection", invocationId: "workforce-leader:selection", modelId: "qwen3:30b-a3b", runtimeId: "ollama:ollama:local", status: "completed" },
    ],
  };
  const runner = async (request) => {
    calls.push(request);
    if (request.systemPrompt.includes("Agentlas Task-Force Orchestrator")) {
      return {
        text: [
          "## Agent Input Packets",
          "```json",
          JSON.stringify({
            packets: specs.map((spec) => ({
              agent: spec.slug,
              inputType: spec.slug === "backend" ? "implementation" : "review",
              inputKind: "codebase",
              brief: `${spec.slug} bounded brief`,
              context: ["redacted test fixture"],
              expectedOutput: `${spec.slug} handoff artifact`,
              constraints: ["Do not synthesize"],
            })),
            synthesis: {},
          }),
          "```",
        ].join("\n"),
        tokens: 50,
      };
    }
    if (request.systemPrompt.includes("Agentlas Task-Force Synthesis")) {
      return { text: "Verified payment API implementation and review synthesis.", tokens: 70 };
    }
    if (request.systemPrompt.includes("Agentlas Task-Force Agent Host Policy")) {
      return { text: "Specialist result with evidence and handoff notes.", tokens: 30 };
    }
    throw new Error("unexpected runner request");
  };
  const active = {
    kind: "ollama",
    backend: "ollama",
    source: "local",
    model: "qwen3:30b-a3b",
    available: true,
  };
  const result = await runBorrowedTaskForceInvocation({
    req: {
      userPrompt: "Implement and review a payment API.",
      permissions: "read",
      runId: "run:workforce-receipt",
    },
    chat: receiptChat,
    orchestratorAgent,
    taskForceName: "Workforce receipt fixture",
    taskForceKind: "task-force",
    taskForceSpecs: specs,
    active,
    runtimes: [active],
    picked: { runner, label: "Ollama qwen3" },
    workingFolder: null,
    locale: "en",
    sink: (event) => events.push(event),
    workforceSelectionReceipt,
    benchmarkMode: true,
    requireAllWorkers: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.receipt.schemaVersion, "agentlas.workforce-execution-receipt.v1");
  assert.equal(result.receipt.executionId.startsWith("workforce-execution:"), true);
  assert.equal(result.receipt.workOrderId, workforceSelectionReceipt.workOrderId);
  assert.equal(result.receipt.selectionReceiptId, workforceSelectionReceipt.selectionReceiptId);
  assert.equal(result.receipt.preparationReceiptId, workforceSelectionReceipt.preparationReceiptId);
  assert.equal(result.receipt.orchestrator.invocationId, "workforce-leader:selection");
  assert.equal(result.receipt.orchestrator.modelId, "qwen3:30b-a3b");
  assert.equal(result.receipt.planner.parseSuccess, true);
  assert.equal(result.receipt.planner.fallbackUsed, false);
  assert.equal(result.receipt.workers.length, 2);
  assert.equal(new Set(result.receipt.workers.map((worker) => worker.invocationId)).size, 2);
  assert.deepEqual(result.receipt.workers.map((worker) => worker.agentReleaseId).sort(), specs.map((spec) => spec.agentReleaseId).sort());
  assert.ok(result.receipt.workers.every((worker) => worker.modelId === "qwen3:30b-a3b"));
  assert.ok(result.receipt.workers.every((worker) => worker.handoffArtifactRefs.length === 1));
  assert.equal(result.receipt.synthesis.status, "completed");
  assert.equal(result.receipt.verifier.status, "completed");
  assert.equal(result.receipt.verifier.verdict, "pass");
  assert.equal(result.receipt.status, "passed");
  assert.deepEqual(result.receipt.substitutions, []);
  assert.ok(events.some((event) => event.tool?.name === "agentlas.workforce.execution_receipt"));
  assert.equal(calls.filter((request) => request.systemPrompt.includes("Agentlas Task-Force Agent Host Policy")).length, 2);

  const blockedEvents = [];
  const blockedChat = createChat({ agentId: orchestratorAgent.id });
  await assert.rejects(
    () => runBorrowedTaskForceInvocation({
      req: { userPrompt: "Bad planner fixture", permissions: "read", runId: "run:workforce-blocked" },
      chat: blockedChat,
      orchestratorAgent,
      taskForceName: "Blocked workforce fixture",
      taskForceKind: "task-force",
      taskForceSpecs: specs,
      active,
      runtimes: [active],
      picked: { runner: async () => ({ text: "not structured JSON", tokens: 1 }), label: "Ollama qwen3" },
      workingFolder: null,
      locale: "en",
      sink: (event) => blockedEvents.push(event),
      workforceSelectionReceipt,
      benchmarkMode: true,
      requireAllWorkers: true,
    }),
    /workforce_planner_parse_failed/,
  );
  const blockedReceiptEvent = blockedEvents.find((event) => event.tool?.name === "agentlas.workforce.planner_receipt");
  assert.ok(blockedReceiptEvent, "benchmark fallback failure must emit a truthful planner receipt");
  const blockedReceipt = JSON.parse(blockedReceiptEvent.tool.result);
  assert.equal(blockedReceipt.parseSuccess, false);
  assert.equal(blockedReceipt.fallbackUsed, true);
  assert.equal(blockedReceipt.status, "blocked");

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("workforce execution receipt: ok");
  app.quit();
}

main().catch((error) => {
  console.error(error);
  app.exit(1);
});
