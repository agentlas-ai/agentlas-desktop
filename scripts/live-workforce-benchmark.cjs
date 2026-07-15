#!/usr/bin/env node
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const BENCHMARK_GOAL = [
  "Design an executable zero-downtime migration for a three-region active-active payment ledger.",
  "The current system has legacy writers for 72 hours, at-least-once events, duplicate and out-of-order PSP callbacks, and network partitions; no global transaction is available.",
  "Preserve double-entry balance, idempotency, monotonic payment state transitions, auditability, and rollback safety.",
  "The deliverable must include invariants, schema/API/idempotency boundaries, event/outbox and reconciliation design, failure matrix, phased rollout, rollback triggers, and independent verification evidence.",
  "Staff separate accountable posts for distributed backend architecture, payment-ledger/data consistency, and independent reliability verification. Do not require external tools; this is a reasoning benchmark.",
].join(" ");

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function safeError(error) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\/(?:Users|Volumes|private\/tmp|tmp)\/[^\s,;)}\]]+/gi, "[redacted-path]")
    .replace(/\b(?:sk|rk|pk|xox[baprs]|gh[pousr])-[A-Za-z0-9_=-]{12,}\b/g, "[redacted-secret]")
    .slice(0, 1200);
}

function eventSummary(event) {
  return {
    kind: event.kind ?? null,
    status: typeof event.status === "string" ? event.status.slice(0, 300) : null,
    tool: event.tool?.name ?? null,
    phase: event.phase ?? null,
    role: event.role ?? null,
    agentName: event.agentName ?? null,
    model: event.model ?? null,
    done: event.done === true,
    error: event.error?.code ?? (event.tool?.isError ? "tool-error" : null),
    tokens: Number.isFinite(event.tokens) ? event.tokens : null,
  };
}

function runtimeArtifact(active) {
  return {
    kind: active.kind,
    backend: active.backend,
    source: path.basename(active.source),
    version: active.version ?? null,
    model: active.model ?? null,
    allocationModels: active.allocationModels ?? [],
    allocationModelProfiles: active.allocationModelProfiles ?? {},
    effort: active.effort ?? null,
  };
}

function selectedRosterArtifact(selection) {
  return selection?.specs?.map((spec) => ({
    slotId: spec.routeLabel?.replace(/^workforce:/, "") ?? null,
    slug: spec.slug,
    name: spec.name,
    entityKind: spec.entityKind,
    agentReleaseId: spec.agentReleaseId,
  })) ?? [];
}

async function activeRuntime(runtimeName) {
  if (runtimeName === "qwen") {
    const { conservativeLocalRuntimeAllocation } = require("../dist/electron/runtime/detect.js");
    const model = argValue("model", "qwen3:30b-a3b");
    return {
      kind: "ollama",
      backend: "ollama",
      source: "ollama",
      version: "live",
      active: true,
      model,
      availableModels: [model],
      ...conservativeLocalRuntimeAllocation([model]),
    };
  }
  if (runtimeName === "terra") {
    const { probeCodex } = require("../dist/electron/runtime/codex.js");
    const { readCodexModelInventory } = require("../dist/electron/runtime/codex-models.js");
    const { cliModels } = require("../dist/shared/models.js");
    const probe = await probeCodex();
    if (!probe) throw new Error("Codex CLI is unavailable.");
    const model = argValue("model", "gpt-5.6-terra");
    const inventory = await readCodexModelInventory();
    const host = inventory.find((entry) => entry.id === model);
    const tier = cliModels("codex").find((entry) => entry.id === model)?.workforceTier;
    if (!host || !tier) throw new Error("Terra is absent from the live host inventory.");
    return {
      kind: "codex",
      backend: "openai",
      source: probe.path,
      version: probe.version,
      active: true,
      model,
      availableModels: inventory.map((entry) => entry.id),
      allocationModels: inventory.map((entry) => entry.id),
      allocationModelProfiles: Object.fromEntries(inventory.map((entry) => [entry.id, {
        ...(entry.id === model ? { costTier: tier } : {}),
        ...(entry.contextWindow !== null ? { contextWindow: entry.contextWindow } : {}),
        capabilities: entry.capabilities,
        ...(entry.supportsTools !== null ? { supportsTools: entry.supportsTools } : {}),
        ...(entry.supportsMultimodal !== null ? { supportsMultimodal: entry.supportsMultimodal } : {}),
        ...(entry.efforts !== null ? { efforts: entry.efforts } : {}),
      }])),
      effort: "low",
    };
  }
  throw new Error(`Unsupported runtime: ${runtimeName}`);
}

async function main() {
  if (!process.argv.includes("--yes-live-hub")) {
    throw new Error("Live Hub benchmark requires --yes-live-hub.");
  }
  const runtimeName = argValue("runtime", "qwen");
  const expectedBlocked = process.argv.includes("--expect-blocked");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `agentlas-workforce-live-${runtimeName}-`));
  process.env.AGENTLAS_STORE_PATH = path.join(tmp, "agentlas.sqlite");
  app.setPath("userData", path.join(tmp, "user-data"));
  await app.whenReady();

  const startedAt = new Date();
  const events = [];
  const hubCalls = [];
  const leaderOutputs = [];
  const selectionAudit = {
    schemaAttempts: [],
    hubToolObservations: [],
    hubToolSupersessions: [],
    leaderDecisionSupersessions: [],
    workOrderRefinements: [],
  };
  const plannerAttempts = [];
  const plannerReceipts = [];
  let activeEvidence = null;
  let benchmarkSnapshot = null;
  let selectionEvidence = null;
  let executionEvidence = null;
  let artifact;
  try {
    const store = require("../dist/electron/store/db.js");
    store.initStore();
    const { seedBuiltinAgents } = require("../dist/electron/architecture/seed.js");
    const { listInstalledAgents } = require("../dist/electron/mcp/registry.js");
    const { createChat } = require("../dist/electron/store/chats.js");
    const { callServerTool } = require("../dist/electron/mcp-tools/client.js");
    const { runWorkforceSelection } = require("../dist/electron/mcp/workforce-orchestrator.js");
    const { runBorrowedTaskForceInvocation } = require("../dist/electron/mcp/borrowed-task-force.js");
    const { pickRunner } = require("../dist/electron/runtime/selection.js");

    seedBuiltinAgents();
    const orchestratorAgent = listInstalledAgents().find((agent) => agent.slug === "agentlas-orchestrator") || listInstalledAgents()[0];
    if (!orchestratorAgent) throw new Error("Built-in Agentlas orchestrator is unavailable.");
    const chat = createChat({ agentId: orchestratorAgent.id });
    const active = await activeRuntime(runtimeName);
    activeEvidence = runtimeArtifact(active);
    const picked = pickRunner(active);
    if (!picked) throw new Error(`No Desktop runner for ${runtimeName}.`);
    const leaderEvidence = [];
    const hephaestus = path.join(os.homedir(), ".agentlas", "runtime", "current", "bin", "hephaestus");
    const server = {
      id: "live-workforce-hephaestus",
      catalogId: "hephaestus-network",
      name: "Hephaestus Network",
      transport: "stdio",
      command: hephaestus,
      args: ["mcp", "serve"],
      envKeys: [],
      enabled: true,
      configurationValid: true,
    };
    const hubMcp = {
      async call(toolName, args) {
        const callStarted = Date.now();
        try {
          const text = await callServerTool(server, toolName, args, {
            timeoutMs: 45_000,
            maxTextChars: 16 * 1024 * 1024,
          });
          if (!text) throw new Error(`${toolName} returned no text content.`);
          const parsed = JSON.parse(text);
          hubCalls.push({ tool: toolName, status: "ok", durationMs: Date.now() - callStarted });
          return parsed;
        } catch (error) {
          hubCalls.push({ tool: toolName, status: "failed", durationMs: Date.now() - callStarted, error: safeError(error) });
          throw error;
        }
      },
    };
    const sink = (event) => {
      events.push(eventSummary(event));
      if (event.tool?.name === "agentlas.workforce.planner_receipt" && typeof event.tool.result === "string") {
        try {
          plannerReceipts.push(JSON.parse(event.tool.result));
        } catch {
          plannerReceipts.push({ schemaVersion: "agentlas.workforce-planner-receipt.v1", status: "unparseable" });
        }
      }
    };
    selectionEvidence = await runWorkforceSelection({
      goal: BENCHMARK_GOAL,
      inputModalities: [],
      active,
      benchmarkMode: true,
      sink,
      hubMcp,
      leader: async (turn) => {
        const result = await picked.runner({
          systemPrompt: turn.systemPrompt,
          history: [],
          userPrompt: turn.userPrompt,
          backendLabel: picked.label,
          model: active.model,
          effort: active.effort ?? undefined,
          permission: "read",
          untrustedNoTools: true,
          chatId: turn.invocationId,
          locale: "en",
        }, { onStatus() {}, onPartial() {}, onTool() {} });
        leaderEvidence.push({
          invocationId: turn.invocationId,
          runtime: { ...active },
          result: { appliedEffort: result.appliedEffort },
        });
        leaderOutputs.push({
          phase: turn.phase,
          attempt: turn.attempt,
          invocationId: turn.invocationId,
          output: result.text,
          outputDigest: sha256(result.text),
        });
        return result.text;
      },
      auditSchemaAttempt: (attempt) => selectionAudit.schemaAttempts.push(structuredClone(attempt)),
      auditHubToolObservation: (observation) => selectionAudit.hubToolObservations.push(structuredClone(observation)),
      auditHubToolSupersession: (supersession) => selectionAudit.hubToolSupersessions.push(structuredClone(supersession)),
      auditLeaderDecisionSupersession: (supersession) => selectionAudit.leaderDecisionSupersessions.push(structuredClone(supersession)),
      auditWorkOrderRefinement: (receipt) => selectionAudit.workOrderRefinements.push(structuredClone(receipt)),
      auditBenchmarkSelectionSnapshot: (snapshot) => { benchmarkSnapshot = structuredClone(snapshot); },
    });
    executionEvidence = await runBorrowedTaskForceInvocation({
      req: {
        userPrompt: BENCHMARK_GOAL,
        permissions: "read",
        runId: `live-workforce-${runtimeName}-${Date.now()}`,
      },
      chat,
      orchestratorAgent,
      taskForceName: `Live Workforce benchmark (${runtimeName})`,
      taskForceKind: "task-force",
      taskForceSpecs: selectionEvidence.specs,
      active,
      runtimes: [active],
      picked,
      workingFolder: null,
      locale: "en",
      sink,
      workforceSelectionReceipt: selectionEvidence.receipt,
      workforceLeaderRunnerEvidence: leaderEvidence,
      benchmarkMode: true,
      requireAllWorkers: true,
      auditWorkforcePlannerAttempt: (attempt) => plannerAttempts.push(structuredClone(attempt)),
    });
    artifact = {
      schemaVersion: "agentlas.desktop-live-workforce-benchmark.v1",
      runtime: activeEvidence,
      benchmarkGoal: BENCHMARK_GOAL,
      benchmarkGoalDigest: sha256(BENCHMARK_GOAL),
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      expectedBlocked,
      status: executionEvidence.ok ? "passed" : "failed",
      hubCalls,
      workOrder: selectionEvidence.workOrder,
      candidateSet: selectionEvidence.candidateSet,
      selection: selectionEvidence.selection,
      validation: selectionEvidence.validation,
      preparation: selectionEvidence.preparation,
      selectedRoster: selectedRosterArtifact(selectionEvidence),
      selectionReceipt: selectionEvidence.receipt,
      executionReceipt: executionEvidence.receipt ?? null,
      verifierIssues: executionEvidence.verifierIssues ?? [],
      output: executionEvidence.text,
      outputDigest: sha256(executionEvidence.text),
      selectionAudit,
      plannerAttempts,
      plannerReceipts,
      events,
      leaderOutputs,
    };
  } catch (error) {
    artifact = {
      schemaVersion: "agentlas.desktop-live-workforce-benchmark.v1",
      runtime: activeEvidence ?? runtimeName,
      benchmarkGoal: BENCHMARK_GOAL,
      benchmarkGoalDigest: sha256(BENCHMARK_GOAL),
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      expectedBlocked,
      status: expectedBlocked ? "blocked-as-expected" : "blocked",
      error: safeError(error),
      hubCalls,
      workOrder: selectionEvidence?.workOrder ?? benchmarkSnapshot?.workOrder ?? null,
      candidateSet: selectionEvidence?.candidateSet ?? benchmarkSnapshot?.candidateSet ?? null,
      selection: selectionEvidence?.selection ?? benchmarkSnapshot?.selection ?? null,
      validation: selectionEvidence?.validation ?? null,
      preparation: selectionEvidence?.preparation ?? null,
      selectedRoster: selectedRosterArtifact(selectionEvidence),
      selectionReceipt: selectionEvidence?.receipt ?? null,
      executionReceipt: executionEvidence?.receipt ?? null,
      verifierIssues: executionEvidence?.verifierIssues ?? [],
      selectionAudit,
      plannerAttempts,
      plannerReceipts,
      events,
      leaderOutputs,
    };
  }

  const outputPath = argValue("output", path.join(tmp, `live-workforce-${runtimeName}.json`));
  fs.writeFileSync(outputPath, JSON.stringify(artifact, null, 2));
  console.log(JSON.stringify({
    status: artifact.status,
    runtime: runtimeName,
    durationMs: artifact.durationMs,
    selectedRoster: artifact.selectedRoster ?? [],
    verifierIssues: artifact.verifierIssues ?? [],
    error: artifact.error ?? null,
    hubCalls: artifact.hubCalls,
    outputPath,
  }, null, 2));
  if (expectedBlocked ? artifact.status !== "blocked-as-expected" : artifact.status !== "passed") {
    process.exitCode = 1;
  }
}

app.whenReady().then(() => main().finally(() => app.quit())).catch((error) => {
  console.error(error);
  app.exit(1);
});
