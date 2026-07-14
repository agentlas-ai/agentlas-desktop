const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");

async function main() {
await app.whenReady();
const routing = require("../dist/electron/runtime/workload-routing.js");
const delegation = require("../dist/electron/mcp/delegate.js");
const borrowed = require("../dist/electron/mcp/borrowed-task-force.js");
const swarm = require("../dist/electron/mcp/swarm-run.js");
const cursorRuntime = require("../dist/electron/runtime/cursor.js");

const claude = {
  kind: "claude-code",
  backend: "anthropic",
  source: "/usr/local/bin/claude",
  version: "1",
  active: true,
  model: "opus",
  availableModels: ["opus", "sonnet", "haiku"],
  allocationModels: ["opus", "sonnet", "haiku"],
  allocationModelProfiles: {
    opus: { costTier: "frontier", contextWindow: 200000, capabilities: ["tools"], supportsTools: true },
    sonnet: { costTier: "balanced", contextWindow: 200000, capabilities: ["tools"], supportsTools: true },
    haiku: { costTier: "economy", contextWindow: 200000, capabilities: ["tools"], supportsTools: true },
  },
  effort: "high",
  efforts: ["low", "medium", "high", "xhigh", "max"].map((id) => ({ id, label: id })),
};
const codex = {
  kind: "codex",
  backend: "openai",
  source: "/usr/local/bin/codex",
  version: "1",
  active: true,
  model: "gpt-5.6-sol",
  availableModels: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
  allocationModels: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
  allocationModelProfiles: {
    "gpt-5.6-sol": { costTier: "frontier", contextWindow: 200000, capabilities: ["tools"], supportsTools: true, efforts: ["low", "medium", "high", "xhigh", "max"] },
    "gpt-5.6-terra": { costTier: "balanced", contextWindow: 200000, capabilities: ["tools"], supportsTools: true, efforts: ["low", "medium", "high", "xhigh", "max"] },
    "gpt-5.6-luna": { costTier: "economy", contextWindow: 200000, capabilities: ["tools"], supportsTools: true, efforts: ["low", "medium"] },
  },
};
const grok = {
  kind: "grok",
  backend: "custom",
  source: "/usr/local/bin/grok",
  version: "1",
  active: false,
  model: "grok-4.5",
  availableModels: ["grok-4.5"],
  allocationModels: ["grok-4.5"],
  allocationModelProfiles: {
    "grok-4.5": { costTier: "frontier", contextWindow: 100000, capabilities: [] },
  },
  efforts: ["low", "medium", "high"].map((id) => ({ id, label: id })),
};
const cursor = {
  kind: "cursor",
  backend: "cursor",
  source: "/usr/local/bin/cursor-agent",
  version: "1",
  active: false,
  model: "auto",
  // Auto is the only account-safe autonomous Cursor selection.
  availableModels: ["auto"],
  allocationModels: ["auto"],
  allocationModelProfiles: {
    auto: { costTier: "balanced", contextWindow: 100000, capabilities: ["tools"], supportsTools: true },
  },
};

function allocation(tier, effort = "medium", phase = "delegate", modelId, runtimeId) {
  return routing.normalizeWorkloadAllocation({
    runtimeId,
    modelId,
    tier,
    effort,
    phase,
    requirements: { inputTokens: 0, expectedOutputTokens: 0, toolRequired: false, multimodalRequired: false },
    reasonCodes: ["bounded-scope"],
    rationale: "Small isolated child with bounded output.",
  }, phase);
}

assert.equal(routing.normalizeWorkloadTier("haiku"), "economy");
assert.equal(routing.normalizeWorkloadTier("luna"), "economy");
assert.equal(routing.normalizeWorkloadTier("sonnet"), "balanced");
assert.equal(routing.normalizeWorkloadTier("tera"), "balanced", "user-facing tera alias must map to Terra tier");
assert.equal(routing.normalizeWorkloadTier("terra"), "balanced");
assert.equal(routing.normalizeWorkloadTier("opus"), "frontier");
assert.equal(routing.normalizeWorkloadTier("sol"), "frontier");
assert.equal(
  routing.normalizeWorkloadAllocation({ tier: "opus", effort: "high" }, "delegate").tier,
  "balanced",
  "missing phase must fail validation into the non-frontier fallback",
);

const claudeEconomy = routing.resolveWorkloadAllocation({
  allocation: allocation("economy", "low", "delegate", "haiku"),
  runtime: claude,
  phase: "delegate",
});
assert.equal(claudeEconomy.runtime.model, "haiku");
assert.equal(claudeEconomy.runtime.effort, "low");

const codexBalanced = routing.resolveWorkloadAllocation({
  allocation: allocation("tera", "max", "delegate", "gpt-5.6-terra"),
  runtime: codex,
  phase: "delegate",
});
assert.equal(codexBalanced.runtime.model, "gpt-5.6-terra", "parent exact live model must be selected");
assert.equal(codexBalanced.runtime.effort, "max", "host-verified per-model max effort must be preserved");
assert.equal(codexBalanced.resolutionCodes.includes("effort-clamped-to-capability"), false);

const codexLunaLimited = routing.resolveWorkloadAllocation({
  allocation: allocation("economy", "high", "delegate", "gpt-5.6-luna"),
  runtime: codex,
  phase: "delegate",
});
assert.equal(codexLunaLimited.runtime.effort, "medium", "effort must clamp to the selected model profile, not the runtime-wide union");
assert.ok(codexLunaLimited.resolutionCodes.includes("effort-clamped-to-capability"));

const codexInvalidEffortProfile = {
  ...codex,
  effort: "low",
  allocationModelProfiles: {
    ...codex.allocationModelProfiles,
    "gpt-5.6-sol": { ...codex.allocationModelProfiles["gpt-5.6-sol"], efforts: [] },
  },
};
const codexInvalidEffortChoice = routing.resolveWorkloadAllocation({
  allocation: allocation("frontier", "max", "delegate", "gpt-5.6-sol"),
  runtime: codexInvalidEffortProfile,
  phase: "delegate",
});
assert.equal(codexInvalidEffortChoice.runtime.effort, null);
assert.ok(codexInvalidEffortChoice.resolutionCodes.includes("effort-capability-unavailable"));

const maxOnlyCodex = {
  ...codex,
  effort: "max",
  allocationModelProfiles: {
    ...codex.allocationModelProfiles,
    "gpt-5.6-sol": { ...codex.allocationModelProfiles["gpt-5.6-sol"], efforts: ["max"] },
  },
};
const maxOnlyUnderHighPolicy = routing.resolveWorkloadAllocation({
  allocation: allocation("frontier", "max", "delegate", "gpt-5.6-sol"),
  runtime: maxOnlyCodex,
  phase: "delegate",
  hostPolicy: { maxEffort: "high" },
});
assert.equal(maxOnlyUnderHighPolicy.runtime.effort, null, "host maxEffort must never escalate back to the model minimum");
assert.ok(maxOnlyUnderHighPolicy.resolutionCodes.includes("effort-clamped-to-host-policy"));
assert.ok(maxOnlyUnderHighPolicy.resolutionCodes.includes("effort-below-capability-unavailable"));

const unavailable = routing.resolveWorkloadAllocation({
  allocation: allocation("frontier", "high", "delegate", "gpt-5.6-sol"),
  runtime: {
    ...codex,
    model: "gpt-5.6-terra",
    availableModels: ["gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.6-sol"],
    allocationModels: ["gpt-5.6-terra", "gpt-5.6-luna"],
  },
  phase: "delegate",
});
assert.equal(unavailable.runtime.model, "gpt-5.6-terra", "missing tier must preserve active model");
assert.equal(unavailable.runtime.effort, codex.effort, "invalid exact model must preserve active effort atomically");
assert.ok(unavailable.resolutionCodes.includes("parent-model-not-in-live-inventory-active-preserved"));

const manualOverride = {
  scope: "agent",
  targetId: "agent-1",
  selection: { kind: "codex", backend: "openai", model: "gpt-5.6-sol", effort: "xhigh" },
  updatedAt: new Date(0).toISOString(),
};
const manual = routing.resolveWorkloadAllocation({
  allocation: allocation("economy", "low", "delegate", "gpt-5.6-luna"),
  runtime: codex,
  phase: "delegate",
  manualOverride,
});
assert.equal(manual.runtime.model, "gpt-5.6-sol", "explicit manual model must win");
assert.equal(manual.source, "manual-override");

const receipt = routing.workloadAllocationReceipt({
  ...claudeEconomy,
  allocation: {
    ...claudeEconomy.allocation,
    rationale: [
      "고객명=김온리리시트-7Q9X",
      "의료정보=희귀질환-오로라-9284 진단 이력",
      "법률정보=비공개가사사건-델타-5519 합의 내용",
      "비표준비밀=ZETA_PRIVATE_CREDENTIAL_4F8A1C",
      "한국어민감문장=당사자만 알아야 하는 회생 신청 내역",
      "Inspect /Users/private/customer/project and mail owner@example.com with sk-abcdefghijklmnop",
    ].join("; "),
  },
});
const receiptJson = JSON.stringify(receipt);
assert.equal(receipt.schemaVersion, "agentlas.model-allocation-receipt.v1");
assert.equal(receipt.privacy.rawPromptIncluded, false);
assert.deepEqual(Object.keys(receipt).sort(), [
  "decisionId", "independentVerificationRequired", "inputFeatureHash", "packetId", "privacy",
  "reasonCodes", "requested", "resolved", "schemaVersion", "selectorVersion", "status", "validationIssues",
].sort(), "Desktop allocation receipt must match the Core public top-level contract exactly");
assert.doesNotMatch(receiptJson, /\/Users\/private|owner@example\.com|sk-abcdefghijklmnop/);
for (const privateValue of [
  "김온리리시트-7Q9X",
  "희귀질환-오로라-9284",
  "비공개가사사건-델타-5519",
  "ZETA_PRIVATE_CREDENTIAL_4F8A1C",
  "당사자만 알아야 하는 회생 신청 내역",
]) {
  assert.equal(receiptJson.includes(privateValue), false, `receipt leaked rationale value: ${privateValue}`);
}
assert.doesNotMatch(receiptJson, /userPrompt|brief|history|systemPrompt|tool/i, "receipt must contain allocation metadata, not prompts/tools");
assert.deepEqual(
  receipt.reasonCodes,
  ["bounded-scope", "parent-live-model-selected"],
  "receipt must persist only normalized allocation/resolution codes, never rationale-derived text",
);
const alternateRationaleReceipt = routing.workloadAllocationReceipt({
  ...claudeEconomy,
  allocation: { ...claudeEconomy.allocation, rationale: "완전히 다른 비공개 설명 OMEGA-7721" },
});
assert.equal(
  alternateRationaleReceipt.inputFeatureHash,
  receipt.inputFeatureHash,
  "rationale must not influence the persisted receipt hash",
);
assert.deepEqual(alternateRationaleReceipt.reasonCodes, receipt.reasonCodes);

const runnerRevalidated = routing.reconcileWorkloadRunnerResult(codexBalanced, { appliedEffort: "xhigh" });
assert.equal(runnerRevalidated.runtime.effort, "xhigh");
assert.ok(runnerRevalidated.resolutionCodes.includes("runner-effort-revalidated"));
assert.equal(
  routing.workloadAllocationReceipt(runnerRevalidated).resolved.effort,
  "xhigh",
  "persisted receipt must use the runner-applied effort, not the provisional allocation",
);

const parsedDelegation = delegation.parseDelegations(`Plan\n\n## Delegate\n\`\`\`json
{"delegations":[
  {"target":"Researcher","brief":"Check facts","allocation":{"runtimeId":"runtime-1","modelId":"haiku","tier":"economy","effort":"low","phase":"delegate","requirements":{"inputTokens":1000,"expectedOutputTokens":500,"toolRequired":false,"multimodalRequired":false},"reasonCodes":["bounded-scope"],"rationale":"bounded lookup"}},
  {"target":"Architect","brief":"Resolve design","allocation":{"runtimeId":"runtime-1","modelId":"opus","tier":"frontier","effort":"xhigh","phase":"delegate","requirements":{"inputTokens":2000,"expectedOutputTokens":1000,"toolRequired":false,"multimodalRequired":false},"reasonCodes":["high-risk"],"rationale":"cross-system decision"}}
],"synthesis":{"runtimeId":"runtime-1","modelId":"sonnet","tier":"balanced","effort":"high","phase":"synthesize","requirements":{"inputTokens":3000,"expectedOutputTokens":1000,"toolRequired":false,"multimodalRequired":false},"reasonCodes":["cross-result-synthesis"],"rationale":"merge two results"}}
\`\`\``);
assert.deepEqual(parsedDelegation.delegations.map((item) => item.allocation.tier), ["economy", "frontier"]);
assert.equal(parsedDelegation.synthesisAllocation.tier, "balanced");
assert.equal(parsedDelegation.cleanedText, "Plan");
const resolvedDelegates = parsedDelegation.delegations.map((item) => routing.resolveWorkloadAllocation({
  allocation: item.allocation,
  runtime: claude,
  phase: "delegate",
}).runtime.model);
assert.deepEqual(resolvedDelegates, ["haiku", "opus"], "different parent allocations must reach different worker models");

const legacyAliasOnly = routing.resolveWorkloadAllocationAcrossRuntimes({
  allocation: routing.normalizeWorkloadAllocation({
    tier: "economy", modelClass: "haiku", effort: "low", phase: "delegate",
    reasonCodes: ["bounded-scope"], rationale: "parent selected Haiku",
  }, "delegate"),
  runtimes: [codex, claude, grok, cursor],
  fallbackRuntime: codex,
  phase: "delegate",
});
assert.equal(legacyAliasOnly.runtime.kind, "codex", "tier/modelClass alone must never switch provider runtime");
assert.equal(legacyAliasOnly.runtime.model, "gpt-5.6-sol", "missing exact pair must preserve the active model");
assert.ok(legacyAliasOnly.resolutionCodes.includes("parent-runtime-model-pair-missing-active-preserved"));

const crossRuntimeComposer = routing.resolveWorkloadAllocationAcrossRuntimes({
  allocation: routing.normalizeWorkloadAllocation({
    tier: "balanced", modelClass: "composer", effort: "medium", phase: "delegate",
    reasonCodes: ["cursor-specialist"], rationale: "parent selected Cursor family",
  }, "delegate"),
  runtimes: [codex, claude, cursor],
  fallbackRuntime: codex,
  phase: "delegate",
});
assert.equal(crossRuntimeComposer.runtime.kind, "codex", "Cursor catalog names alone must not imply account entitlement");

const crossRuntimeGrok = routing.resolveWorkloadAllocationAcrossRuntimes({
  allocation: routing.normalizeWorkloadAllocation({
    tier: "frontier", modelClass: "grok", effort: "high", phase: "delegate",
    reasonCodes: ["independent-review"], rationale: "parent selected Grok review",
  }, "delegate"),
  runtimes: [claude, codex, grok],
  fallbackRuntime: codex,
  phase: "delegate",
});
assert.equal(crossRuntimeGrok.runtime.kind, "codex", "Grok family aliases must not manufacture a cross-runtime choice");

const liveInventory = routing.workloadRuntimeInventory([codex, claude, grok, cursor]);
assert.deepEqual(liveInventory[0].efforts, ["low", "medium", "high", "xhigh", "max"]);
assert.deepEqual(liveInventory[0].modelProfiles["gpt-5.6-luna"].efforts, ["low", "medium"]);
assert.deepEqual(liveInventory[1], {
  runtimeId: "runtime-2",
  kind: "claude-code",
  backend: "anthropic",
  models: ["opus", "sonnet", "haiku"],
  efforts: ["low", "medium", "high", "xhigh", "max"],
  modelProfiles: {
    opus: { costTier: "frontier", contextWindow: 200000, capabilities: ["tools"], supportsTools: true, supportsMultimodal: null, efforts: null },
    sonnet: { costTier: "balanced", contextWindow: 200000, capabilities: ["tools"], supportsTools: true, supportsMultimodal: null, efforts: null },
    haiku: { costTier: "economy", contextWindow: 200000, capabilities: ["tools"], supportsTools: true, supportsMultimodal: null, efforts: null },
  },
});
const displayOnlyRuntime = {
  ...codex,
  model: "gpt-5.6-sol",
  availableModels: ["gpt-5.6-sol", "display-only-unverified"],
  allocationModels: ["gpt-5.6-sol"],
};
assert.deepEqual(
  routing.workloadRuntimeInventory([displayOnlyRuntime])[0].models,
  ["gpt-5.6-sol"],
  "UI fallback models must never enter automatic allocation inventory",
);
const exactParentChoice = routing.resolveWorkloadAllocationAcrossRuntimes({
  allocation: routing.normalizeWorkloadAllocation({
    runtimeId: "runtime-2", modelId: "sonnet", tier: "balanced", effort: "high", phase: "delegate",
    requirements: { inputTokens: 0, expectedOutputTokens: 0, toolRequired: false, multimodalRequired: false },
    reasonCodes: ["parent-live-inventory-choice"], rationale: "parent selected the exact live session/model pair",
  }, "delegate"),
  runtimes: [codex, claude, grok, cursor],
  fallbackRuntime: codex,
  phase: "delegate",
});
assert.equal(exactParentChoice.runtime.kind, "claude-code");
assert.equal(exactParentChoice.runtime.model, "sonnet");
assert.equal(exactParentChoice.runtime.effort, "high");
assert.ok(exactParentChoice.resolutionCodes.includes("parent-selected-live-runtime-model"));

const unknownProfileRuntime = { ...claude, allocationModelProfiles: undefined };
const unknownProfileChoice = routing.resolveWorkloadAllocationAcrossRuntimes({
  allocation: routing.normalizeWorkloadAllocation({
    runtimeId: "runtime-1", modelId: "haiku", tier: "economy", effort: "low", phase: "delegate",
    requirements: { inputTokens: 500, expectedOutputTokens: 200, toolRequired: false, multimodalRequired: false },
    reasonCodes: ["unknown-profile"], rationale: "runtime discovery did not provide a profile",
  }, "delegate"),
  runtimes: [unknownProfileRuntime],
  fallbackRuntime: unknownProfileRuntime,
  phase: "delegate",
});
assert.equal(unknownProfileChoice.runtime.model, "opus", "unknown context profile must not switch exact models");
assert.ok(unknownProfileChoice.resolutionCodes.includes("requested-exact-model-context-incompatible-active-preserved"));

const missingRequirementsChoice = routing.resolveWorkloadAllocationAcrossRuntimes({
  allocation: routing.normalizeWorkloadAllocation({
    runtimeId: "runtime-1", modelId: "haiku", tier: "economy", effort: "low", phase: "delegate",
    reasonCodes: ["legacy-parent"], rationale: "requirements omitted",
  }, "delegate"),
  runtimes: [claude],
  fallbackRuntime: claude,
  phase: "delegate",
});
assert.equal(missingRequirementsChoice.runtime.model, "opus");
assert.ok(missingRequirementsChoice.resolutionCodes.includes("parent-requirements-invalid-active-preserved"));

const invalidFallback = routing.resolveWorkloadAllocation({
  allocation: routing.normalizeWorkloadAllocation(null, "delegate"),
  runtime: claude,
  phase: "delegate",
});
assert.equal(invalidFallback.runtime.model, "opus", "invalid planner output must preserve the active model");
assert.equal(invalidFallback.runtime.effort, "high", "invalid planner output must preserve active effort");

const invalidPairWithMaxEffort = routing.resolveWorkloadAllocationAcrossRuntimes({
  allocation: routing.normalizeWorkloadAllocation({
    runtimeId: "runtime-99", modelId: "invented-frontier", tier: "frontier", effort: "max", phase: "delegate",
    reasonCodes: ["invalid-pair-test"], rationale: "must preserve the active fallback",
  }, "delegate"),
  runtimes: [claude, codex],
  fallbackRuntime: claude,
  phase: "delegate",
});
assert.equal(invalidPairWithMaxEffort.runtime.model, "opus");
assert.equal(invalidPairWithMaxEffort.runtime.effort, "high", "invalid pair must not upgrade effort to max");
const invalidPairReceipt = routing.workloadAllocationReceipt(invalidPairWithMaxEffort);
assert.equal(invalidPairReceipt.requested.sessionId, "runtime-99");
assert.equal(invalidPairReceipt.resolved.sessionId, "runtime-1");
assert.equal(invalidPairReceipt.resolved.modelId, "opus");
assert.equal(invalidPairReceipt.resolved.tier, "frontier");

const constrainedClaude = {
  ...claude,
  allocationModelProfiles: {
    opus: {
      costTier: "frontier",
      contextWindow: 200_000,
      capabilities: ["tools", "multimodal"],
      supportsTools: true,
      supportsMultimodal: true,
    },
    sonnet: {
      costTier: "balanced",
      contextWindow: 32_000,
      capabilities: [],
      supportsTools: false,
      supportsMultimodal: false,
    },
  },
};
const costRejected = routing.resolveWorkloadAllocationAcrossRuntimes({
  allocation: routing.normalizeWorkloadAllocation({
    runtimeId: "runtime-1", modelId: "opus", tier: "frontier", effort: "max", phase: "delegate",
    requirements: { inputTokens: 1000, expectedOutputTokens: 500, toolRequired: false, multimodalRequired: false },
    reasonCodes: ["parent-choice"], rationale: "frontier requested",
  }, "delegate"),
  runtimes: [constrainedClaude],
  fallbackRuntime: codex,
  phase: "delegate",
  hostPolicy: { maxTier: "balanced" },
});
assert.equal(costRejected.runtime.model, codex.model);
assert.equal(costRejected.runtime.effort, codex.effort);
assert.ok(costRejected.resolutionCodes.includes("parent-tier-exceeds-host-cost-policy-active-preserved"));

const contextRejected = routing.resolveWorkloadAllocationAcrossRuntimes({
  allocation: routing.normalizeWorkloadAllocation({
    runtimeId: "runtime-1", modelId: "sonnet", tier: "balanced", effort: "high", phase: "delegate",
    requirements: { inputTokens: 40_000, expectedOutputTokens: 8_000, toolRequired: false, multimodalRequired: false },
    reasonCodes: ["large-context"], rationale: "large context",
  }, "delegate"),
  runtimes: [constrainedClaude],
  fallbackRuntime: codex,
  phase: "delegate",
});
assert.equal(contextRejected.runtime.model, codex.model);
assert.ok(contextRejected.resolutionCodes.includes("requested-exact-model-context-incompatible-active-preserved"));

const capabilityRejected = routing.resolveWorkloadAllocationAcrossRuntimes({
  allocation: routing.normalizeWorkloadAllocation({
    runtimeId: "runtime-1", modelId: "sonnet", tier: "balanced", effort: "high", phase: "delegate",
    requirements: { inputTokens: 1_000, expectedOutputTokens: 1_000, toolRequired: true, multimodalRequired: false },
    reasonCodes: ["tool-required"], rationale: "tool use required",
  }, "delegate"),
  runtimes: [constrainedClaude],
  fallbackRuntime: codex,
  phase: "delegate",
});
assert.equal(capabilityRejected.runtime.model, codex.model);
assert.ok(capabilityRejected.resolutionCodes.includes("requested-exact-model-tools-incompatible-active-preserved"));

const validConstrained = routing.resolveWorkloadAllocationAcrossRuntimes({
  allocation: routing.normalizeWorkloadAllocation({
    runtimeId: "runtime-1", modelId: "opus", tier: "frontier", effort: "max", phase: "delegate",
    requirements: { inputTokens: 10_000, expectedOutputTokens: 2_000, toolRequired: true, multimodalRequired: true },
    reasonCodes: ["verified-profile"], rationale: "host profile is compatible",
  }, "delegate"),
  runtimes: [constrainedClaude],
  fallbackRuntime: codex,
  phase: "delegate",
  hostPolicy: { maxTier: "frontier", maxEffort: "high", requiredCapabilities: ["tools"] },
});
assert.equal(validConstrained.runtime.model, "opus");
assert.equal(validConstrained.runtime.effort, "high");
assert.ok(validConstrained.resolutionCodes.includes("effort-clamped-to-host-policy"));

const typoPolicy = routing.resolveWorkloadAllocationAcrossRuntimes({
  allocation: allocation("balanced", "high", "delegate", "sonnet", "runtime-1"),
  runtimes: [constrainedClaude],
  fallbackRuntime: codex,
  phase: "delegate",
  hostPolicy: { max_tier: "balanced" },
});
assert.equal(typoPolicy.runtime.model, codex.model);
assert.ok(typoPolicy.resolutionCodes.includes("host-allocation-policy-invalid-active-preserved"));

const oversizedCapabilitiesPolicy = routing.resolveWorkloadAllocationAcrossRuntimes({
  allocation: allocation("balanced", "high", "delegate", "sonnet", "runtime-1"),
  runtimes: [constrainedClaude],
  fallbackRuntime: codex,
  phase: "delegate",
  hostPolicy: { requiredCapabilities: Array.from({ length: 33 }, (_, index) => `cap-${index}`) },
});
assert.equal(oversizedCapabilitiesPolicy.runtime.model, codex.model);
assert.ok(oversizedCapabilitiesPolicy.resolutionCodes.includes("host-allocation-policy-invalid-active-preserved"));

const borrowedPlan = borrowed.parseBorrowedWorkloadPlan(`## Agent Input Packets\n\`\`\`json
{"packets":[{"agent":"a","brief":"one","allocation":{"runtimeId":"runtime-1","modelId":"haiku","tier":"luna","effort":"low","phase":"delegate","requirements":{"inputTokens":100,"expectedOutputTokens":100,"toolRequired":false,"multimodalRequired":false},"reasonCodes":["bounded-scope"],"rationale":"small"}}],"synthesis":{"runtimeId":"runtime-2","modelId":"gpt-5.6-sol","tier":"sol","effort":"xhigh","phase":"synthesize","requirements":{"inputTokens":200,"expectedOutputTokens":100,"toolRequired":false,"multimodalRequired":false},"reasonCodes":["high-risk"],"rationale":"final"}}
\`\`\``);
assert.equal(borrowedPlan.packets[0].allocation.tier, "economy");
assert.equal(borrowedPlan.synthesisAllocation.tier, "frontier");

const swarmPlan = swarm.parseSwarmOutput(`root result\n## Spawn\n\`\`\`json
{"tasks":[
  {"role":"worker","brief":"cheap child","allocation":{"runtimeId":"runtime-2","modelId":"haiku","tier":"haiku","effort":"low","phase":"delegate","requirements":{"inputTokens":100,"expectedOutputTokens":100,"toolRequired":false,"multimodalRequired":false},"reasonCodes":["parallel-throughput"],"rationale":"small"}},
  {"role":"reviewer","brief":"critical child","allocation":{"runtimeId":"runtime-2","modelId":"opus","tier":"opus","effort":"xhigh","phase":"delegate","requirements":{"inputTokens":200,"expectedOutputTokens":100,"toolRequired":false,"multimodalRequired":false},"reasonCodes":["high-risk"],"rationale":"critical"}}
],"synthesis":{"runtimeId":"runtime-2","modelId":"sonnet","tier":"sonnet","effort":"high","phase":"synthesize","requirements":{"inputTokens":300,"expectedOutputTokens":100,"toolRequired":false,"multimodalRequired":false},"reasonCodes":["cross-result-synthesis"],"rationale":"merge"}}
\`\`\``);
assert.deepEqual(swarmPlan.spawn.map((item) => item.allocation.tier), ["economy", "frontier"]);
assert.equal(swarmPlan.synthesisAllocation.tier, "balanced");

assert.deepEqual(
  cursorRuntime.parseCursorModelList('{"models":[{"id":"Composer 2.5"},{"id":"GPT-5.6 Sol High Fast"}]}'),
  ["Composer 2.5", "GPT-5.6 Sol High Fast"],
  "Cursor JSON model inventory must retain account-visible model IDs",
);
assert.deepEqual(
  cursorRuntime.parseCursorModelList("Available models\n* Composer 2.5\n* Grok 4.5 (recommended)"),
  ["Composer 2.5", "Grok 4.5"],
  "Cursor text model inventory must preserve model choices and strip presentation markers",
);

const source = fs.readFileSync(path.join(__dirname, "..", "electron", "runtime", "workload-routing.ts"), "utf8");
assert.doesNotMatch(source, /userPrompt|task\.includes|brief\.includes|keyword/i, "host allocator must not judge task text or keywords");
assert.doesNotMatch(
  source,
  /function chooseSameTierModel|function chooseTierModel|preferredAliasOrder|modelOptionsFor/,
  "host allocator must not translate tiers or UI catalogs into provider model IDs",
);
assert.match(source, /runtime\.allocationModels \?\? \[\]/, "automatic inventory must come only from allocationModels");
const detectSource = fs.readFileSync(path.join(__dirname, "..", "electron", "runtime", "detect.ts"), "utf8");
assert.match(detectSource, /allocationModels:\s*codexDiscoveredModels/);
assert.match(detectSource, /availableModels:\s*grokModels,[\s\S]*allocationModels:\s*gr\.models/);
assert.match(detectSource, /allocationModels:\s*runtime\.allocationModels \? \[\.\.\.runtime\.allocationModels\]/);
const swarmSource = fs.readFileSync(path.join(__dirname, "..", "electron", "mcp", "swarm-run.ts"), "utf8");
assert.match(swarmSource, /coreHarnessPrompt/);
assert.doesNotMatch(swarmSource, /["`]GOAL MODE:/, "Desktop swarm must not define a local Goal mode prompt");
assert.doesNotMatch(swarmSource, /["`]ULTRACODE MODE:/, "Desktop swarm must not define a local UltraCode mode prompt");
assert.match(swarmSource, /p\.stormbreakerMode \? STORMBREAKER_LOOP_PROTOCOL/);
assert.match(swarmSource, /agentName:\s*"Stormbreaker"/);
assert.match(swarmSource, /role:\s*"Goal · UltraCode"/);
assert.match(swarmSource, /runtime.*model.*effort|런타임.*모델.*effort/s);
assert.match(swarmSource, /WORK ALREADY ASSIGNED TO PEERS/);
assert.match(swarmSource, /HOST-VERIFIED ALLOCATION:/);
assert.match(
  swarmSource,
  /const candidateRuntimes = p\.restrictedReadBoundary[\s\S]*isMobileReadRuntimeAllowed\(runtime\.kind\)/,
  "restricted-read swarm inventory must exclude unverified CLI runtimes before parent allocation",
);
assert.equal(
  (swarmSource.match(/runtimes: candidateRuntimes/g) ?? []).length,
  2,
  "worker and synthesis allocation must both use the restricted candidate inventory",
);
assert.match(
  swarmSource,
  /p\.restrictedReadBoundary && !isMobileReadRuntimeAllowed\(active\.kind\)/,
  "swarm execution must fail closed if a selected runtime crosses the restricted-read boundary",
);
const clientSource = fs.readFileSync(path.join(__dirname, "..", "electron", "mcp", "client.ts"), "utf8");
assert.match(clientSource, /stormbreakerMode:\s*stormbreakerSwarm/);
assert.match(clientSource, /stormbreakerHarness/);
assert.match(clientSource, /coreHarness\.system_prompt/);
for (const relative of [
  ["electron", "hephaestus", "builder.ts"],
  ["electron", "mcp", "borrowed-task-force.ts"],
  ["electron", "mcp", "delegate.ts"],
]) {
  const plannerSource = fs.readFileSync(path.join(__dirname, "..", ...relative), "utf8");
  assert.match(plannerSource, /workloadAllocationInventoryPrompt/, `${relative.join("/")} must receive value-safe live inventory`);
}

for (const [relative, expectedReceipts] of [
  [["electron", "hephaestus", "builder.ts"], 1],
  [["electron", "mcp", "borrowed-task-force.ts"], 2],
  [["electron", "mcp", "firm-orchestrator.ts"], 1],
  [["electron", "mcp", "swarm-run.ts"], 2],
]) {
  const executionSource = fs.readFileSync(path.join(__dirname, "..", ...relative), "utf8");
  const receiptArgs = [...executionSource.matchAll(/workloadAllocationReceipt\(([^)]+)\)/g)]
    .map((match) => match[1].trim());
  assert.equal(receiptArgs.length, expectedReceipts, `${relative.join("/")} receipt count changed`);
  assert.ok(
    receiptArgs.every((argument) => argument.startsWith("executed")),
    `${relative.join("/")} must not persist a provisional pre-run allocation receipt`,
  );
  assert.match(executionSource, /reconcileWorkloadRunnerResult\(/);
}

console.log("workload routing contract ok");
app.quit();
}

main().catch((error) => {
  console.error(error);
  app.exit(1);
});
